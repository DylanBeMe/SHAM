const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { parseSimpleYaml, resolveRuntimeSpec, executionPolicyHash } = require('../src/runtime-spec');
const { validateSiteInput } = require('../src/validation');
const { safeArchiveEntry } = require('../src/backup-restore');
const { lineLogger, shellCommand, waitForReadiness } = require('../src/runtime-engine');
const { verifyWithJwk } = require('../src/oidc');
const { siteRoot, safeReleaseDirectory } = require('../src/site-paths');
const { RELEASES_DIR, SITES_DIR } = require('../src/config');

test('runtime manifest resolves a generic process and policy hash changes with execution policy', () => {
  const manifest = parseSimpleYaml(`
runtime:
  preset: custom
  driver: process
  command: "python app.py"
  portEnv: APP_PORT
readiness:
  type: http
  path: /ready
  statusMin: 200
  statusMax: 299
shutdown:
  graceSeconds: 12
  drainSeconds: 4
`);
  const site = {
    runtime_type: 'process', runtime_preset: 'custom', start_command: 'ignored', runtime_port_env: 'PORT',
    working_directory: '', container_image: 'node:22-alpine', container_mode: 'image', container_port: 3000,
    dockerfile_path: 'Dockerfile', compose_file: 'compose.yaml', compose_service: 'app', entry_file: 'index.html',
    manifest_enabled: true
  };
  const spec = resolveRuntimeSpec(site, '/tmp/example', { manifestRecord: { filename: 'sham.yaml', manifest, raw: '' } });
  assert.equal(spec.driver, 'process');
  assert.equal(spec.command, 'python app.py');
  assert.equal(spec.portEnv, 'APP_PORT');
  assert.equal(spec.readiness.path, '/ready');
  assert.equal(spec.shutdownGraceMs, 12_000);
  assert.equal(spec.drainMs, 4_000);
  const changed = { ...spec, command: 'python other.py' };
  assert.notEqual(executionPolicyHash(spec), executionPolicyHash(changed));
});

test('runtime manifest parser rejects duplicate execution keys', () => {
  assert.throws(() => parseSimpleYaml('runtime:\n  command: one\n  command: two\n'), /repeats key command/);
});

test('site validation supports new process/container/compose modes and fails closed for command probes', () => {
  const processSite = validateSiteInput({ name: 'Fast API', port: 4300, runtimeType: 'process', runtimePreset: 'fastapi', readinessType: 'http' });
  assert.equal(processSite.runtime_type, 'process');
  assert.equal(processSite.runtime_preset, 'fastapi');
  const container = validateSiteInput({ name: 'Image', port: 4301, runtimeType: 'container', runtimePreset: 'dockerfile', containerMode: 'dockerfile', containerPort: 8080 });
  assert.equal(container.container_mode, 'dockerfile');
  const compose = validateSiteInput({ name: 'Compose', port: 4302, runtimeType: 'compose', runtimePreset: 'compose', composeService: 'web', composeFile: 'compose.yaml' });
  assert.equal(compose.compose_service, 'web');
  assert.throws(() => validateSiteInput({ name: 'No command', port: 4303, runtimeType: 'process', runtimePreset: 'custom' }), /require a start command/);
  assert.throws(() => validateSiteInput({ name: 'No probe', port: 4304, runtimeType: 'process', runtimePreset: 'npm', readinessType: 'command' }), /requires a readiness command/);
  assert.throws(() => validateSiteInput({ name: 'No health command', port: 4305, healthCheckType: 'command' }), /require a health-check command/);
});

test('runtime line logger preserves lines split across stream chunks', async () => {
  const stream = new PassThrough();
  const lines = [];
  lineLogger(stream, (line) => lines.push(line));
  stream.write('first half');
  stream.write(' second\nnext');
  stream.end(' line\n');
  await new Promise((resolve) => stream.once('end', resolve));
  assert.deepEqual(lines, ['first half second', 'next line']);
});

test('structured runtime argv preserves argument boundaries and startup spawn errors fail fast', async () => {
  const child = shellCommand([process.execPath, '-e', 'process.stdout.write(process.argv[1])', 'space preserved'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  assert.equal(output, 'space preserved');
  const missing = shellCommand(['sham-command-that-does-not-exist-xyz'], { stdio: 'ignore' });
  await assert.rejects(() => waitForReadiness({ readiness: { type: 'tcp', timeoutMs: 2000 }, host: '127.0.0.1', internalPort: 9 }, { child: missing, host: '127.0.0.1', port: 9 }), /could not start/);
});

test('backup restore entry validation rejects traversal and absolute paths', () => {
  assert.equal(safeArchiveEntry('./sites/example/index.html'), true);
  assert.equal(safeArchiveEntry('../etc/passwd'), false);
  assert.equal(safeArchiveEntry('/etc/passwd'), false);
  assert.equal(safeArchiveEntry('sites/../../etc/passwd'), false);
});

test('OIDC ES256 verification accepts JOSE/P1363 signatures', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: '123' })).toString('base64url');
  const signingInput = Buffer.from(`${header}.${payload}`);
  const signature = crypto.sign('sha256', signingInput, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  assert.equal(verifyWithJwk({ header: { alg: 'ES256' }, signingInput, signature }, publicKey.export({ format: 'jwk' })), true);
});


test('active releases resolve through stable retained release paths', () => {
  const legacy = siteRoot({ id: 41, directory_name: 'demo', active_release_directory: '' });
  assert.equal(legacy, path.join(SITES_DIR, 'demo'));
  const active = siteRoot({ id: 41, directory_name: 'demo', active_release_directory: 'release-1234-abcd' });
  assert.equal(active, path.join(RELEASES_DIR, '41', 'release-1234-abcd'));
  assert.equal(safeReleaseDirectory('release-1234-abcd'), 'release-1234-abcd');
  assert.throws(() => safeReleaseDirectory('../release-1234'), /invalid/);
});

test('release activation starts candidates only after placing them at their stable release path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'operations', 'deployments.js'), 'utf8');
  const section = source.slice(source.indexOf('async activateRelease('), source.indexOf('beginDeployment(', source.indexOf('async activateRelease(')));
  assert.match(section, /await fs\.promises\.rename\(stage, releaseRoot\);/);
  assert.match(section, /prepareCandidate\(site, releaseRoot/);
  assert.doesNotMatch(section, /rename\(stage, root\)/);
  assert.match(section, /active_release_directory = \?/);
});

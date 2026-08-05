const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function requireConfig(dataPath, trustedProxies) {
  return spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: root,
    env: {
      ...process.env,
      SHAM_DATA_PATH: dataPath,
      SHAM_TRUSTED_EDGE_PROXIES: trustedProxies
    },
    encoding: 'utf8'
  });
}

test('trusted edge proxy ranges fail closed when malformed', () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-config-invalid-'));
  try {
    const result = requireConfig(dataPath, 'not-a-cidr');
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /SHAM_TRUSTED_EDGE_PROXIES contains an invalid IP address or CIDR range/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('trusted edge proxy ranges accept valid IPs and CIDRs', () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-config-valid-'));
  try {
    const result = requireConfig(dataPath, '127.0.0.1,10.10.0.0/16,2001:db8::/32');
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('worker threads do not delete in-flight multipart uploads', () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-config-worker-'));
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { Worker } = require('node:worker_threads');
    const config = require('./src/config');
    const marker = path.join(config.UPLOAD_TMP_DIR, 'in-flight-upload');
    fs.writeFileSync(marker, 'still here');
    const worker = new Worker(
      "const { parentPort } = require('node:worker_threads'); require('./src/config'); parentPort.postMessage('ready');",
      { eval: true }
    );
    worker.once('message', () => {
      if (!fs.existsSync(marker)) process.exitCode = 2;
    });
    worker.once('error', (error) => { console.error(error); process.exitCode = 3; });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      env: { ...process.env, SHAM_DATA_PATH: dataPath },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

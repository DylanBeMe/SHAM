'use strict';

process.env.SHAM_JWT_SECRET = 'cloudflare-tunnel-test-secret-at-least-32-characters';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  CloudflareTunnelManager,
  validateToken
} = require('../src/cloudflare-tunnel');

class FakeSettingsStore {
  constructor({ enabled = false, token = '', tokenError = null } = {}) {
    this.enabled = enabled;
    this.savedToken = token;
    this.tokenError = tokenError;
  }

  status() {
    return { enabled: this.enabled, tokenConfigured: Boolean(this.savedToken) };
  }

  token() {
    if (this.tokenError) throw this.tokenError;
    return this.savedToken;
  }

  save({ enabled, token, clearToken }) {
    this.enabled = Boolean(enabled);
    if (token !== undefined) {
      this.savedToken = token;
      this.tokenError = null;
    } else if (clearToken) {
      this.savedToken = '';
      this.tokenError = null;
    }
    return this.status();
  }
}

class FakeChild extends EventEmitter {
  constructor(pid = 1234) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  exit(code = 1, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function createHarness(settings = new FakeSettingsStore(), options = {}) {
  const spawns = [];
  const children = [];
  const logs = [];
  const manager = new CloudflareTunnelManager({
    settingsStore: settings,
    command: '/usr/local/bin/cloudflared',
    commandAvailableCheck: () => options.available !== false,
    spawnProcess: (command, args, spawnOptions) => {
      const child = new FakeChild(1200 + children.length);
      children.push(child);
      spawns.push({ command, args, options: spawnOptions });
      return child;
    },
    terminateProcess: async (child) => {
      if (child.exitCode === null && child.signalCode === null) child.exit(0, 'SIGTERM');
    },
    environment: (extra) => ({ PATH: '/usr/local/bin', ...extra }),
    log: (level, message) => logs.push({ level, message }),
    restartBaseMs: 100,
    restartMaxMs: 200,
    stableAfterMs: 100
  });
  return { manager, settings, spawns, children, logs };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('tunnel tokens are validated as bounded single values', () => {
  assert.equal(validateToken('abc.def.ghi'), 'abc.def.ghi');
  assert.throws(() => validateToken(''), /single value/);
  assert.throws(() => validateToken('token with spaces'), /single value/);
  assert.throws(() => validateToken(`token\nother`), /single value/);
});

test('enabling requires a configured tunnel token', async () => {
  const { manager } = createHarness();
  await assert.rejects(manager.configure({ enabled: true }), /Set a Cloudflare Tunnel token/);
  assert.equal(manager.status().state, 'stopped');
});

test('cloudflared receives the token through its environment, not argv', async () => {
  const token = 'eyJ-cloudflare-token';
  const { manager, spawns, children } = createHarness(new FakeSettingsStore({ enabled: true, token }));
  await manager.start();
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['tunnel', '--no-autoupdate', 'run']);
  assert.equal(spawns[0].options.env.TUNNEL_TOKEN, token);
  assert.doesNotMatch(spawns[0].args.join(' '), /eyJ-cloudflare-token/);
  children[0].stderr.write('INF Registered tunnel connection connIndex=0\n');
  await wait(5);
  assert.equal(manager.status().state, 'connected');
  await manager.shutdown();
});

test('connector output is bounded and redacts the saved token', async () => {
  const token = 'super-secret-tunnel-token';
  const { manager, children } = createHarness(new FakeSettingsStore({ enabled: true, token }));
  await manager.start();
  children[0].stderr.write(`ERR failed to authenticate ${token}\n`);
  await wait(5);
  assert.doesNotMatch(manager.status().lastLog, /super-secret-tunnel-token/);
  assert.match(manager.status().lastLog, /\[redacted\]/);
  assert.match(manager.status().lastError, /failed to authenticate/);
  await manager.shutdown();
});

test('unexpected exits use bounded supervised restart backoff', async () => {
  const { manager, children, spawns } = createHarness(new FakeSettingsStore({ enabled: true, token: 'token' }));
  await manager.start();
  children[0].exit(1);
  assert.equal(manager.status().state, 'backoff');
  assert.equal(manager.status().restartCount, 1);
  await wait(130);
  assert.equal(spawns.length, 2);
  assert.equal(manager.status().running, true);
  await manager.shutdown();
});

test('disabling terminates the connector and cancels restart', async () => {
  const { manager, settings, children, spawns } = createHarness(new FakeSettingsStore({ enabled: true, token: 'token' }));
  await manager.start();
  children[0].exit(1);
  await manager.configure({ enabled: false });
  assert.equal(settings.enabled, false);
  assert.equal(manager.status().state, 'disabled');
  await wait(130);
  assert.equal(spawns.length, 1);
});

test('an unreadable saved token can be replaced or cleared', async () => {
  const settings = new FakeSettingsStore({ enabled: true, token: 'encrypted-value', tokenError: new Error('wrong master key') });
  const { manager, spawns } = createHarness(settings);
  await manager.start();
  assert.equal(manager.status().state, 'error');
  assert.equal(manager.status().tokenReadable, false);
  await assert.rejects(manager.configure({ enabled: true }), /cannot be read/);
  await manager.configure({ enabled: true, token: 'replacement-token' });
  assert.equal(spawns.length, 1);
  assert.equal(manager.status().tokenReadable, true);
  await manager.configure({ enabled: false, clearToken: true });
  assert.equal(settings.savedToken, '');
  assert.equal(manager.status().state, 'disabled');
});

test('missing cloudflared is reported without crashing SHAM startup', async () => {
  const { manager, spawns } = createHarness(new FakeSettingsStore({ enabled: true, token: 'token' }), { available: false });
  await manager.start();
  assert.equal(spawns.length, 0);
  assert.equal(manager.status().state, 'unavailable');
  assert.match(manager.status().lastError, /not executable/);
});

test('shutdown stops the child and prevents later restarts', async () => {
  const { manager, children, spawns } = createHarness(new FakeSettingsStore({ enabled: true, token: 'token' }));
  await manager.start();
  children[0].exit(1);
  await manager.shutdown();
  await wait(130);
  assert.equal(spawns.length, 1);
  assert.equal(manager.status().state, 'stopped');
});

test('capability status refreshes when cloudflared becomes available', async () => {
  const options = { available: false };
  const { manager } = createHarness(new FakeSettingsStore(), options);
  await manager.start();
  assert.equal(manager.status().available, false);
  options.available = true;
  assert.equal(manager.status().available, true);
});

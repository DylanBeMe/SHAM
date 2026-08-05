const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-install-scheduler-'));
process.env.SHAM_DATA_PATH = temporaryData;
process.env.SHAM_JWT_SECRET = 'install-scheduler-test-secret-at-least-32-characters';
test.after(() => fs.rmSync(temporaryData, { recursive: true, force: true }));
const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'express') return function express() {};
  if (request === 'http-proxy') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { SiteManager } = require('../src/site-manager');
Module._load = originalLoad;

function scheduler() {
  const manager = Object.create(SiteManager.prototype);
  manager.installActive = 0;
  manager.installQueue = [];
  manager.installStopping = false;
  return manager;
}

test('npm install scheduler transfers released capacity without exceeding its worker limit', async () => {
  const manager = scheduler();
  await manager.acquireInstallSlot();
  await manager.acquireInstallSlot();
  assert.equal(manager.installActive, 2);

  let entered = false;
  const waiting = manager.acquireInstallSlot().then(() => { entered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, false);
  assert.equal(manager.installQueue.length, 1);

  manager.releaseInstallSlot();
  await waiting;
  assert.equal(entered, true);
  assert.equal(manager.installActive, 2);
  assert.equal(manager.installQueue.length, 0);

  manager.releaseInstallSlot();
  manager.releaseInstallSlot();
  assert.equal(manager.installActive, 0);
});

test('npm install scheduler rejects new work during shutdown', async () => {
  const manager = scheduler();
  manager.installStopping = true;
  await assert.rejects(() => manager.acquireInstallSlot(), /shutting down/);
});

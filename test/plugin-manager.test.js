const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-plugins-'));
process.env.SHAM_DATA_PATH = temporaryData;

const { PluginManager, validateManifest, validateDeclarativeSql } = require('../src/plugin-manager');

test.after(() => fs.rmSync(temporaryData, { recursive: true, force: true }));

test('JSON plugin manifests expose bounded declarative data actions and UI', () => {
  const manifest = validateManifest({
    id: 'site-counts',
    name: 'Site Counts',
    type: 'json',
    settings: [{ key: 'title', type: 'text', default: 'Sites' }],
    queries: {
      count: { mode: 'get', sql: 'SELECT COUNT(*) AS count FROM sites' },
      incrementStats: { mode: 'run', sql: 'UPDATE site_stats SET total_requests = total_requests + ? WHERE site_id = ?', params: ['amount', 'id'] }
    },
    ui: {
      dashboardCards: [{ label: 'Sites', action: 'count', valuePath: 'count' }],
      pages: [{ id: 'summary', title: 'Summary', cards: [{ label: 'Sites', action: 'count' }] }]
    }
  });

  assert.equal(manifest.type, 'json');
  assert.equal(manifest.queries.count.mode, 'get');
  assert.deepEqual(manifest.queries.incrementStats.params, ['amount', 'id']);
  assert.equal(manifest.ui.dashboardCards[0].action, 'count');
  assert.equal(manifest.ui.pages[0].cards[0].label, 'Sites');
});

test('declarative SQL is single-statement and limits write actions', () => {
  assert.equal(validateDeclarativeSql('SELECT COUNT(*) FROM sites;', 'get'), 'SELECT COUNT(*) FROM sites');
  assert.equal(validateDeclarativeSql('UPDATE site_stats SET total_requests = total_requests + ? WHERE site_id = ?', 'run'), 'UPDATE site_stats SET total_requests = total_requests + ? WHERE site_id = ?');
  assert.throws(() => validateDeclarativeSql('DELETE FROM sites; DROP TABLE users', 'run'), /exactly one/);
  assert.throws(() => validateDeclarativeSql('DROP TABLE users', 'run'), /INSERT, UPDATE, or DELETE/);
  assert.throws(() => validateDeclarativeSql('UPDATE sites SET name = ?', 'get'), /SELECT/);
  assert.throws(() => validateDeclarativeSql('SELECT 1 -- comment', 'get'), /comments/);
  assert.throws(() => validateDeclarativeSql('SELECT password_hash FROM users', 'get'), /may not access users/);
  assert.throws(() => validateDeclarativeSql('SELECT value FROM settings', 'all'), /may not access settings/);
  assert.throws(() => validateDeclarativeSql('UPDATE sites SET name = ? WHERE id = ?', 'run'), /may not modify sites/);
  assert.throws(() => validateDeclarativeSql('DELETE FROM plugins WHERE id = ?', 'run'), /may not modify plugins/);
  assert.throws(() => validateDeclarativeSql('SELECT * FROM pragma_table_info(?)', 'all'), /pragma/);
});

test('plugin manifests reject unsafe IDs and client paths', () => {
  assert.throws(() => validateManifest({ id: '../bad', name: 'Bad' }), /Plugin ID/);
  assert.throws(() => validateManifest({ id: 'safe-id', name: 'Bad client', client: '../client.js' }), /safe/);
});


test('plugin unload awaits asynchronous cleanup before removing lifecycle state', async () => {
  const manager = new PluginManager({}, { log() {}, error() {} });
  let cleaned = false;
  manager.active.set('async-cleanup', {
    instance: {
      async deactivate() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        cleaned = true;
      }
    }
  });

  await manager.unload('async-cleanup');
  assert.equal(cleaned, true);
  assert.equal(manager.active.has('async-cleanup'), false);
});

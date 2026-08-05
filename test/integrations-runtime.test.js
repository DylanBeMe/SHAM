const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function renewalNeedsPort80(dataPath) {
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/integrations').renewalNeedsPort80()))"], {
    cwd: root,
    env: { ...process.env, SHAM_DATA_PATH: dataPath },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('certificate renewal only claims port 80 for standalone configurations', () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-renewal-'));
  const renewalDir = path.join(dataPath, 'certbot', 'config', 'renewal');
  try {
    assert.equal(renewalNeedsPort80(dataPath), 'false');
    fs.mkdirSync(renewalDir, { recursive: true });
    fs.writeFileSync(path.join(renewalDir, 'dns.example.conf'), 'authenticator = dns-cloudflare\n');
    assert.equal(renewalNeedsPort80(dataPath), 'false');
    fs.writeFileSync(path.join(renewalDir, 'standalone.example.conf'), 'authenticator = standalone\n');
    assert.equal(renewalNeedsPort80(dataPath), 'true');
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

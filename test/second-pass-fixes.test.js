'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { source } = require('./source-tree');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('canonical public origin drives reverse-proxy-sensitive authentication decisions', () => {
  const config = read('src/config.js');
  const server = source('src/server.js');
  const security = read('src/security.js');
  assert.match(config, /process\.env\.SHAM_PUBLIC_ORIGIN/);
  assert.match(config, /SHAM_PUBLIC_ORIGIN must not include a path/);
  assert.match(config, /PUBLIC_ORIGIN: publicOriginEnv\(\)/);
  assert.match(server, /return PUBLIC_ORIGIN \|\| new URL\(`\$\{req\.protocol\}:\/\/\$\{req\.get\('host'\)\}`\)\.origin/);
  assert.match(security, /const expected = PUBLIC_ORIGIN \|\| new URL/);
  assert.match(security, /req\.secure \|\| PUBLIC_ORIGIN\.startsWith\('https:\/\/'\)/);
});

test('browser sessions are versioned, individually revocable, and invalidated by access changes', () => {
  const db = read('src/db.js');
  const security = read('src/security.js');
  const server = source('src/server.js');
  assert.match(db, /session_version[^\n]+DEFAULT 1/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS revoked_sessions/);
  assert.match(security, /sid: crypto\.randomUUID\(\)/);
  assert.match(security, /sv: sessionVersion/);
  assert.match(security, /SELECT 1 FROM revoked_sessions WHERE sid = \? AND expires_at > \?/);
  assert.match(server, /revokeCurrentSession\(req\);[\s\S]*auth\.logout/);
  assert.match(server, /session_version = session_version \+ \?/);
  assert.match(server, /\/api\/admin\/users\/:id\/revoke-sessions/);
});

test('OIDC-provisioned accounts can bootstrap a usable local password', () => {
  const db = read('src/db.js');
  const server = source('src/server.js');
  const securityUi = read('public/js/security.js');
  assert.match(server, /oidc_identities[\s\S]*password_configured/);
  assert.match(server, /INSERT INTO users \(username, password_hash, password_salt, role, active, password_configured\)[^\n]+1, 0/);
  assert.match(server, /app\.put\('\/api\/security\/password'/);
  assert.match(server, /This account cannot bootstrap a local password from the current sign-in method/);
  assert.match(server, /password_configured = 1, session_version = session_version \+ 1/);
  assert.match(db, /UPDATE users SET password_configured = 0 WHERE id IN \(SELECT DISTINCT user_id FROM oidc_identities\)/);
  assert.match(securityUi, /Set local password/);
  assert.match(securityUi, /requestSecurityPassword/);
});

test('post-bootstrap public signup is disabled and administrators create accounts explicitly', () => {
  const server = source('src/server.js');
  const html = read('public/index.html');
  const admin = read('public/js/admin.js');
  assert.match(server, /function registrationEnabled\(\)[\s\S]*return userCount\(\) === 0/);
  assert.match(server, /if \(userCount\(\) > 0\) return res\.status\(403\)\.json\(\{ error: 'Public registration is disabled/);
  assert.match(server, /app\.post\('\/api\/admin\/users'/);
  assert.doesNotMatch(html, /id="registration-toggle"/);
  assert.match(html, /id="admin-create-password"[^>]+type="password"[^>]+autocomplete="new-password"/);
  assert.match(admin, /api\('\/api\/admin\/users', \{ method: 'POST'/);
});

test('Appearance remains available to regular users while administrator settings stay gated', () => {
  const html = read('public/index.html');
  const core = read('public/js/core.js');
  const operations = read('public/js/operations.js');
  assert.match(html, /<button class="nav-item" data-section="operations"[^>]*>[^<]*<span>⚙<\/span>Settings<\/button>/);
  assert.match(html, /id="operations-tab-appearance" class="tab active"/);
  for (const tab of ['delivery', 'configuration', 'automation', 'instance', 'administration']) {
    assert.match(html, new RegExp(`id="operations-tab-${tab}" class="tab admin-only"`));
  }
  assert.match(core, /sectionName === 'operations' && state\.user\?\.role !== 'admin'[\s\S]*setOperationsTab\('appearance'\)/);
  assert.match(core, /sectionName === 'operations' && state\.user\?\.role === 'admin'[\s\S]*loadOperations\(\);[\s\S]*loadAdmin\(\)/);
  assert.match(operations, /filter\(\(button\) => !button\.hidden\)/);
});

test('per-site alert rule mutations autosave in a serialized queue', () => {
  const html = read('public/index.html');
  const performance = read('public/js/performance.js');
  assert.doesNotMatch(html, /performance-save-rules/);
  assert.match(html, /Changes save automatically/);
  assert.match(performance, /let performanceRulesSaveTail = Promise\.resolve\(\)/);
  assert.match(performance, /performanceRulesSaveTail = performanceRulesSaveTail\.catch\(\(\) => \{\}\)\.then\(\(\) => persistPerformanceRules/);
  assert.ok((performance.match(/saveCurrentPerformanceRules\(\)/g) || []).length >= 3);
});

test('sensitive browser values are cleared or remasked when their UI lifetime ends', () => {
  const core = read('public/js/core.js');
  const securityUi = read('public/js/security.js');
  const operations = read('public/js/operations.js');
  assert.match(core, /actionInput\.value = ''/);
  assert.match(core, /payload\.error === 'Authentication required\.'/);
  assert.match(securityUi, /function clearTransientSecuritySecrets\(\)/);
  assert.match(securityUi, /recovery-codes'\)\.textContent = ''/);
  assert.match(securityUi, /api-token-value'\)\.textContent = ''/);
  assert.match(securityUi, /recovery-dialog'\)\.addEventListener\('close'/);
  assert.match(securityUi, /api-token-dialog'\)\.addEventListener\('close'/);
  assert.match(operations, /setTimeout\(remask, 30_000\)/);
  assert.match(operations, /input\.addEventListener\('blur', remask/);
});

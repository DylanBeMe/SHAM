const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('certificate issuance acquires its operation lock exactly once', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/api/admin/sites/:id/certificate'");
  const routeEnd = source.indexOf("app.post('/api/admin/certificates/renew'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.equal((route.match(/acquireCertificateOperation\(res\)/g) || []).length, 1);
  assert.match(route, /finally\s*\{[\s\S]*certificateOperationActive = false;/);
});

test('dashboard startup imports its configured data path', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.match(source, /\bDATA_DIR\b/);
  assert.match(source, /SHAM data path: \$\{DATA_DIR\}/);
});


test('static and Node listeners share the configured request timeout', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'site-manager.js'), 'utf8');
  assert.equal((source.match(/server\.requestTimeout = HTTP_REQUEST_TIMEOUT_MS/g) || []).length, 2);
  assert.doesNotMatch(source, /server\.requestTimeout = 30_000/);
});

test('content replacement restores a previously running site', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const routeStart = source.indexOf("app.put('/api/sites/:id/content'");
  const routeEnd = source.indexOf("app.get('/api/sites/:id/files'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(source.slice(routeStart, routeEnd), /if \(wasRunning \|\| site\.enabled\)/);
});


test('Node reverse proxy applies outgoing and incoming request timeouts', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'site-manager.js'), 'utf8');
  assert.match(source, /timeout: HTTP_REQUEST_TIMEOUT_MS/);
  assert.match(source, /proxyTimeout: HTTP_REQUEST_TIMEOUT_MS/);
});

test('site restart compensates when enabled-state persistence fails', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/api/sites/:id/restart'");
  const routeEnd = source.indexOf("app.post('/api/sites/:id/npm-install'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /if \(!wasRunning\) await manager\.stop\(site\.id\)/);
  assert.match(route, /could not persist its enabled state/);
});


test('API body parser failures return useful client errors', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.match(source, /error\?\.type === 'entity\.too\.large'/);
  assert.match(source, /Request body contains invalid JSON/);
  assert.match(source, /if \(res\.headersSent\) return next\(error\)/);
});

test('Cloudflare sync warns about unsupported visitor-facing ports', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.match(source, /CLOUDFLARE_HTTP_PORTS/);
  assert.match(source, /CLOUDFLARE_HTTPS_PORTS/);
  assert.match(source, /warning: cloudflarePortWarning\(site\)/);
});

test('changing a site domain invalidates the stored Cloudflare synchronization state', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const routeStart = source.indexOf("app.put('/api/sites/:id'");
  const routeEnd = source.indexOf("app.patch('/api/sites/:id/toggle'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /const domainChanged = config\.domain !== site\.domain/);
  assert.match(route, /if \(domainChanged\) config\.cloudflare_enabled = false/);
  assert.match(route, /marked Cloudflare DNS as unsynchronized/);
});

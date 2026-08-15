'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { source } = require('./source-tree');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('site upload routes import and use the configured upload byte limit', () => {
  const routes = read('src/routes/sites.js');
  assert.match(routes, /const \{ RELEASES_DIR, UPLOAD_LIMIT_BYTES \} = require\('\.\.\/config'\);/);
  assert.ok((routes.match(/maxBytes: UPLOAD_LIMIT_BYTES/g) || []).length >= 2);
});

test('observability feed is filterable, compact, and does not leave regular users in a half-width column', () => {
  const html = read('public/index.html');
  const activity = read('public/js/activity.js');
  const css = read('public/styles.css');
  assert.match(html, /id="activity-search"/);
  assert.match(html, /id="activity-level"/);
  assert.match(html, /class="observability-list"/);
  assert.match(activity, /classList\.toggle\('single-column', !admin\)/);
  assert.match(activity, /<details class="audit-detail">/);
  assert.match(css, /\.activity-columns\.single-column \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.observability-event/);
});

test('observability settings are grouped and tooltip question marks are optically centered', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  assert.ok((html.match(/class="observability-setting-group"/g) || []).length >= 4);
  assert.match(html, /id="open-public-status"/);
  assert.match(css, /\.help-tip \{ font-size: 0; \}/);
  assert.match(css, /\.help-tip::before \{ content: "\?";/);
});

test('public status API and page use one normalized snapshot with an overall state', () => {
  const server = source('src/server.js');
  assert.match(server, /function publicStatusSnapshot\(\)/);
  assert.match(server, /overall = !sites\.length \? 'empty'/);
  assert.match(server, /res\.json\(publicStatusSnapshot\(\)\)/);
  assert.match(server, /status-overview-badge/);
  assert.match(server, /http-equiv="refresh" content="30"/);
});

test('OpenTelemetry endpoint normalization does not duplicate the metrics suffix after a trailing slash', () => {
  const observability = read('src/operations/observability.js');
  assert.match(observability, /const normalizedPath = parsed\.pathname\.replace\(\/\\\/\+\$\/, ''\);/);
  assert.match(observability, /normalizedPath\.endsWith\('\/v1\/metrics'\)/);
});

test('Cloudflare Tunnel documentation covers tokens, Docker routing, lifecycle states, and troubleshooting', () => {
  const guide = read('docs/cloudflare-tunnels.md');
  const docs = read('docs/README.md');
  const readme = read('README.md');
  assert.match(guide, /Tunnel token.*Cloudflare API token/s);
  assert.match(guide, /http:\/\/localhost:80/);
  assert.match(guide, /Connector states/);
  assert.match(guide, /Backoff/);
  assert.match(guide, /502\/Bad Gateway/);
  assert.match(guide, /SHAM_CLOUDFLARED_BIN/);
  assert.match(docs, /cloudflare-tunnels\.md/);
  assert.match(readme, /docs\/cloudflare-tunnels\.md/);
});

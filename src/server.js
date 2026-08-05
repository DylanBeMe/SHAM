require('./env');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const express = require('express');
const multer = require('multer');

const {
  ROOT_DIR,
  DATA_DIR,
  SITES_DIR,
  UPLOAD_TMP_DIR,
  DASHBOARD_HOST,
  DASHBOARD_PORT,
  UPLOAD_LIMIT_BYTES,
  EDITOR_LIMIT_BYTES,
  HTTP_REQUEST_TIMEOUT_MS,
  TRUST_PROXY,
  EDGE_HTTP_PORT,
  EDGE_HTTPS_PORT
} = require('./config');
const { db, getSetting, setSetting, audit: writeAudit } = require('./db');
const {
  normalizeUsername,
  hashPassword,
  verifyPassword,
  issueToken,
  issueMfaToken,
  verifyMfaToken,
  setAuthCookie,
  clearAuthCookie,
  optionalAuth,
  requireAuth,
  requireAdmin,
  sameOriginGuard,
  createRateLimiter
} = require('./security');
const { bool, validateSiteInput, safeRelativePath } = require('./validation');
const { auditObfuscationCompatibility } = require('./obfuscation-audit');
const { installUploadAsync, stopUploadWorkers, MAX_FILES } = require('./upload-utils');
const { CappedDiskStorage, cleanupUploadedFiles } = require('./upload-storage');
const {
  listSiteFilesAsync,
  readTextFileAsync,
  writeTextFileAsync,
  replaceSingleFileFromPathAsync,
  deleteSingleFileAsync,
  stageSingleFileDeletionAsync
} = require('./file-utils');
const { SiteManager, hydrateSite, realFileInside } = require('./site-manager');
const {
  syncCloudflareRecord,
  syncCloudflareFirewall,
  issueCertificate,
  renewalNeedsPort80,
  renewCertificates,
  hasCertificate,
  writeCloudflareCredentials,
  stopIntegrationProcesses
} = require('./integrations');
const { PluginManager } = require('./plugin-manager');
const { getSecretSetting, setSecretSetting, rotateMasterKey, encrypt, decrypt } = require('./secret-store');
const { generateTotpSetup, generateRecoveryCodes, verifyTotp, consumeRecoveryCode, enableTotp, disableTotp, userTotpSecret } = require('./mfa');
const { registrationOptions, verifyRegistration, assertionOptions, verifyAssertion } = require('./webauthn');
const { SnapshotManager } = require('./snapshot-manager');
const { DependencyScanner } = require('./dependency-scanner');
const { PerformanceMonitor } = require('./performance-monitor');
const { EdgeProxy } = require('./edge-proxy');
const { validatePluginArchiveFile } = require('./plugin-archive');
const { OperationsManager } = require('./operations-manager');
const { UpdateManager } = require('./update-manager');

const app = express();
const DEPLOY_WEBHOOK_DUMMY_SECRET = crypto.randomBytes(32);
const manager = new SiteManager(db);
const pluginManager = new PluginManager(db, console, manager);
const snapshotManager = new SnapshotManager(db);
const dependencyScanner = new DependencyScanner(db);
const performanceMonitor = new PerformanceMonitor({ db, manager, snapshotManager, dependencyScanner });
const edgeProxy = new EdgeProxy({ db, manager });
const operationsManager = new OperationsManager({ db, manager, snapshotManager, edgeProxy });
const updateManager = new UpdateManager({ db });
manager.setOperations(operationsManager);
edgeProxy.setOperations(operationsManager);
const publicDir = path.join(ROOT_DIR, 'public');
pluginManager.loadEnabled();

app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(sameOriginGuard);
app.use(express.json({
  limit: `${Math.max(EDITOR_LIMIT_BYTES + 1024 * 1024, 3 * 1024 * 1024)}b`,
  verify: (req, _res, buffer) => { if (req.path.startsWith('/api/hooks/deploy/')) req.rawBody = Buffer.from(buffer); }
}));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const webhookLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120 });
const upload = multer({
  storage: new CappedDiskStorage(UPLOAD_TMP_DIR, UPLOAD_LIMIT_BYTES),
  limits: {
    fileSize: UPLOAD_LIMIT_BYTES,
    files: MAX_FILES,
    fields: 80,
    parts: MAX_FILES + 80,
    fieldNameSize: 100,
    fieldNestingDepth: 0,
    fieldSize: Math.max(EDITOR_LIMIT_BYTES, 2 * 1024 * 1024)
  }
});
const updateUpload = multer({
  storage: new CappedDiskStorage(UPLOAD_TMP_DIR, 512 * 1024 * 1024),
  limits: { fileSize: 512 * 1024 * 1024, files: 1, fields: 4, parts: 5, fieldNameSize: 100, fieldNestingDepth: 0, fieldSize: 64 * 1024 }
});
const pluginUpload = multer({
  storage: new CappedDiskStorage(UPLOAD_TMP_DIR, 20 * 1024 * 1024),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 8, parts: 9, fieldNameSize: 100, fieldNestingDepth: 0, fieldSize: 64 * 1024 }
});

const receiveWebsite = upload.fields([
  { name: 'archive', maxCount: 1 },
  { name: 'files', maxCount: MAX_FILES }
]);
const receiveSingleFile = upload.single('file');

function uploadSizeGuard(req, res, next) {
  const contentLength = Number(req.get('content-length') || 0);
  const multipartAllowance = 10 * 1024 * 1024;
  if (contentLength && contentLength > UPLOAD_LIMIT_BYTES + multipartAllowance) {
    return res.status(413).json({ error: 'Upload exceeds the configured size limit.' });
  }
  next();
}

function multipart(handler) {
  return (req, res, next) => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupUploadedFiles(req);
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    handler(req, res, (error) => {
      if (!error) return next();
      cleanup();
      const message = error instanceof multer.MulterError ? `Upload rejected: ${error.message}` : error.message;
      res.status(error?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    });
  };
}

function recordAudit(userId, action, detail = null) {
  try {
    writeAudit(userId, action, detail);
  } catch (error) {
    manager.log(null, 'error', `Could not write audit event “${action}”: ${error.message}`);
  }
}

let certificateOperationActive = false;
function acquireCertificateOperation(res) {
  if (certificateOperationActive) {
    res.status(409).json({ error: 'Another certificate operation is already running.' });
    return false;
  }
  certificateOperationActive = true;
  return true;
}

let pluginMutationTail = Promise.resolve();
async function serializePluginMutation(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const previous = pluginMutationTail;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  pluginMutationTail = previous.catch(() => {}).then(() => gate);
  await previous.catch(() => {});
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
}

const siteMutationTails = new Map();
async function serializeSiteMutation(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const siteId = Number(req.params.id);
  if (!Number.isSafeInteger(siteId) || siteId < 1) return next();

  const previous = siteMutationTails.get(siteId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  siteMutationTails.set(siteId, tail);
  await previous.catch(() => {});

  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
    if (siteMutationTails.get(siteId) === tail) siteMutationTails.delete(siteId);
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
}

function publicUser(user) {
  return user ? {
    id: user.id,
    username: user.username,
    role: user.role,
    active: Boolean(user.active),
    totpEnabled: Boolean(user.totp_enabled),
    passkeyCount: Number(user.passkey_count || 0),
    createdAt: user.created_at
  } : null;
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

function registrationEnabled() {
  return getSetting('registration_enabled', '0') === '1';
}

function securityUser(id) {
  return db.prepare(`SELECT users.*, (SELECT COUNT(*) FROM passkeys WHERE user_id = users.id) AS passkey_count FROM users WHERE users.id = ?`).get(id);
}

function requestOrigin(req) {
  return new URL(`${req.protocol}://${req.get('host')}`).origin;
}

function requestRpId(req) {
  const host = String(req.hostname || '').trim().toLowerCase();
  if (!host) throw new Error('The dashboard hostname is unavailable for passkey verification.');
  return host;
}

function createChallenge(userId, purpose, challenge, rpId, origin, ttlMs = 5 * 60_000) {
  db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").run(Date.now());
  db.prepare('DELETE FROM webauthn_challenges WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, rp_id, origin, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, purpose, challenge, rpId, origin, Date.now() + ttlMs);
  return id;
}

function consumeChallenge(id, userId, purpose) {
  const row = db.prepare('SELECT * FROM webauthn_challenges WHERE id = ? AND user_id = ? AND purpose = ?').get(String(id || ''), userId, purpose);
  db.prepare('DELETE FROM webauthn_challenges WHERE id = ? AND user_id = ? AND purpose = ?').run(String(id || ''), userId, purpose);
  if (!row || row.expires_at < Date.now()) throw new Error('The authentication challenge expired. Start again.');
  return row;
}

function uniqueSlug(base, excludedId = null) {
  let candidate = base;
  let suffix = 2;
  const query = excludedId
    ? db.prepare('SELECT 1 FROM sites WHERE slug = ? AND id != ?')
    : db.prepare('SELECT 1 FROM sites WHERE slug = ?');
  while (excludedId ? query.get(candidate, excludedId) : query.get(candidate)) {
    candidate = `${base.slice(0, 54)}-${suffix++}`;
  }
  return candidate;
}

function checkPort(port, excludedId = null) {
  if (port === DASHBOARD_PORT) throw new Error(`Port ${port} is reserved by the SHAM dashboard.`);
  if ([EDGE_HTTP_PORT, EDGE_HTTPS_PORT].includes(port) && port > 0) throw new Error(`Port ${port} is reserved by the SHAM shared edge proxy.`);
  const row = excludedId
    ? db.prepare('SELECT id, name FROM sites WHERE port = ? AND id != ?').get(port, excludedId)
    : db.prepare('SELECT id, name FROM sites WHERE port = ?').get(port);
  if (row) throw new Error(`Port ${port} is already assigned to “${row.name}”.`);
}

function writeSiteConfig(id, config) {
  db.prepare(`
    UPDATE sites SET
      name = ?, slug = ?, bind_host = ?, port = ?, runtime_type = ?, entry_file = ?,
      node_entry = ?, install_dependencies = ?, minify = ?, obfuscate = ?, obfuscation_risk_acknowledged = ?, domain_only = ?, spa_fallback = ?,
      cache_seconds = ?, headers_json = ?, domain = ?, ssl_enabled = ?,
      cloudflare_enabled = ?, firewall_enabled = ?, firewall_json = ?, compression = ?, security_preset = ?, csp = ?,
      health_check_path = ?, health_check_interval = ?, restart_policy = ?, max_restarts = ?, memory_limit_mb = ?,
      max_connections = ?, edge_enabled = ?, runtime_isolation = ?, container_image = ?, cpu_limit = ?, pids_limit = ?,
      outbound_network = ?, anubis_enabled = ?, anubis_preset = ?, anubis_difficulty = ?, anubis_policy = ?,
      maintenance_enabled = ?, maintenance_html = ?, redirects_json = ?, error_pages_json = ?, cache_rules_json = ?,
      release_mode = ?, git_url = ?, git_branch = ?, preview_domain = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    config.name,
    config.slug,
    config.bind_host,
    config.port,
    config.runtime_type,
    config.entry_file,
    config.node_entry,
    Number(config.install_dependencies),
    Number(config.minify),
    Number(config.obfuscate),
    Number(config.obfuscation_risk_acknowledged),
    Number(config.domain_only),
    Number(config.spa_fallback),
    config.cache_seconds,
    JSON.stringify(config.headers || {}),
    config.domain,
    Number(config.ssl_enabled),
    Number(config.cloudflare_enabled),
    Number(config.firewall_enabled),
    JSON.stringify(config.firewall || {}),
    Number(config.compression),
    config.security_preset,
    config.csp,
    config.health_check_path,
    config.health_check_interval,
    config.restart_policy,
    config.max_restarts,
    config.memory_limit_mb,
    config.max_connections,
    Number(config.edge_enabled),
    config.runtime_isolation,
    config.container_image,
    config.cpu_limit,
    config.pids_limit,
    Number(config.outbound_network),
    Number(config.anubis_enabled),
    config.anubis_preset,
    config.anubis_difficulty,
    config.anubis_policy,
    Number(config.maintenance_enabled),
    config.maintenance_html,
    JSON.stringify(config.redirects || []),
    JSON.stringify(config.error_pages || {}),
    JSON.stringify(config.cache_rules || []),
    Number(config.release_mode),
    config.git_url,
    config.git_branch,
    config.preview_domain,
    id
  );
}

function requiredSiteFile(config) {
  return config.runtime_type === 'node' ? config.node_entry : config.entry_file;
}

function obfuscationWarning(report) {
  if (!report) return 'JavaScript obfuscation is enabled. Test the deployed site because static analysis cannot prove runtime compatibility.';
  if (report.warningCount || report.skippedFiles?.length) {
    return `JavaScript obfuscation is enabled. The compatibility report found ${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}${report.skippedFiles?.length ? ` and skipped ${report.skippedFiles.length} file(s)` : ''}. Review the report and test the deployed site.`;
  }
  return 'JavaScript obfuscation is enabled. No known risky patterns were found, but runtime compatibility still cannot be guaranteed; test the deployed site.';
}

async function safeObfuscationWarning(site) {
  try { return obfuscationWarning(await auditObfuscationCompatibility(site)); }
  catch (error) { return `JavaScript obfuscation is enabled, but SHAM could not complete the compatibility report: ${error.message}. Test the deployed site.`; }
}

function uploadParts(req) {
  const archive = req.files?.archive?.[0] || null;
  const files = req.files?.files || [];
  let relativePaths = [];
  if (req.body.relativePaths) {
    try { relativePaths = JSON.parse(req.body.relativePaths); }
    catch { throw new Error('Upload path manifest is not valid JSON.'); }
  }
  return { archive, files, relativePaths };
}

function siteRows() {
  return db.prepare(`
    SELECT sites.*, users.username AS created_by_username
    FROM sites
    LEFT JOIN users ON users.id = sites.created_by
    ORDER BY sites.created_at DESC, sites.id DESC
  `).all().map((row) => manager.decorate(hydrateSite(row)));
}

function getSiteOr404(req, res) {
  const site = manager.getSite(Number(req.params.id));
  if (!site) {
    res.status(404).json({ error: 'Site not found.' });
    return null;
  }
  return site;
}

function activeAdminCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count;
}

function integrationSettings() {
  return {
    cloudflareTokenConfigured: Boolean(getSecretSetting(db, 'cloudflare_api_token', '')),
    cloudflareZoneId: getSetting('cloudflare_zone_id', ''),
    cloudflareTargetIp: getSetting('cloudflare_target_ip', ''),
    certbotEmail: getSetting('certbot_email', '')
  };
}

function securitySettings() {
  let trustedKeys = [];
  try { trustedKeys = JSON.parse(getSetting('plugin_trusted_keys_json', '[]')); } catch { trustedKeys = []; }
  return {
    allowUnsignedPlugins: getSetting('allow_unsigned_plugins', '0') === '1',
    pluginTrustedKeys: Array.isArray(trustedKeys) ? trustedKeys : [],
    logRetentionDays: Number(getSetting('log_retention_days', '30')) || 30,
    visitorPrivacyMode: getSetting('visitor_privacy_mode', 'mask'),
    alertCpuPercent: Number(getSetting('alert_cpu_percent', '90')) || 90,
    alertEventLoopMs: Number(getSetting('alert_event_loop_ms', '250')) || 250,
    alertDiskPercent: Number(getSetting('alert_disk_percent', '90')) || 90,
    alertTrafficMultiplier: Number(getSetting('alert_traffic_multiplier', '5')) || 5,
    alertErrorPercent: Number(getSetting('alert_error_percent', '25')) || 25,
    masterKeyExternal: Boolean(process.env.SHAM_MASTER_KEY),
    edge: edgeProxy.status()
  };
}

function integerSetting(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return number;
}

function snapshotLabel(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 120);
}

async function stopRunningSitesOnPort(port) {
  const stopped = [];
  for (const row of db.prepare('SELECT id FROM sites WHERE port = ?').all(port)) {
    if (!manager.statusFor(row.id).running) continue;
    await manager.stop(row.id);
    stopped.push(row.id);
  }
  return stopped;
}

async function restoreEnabledSites(ids) {
  const warnings = [];
  for (const id of [...new Set(ids)]) {
    const site = manager.getSite(id);
    if (!site?.enabled || manager.statusFor(id).running) continue;
    try { await manager.start(id); }
    catch (error) {
      const warning = `Site ${id} could not be restored after the certificate operation: ${error.message}`;
      warnings.push(warning);
      manager.log(id, 'error', warning);
    }
  }
  return warnings;
}

const CLOUDFLARE_HTTP_PORTS = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);
const CLOUDFLARE_HTTPS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);

function cloudflarePortWarning(site) {
  if (site.edge_enabled && ((site.ssl_enabled && EDGE_HTTPS_PORT > 0) || (!site.ssl_enabled && EDGE_HTTP_PORT > 0))) return null;
  const supported = site.ssl_enabled ? CLOUDFLARE_HTTPS_PORTS : CLOUDFLARE_HTTP_PORTS;
  if (supported.has(Number(site.port))) return null;
  const protocol = site.ssl_enabled ? 'HTTPS' : 'HTTP';
  return `The DNS record is proxied, but port ${site.port} is not a standard Cloudflare ${protocol} proxy port. Use a supported port or place a reverse proxy on 80/443 before relying on proxied traffic.`;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/bootstrap', optionalAuth, (req, res) => {
  const count = userCount();
  res.json({
    needsSetup: count === 0,
    registrationEnabled: count === 0 || registrationEnabled(),
    authenticated: Boolean(req.user),
    user: publicUser(req.user ? securityUser(req.user.id) : null),
    locale: getSetting('instance_locale', 'en'),
    setupCompleted: req.user?.role !== 'admin' || getSetting('setup_completed', '0') === '1'
  });
});

app.get('/api/public/status', (_req, res) => {
  if (getSetting('public_status_enabled', '0') !== '1') return res.status(404).json({ error: 'Public status page is disabled.' });
  const sites = db.prepare("SELECT id, name FROM sites WHERE enabled = 1 ORDER BY name COLLATE NOCASE").all().map((site) => {
    const runtime = manager.statusFor(site.id);
    return { name: site.name, status: runtime.running && runtime.health?.status !== 'unhealthy' ? runtime.health?.status || 'online' : 'offline' };
  });
  res.json({ title: getSetting('public_status_title', 'SHAM service status'), generatedAt: new Date().toISOString(), sites });
});

app.get('/status', (_req, res) => {
  if (getSetting('public_status_enabled', '0') !== '1') return res.status(404).type('text/plain').send('Status page is disabled.');
  const title = getSetting('public_status_title', 'SHAM service status');
  const escapeStatusHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const safeTitle = escapeStatusHtml(title);
  const generatedDate = new Date();
  const generatedAt = generatedDate.toISOString();
  const generatedLabel = new Intl.DateTimeFormat('en', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short'
  }).format(generatedDate);
  const statusLabels = { healthy: 'Healthy', online: 'Online', degraded: 'Degraded', starting: 'Starting', offline: 'Offline' };
  const sites = db.prepare("SELECT id, name FROM sites WHERE enabled = 1 ORDER BY name COLLATE NOCASE").all().map((site) => {
    const runtime = manager.statusFor(site.id);
    const runtimeStatus = runtime.running && runtime.health?.status !== 'unhealthy' ? runtime.health?.status || 'online' : 'offline';
    const status = Object.hasOwn(statusLabels, runtimeStatus) ? runtimeStatus : 'offline';
    return `<article class="status-card"><span class="status-indicator ${status}" aria-hidden="true"></span><div><strong>${escapeStatusHtml(site.name)}</strong><small>${statusLabels[status]}</small></div></article>`;
  }).join('');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="en" class="status-document"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0c0717"><title>${safeTitle}</title><script src="/theme-init.js"></script><link rel="stylesheet" href="/styles.css"></head><body class="status-page"><main class="status-shell"><header class="status-header"><p class="eyebrow">SHAM public status</p><h1>${safeTitle}</h1><p class="muted">Updated <time datetime="${generatedAt}">${generatedLabel}</time></p></header><section class="status-list" aria-label="Service status">${sites || '<article class="status-card empty"><div><strong>No public services</strong><small>No enabled sites are currently listed.</small></div></article>'}</section></main></body></html>`);
});

app.get('/metrics', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (getSetting('prometheus_enabled', '0') !== '1') return res.status(404).type('text/plain').send('Metrics are disabled.');
  const expected = getSecretSetting(db, 'prometheus_token', '');
  if (!expected) return res.status(503).type('text/plain').send('Metrics token is not configured.');
  const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="SHAM metrics"');
    return res.status(401).type('text/plain').send('Unauthorized');
  }
  res.type('text/plain; version=0.0.4').send(operationsManager.metricsText(performanceMonitor.payload()));
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const { salt, hash } = await hashPassword(req.body.password);
    const createUser = db.transaction(() => {
      const count = userCount();
      if (count > 0 && !registrationEnabled()) throw new Error('Registration is currently locked.');
      const role = count === 0 ? 'admin' : 'user';
      const result = db.prepare(`
        INSERT INTO users (username, password_hash, password_salt, role)
        VALUES (?, ?, ?, ?)
      `).run(username, hash, salt, role);
      if (count === 0) setSetting('registration_enabled', '0');
      return db.prepare('SELECT id, username, role, active, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    });
    const user = createUser();
    setAuthCookie(req, res, issueToken(user));
    recordAudit(user.id, 'auth.register', { role: user.role });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    const duplicate = String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE');
    res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'That username is already in use.' : error.message });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const user = db.prepare(`SELECT users.*, (SELECT COUNT(*) FROM passkeys WHERE user_id = users.id) AS passkey_count FROM users WHERE username = ? COLLATE NOCASE`).get(username);
  const suppliedPassword = typeof req.body.password === 'string' && req.body.password.length <= 200 ? req.body.password : '';
  const valid = await verifyPassword(
    suppliedPassword,
    user?.password_salt || '00000000000000000000000000000000',
    user?.password_hash || '00'.repeat(64)
  );
  if (!user || !user.active || !valid) return res.status(401).json({ error: 'Invalid username or password.' });
  const methods = [];
  if (user.totp_enabled) methods.push('totp', 'recovery');
  if (user.passkey_count > 0) methods.push('passkey');
  if (methods.length) {
    recordAudit(user.id, 'auth.password.accepted', { mfa: true });
    return res.json({ mfaRequired: true, mfaToken: issueMfaToken(user), methods, username: user.username });
  }
  setAuthCookie(req, res, issueToken(user));
  recordAudit(user.id, 'auth.login');
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login/totp', authLimiter, (req, res) => {
  const user = verifyMfaToken(req.body.mfaToken);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'The multi-factor login session expired.' });
  const code = String(req.body.code || '');
  const valid = verifyTotp(userTotpSecret(user), code) || consumeRecoveryCode(db, user.id, code);
  if (!valid) return res.status(401).json({ error: 'The verification code is not valid.' });
  const hydrated = securityUser(user.id);
  setAuthCookie(req, res, issueToken(hydrated));
  recordAudit(user.id, 'auth.mfa.totp');
  res.json({ user: publicUser(hydrated) });
});

app.post('/api/auth/login/passkey/options', authLimiter, (req, res) => {
  const user = verifyMfaToken(req.body.mfaToken);
  if (!user) return res.status(401).json({ error: 'The multi-factor login session expired.' });
  const credentials = db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY id').all(user.id);
  if (!credentials.length) return res.status(400).json({ error: 'No passkey is registered for this account.' });
  const options = assertionOptions({ credentials });
  options.rpId = requestRpId(req);
  const challengeId = createChallenge(user.id, 'login', options.challenge, options.rpId, requestOrigin(req));
  res.json({ challengeId, options });
});

app.post('/api/auth/login/passkey/verify', authLimiter, (req, res) => {
  try {
    const user = verifyMfaToken(req.body.mfaToken);
    if (!user) return res.status(401).json({ error: 'The multi-factor login session expired.' });
    const challenge = consumeChallenge(req.body.challengeId, user.id, 'login');
    const credential = db.prepare('SELECT * FROM passkeys WHERE user_id = ? AND credential_id = ?').get(user.id, String(req.body.credential?.id || ''));
    if (!credential) throw new Error('Passkey is not registered for this account.');
    const result = verifyAssertion({ response: req.body.credential, credential, challenge: challenge.challenge, rpId: challenge.rp_id, origins: [challenge.origin] });
    db.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(result.signCount, credential.id);
    const hydrated = securityUser(user.id);
    setAuthCookie(req, res, issueToken(hydrated));
    recordAudit(user.id, 'auth.mfa.passkey', { passkeyId: credential.id });
    res.json({ user: publicUser(hydrated) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/auth/logout', optionalAuth, (req, res) => {
  if (req.user) recordAudit(req.user.id, 'auth.logout');
  clearAuthCookie(req, res);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(securityUser(req.user.id)) }));


app.get('/api/security', requireAuth, (req, res) => {
  const user = securityUser(req.user.id);
  const passkeys = db.prepare('SELECT id, name, transports_json, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id').all(req.user.id).map((row) => ({
    id: row.id, name: row.name, transports: (() => { try { return JSON.parse(row.transports_json); } catch { return []; } })(), createdAt: row.created_at, lastUsedAt: row.last_used_at
  }));
  res.json({ user: publicUser(user), passkeys, recoveryCodesRemaining: (() => { try { return JSON.parse(user.recovery_codes_json || '[]').length; } catch { return 0; } })(), webauthnAvailable: true });
});

app.post('/api/security/totp/setup', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const suppliedPassword = typeof req.body.password === 'string' && req.body.password.length <= 200 ? req.body.password : '';
  if (!(await verifyPassword(suppliedPassword, user.password_salt, user.password_hash))) {
    return res.status(401).json({ error: 'Password confirmation failed.' });
  }
  const setup = generateTotpSetup(req.user.username);
  const id = createChallenge(req.user.id, 'totp-setup', require('./secret-store').encrypt(setup.secret), '-', requestOrigin(req), 10 * 60_000);
  res.json({ setupId: id, secret: setup.secret, otpauthUrl: setup.url });
});

app.post('/api/security/totp/enable', requireAuth, (req, res) => {
  try {
    const challenge = consumeChallenge(req.body.setupId, req.user.id, 'totp-setup');
    const secret = require('./secret-store').decrypt(challenge.challenge);
    if (!verifyTotp(secret, req.body.code)) throw new Error('The authenticator code did not match. Check the device clock and try again.');
    const recoveryCodes = generateRecoveryCodes();
    enableTotp(db, req.user.id, secret, recoveryCodes);
    recordAudit(req.user.id, 'security.totp.enable');
    res.json({ user: publicUser(securityUser(req.user.id)), recoveryCodes });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/security/totp/disable', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(req.body.password || ''), user.password_salt, user.password_hash))) return res.status(401).json({ error: 'Password confirmation failed.' });
  disableTotp(db, req.user.id);
  recordAudit(req.user.id, 'security.totp.disable');
  res.json({ user: publicUser(securityUser(req.user.id)) });
});

app.post('/api/security/recovery-codes/regenerate', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(req.body.password || ''), user.password_salt, user.password_hash))) return res.status(401).json({ error: 'Password confirmation failed.' });
  if (!user.totp_enabled) return res.status(400).json({ error: 'Enable TOTP before generating recovery codes.' });
  const codes = generateRecoveryCodes();
  db.prepare('UPDATE users SET recovery_codes_json = ? WHERE id = ?').run(JSON.stringify(codes.map(require('./mfa').hashRecoveryCode)), req.user.id);
  recordAudit(req.user.id, 'security.recovery.regenerate');
  res.json({ recoveryCodes: codes });
});

app.post('/api/security/passkeys/options', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const suppliedPassword = typeof req.body.password === 'string' && req.body.password.length <= 200 ? req.body.password : '';
  if (!(await verifyPassword(suppliedPassword, user.password_salt, user.password_hash))) {
    return res.status(401).json({ error: 'Password confirmation failed.' });
  }
  const existing = db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(req.user.id).map((row) => row.credential_id);
  const rpId = requestRpId(req);
  const options = registrationOptions({ user: req.user, rpId, existing });
  const challengeId = createChallenge(req.user.id, 'register', options.challenge, rpId, requestOrigin(req));
  res.json({ challengeId, options });
});

app.post('/api/security/passkeys/register', requireAuth, (req, res) => {
  try {
    const challenge = consumeChallenge(req.body.challengeId, req.user.id, 'register');
    const result = verifyRegistration({ response: req.body.credential, challenge: challenge.challenge, rpId: challenge.rp_id, origins: [challenge.origin] });
    const name = String(req.body.name || 'Passkey').trim().slice(0, 100) || 'Passkey';
    db.prepare('INSERT INTO passkeys (user_id, credential_id, public_key_jwk, algorithm, sign_count, transports_json, name) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, result.credentialId, JSON.stringify(result.publicKeyJwk), result.publicKeyJwk.alg, result.signCount, JSON.stringify(result.transports), name);
    recordAudit(req.user.id, 'security.passkey.add', { name });
    res.status(201).json({ passkeys: db.prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY id').all(req.user.id) });
  } catch (error) {
    const duplicate = String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE');
    res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'That passkey is already registered.' : error.message });
  }
});

app.delete('/api/security/passkeys/:id', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(req.body.password || ''), user.password_salt, user.password_hash))) return res.status(401).json({ error: 'Password confirmation failed.' });
  const result = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Passkey not found.' });
  recordAudit(req.user.id, 'security.passkey.delete', { id: Number(req.params.id) });
  res.status(204).end();
});

app.use(['/api/sites/:id', '/api/admin/sites/:id'], requireAuth, serializeSiteMutation);

app.get('/api/sites', requireAuth, (_req, res) => res.json({ sites: siteRows() }));

app.get('/api/statistics', requireAuth, (_req, res) => {
  try { manager.flushStats(); } catch (error) { manager.log(null, 'error', `Could not flush statistics before reading them: ${error.message}`); }
  const totals = db.prepare(`
    SELECT
      COUNT(sites.id) AS sites,
      COALESCE(SUM(site_stats.total_requests), 0) AS requests,
      COALESCE(SUM(site_stats.total_bytes), 0) AS bytes,
      COALESCE(SUM(site_stats.total_errors), 0) AS errors,
      COALESCE(SUM(site_stats.total_response_ms), 0) AS response_ms,
      (SELECT COUNT(DISTINCT ip) FROM site_visitor_stats) AS visitors
    FROM sites
    LEFT JOIN site_stats ON site_stats.site_id = sites.id
  `).get();
  const sites = db.prepare(`
    SELECT sites.id, sites.name, sites.runtime_type, sites.enabled,
      COALESCE(site_stats.total_requests, 0) AS requests,
      COALESCE(site_stats.total_bytes, 0) AS bytes,
      COALESCE(site_stats.total_errors, 0) AS errors,
      COALESCE(site_stats.total_response_ms, 0) AS response_ms,
      site_stats.last_request_at
    FROM sites
    LEFT JOIN site_stats ON site_stats.site_id = sites.id
    ORDER BY requests DESC, sites.name COLLATE NOCASE
  `).all().map((row) => ({ ...row, enabled: Boolean(row.enabled), running: manager.statusFor(row.id).running }));
  const daily = db.prepare(`
    SELECT day, SUM(requests) AS requests, SUM(bytes) AS bytes, SUM(errors) AS errors
    FROM site_daily_stats
    WHERE day >= date('now', '-13 days')
    GROUP BY day
    ORDER BY day
  `).all();
  const countries = db.prepare(`
    SELECT country, SUM(requests) AS requests, SUM(bytes) AS bytes,
      COUNT(DISTINCT ip) AS visitors, MAX(last_request_at) AS last_request_at
    FROM site_visitor_stats
    GROUP BY country
    ORDER BY requests DESC, country
    LIMIT 100
  `).all();
  const visitors = db.prepare(`
    SELECT visitor.site_id, sites.name AS site_name, visitor.ip, visitor.country,
      visitor.requests, visitor.bytes, visitor.errors, visitor.last_request_at
    FROM site_visitor_stats AS visitor
    JOIN sites ON sites.id = visitor.site_id
    ORDER BY visitor.last_request_at DESC
    LIMIT 100
  `).all();
  res.json({ totals: { ...totals, running: manager.running.size }, sites, daily, countries, visitors });
});

app.get('/api/performance', requireAuth, async (req, res) => {
  try {
    if (bool(req.query.refresh, false)) await performanceMonitor.runSample();
    res.json(performanceMonitor.payload());
  } catch (error) {
    res.status(503).json({ error: `Performance sample failed: ${error.message}` });
  }
});

app.post('/api/performance/alerts/:id/acknowledge', requireAuth, (req, res) => {
  if (!performanceMonitor.acknowledge(Number(req.params.id))) return res.status(404).json({ error: 'Active alert not found.' });
  recordAudit(req.user.id, 'alert.acknowledge', { id: Number(req.params.id) });
  res.status(204).end();
});

app.get('/api/runtime-logs', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
  const siteId = Number(req.query.siteId);
  const rows = Number.isSafeInteger(siteId) && siteId > 0
    ? db.prepare('SELECT id, site_id AS siteId, level, message, context_json AS contextJson, created_at AS createdAt FROM runtime_logs WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(siteId, limit)
    : db.prepare('SELECT id, site_id AS siteId, level, message, context_json AS contextJson, created_at AS createdAt FROM runtime_logs ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ logs: rows.map((row) => ({ ...row, context: (() => { try { return JSON.parse(row.contextJson || 'null'); } catch { return null; } })(), contextJson: undefined })) });
});

app.get('/api/admin/logs/export', requireAuth, requireAdmin, (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'ndjson';
  const rows = db.prepare('SELECT id, site_id AS siteId, level, message, context_json AS contextJson, created_at AS createdAt FROM runtime_logs ORDER BY id DESC LIMIT 10000').all().map((row) => ({
    id: row.id, siteId: row.siteId, level: row.level, message: row.message,
    context: (() => { try { return JSON.parse(row.contextJson || 'null'); } catch { return null; } })(), createdAt: row.createdAt
  }));
  res.setHeader('Content-Disposition', `attachment; filename="sham-runtime-logs.${format === 'json' ? 'json' : 'ndjson'}"`);
  if (format === 'json') return res.type('application/json').send(JSON.stringify(rows, null, 2));
  res.type('application/x-ndjson').send(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
});

app.post('/api/sites', requireAuth, uploadSizeGuard, multipart(receiveWebsite), async (req, res) => {
  let destination = null;
  let createdId = null;
  try {
    const config = validateSiteInput(req.body);
    checkPort(config.port);
    if (config.ssl_enabled && (!config.domain || !hasCertificate(config.domain))) {
      throw new Error('Issue a certificate before enabling SSL.');
    }
    config.slug = uniqueSlug(config.slug);
    const directoryName = `site-${crypto.randomUUID()}`;
    destination = path.join(SITES_DIR, directoryName);
    await installUploadAsync({
      ...uploadParts(req),
      destination,
      entryFile: requiredSiteFile(config),
      maxBytes: UPLOAD_LIMIT_BYTES
    });

    const result = db.prepare(`
      INSERT INTO sites (
        name, slug, directory_name, bind_host, port, runtime_type, entry_file,
        node_entry, install_dependencies, minify, obfuscate, obfuscation_risk_acknowledged, domain_only, spa_fallback, cache_seconds,
        headers_json, enabled, domain, ssl_enabled, cloudflare_enabled, firewall_enabled, firewall_json,
        compression, security_preset, csp, health_check_path, health_check_interval, restart_policy, max_restarts,
        memory_limit_mb, max_connections, edge_enabled, runtime_isolation, container_image, cpu_limit, pids_limit,
        outbound_network, anubis_enabled, anubis_preset, anubis_difficulty, anubis_policy,
        maintenance_enabled, maintenance_html, redirects_json, error_pages_json, cache_rules_json,
        release_mode, git_url, git_branch, preview_domain, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.name,
      config.slug,
      directoryName,
      config.bind_host,
      config.port,
      config.runtime_type,
      config.entry_file,
      config.node_entry,
      Number(config.install_dependencies),
      Number(config.minify),
      Number(config.obfuscate),
      Number(config.obfuscation_risk_acknowledged),
      Number(config.domain_only),
      Number(config.spa_fallback),
      config.cache_seconds,
      JSON.stringify(config.headers),
      config.domain,
      Number(config.ssl_enabled),
      Number(config.cloudflare_enabled),
      Number(config.firewall_enabled),
      JSON.stringify(config.firewall),
      Number(config.compression),
      config.security_preset,
      config.csp,
      config.health_check_path,
      config.health_check_interval,
      config.restart_policy,
      config.max_restarts,
      config.memory_limit_mb,
      config.max_connections,
      Number(config.edge_enabled),
      config.runtime_isolation,
      config.container_image,
      config.cpu_limit,
      config.pids_limit,
      Number(config.outbound_network),
      Number(config.anubis_enabled),
      config.anubis_preset,
      config.anubis_difficulty,
      config.anubis_policy,
      Number(config.maintenance_enabled),
      config.maintenance_html,
      JSON.stringify(config.redirects || []),
      JSON.stringify(config.error_pages || {}),
      JSON.stringify(config.cache_rules || []),
      Number(config.release_mode),
      config.git_url,
      config.git_branch,
      config.preview_domain,
      req.user.id
    );

    const id = Number(result.lastInsertRowid);
    createdId = id;
    let warning = null;
    if (config.enabled) {
      try {
        await manager.start(id);
        try {
          db.prepare('UPDATE sites SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        } catch (error) {
          await manager.stop(id);
          throw new Error(`The runtime started, but SHAM could not persist its enabled state: ${error.message}`);
        }
      } catch (error) {
        warning = `Site was uploaded but could not be started: ${error.message}`;
      }
    }
    if (config.obfuscate) {
      const compatibilityWarning = await safeObfuscationWarning(manager.getSite(id));
      warning = [warning, compatibilityWarning].filter(Boolean).join(' ');
    }
    recordAudit(req.user.id, 'site.create', { id, name: config.name, port: config.port, runtime: config.runtime_type });
    res.status(201).json({ site: manager.decorate(manager.getSite(id)), warning });
  } catch (error) {
    if (createdId) {
      try { await manager.stop(createdId); } catch { /* Best-effort cleanup. */ }
      try { db.prepare('DELETE FROM sites WHERE id = ?').run(createdId); }
      catch (cleanupError) { manager.log(createdId, 'error', `Could not roll back failed site creation: ${cleanupError.message}`); }
      manager.forgetSite(createdId);
    }
    if (destination) {
      try { await fs.promises.rm(destination, { recursive: true, force: true }); }
      catch (cleanupError) { manager.log(createdId, 'error', `Could not remove failed site upload: ${cleanupError.message}`); }
    }
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/sites/:id', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const wasRunning = manager.statusFor(site.id).running;
  try {
    const config = validateSiteInput(req.body, site);
    checkPort(config.port, site.id);
    config.slug = uniqueSlug(config.slug, site.id);
    const domainChanged = config.domain !== site.domain;
    if (domainChanged) config.cloudflare_enabled = false;
    if (config.ssl_enabled && (!config.domain || !hasCertificate(config.domain))) {
      throw new Error('Issue a certificate before enabling SSL.');
    }
    const required = requiredSiteFile(config);
    const entryPath = path.join(SITES_DIR, site.directory_name, ...required.split('/'));
    if (!realFileInside(path.join(SITES_DIR, site.directory_name), entryPath)) {
      throw new Error(`Required file “${required}” does not exist in this website.`);
    }

    writeSiteConfig(site.id, config);
    try {
      if (wasRunning) await manager.restart(site.id);
      else if (site.enabled) await manager.start(site.id);
    } catch (restartError) {
      writeSiteConfig(site.id, site);
      await manager.stop(site.id);
      let rollbackError = null;
      if (wasRunning || site.enabled) {
        try { await manager.start(site); } catch (error) { rollbackError = error; }
      }
      const suffix = rollbackError ? ` The previous runtime also failed to recover: ${rollbackError.message}` : '';
      throw new Error(`The new settings could not be applied and were rolled back: ${restartError.message}.${suffix}`);
    }

    recordAudit(req.user.id, 'site.update', { id: site.id });
    const updated = manager.getSite(site.id);
    const warnings = [];
    if (domainChanged && site.cloudflare_enabled) {
      warnings.push('The domain changed, so SHAM marked Cloudflare DNS as unsynchronized. Sync the new hostname and remove any obsolete external DNS record if it is no longer needed.');
    }
    const portWarning = updated.cloudflare_enabled ? cloudflarePortWarning(updated) : null;
    if (portWarning) warnings.push(portWarning);
    if (updated.obfuscate && !site.obfuscate) warnings.push(await safeObfuscationWarning(updated));
    res.json({ site: manager.decorate(updated), warning: warnings.join(' ') || null });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/sites/:id/toggle', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const enabled = bool(req.body.enabled, !site.enabled);
  try {
    if (enabled) {
      await manager.start(site.id);
      try {
        db.prepare('UPDATE sites SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
      } catch (error) {
        await manager.stop(site.id);
        throw new Error(`The site started, but SHAM could not persist its enabled state: ${error.message}`);
      }
    } else {
      const wasRunning = manager.statusFor(site.id).running;
      await manager.stop(site.id);
      try {
        db.prepare('UPDATE sites SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
      } catch (error) {
        if (wasRunning) {
          try { await manager.start(site); }
          catch (restoreError) { throw new Error(`SHAM could not persist the stopped state, and the site could not be restored: ${error.message}; ${restoreError.message}`); }
        }
        throw new Error(`The site was stopped, but SHAM could not persist its disabled state: ${error.message}`);
      }
    }
    recordAudit(req.user.id, enabled ? 'site.start' : 'site.stop', { id: site.id });
    res.json({ site: manager.decorate(manager.getSite(site.id)) });
  } catch (error) {
    res.status(409).json({ error: error.message, site: manager.decorate(manager.getSite(site.id)) });
  }
});

app.post('/api/sites/:id/restart', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const wasRunning = manager.statusFor(site.id).running;
  try {
    await manager.restart(site.id);
    try {
      db.prepare('UPDATE sites SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
    } catch (error) {
      if (!wasRunning) await manager.stop(site.id);
      throw new Error(`The site restarted, but SHAM could not persist its enabled state: ${error.message}`);
    }
    recordAudit(req.user.id, 'site.restart', { id: site.id });
    res.json({ site: manager.decorate(manager.getSite(site.id)) });
  } catch (error) {
    res.status(409).json({ error: error.message, site: manager.decorate(manager.getSite(site.id)) });
  }
});

app.post('/api/sites/:id/npm-install', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const wasRunning = manager.statusFor(site.id).running;
  let rollbackSnapshot = null;
  try {
    rollbackSnapshot = await snapshotManager.create(site, 'Automatic pre-npm-install rollback');
    if (wasRunning) await manager.stop(site.id);
    try {
      await manager.runInstall(site);
    } catch (error) {
      if (wasRunning && !manager.statusFor(site.id).running) {
        try { await manager.start(site.id); } catch { /* Preserve the install error. */ }
      }
      throw error;
    }

    let warning = null;
    if (wasRunning || site.enabled) {
      try { await manager.start(site.id); }
      catch (error) {
        warning = `Dependencies were installed, but the site could not restart: ${error.message}`;
        manager.log(site.id, 'error', warning);
      }
    }
    recordAudit(req.user.id, 'site.npm.install', { id: site.id, restartWarning: Boolean(warning) });
    res.json({ site: manager.decorate(manager.getSite(site.id)), message: 'npm install completed.', warning, rollbackSnapshot });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/sites/:id/content', requireAuth, uploadSizeGuard, multipart(receiveWebsite), async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const wasRunning = manager.statusFor(site.id).running;
  let rollbackSnapshot = null;
  try {
    rollbackSnapshot = await snapshotManager.create(site, 'Automatic pre-content-replacement rollback');
    if (wasRunning) await manager.stop(site.id);
    await installUploadAsync({
      ...uploadParts(req),
      destination: path.join(SITES_DIR, site.directory_name),
      entryFile: requiredSiteFile(site),
      maxBytes: UPLOAD_LIMIT_BYTES
    });
    let warning = null;
    if (wasRunning || site.enabled) {
      try { await manager.start(site.id); }
      catch (error) {
        warning = `Content was replaced, but the site could not restart: ${error.message}`;
        manager.log(site.id, 'error', warning);
      }
    }
    if (site.obfuscate) {
      const compatibilityWarning = await safeObfuscationWarning(manager.getSite(site.id));
      warning = [warning, compatibilityWarning].filter(Boolean).join(' ');
    }
    recordAudit(req.user.id, 'site.content.replace', { id: site.id });
    res.json({ site: manager.decorate(manager.getSite(site.id)), warning, rollbackSnapshot });
  } catch (error) {
    if (wasRunning && !manager.statusFor(site.id).running) {
      try { await manager.start(site.id); } catch { /* Original error is more useful. */ }
    }
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/sites/:id/obfuscation-report', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { res.json({ report: await auditObfuscationCompatibility(site) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/sites/:id/files', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { res.json({ files: await listSiteFilesAsync(site) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/sites/:id/files/content', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { res.json(await readTextFileAsync(site, req.query.path)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/sites/:id/files/content', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    const result = await writeTextFileAsync(site, req.body.path, req.body.content);
    recordAudit(req.user.id, 'site.file.write', { id: site.id, path: result.path, size: result.size });
    res.json({ file: result, restartRecommended: site.runtime_type === 'node' && manager.statusFor(site.id).running });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/sites/:id/files/upload', requireAuth, uploadSizeGuard, multipart(receiveSingleFile), async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    if (!req.file) throw new Error('Choose one file to upload.');
    const destination = req.body.path || req.file.originalname;
    const result = await replaceSingleFileFromPathAsync(site, destination, req.file.path, req.file.size);
    recordAudit(req.user.id, 'site.file.replace', { id: site.id, path: result.path, size: result.size });
    res.json({ file: result, restartRecommended: site.runtime_type === 'node' && manager.statusFor(site.id).running });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/sites/:id/files', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const wasRunning = manager.statusFor(site.id).running;
  let stagedDeletion = null;
  let rollbackSnapshot = null;
  try {
    const relative = safeRelativePath(req.query.path, 'File path');
    const critical = relative === requiredSiteFile(site);
    if (critical) rollbackSnapshot = await snapshotManager.create(site, 'Automatic pre-entry-file-deletion rollback');
    if (critical && wasRunning) await manager.stop(site.id);
    if (critical) {
      stagedDeletion = await stageSingleFileDeletionAsync(site, relative);
      try {
        db.prepare('UPDATE sites SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
      } catch (error) {
        await stagedDeletion.rollback();
        stagedDeletion = null;
        throw new Error(`The file was preserved because SHAM could not persist the disabled state: ${error.message}`);
      }
      await stagedDeletion.commit();
      stagedDeletion = null;
    } else {
      await deleteSingleFileAsync(site, relative);
    }
    recordAudit(req.user.id, 'site.file.delete', { id: site.id, path: relative, critical });
    res.json({ deleted: relative, warning: critical ? 'The required runtime file was deleted, so the site was stopped and disabled. An automatic rollback snapshot was retained.' : null, rollbackSnapshot });
  } catch (error) {
    if (stagedDeletion) {
      try { await stagedDeletion.rollback(); } catch (rollbackError) { manager.log(site.id, 'error', `Could not restore the staged file deletion: ${rollbackError.message}`); }
    }
    if (wasRunning && site.enabled && !manager.statusFor(site.id).running) {
      try { await manager.start(site.id); } catch { /* Preserve the original file error. */ }
    }
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/sites/:id', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const wasRunning = manager.statusFor(site.id).running;
  const root = path.join(SITES_DIR, site.directory_name);
  const trash = `${root}.delete-${crypto.randomUUID()}`;
  let filesStaged = false;
  try {
    await manager.stop(site.id);
    manager.flushStats();
    manager.flushRuntimeLogs();
    try {
      await fs.promises.rename(root, trash);
      filesStaged = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
    manager.forgetSite(site.id);
    if (filesStaged) {
      fs.rm(trash, { recursive: true, force: true }, (cleanupError) => {
        if (cleanupError) manager.log(null, 'error', `Could not remove deleted site data for ${site.name}: ${cleanupError.message}`, { deletedSiteId: site.id });
      });
    }
    recordAudit(req.user.id, 'site.delete', { id: site.id, name: site.name });
    res.status(204).end();
  } catch (error) {
    if (filesStaged) {
      try { await fs.promises.rename(trash, root); }
      catch (restoreError) { manager.log(site.id, 'error', `Could not restore site files after a failed deletion: ${restoreError.message}`); }
    }
    if (wasRunning && !manager.statusFor(site.id).running && manager.getSite(site.id)) {
      try { await manager.start(site); }
      catch (restoreError) { manager.log(site.id, 'error', `Could not restore site runtime after a failed deletion: ${restoreError.message}`); }
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sites/:id/dependency-scan', requireAuth, (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  res.json({ result: dependencyScanner.latest(site.id) });
});

app.post('/api/sites/:id/dependency-scan', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    if (site.runtime_type !== 'node') throw new Error('Dependency scanning is available for Node.js sites only.');
    const result = await dependencyScanner.scan(site);
    recordAudit(req.user.id, 'site.dependencies.scan', { id: site.id, vulnerabilities: result.vulnerabilities?.total || 0 });
    res.json({ result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/sites/:id/snapshots', requireAuth, (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  res.json({ snapshots: snapshotManager.list(site.id) });
});

app.post('/api/sites/:id/snapshots', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    const snapshot = await snapshotManager.create(site, snapshotLabel(req.body.label, 'Manual snapshot'));
    recordAudit(req.user.id, 'site.snapshot.create', { id: site.id, snapshotId: snapshot.id });
    res.status(201).json({ snapshot });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/sites/:id/snapshots/:snapshotId/restore', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const wasRunning = manager.statusFor(site.id).running;
  let rollbackSnapshot = null;
  try {
    rollbackSnapshot = await snapshotManager.create(site, 'Automatic pre-restore rollback');
    if (wasRunning) await manager.stop(site.id);
    const restoreResult = await snapshotManager.restore(site, Number(req.params.snapshotId));
    if (wasRunning || site.enabled) await manager.start(site.id);
    manager.invalidateSiteCache?.(site.id);
    recordAudit(req.user.id, 'site.snapshot.restore', { id: site.id, snapshotId: Number(req.params.snapshotId), rollbackSnapshotId: rollbackSnapshot.id });
    res.json({ site: manager.decorate(manager.getSite(site.id)), rollbackSnapshot, warning: restoreResult?.warning || null });
  } catch (error) {
    let rollbackError = null;
    if (rollbackSnapshot) {
      try {
        await manager.stop(site.id);
        await snapshotManager.restore(site, rollbackSnapshot.id);
        if (wasRunning || site.enabled) await manager.start(site.id);
      } catch (restoreError) { rollbackError = restoreError; }
    }
    const suffix = rollbackError ? ` Automatic rollback also failed: ${rollbackError.message}` : '';
    res.status(409).json({ error: `${error.message}${suffix}` });
  }
});

app.delete('/api/sites/:id/snapshots/:snapshotId', requireAuth, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    await snapshotManager.delete(site.id, Number(req.params.snapshotId));
    recordAudit(req.user.id, 'site.snapshot.delete', { id: site.id, snapshotId: Number(req.params.snapshotId) });
    res.status(204).end();
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/runtime-events', requireAuth, (req, res) => {
  res.json({ events: manager.listEvents(Number(req.query.limit) || 100) });
});

app.use('/api/admin/plugins', requireAuth, requireAdmin, serializePluginMutation);

app.get('/api/plugins', requireAuth, (req, res) => res.json({
  plugins: pluginManager.list()
}));

app.get('/api/plugins/:id/client.js', requireAuth, async (req, res) => {
  try {
    res.type('application/javascript').send(await pluginManager.clientScript(req.params.id));
  } catch (error) { res.status(404).type('application/javascript').send(`console.error(${JSON.stringify(error.message)});`); }
});

app.all('/api/plugins/:id/actions/:action', requireAuth, async (req, res) => {
  try {
    const result = await pluginManager.handleApi(req.params.id, req.params.action, {
      body: req.body,
      query: req.query,
      user: publicUser(req.user),
      method: req.method
    });
    if (result && typeof result === 'object' && Number.isInteger(result.status) && Object.hasOwn(result, 'body')) {
      return res.status(result.status).json(result.body);
    }
    res.json(result ?? { ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/admin/plugins', requireAuth, requireAdmin, multipart(pluginUpload.single('plugin')), async (req, res) => {
  try {
    if (!req.file) throw new Error('Choose a plugin ZIP archive.');
    await validatePluginArchiveFile(req.file.path, req.file.originalname);
    const plugin = await pluginManager.installAsync(req.file.path, { allowUnsigned: bool(req.body.allowUnsigned, false) });
    recordAudit(req.user.id, 'plugin.install', { id: plugin.id, type: plugin.type });
    res.status(201).json({ plugin });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/admin/plugins/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  try {
    const plugin = await pluginManager.toggle(req.params.id, bool(req.body.enabled, false));
    recordAudit(req.user.id, 'plugin.toggle', { id: plugin.id, enabled: plugin.enabled });
    res.json({ plugin });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/admin/plugins/:id/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    pluginManager.setSettings(req.params.id, req.body.settings || {}, { clearSecrets: req.body.clearSecrets || [] });
    const plugin = pluginManager.list().find((item) => item.id === req.params.id);
    recordAudit(req.user.id, 'plugin.settings', { id: req.params.id });
    res.json({ settings: plugin?.settings || {}, secretConfigured: plugin?.secretConfigured || {} });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/admin/plugins/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pluginManager.delete(req.params.id);
    recordAudit(req.user.id, 'plugin.delete', { id: req.params.id });
    res.status(204).end();
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/admin/settings', requireAuth, requireAdmin, (_req, res) => {
  res.json({ registrationEnabled: registrationEnabled(), integrations: integrationSettings(), security: securitySettings() });
});

app.put('/api/admin/settings/security', requireAuth, requireAdmin, (req, res) => {
  try {
    const privacy = String(req.body.visitorPrivacyMode || 'mask');
    if (!['none', 'mask', 'hash'].includes(privacy)) throw new Error('Visitor privacy mode is invalid.');
    let trustedKeys = req.body.pluginTrustedKeys;
    if (typeof trustedKeys === 'string') {
      try { trustedKeys = JSON.parse(trustedKeys || '[]'); } catch { throw new Error('Trusted plugin keys must be valid JSON.'); }
    }
    if (!Array.isArray(trustedKeys) || trustedKeys.length > 100) throw new Error('Trusted plugin keys must be a JSON array with at most 100 entries.');
    for (const entry of trustedKeys) {
      if (!entry || typeof entry !== 'object' || !String(entry.id || '').trim() || !String(entry.publicKey || '').includes('PUBLIC KEY')) throw new Error('Each trusted key needs an id and a PEM publicKey.');
      try { crypto.createPublicKey(String(entry.publicKey)); } catch { throw new Error(`Trusted key “${String(entry.id)}” is not a valid public key.`); }
    }
    const values = {
      allow_unsigned_plugins: bool(req.body.allowUnsignedPlugins, false) ? '1' : '0',
      plugin_trusted_keys_json: JSON.stringify(trustedKeys),
      log_retention_days: String(integerSetting(req.body.logRetentionDays, 'Log retention', 1, 3650)),
      visitor_privacy_mode: privacy,
      alert_cpu_percent: String(integerSetting(req.body.alertCpuPercent, 'CPU alert threshold', 10, 1000)),
      alert_event_loop_ms: String(integerSetting(req.body.alertEventLoopMs, 'Event-loop alert threshold', 10, 10000)),
      alert_disk_percent: String(integerSetting(req.body.alertDiskPercent, 'Disk alert threshold', 10, 100)),
      alert_traffic_multiplier: String(Number(req.body.alertTrafficMultiplier) >= 2 && Number(req.body.alertTrafficMultiplier) <= 100 ? Number(req.body.alertTrafficMultiplier) : (() => { throw new Error('Traffic spike multiplier must be between 2 and 100.'); })()),
      alert_error_percent: String(integerSetting(req.body.alertErrorPercent, 'Error-rate alert threshold', 1, 100))
    };
    db.transaction(() => { for (const [key, value] of Object.entries(values)) setSetting(key, value); })();
    recordAudit(req.user.id, 'settings.security');
    res.json({ security: securitySettings() });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/admin/security/rotate-master-key', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(String(req.body.password || ''), user.password_salt, user.password_hash))) return res.status(401).json({ error: 'Password confirmation failed.' });
    const result = rotateMasterKey(db);
    writeCloudflareCredentials(getSecretSetting(db, 'cloudflare_api_token', ''));
    recordAudit(req.user.id, 'security.master-key.rotate');
    res.json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/admin/settings/registration', requireAuth, requireAdmin, (req, res) => {
  const enabled = bool(req.body.enabled, false);
  setSetting('registration_enabled', enabled ? '1' : '0');
  recordAudit(req.user.id, 'settings.registration', { enabled });
  res.json({ registrationEnabled: enabled });
});

app.put('/api/admin/settings/integrations', requireAuth, requireAdmin, (req, res) => {
  try {
    const zoneId = String(req.body.cloudflareZoneId || '').trim();
    const targetIp = String(req.body.cloudflareTargetIp || '').trim();
    const email = String(req.body.certbotEmail || '').trim();
    if (zoneId && !/^[a-fA-F0-9]{32}$/.test(zoneId)) throw new Error('Cloudflare zone ID must be a 32-character hexadecimal ID.');
    if (targetIp && net.isIP(targetIp) !== 4) throw new Error('Cloudflare origin must be a valid IPv4 address for the A record.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Certbot email address is not valid.');
    let cloudflareToken = getSecretSetting(db, 'cloudflare_api_token', '');
    if (req.body.cloudflareApiToken) cloudflareToken = String(req.body.cloudflareApiToken).trim();
    if (bool(req.body.clearCloudflareToken, false)) cloudflareToken = '';
    const previousToken = getSecretSetting(db, 'cloudflare_api_token', '');
    writeCloudflareCredentials(cloudflareToken);
    try {
      db.transaction(() => {
        setSecretSetting(db, 'cloudflare_api_token', cloudflareToken);
        setSetting('cloudflare_zone_id', zoneId);
        setSetting('cloudflare_target_ip', targetIp);
        setSetting('certbot_email', email);
      })();
    } catch (error) {
      try { writeCloudflareCredentials(previousToken); }
      catch (restoreError) { manager.log(null, 'error', `Could not restore Certbot credentials after a settings failure: ${restoreError.message}`); }
      throw error;
    }
    recordAudit(req.user.id, 'settings.integrations');
    res.json({ integrations: integrationSettings() });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/admin/sites/:id/cloudflare', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    if (!site.domain) throw new Error('Configure a domain for this site first.');
    const record = await syncCloudflareRecord({
      token: getSecretSetting(db, 'cloudflare_api_token', ''),
      zoneId: getSetting('cloudflare_zone_id', ''),
      targetIp: getSetting('cloudflare_target_ip', ''),
      domain: site.domain,
      proxied: true
    });
    db.prepare('UPDATE sites SET cloudflare_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
    recordAudit(req.user.id, 'site.cloudflare.sync', { id: site.id, domain: site.domain, recordId: record.id });
    res.json({
      site: manager.decorate(manager.getSite(site.id)),
      record: { id: record.id, name: record.name, content: record.content, proxied: record.proxied },
      warning: cloudflarePortWarning(site)
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/admin/sites/:id/cloudflare-firewall', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    if (!site.domain) throw new Error('Configure a domain for this site first.');
    const cloudflareMode = ['cloudflare', 'both'].includes(site.firewall.mode);
    const rule = await syncCloudflareFirewall({
      token: getSecretSetting(db, 'cloudflare_api_token', ''),
      zoneId: getSetting('cloudflare_zone_id', ''),
      siteId: site.id,
      domain: site.domain,
      enabled: site.firewall_enabled && cloudflareMode,
      firewall: site.firewall
    });
    recordAudit(req.user.id, 'site.cloudflare.firewall.sync', { id: site.id, domain: site.domain, deleted: Boolean(rule.deleted) });
    res.json({
      site: manager.decorate(manager.getSite(site.id)),
      rule: rule.inactive ? null : { id: rule.id || null, action: rule.action || site.firewall.cloudflareAction },
      message: rule.deleted ? 'Cloudflare firewall rule removed.' : rule.inactive ? 'No Cloudflare firewall rule was needed.' : 'Cloudflare firewall rule synchronized.'
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/admin/sites/:id/certificate', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site || !acquireCertificateOperation(res)) return;
  const wasRunning = manager.statusFor(site.id).running;
  const stoppedForChallenge = [];
  let edgeHttpPaused = false;
  try {
    if (!site.domain) throw new Error('Configure a domain for this site first.');
    const cloudflareToken = getSecretSetting(db, 'cloudflare_api_token', '');
    const wildcard = bool(req.body?.wildcard, false);
    if (wildcard && !cloudflareToken) throw new Error('Wildcard certificates require a configured Cloudflare API token for DNS validation.');
    if (!cloudflareToken) {
      if (DASHBOARD_PORT === 80) throw new Error('Certbot standalone cannot use port 80 while the SHAM dashboard is bound there. Configure the Cloudflare DNS challenge or move the dashboard port.');
      if (EDGE_HTTP_PORT === 80 && edgeProxy.status().httpRunning) { await edgeProxy.pauseHttp(); edgeHttpPaused = true; }
      stoppedForChallenge.push(...await stopRunningSitesOnPort(80));
    }
    await issueCertificate({
      domain: site.domain,
      email: getSetting('certbot_email', ''),
      cloudflareToken,
      wildcard,
      onLine: (level, line) => manager.log(site.id, level, `certbot: ${line.slice(0, 1000)}`)
    });
    db.prepare('UPDATE sites SET ssl_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
    let warning = null;
    try { await edgeProxy.reloadTls(); }
    catch (error) {
      warning = `The certificate was installed, but the shared HTTPS proxy could not reload it: ${error.message}`;
      manager.log(site.id, 'error', warning);
    }
    try {
      if (manager.statusFor(site.id).running) await manager.restart(site.id);
      else if (wasRunning || site.enabled) await manager.start(site.id);
    } catch (error) {
      const message = `The certificate was installed, but the site could not start with SSL: ${error.message}`;
      warning = [warning, message].filter(Boolean).join(' ');
      manager.log(site.id, 'error', message);
    }
    if (edgeHttpPaused) {
      try { await edgeProxy.resumeHttp(); }
      catch (error) {
        const message = `The certificate was installed, but the shared HTTP proxy could not resume: ${error.message}`;
        warning = [warning, message].filter(Boolean).join(' ');
        manager.log(null, 'error', message);
      }
      edgeHttpPaused = false;
    }
    const restoreWarnings = await restoreEnabledSites(stoppedForChallenge.filter((id) => id !== site.id));
    if (restoreWarnings.length) {
      warning = [warning, `${restoreWarnings.length} temporarily stopped site${restoreWarnings.length === 1 ? '' : 's'} could not be restored. Review Activity for details.`].filter(Boolean).join(' ');
    }
    recordAudit(req.user.id, 'site.certificate.issue', { id: site.id, domain: site.domain, wildcard, warning: Boolean(warning) });
    res.json({ site: manager.decorate(manager.getSite(site.id)), message: wildcard ? 'Wildcard certificate is installed and SSL is enabled.' : 'Certificate is installed and SSL is enabled.', warning });
  } catch (error) {
    if (edgeHttpPaused) { try { await edgeProxy.resumeHttp(); } catch (resumeError) { manager.log(null, 'error', `Could not resume edge HTTP after certificate failure: ${resumeError.message}`); } edgeHttpPaused = false; }
    await restoreEnabledSites([...stoppedForChallenge, ...(wasRunning ? [site.id] : [])]);
    res.status(400).json({ error: error.message });
  } finally {
    if (edgeHttpPaused) { try { await edgeProxy.resumeHttp(); } catch (error) { manager.log(null, 'error', `Could not resume edge HTTP: ${error.message}`); } }
    certificateOperationActive = false;
  }
});

app.post('/api/admin/certificates/renew', requireAuth, requireAdmin, async (req, res) => {
  if (!acquireCertificateOperation(res)) return;
  const stoppedForChallenge = [];
  let edgeHttpPaused = false;
  try {
    if (renewalNeedsPort80()) {
      if (DASHBOARD_PORT === 80) throw new Error('A standalone Certbot renewal needs port 80, but the SHAM dashboard is using it. Configure DNS renewal or move the dashboard port.');
      if (EDGE_HTTP_PORT === 80 && edgeProxy.status().httpRunning) { await edgeProxy.pauseHttp(); edgeHttpPaused = true; }
      stoppedForChallenge.push(...await stopRunningSitesOnPort(80));
    }
    await renewCertificates({ onLine: (level, line) => manager.log(null, level, `certbot: ${line.slice(0, 1000)}`) });
    const restartWarnings = [];
    if (edgeHttpPaused) {
      try { await edgeProxy.resumeHttp(); }
      catch (error) {
        const warning = `Certificates were renewed, but the shared HTTP proxy could not resume: ${error.message}`;
        restartWarnings.push(warning);
        manager.log(null, 'error', warning);
      }
      edgeHttpPaused = false;
    }
    try { await edgeProxy.reloadTls(); }
    catch (error) {
      const warning = `Certificates were renewed, but the shared HTTPS proxy could not reload them: ${error.message}`;
      restartWarnings.push(warning);
      manager.log(null, 'error', warning);
    }
    const runningSslSites = db.prepare('SELECT id FROM sites WHERE ssl_enabled = 1 AND enabled = 1').all();
    for (const site of runningSslSites) {
      if (!manager.statusFor(site.id).running) continue;
      try { await manager.restart(site.id); }
      catch (error) {
        const warning = `Site ${site.id} could not restart after certificate renewal: ${error.message}`;
        restartWarnings.push(warning);
        manager.log(site.id, 'error', warning);
      }
    }
    restartWarnings.push(...await restoreEnabledSites(stoppedForChallenge));
    recordAudit(req.user.id, 'certificates.renew', { restartWarnings: restartWarnings.length });
    res.json({
      message: 'Certificate renewal completed.',
      warning: restartWarnings.length ? `${restartWarnings.length} site${restartWarnings.length === 1 ? '' : 's'} could not restart or be restored. Review Activity for details.` : null
    });
  } catch (error) {
    if (edgeHttpPaused) { try { await edgeProxy.resumeHttp(); } catch (resumeError) { manager.log(null, 'error', `Could not resume edge HTTP after renewal failure: ${resumeError.message}`); } edgeHttpPaused = false; }
    await restoreEnabledSites(stoppedForChallenge);
    res.status(400).json({ error: error.message });
  } finally {
    if (edgeHttpPaused) { try { await edgeProxy.resumeHttp(); } catch (error) { manager.log(null, 'error', `Could not resume edge HTTP: ${error.message}`); } }
    certificateOperationActive = false;
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare('SELECT id, username, role, active, created_at FROM users ORDER BY created_at, id').all();
  res.json({ users: users.map(publicUser) });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT id, username, role, active, created_at FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (targetId === req.user.id && req.body.active !== undefined && !bool(req.body.active, true)) {
    return res.status(400).json({ error: 'You cannot disable your own account.' });
  }
  const role = req.body.role === undefined ? target.role : String(req.body.role);
  const active = req.body.active === undefined ? Boolean(target.active) : bool(req.body.active, true);
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user.' });
  if (targetId === req.user.id && role !== target.role) return res.status(400).json({ error: 'You cannot change your own role.' });
  if (target.role === 'admin' && target.active && (role !== 'admin' || !active) && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'SHAM must keep at least one active administrator.' });
  }
  db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(role, Number(active), targetId);
  recordAudit(req.user.id, 'user.update', { targetId, role, active });
  const updated = db.prepare('SELECT id, username, role, active, created_at FROM users WHERE id = ?').get(targetId);
  res.json({ user: publicUser(updated) });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'admin' && target.active && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'SHAM must keep at least one active administrator.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  recordAudit(req.user.id, 'user.delete', { targetId, username: target.username });
  res.status(204).end();
});

function authenticateDeployWebhook(req, res, next) {
  const site = manager.getSite(Number(req.params.id));
  const configuredSecret = site ? operationsManager.siteEnvironment(site.id, 'build').DEPLOY_WEBHOOK_SECRET : '';
  const verificationSecret = configuredSecret || DEPLOY_WEBHOOK_DUMMY_SECRET;
  const supplied = String(req.get('x-hub-signature-256') || req.get('x-sham-signature') || '').trim().toLowerCase();
  const expected = `sha256=${crypto.createHmac('sha256', verificationSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex')}`;
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!site || !configuredSecret || !valid) return res.status(401).json({ error: 'Webhook authentication failed.' });
  req.deployWebhookSite = site;
  next();
}

app.post('/api/hooks/deploy/:id', webhookLimiter, authenticateDeployWebhook, serializeSiteMutation, async (req, res) => {
  const site = req.deployWebhookSite;
  const requestedBranch = String(req.body?.ref || '').replace(/^refs\/heads\//, '');
  if (requestedBranch && site.git_branch && requestedBranch !== site.git_branch) return res.status(202).json({ ignored: true, reason: 'The push was for another branch.' });
  const deliveryId = String(req.get('x-github-delivery') || req.get('x-sham-delivery') || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(deliveryId)) return res.status(400).json({ error: 'A valid X-GitHub-Delivery or X-SHAM-Delivery identifier is required.' });
  db.prepare("DELETE FROM deploy_webhook_deliveries WHERE received_at < datetime('now', '-14 days')").run();
  try {
    db.prepare('INSERT INTO deploy_webhook_deliveries (site_id, delivery_id) VALUES (?, ?)').run(site.id, deliveryId);
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(202).json({ ignored: true, reason: 'This webhook delivery was already processed.' });
    throw error;
  }
  try {
    const release = await operationsManager.deployGit(site, {
      url: site.git_url,
      branch: site.git_branch,
      installDependencies: site.install_dependencies
    });
    recordAudit(null, 'site.git.webhook-deploy', { siteId: site.id, releaseId: release.id, branch: site.git_branch, deliveryId });
    res.json({ deployed: true, releaseId: release.id });
  } catch (error) {
    db.prepare('DELETE FROM deploy_webhook_deliveries WHERE site_id = ? AND delivery_id = ?').run(site.id, deliveryId);
    manager.log(site.id, 'error', `Webhook deployment failed: ${error.message}`);
    res.status(500).json({ error: 'Webhook deployment failed. Review the authenticated runtime logs for details.' });
  }
});

app.get('/api/sites/:id/operations', requireAuth, requireAdmin, (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  res.json({ site: manager.decorate(site), ...operationsManager.operationsPayload(site.id) });
});

app.put('/api/sites/:id/environment', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    const environment = operationsManager.saveEnvironment(site.id, req.body.variables);
    if (manager.statusFor(site.id).running) await manager.restart(site.id);
    recordAudit(req.user.id, 'site.environment.update', { id: site.id, keys: environment.map((item) => item.key) });
    res.json({ environment });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/sites/:id/database-profiles', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    const databaseProfiles = operationsManager.attachDatabaseProfiles(site.id, req.body.profileIds);
    if (manager.statusFor(site.id).running) await manager.restart(site.id);
    recordAudit(req.user.id, 'site.database-profiles.update', { id: site.id, profileIds: req.body.profileIds || [] });
    res.json({ databaseProfiles });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/sites/:id/jobs', requireAuth, requireAdmin, (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    const id = operationsManager.saveJob(site.id, req.body);
    recordAudit(req.user.id, 'site.job.save', { siteId: site.id, jobId: id });
    res.status(req.body.id ? 200 : 201).json({ jobs: operationsManager.listJobs(site.id), id });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/sites/:id/jobs/:jobId', requireAuth, requireAdmin, (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { operationsManager.deleteJob(site.id, Number(req.params.jobId)); recordAudit(req.user.id, 'site.job.delete', { siteId: site.id, jobId: Number(req.params.jobId) }); res.status(204).end(); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/sites/:id/jobs/:jobId/run', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { const result = await operationsManager.runJob(Number(req.params.jobId), 'manual'); recordAudit(req.user.id, 'site.job.run', { siteId: site.id, jobId: Number(req.params.jobId) }); res.json(result); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/sites/:id/deploy/git', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    const release = await operationsManager.deployGit(site, {
      url: req.body.url || site.git_url,
      branch: req.body.branch || site.git_branch,
      deployKey: String(req.body.deployKey || ''),
      installDependencies: bool(req.body.installDependencies, site.install_dependencies)
    });
    recordAudit(req.user.id, 'site.git.deploy', { siteId: site.id, releaseId: release.id, branch: req.body.branch || site.git_branch });
    res.json({ release, site: manager.decorate(manager.getSite(site.id)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/sites/:id/releases/:releaseId/rollback', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { const releases = await operationsManager.rollbackRelease(site, Number(req.params.releaseId)); recordAudit(req.user.id, 'site.release.rollback', { siteId: site.id, releaseId: Number(req.params.releaseId) }); res.json({ releases }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/sites/:id/previews', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { const preview = await operationsManager.createPreview(site, req.body); recordAudit(req.user.id, 'site.preview.create', { siteId: site.id, previewId: preview.id, hostname: preview.hostname }); res.status(201).json({ preview }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/sites/:id/previews/:previewId', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try { await operationsManager.deletePreview(Number(req.params.previewId)); recordAudit(req.user.id, 'site.preview.delete', { siteId: site.id, previewId: Number(req.params.previewId) }); res.status(204).end(); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/sites/:id/config/export', requireAuth, requireAdmin, (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  const payload = {
    format: 'sham-site-config', version: 1, exportedAt: new Date().toISOString(),
    site: { ...site, id: undefined, directory_name: undefined, created_at: undefined, updated_at: undefined, cloudflare_zone_id: undefined, cloudflare_record_id: undefined, cloudflare_firewall_rule_id: undefined, headers_json: undefined, firewall_json: undefined, redirects_json: undefined, error_pages_json: undefined, cache_rules_json: undefined },
    environment: operationsManager.listEnvironment(site.id).map((item) => ({ key: item.key, secret: item.secret, scope: item.scope, value: item.secret ? null : operationsManager.siteEnvironment(site.id, item.scope)[item.key] })),
    databaseProfiles: operationsManager.listDatabaseProfiles(site.id).filter((item) => item.attached).map((item) => ({ name: item.name, envKey: item.envKey, type: item.type })),
    jobs: operationsManager.listJobs(site.id).map(({ id, site_id, running, last_status, ...job }) => job)
  };
  res.setHeader('Content-Disposition', `attachment; filename="${site.slug}-sham-config.json"`);
  res.json(payload);
});

app.post('/api/sites/:id/config/import', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteOr404(req, res);
  if (!site) return;
  try {
    if (req.body?.format !== 'sham-site-config' || !req.body.site) throw new Error('This is not a supported SHAM site configuration export.');
    const config = validateSiteInput({ ...req.body.site, port: site.port, name: req.body.site.name || site.name }, site);
    config.slug = uniqueSlug(config.slug, site.id);
    writeSiteConfig(site.id, config);
    if (Array.isArray(req.body.environment)) operationsManager.saveEnvironment(site.id, req.body.environment.filter((item) => !item.secret || item.value));
    if (Array.isArray(req.body.jobs)) for (const job of req.body.jobs.slice(0, 100)) operationsManager.saveJob(site.id, job);
    if (manager.statusFor(site.id).running) await manager.restart(site.id);
    recordAudit(req.user.id, 'site.config.import', { siteId: site.id });
    res.json({ site: manager.decorate(manager.getSite(site.id)), warning: 'Secret values and database connection strings are never imported from an export; review them separately.' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/runtime-logs/search', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
  const conditions = [];
  const values = [];
  if (req.query.siteId) { conditions.push('site_id = ?'); values.push(Number(req.query.siteId)); }
  if (req.query.level && ['info', 'error'].includes(req.query.level)) { conditions.push('level = ?'); values.push(req.query.level); }
  if (req.query.query) { conditions.push('message LIKE ? ESCAPE \'\\\''); values.push(`%${String(req.query.query).slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`); }
  if (req.query.since) { conditions.push('created_at >= ?'); values.push(String(req.query.since).slice(0, 30)); }
  const sql = `SELECT id, site_id AS siteId, level, message, context_json AS contextJson, created_at AS createdAt FROM runtime_logs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...values, limit).map((row) => ({ ...row, context: (() => { try { return JSON.parse(row.contextJson || 'null'); } catch { return null; } })(), contextJson: undefined }));
  res.json({ logs: rows });
});

function savedLogFilters(userId) {
  return db.prepare('SELECT id, name, filter_json AS filterJson, created_at AS createdAt FROM saved_log_filters WHERE user_id = ? ORDER BY name').all(userId).map((row) => {
    let filter = {};
    try {
      const parsed = JSON.parse(row.filterJson || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) filter = parsed;
    } catch { /* Ignore a corrupt legacy filter instead of breaking the whole page. */ }
    return { id: row.id, name: row.name, filter, createdAt: row.createdAt };
  });
}

app.get('/api/log-filters', requireAuth, (req, res) => {
  res.json({ filters: savedLogFilters(req.user.id) });
});

app.post('/api/log-filters', requireAuth, (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const filter = req.body.filter && typeof req.body.filter === 'object' && !Array.isArray(req.body.filter) ? req.body.filter : {};
    const serialized = JSON.stringify(filter);
    if (!name || serialized.length > 4000) throw new Error('Filter name or value is invalid.');
    db.prepare(`INSERT INTO saved_log_filters (user_id, name, filter_json) VALUES (?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET filter_json = excluded.filter_json`).run(req.user.id, name, serialized);
    res.status(201).json({ filters: savedLogFilters(req.user.id) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/log-filters/:id', requireAuth, (req, res) => { db.prepare('DELETE FROM saved_log_filters WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id); res.status(204).end(); });

app.get('/api/admin/database-profiles', requireAuth, requireAdmin, (_req, res) => res.json({ profiles: operationsManager.listDatabaseProfiles() }));
app.post('/api/admin/database-profiles', requireAuth, requireAdmin, (req, res) => { try { const id = operationsManager.saveDatabaseProfile(req.body); recordAudit(req.user.id, 'database-profile.save', { id }); res.status(req.body.id ? 200 : 201).json({ id, profiles: operationsManager.listDatabaseProfiles() }); } catch (error) { res.status(400).json({ error: error.message }); } });
app.delete('/api/admin/database-profiles/:id', requireAuth, requireAdmin, (req, res) => { try { operationsManager.deleteDatabaseProfile(Number(req.params.id)); recordAudit(req.user.id, 'database-profile.delete', { id: Number(req.params.id) }); res.status(204).end(); } catch (error) { res.status(400).json({ error: error.message }); } });

app.get('/api/admin/operations', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    ...operationsManager.operationsPayload(),
    settings: {
      prometheusEnabled: getSetting('prometheus_enabled', '0') === '1',
      prometheusTokenConfigured: Boolean(getSecretSetting(db, 'prometheus_token', '')),
      otelEndpoint: getSetting('otel_endpoint', ''),
      otelHeadersConfigured: Boolean(getSecretSetting(db, 'otel_headers', '')),
      publicStatusEnabled: getSetting('public_status_enabled', '0') === '1',
      publicStatusTitle: getSetting('public_status_title', 'SHAM service status'),
      locale: getSetting('instance_locale', 'en'),
      setupCompleted: getSetting('setup_completed', '0') === '1',
      updateChannel: getSetting('update_channel', 'stable')
    },
    update: updateManager.status()
  });
});

app.put('/api/admin/operations/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const clearPrometheusToken = bool(body.clearPrometheusToken, false);
    const incomingPrometheusToken = has('prometheusToken') ? String(body.prometheusToken || '').trim() : '';
    if (incomingPrometheusToken && (incomingPrometheusToken.length > 4096 || /[\s\0]/.test(incomingPrometheusToken))) throw new Error('Metrics token must be a single value no longer than 4096 characters.');
    if (clearPrometheusToken && incomingPrometheusToken) throw new Error('Choose either a new metrics token or clear the saved token.');
    const prometheusEnabled = has('prometheusEnabled') ? bool(body.prometheusEnabled) : getSetting('prometheus_enabled', '0') === '1';
    const nextPrometheusToken = clearPrometheusToken ? '' : incomingPrometheusToken || getSecretSetting(db, 'prometheus_token', '');
    if (prometheusEnabled && !nextPrometheusToken) throw new Error('Set a metrics token before enabling the Prometheus endpoint.');

    const otelEndpoint = has('otelEndpoint') ? String(body.otelEndpoint || '').trim() : null;
    if (otelEndpoint !== null && otelEndpoint.length > 2048) throw new Error('OpenTelemetry endpoint is too long.');
    if (otelEndpoint) {
      let parsedEndpoint;
      try { parsedEndpoint = new URL(otelEndpoint); } catch { throw new Error('OpenTelemetry endpoint must be a valid HTTP or HTTPS URL.'); }
      if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) throw new Error('OpenTelemetry endpoint must be a valid HTTP or HTTPS URL.');
    }
    const clearOtelHeaders = bool(body.clearOtelHeaders, false);
    let serializedOtelHeaders = null;
    if (has('otelHeaders')) {
      if (!body.otelHeaders || typeof body.otelHeaders !== 'object' || Array.isArray(body.otelHeaders)) throw new Error('OpenTelemetry headers must be a JSON object.');
      serializedOtelHeaders = JSON.stringify(body.otelHeaders);
      if (serializedOtelHeaders.length > 64 * 1024 || serializedOtelHeaders.includes('\0')) throw new Error('OpenTelemetry headers are too large or invalid.');
    }
    if (clearOtelHeaders && serializedOtelHeaders && serializedOtelHeaders !== '{}') throw new Error('Choose either new OpenTelemetry headers or clear the saved headers.');

    const locale = has('locale') ? String(body.locale).toLowerCase() : null;
    if (locale !== null && !['en', 'nl', 'de'].includes(locale)) throw new Error('Locale must be English, Dutch, or German.');
    const updateChannel = has('updateChannel') ? String(body.updateChannel) : null;
    if (updateChannel !== null && !['stable', 'preview'].includes(updateChannel)) throw new Error('Update channel is invalid.');

    db.transaction(() => {
      if (body.backup) operationsManager.saveBackupSettings(body.backup);
      if (has('prometheusEnabled')) setSetting('prometheus_enabled', prometheusEnabled ? '1' : '0');
      if (incomingPrometheusToken) setSecretSetting(db, 'prometheus_token', incomingPrometheusToken);
      if (clearPrometheusToken) setSecretSetting(db, 'prometheus_token', '');
      if (otelEndpoint !== null) setSetting('otel_endpoint', otelEndpoint);
      if (serializedOtelHeaders !== null) setSecretSetting(db, 'otel_headers', serializedOtelHeaders);
      if (clearOtelHeaders) setSecretSetting(db, 'otel_headers', '');
      if (has('publicStatusEnabled')) setSetting('public_status_enabled', bool(body.publicStatusEnabled) ? '1' : '0');
      if (has('publicStatusTitle')) setSetting('public_status_title', String(body.publicStatusTitle || 'SHAM service status').slice(0, 120));
      if (locale !== null) setSetting('instance_locale', locale);
      if (has('setupCompleted')) setSetting('setup_completed', bool(body.setupCompleted) ? '1' : '0');
      if (updateChannel !== null) setSetting('update_channel', updateChannel);
    })();
    recordAudit(req.user.id, 'operations.settings.update');
    res.json({ saved: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/admin/backups/run', requireAuth, requireAdmin, async (req, res) => { try { const backup = await operationsManager.createBackup({ provider: req.body.provider || null }); recordAudit(req.user.id, 'backup.run', backup); res.json({ backup }); } catch (error) { res.status(400).json({ error: error.message }); } });

app.post('/api/admin/alert-destinations', requireAuth, requireAdmin, (req, res) => { try { const id = operationsManager.saveAlertDestination(req.body); recordAudit(req.user.id, 'alert-destination.save', { id }); res.status(req.body.id ? 200 : 201).json({ id, destinations: operationsManager.listAlertDestinations() }); } catch (error) { res.status(400).json({ error: error.message }); } });
app.post('/api/admin/alert-destinations/:id/test', requireAuth, requireAdmin, async (req, res) => { try { await operationsManager.testAlertDestination(Number(req.params.id)); res.json({ sent: true }); } catch (error) { res.status(400).json({ error: error.message }); } });
app.delete('/api/admin/alert-destinations/:id', requireAuth, requireAdmin, (req, res) => { try { operationsManager.deleteAlertDestination(Number(req.params.id)); recordAudit(req.user.id, 'alert-destination.delete', { id: Number(req.params.id) }); res.status(204).end(); } catch (error) { res.status(400).json({ error: error.message }); } });

app.get('/api/admin/audit/export', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare(`SELECT audit_logs.id, users.username, audit_logs.action, audit_logs.detail, audit_logs.created_at AS createdAt FROM audit_logs LEFT JOIN users ON users.id = audit_logs.user_id ORDER BY audit_logs.id DESC LIMIT 10000`).all();
  res.setHeader('Content-Disposition', 'attachment; filename="sham-audit-log.ndjson"');
  res.type('application/x-ndjson').send(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
});

app.post('/api/admin/update', requireAuth, requireAdmin, multipart(updateUpload.single('archive')), async (req, res) => {
  try {
    if (!req.file?.path) throw new Error('Choose a SHAM update ZIP.');
    const pending = await updateManager.stage(req.file.path, req.file.originalname, { allowUnsigned: bool(req.body.allowUnsigned, false) });
    recordAudit(req.user.id, 'update.stage', { version: pending.version, archiveName: pending.archiveName });
    res.status(201).json({ pending, message: 'Update staged. Restart SHAM to apply it with automatic managed-file rollback.' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/admin/update', requireAuth, requireAdmin, async (req, res) => { try { const result = await updateManager.cancel(); recordAudit(req.user.id, 'update.cancel', result); res.json(result); } catch (error) { res.status(400).json({ error: error.message }); } });

app.get('/api/admin/audit', requireAuth, requireAdmin, (_req, res) => {
  const logs = db.prepare(`
    SELECT audit_logs.*, users.username
    FROM audit_logs
    LEFT JOIN users ON users.id = audit_logs.user_id
    ORDER BY audit_logs.id DESC
    LIMIT 300
  `).all().map((row) => ({
    id: row.id,
    username: row.username || 'system',
    action: row.action,
    detail: row.detail ? (() => { try { return JSON.parse(row.detail); } catch { return { raw: row.detail }; } })() : null,
    createdAt: row.created_at
  }));
  res.json({ logs });
});

app.get('/LICENSE', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'LICENSE')));

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));
app.use((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(404).type('text/plain').send('Not found');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({ error: 'Request body exceeds the configured size limit.' });
  }
  if (error instanceof SyntaxError && error?.status === 400 && Object.hasOwn(error, 'body')) {
    return res.status(400).json({ error: 'Request body contains invalid JSON.' });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

let resolveDashboardReady;
let rejectDashboardReady;
let dashboardStartupSettled = false;
const ready = new Promise((resolve, reject) => {
  resolveDashboardReady = resolve;
  rejectDashboardReady = reject;
});

const dashboardServer = app.listen(DASHBOARD_PORT, DASHBOARD_HOST, async () => {
  const dashboardUrlHost = net.isIP(DASHBOARD_HOST) === 6 ? `[${DASHBOARD_HOST}]` : DASHBOARD_HOST;
  console.log(`SHAM dashboard listening on http://${dashboardUrlHost}:${DASHBOARD_PORT}`);
  console.log(`SHAM data path: ${DATA_DIR}`);
  try {
    await manager.startEnabledSites();
    await edgeProxy.start();
  } catch (error) {
    console.error(`Could not restore enabled sites during startup: ${error.message}`);
  } finally {
    dashboardStartupSettled = true;
    resolveDashboardReady({ host: DASHBOARD_HOST, port: DASHBOARD_PORT });
  }
});

dashboardServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
dashboardServer.headersTimeout = Math.min(60_000, HTTP_REQUEST_TIMEOUT_MS);
dashboardServer.keepAliveTimeout = 5_000;

dashboardServer.on('error', (error) => {
  console.error(`Dashboard failed: ${error.message}`);
  if (!dashboardStartupSettled) {
    dashboardStartupSettled = true;
    rejectDashboardReady(error);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping SHAM...`);

  let serverClosed = false;
  let resolveServerClosed;
  const serverClosedPromise = new Promise((resolve) => { resolveServerClosed = resolve; });
  dashboardServer.close(() => {
    serverClosed = true;
    resolveServerClosed();
  });
  dashboardServer.closeIdleConnections?.();

  await stopIntegrationProcesses();
  await Promise.allSettled([performanceMonitor.stop(), dependencyScanner.shutdown(), snapshotManager.shutdown(), operationsManager.shutdown(), updateManager.shutdown(), edgeProxy.stop()]);
  await stopUploadWorkers();
  await pluginManager.shutdown();
  await manager.stopAll();

  if (!serverClosed) {
    const forceTimer = setTimeout(() => {
      dashboardServer.closeAllConnections?.();
      resolveServerClosed();
    }, 5_000);
    forceTimer.unref?.();
    await serverClosedPromise;
    clearTimeout(forceTimer);
  }

  try { await fs.promises.rm(UPLOAD_TMP_DIR, { recursive: true, force: true }); } catch { /* Temporary files are best-effort cleanup. */ }
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, dashboardServer, ready, shutdown };

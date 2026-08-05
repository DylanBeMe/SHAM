const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const express = require('express');
const httpProxy = require('http-proxy');
const {
  SITES_DIR,
  NODE_START_TIMEOUT_MS,
  NPM_INSTALL_TIMEOUT_MS,
  NPM_INSTALL_WORKERS,
  NPM_INSTALL_QUEUE_LIMIT,
  HTTP_REQUEST_TIMEOUT_MS,
  STATS_FLUSH_INTERVAL_MS,
  VISITOR_RETENTION_DAYS,
  MINIFY_MAX_BYTES,
  MINIFY_CACHE_BYTES,
  MINIFY_WORKERS,
  MINIFY_QUEUE_LIMIT,
  COMPRESSION_WORKERS,
  COMPRESSION_QUEUE_LIMIT,
  VISITOR_PENDING_BUCKETS,
  FIREWALL_RATE_LIMIT_BUCKETS,
  TRUSTED_EDGE_PROXIES,
  DOCKER_BIN,
  DOCKER_INTERNAL_NETWORK,
  DOCKER_EGRESS_NETWORK,
  SITE_DATA_DIR,
  JWT_SECRET
} = require('./config');
const { safeRelativePath } = require('./validation');
const { certbotPaths, hasCertificate } = require('./integrations');
const { runtimeEnvironment, buildEnvironment, operatorEnvironment } = require('./process-env');

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);
const execFileAsync = promisify(execFile);
let dockerInternalNetworkPromise = null;
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.csv', '.map', '.wasm']);
const INTERNAL_EDGE_TOKEN = crypto.randomBytes(32).toString('base64url');
const REQUEST_IDENTITY = Symbol('shamRequestIdentity');


function appendTail(current, chunk, limit = 64 * 1024) {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function cacheEntryBytes(entry) {
  let total = Number(entry?.bytes || 0);
  for (const value of Object.values(entry?.encoded || {})) {
    if (Buffer.isBuffer(value)) total += value.length;
  }
  return total;
}

function responseChunkBytes(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return 0;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
  if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

function processOptions(options = {}) {
  return { ...options, detached: process.platform !== 'win32' };
}

function terminateChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* The process already stopped. */ }
  }
}

async function ensureDockerInternalNetwork() {
  if (dockerInternalNetworkPromise) return dockerInternalNetworkPromise;
  dockerInternalNetworkPromise = (async () => {
    try {
      await execFileAsync(DOCKER_BIN, ['network', 'inspect', DOCKER_INTERNAL_NETWORK], { timeout: 15_000, windowsHide: true, env: operatorEnvironment() });
      return DOCKER_INTERNAL_NETWORK;
    } catch {
      try {
        await execFileAsync(DOCKER_BIN, ['network', 'create', '--driver', 'bridge', '--internal', '--label', 'sham.managed=true', DOCKER_INTERNAL_NETWORK], { timeout: 30_000, windowsHide: true, env: operatorEnvironment() });
      } catch (error) {
        try { await execFileAsync(DOCKER_BIN, ['network', 'inspect', DOCKER_INTERNAL_NETWORK], { timeout: 15_000, windowsHide: true, env: operatorEnvironment() }); }
        catch { throw new Error(`Could not create the isolated Docker network: ${error.message}`); }
      }
      return DOCKER_INTERNAL_NETWORK;
    }
  })().catch((error) => { dockerInternalNetworkPromise = null; throw error; });
  return dockerInternalNetworkPromise;
}

function terminateAndWait(child, graceMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(fallbackTimer);
      resolve();
    };
    child.once('exit', finish);
    const forceTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), graceMs);
    forceTimer.unref?.();
    const fallbackTimer = setTimeout(finish, graceMs + 3000);
    fallbackTimer.unref?.();
    terminateChild(child, 'SIGTERM');
  });
}

function realFileInside(root, absolute) {
  try {
    const rootReal = fs.realpathSync(root);
    const targetReal = fs.realpathSync(absolute);
    return targetReal.startsWith(`${rootReal}${path.sep}`) && fs.statSync(targetReal).isFile();
  } catch {
    return false;
  }
}

async function realFileInsideAsync(root, absolute) {
  try {
    const [rootReal, targetReal] = await Promise.all([
      fs.promises.realpath(root),
      fs.promises.realpath(absolute)
    ]);
    const stat = await fs.promises.stat(targetReal);
    return targetReal.startsWith(`${rootReal}${path.sep}`) && stat.isFile();
  } catch {
    return false;
  }
}


function hostForUrl(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function normalizeIp(value) {
  let ip = String(value || '').trim().split(',')[0].trim();
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  return net.isIP(ip) ? ip : 'unknown';
}

function requestHostname(req) {
  const raw = String(req.headers.host || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end === -1 ? raw : raw.slice(1, end);
  }
  return raw.replace(/:\d+$/, '').replace(/\.$/, '');
}

const TRUSTED_EDGE_RANGES = [
  '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/13', '104.24.0.0/14',
  '108.162.192.0/18', '131.0.72.0/22', '141.101.64.0/18', '162.158.0.0/15', '172.64.0.0/13',
  '173.245.48.0/20', '188.114.96.0/20', '190.93.240.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
  ...TRUSTED_EDGE_PROXIES
];
const trustedEdgePeers = buildIpBlockList(TRUSTED_EDGE_RANGES);

function trustedEdgePeer(ip) {
  const version = net.isIP(ip);
  return Boolean(version && trustedEdgePeers.check(ip, version === 6 ? 'ipv6' : 'ipv4'));
}

function requestIdentity(site, req) {
  if (req[REQUEST_IDENTITY]) return req[REQUEST_IDENTITY];
  const peerIp = normalizeIp(req.socket?.remoteAddress);
  const suppliedEdgeToken = String(req.headers['x-sham-edge-token'] || '');
  const trustedInternalEdge = suppliedEdgeToken.length === INTERNAL_EDGE_TOKEN.length
    && crypto.timingSafeEqual(Buffer.from(suppliedEdgeToken), Buffer.from(INTERNAL_EDGE_TOKEN));
  const trustCloudflare = !trustedInternalEdge && site.cloudflare_enabled && trustedEdgePeer(peerIp);
  const forwardedIp = trustedInternalEdge ? normalizeIp(req.headers['x-sham-client-ip']) : 'unknown';
  const cloudflareIp = trustCloudflare ? normalizeIp(req.headers['cf-connecting-ip']) : 'unknown';
  const ip = forwardedIp !== 'unknown' ? forwardedIp : cloudflareIp !== 'unknown' ? cloudflareIp : peerIp;
  const rawCountry = trustedInternalEdge
    ? String(req.headers['x-sham-client-country'] || '').trim().toUpperCase()
    : trustCloudflare ? String(req.headers['cf-ipcountry'] || '').trim().toUpperCase() : '';
  const country = /^(?:[A-Z]{2}|T1)$/.test(rawCountry) ? rawCountry : 'ZZ';
  delete req.headers['x-sham-edge-token'];
  delete req.headers['x-sham-client-ip'];
  delete req.headers['x-sham-client-country'];
  req[REQUEST_IDENTITY] = { ip, country };
  return req[REQUEST_IDENTITY];
}

function buildIpBlockList(entries = []) {
  const list = new net.BlockList();
  for (const entry of entries) {
    const [ip, prefixRaw] = String(entry).split('/');
    const version = net.isIP(ip);
    if (!version) continue;
    const type = version === 6 ? 'ipv6' : 'ipv4';
    if (prefixRaw === undefined) list.addAddress(ip, type);
    else list.addSubnet(ip, Number(prefixRaw), type);
  }
  return list;
}

function ipMatchesList(ip, entries = []) {
  const version = net.isIP(ip);
  if (!version || !entries.length) return false;
  return buildIpBlockList(entries).check(ip, version === 6 ? 'ipv6' : 'ipv4');
}

function hydrateSite(row) {
  if (!row) return null;
  let headers = {};
  let firewall = {};
  let redirects = [];
  let errorPages = {};
  let cacheRules = [];
  try { headers = JSON.parse(row.headers_json || '{}'); } catch { headers = {}; }
  try { firewall = JSON.parse(row.firewall_json || '{}'); } catch { firewall = {}; }
  try { redirects = JSON.parse(row.redirects_json || '[]'); } catch { redirects = []; }
  try { errorPages = JSON.parse(row.error_pages_json || '{}'); } catch { errorPages = {}; }
  try { cacheRules = JSON.parse(row.cache_rules_json || '[]'); } catch { cacheRules = []; }
  return {
    ...row,
    enabled: Boolean(row.enabled),
    spa_fallback: Boolean(row.spa_fallback),
    install_dependencies: Boolean(row.install_dependencies),
    minify: Boolean(row.minify),
    obfuscate: Boolean(row.obfuscate),
    obfuscation_risk_acknowledged: Boolean(row.obfuscation_risk_acknowledged),
    domain_only: Boolean(row.domain_only),
    ssl_enabled: Boolean(row.ssl_enabled),
    cloudflare_enabled: Boolean(row.cloudflare_enabled),
    firewall_enabled: Boolean(row.firewall_enabled),
    compression: row.compression === undefined ? true : Boolean(row.compression),
    edge_enabled: Boolean(row.edge_enabled),
    runtime_isolation: row.runtime_isolation || 'process',
    outbound_network: row.outbound_network === undefined ? true : Boolean(row.outbound_network),
    anubis_enabled: Boolean(row.anubis_enabled),
    maintenance_enabled: Boolean(row.maintenance_enabled),
    release_mode: Boolean(row.release_mode),
    cpu_limit: Number(row.cpu_limit || 0),
    pids_limit: Number(row.pids_limit || 128),
    anubis_difficulty: Number(row.anubis_difficulty || 4),
    redirects: Array.isArray(redirects) ? redirects : [],
    errorPages: errorPages && typeof errorPages === 'object' && !Array.isArray(errorPages) ? errorPages : {},
    cacheRules: Array.isArray(cacheRules) ? cacheRules : [],
    health_check_interval: Number(row.health_check_interval || 30),
    max_restarts: Number(row.max_restarts || 5),
    memory_limit_mb: Number(row.memory_limit_mb || 0),
    max_connections: Number(row.max_connections || 0),
    headers,
    firewall: {
      mode: firewall.mode || 'local',
      cloudflareAction: firewall.cloudflareAction || 'managed_challenge',
      rateLimitPerMinute: Number(firewall.rateLimitPerMinute || 0),
      maxBodyKb: Number(firewall.maxBodyKb || 0),
      blockedIps: Array.isArray(firewall.blockedIps) ? firewall.blockedIps : [],
      allowedIps: Array.isArray(firewall.allowedIps) ? firewall.allowedIps : [],
      blockedCountries: Array.isArray(firewall.blockedCountries) ? firewall.blockedCountries : [],
      allowedCountries: Array.isArray(firewall.allowedCountries) ? firewall.allowedCountries : [],
      blockBots: Boolean(firewall.blockBots)
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    let settled = false;
    let forceTimer;
    let fallbackTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(fallbackTimer);
      resolve();
    };
    forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      fallbackTimer = setTimeout(finish, 1500);
      fallbackTimer.unref?.();
    }, 3000);
    forceTimer.unref?.();
    try {
      server.close(finish);
      server.closeIdleConnections?.();
    } catch {
      finish();
    }
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, child, timeoutMs, host = '127.0.0.1') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onChildError = (error) => finish(reject, new Error(`Node process could not start: ${error.message}`));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      child.off('error', onChildError);
      callback(value);
    };
    child.once('error', onChildError);
    const attempt = () => {
      if (settled) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
        return finish(reject, new Error(`Node process exited with ${detail} before opening its port.`));
      }
      const socket = net.connect({ host, port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.removeAllListeners();
        socket.destroy();
        finish(resolve);
      });
      const retry = () => {
        socket.removeAllListeners();
        socket.destroy();
        if (settled) return;
        if (Date.now() - started >= timeoutMs) {
          finish(reject, new Error(`Node server did not listen on PORT=${port} within ${Math.round(timeoutMs / 1000)} seconds.`));
        } else {
          setTimeout(attempt, 250).unref?.();
        }
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}


function siteIsolation(site) {
  return site?.runtime_isolation === 'docker' ? 'docker' : 'process';
}

function dockerContainerName(siteId) { return `sham-site-${Number(siteId)}`; }

class SiteManager {
  constructor(db) {
    this.db = db;
    this.running = new Map();
    this.starting = new Map();
    this.installing = new Map();
    this.installProcesses = new Map();
    this.installActive = 0;
    this.installQueue = [];
    this.installStopping = false;
    this.errors = new Map();
    this.events = [];
    this.minifyCache = new Map();
    this.minifyCacheBytes = 0;
    this.minifyPending = new Map();
    this.minifyWorkers = new Set();
    this.minifyQueue = [];
    this.minifyStopping = false;
    this.minifyBusyLoggedAt = 0;
    this.compressionActive = 0;
    this.compressionOperations = new Set();
    this.compressionQueue = [];
    this.compressionStopping = false;
    this.compressionBusyLoggedAt = 0;
    this.pendingStats = new Map();
    this.pendingVisitors = new Map();
    this.statsFlushImmediate = null;
    this.runtimeLogFlushImmediate = null;
    this.runtimeLogStopping = false;
    this.pendingRuntimeLogs = [];
    this.runtimeLogWrites = 0;
    this.firewallCache = new Map();
    this.firewallHits = new Map();
    this.statsFlushCount = 0;
    this.healthState = new Map();
    this.healthCheckPromise = null;
    this.healthStopping = false;
    this.restartHistory = new Map();
    this.restartTimers = new Map();
    this.operations = null;
    this.privacyCache = { mode: 'mask', loadedAt: 0 };
    this.writeTotalStats = db.prepare(`
      INSERT INTO site_stats (site_id, total_requests, total_bytes, total_errors, total_response_ms, last_request_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(site_id) DO UPDATE SET
        total_requests = total_requests + excluded.total_requests,
        total_bytes = total_bytes + excluded.total_bytes,
        total_errors = total_errors + excluded.total_errors,
        total_response_ms = total_response_ms + excluded.total_response_ms,
        last_request_at = CURRENT_TIMESTAMP
    `);
    this.writeDailyStats = db.prepare(`
      INSERT INTO site_daily_stats (site_id, day, requests, bytes, errors, response_ms)
      VALUES (?, date('now'), ?, ?, ?, ?)
      ON CONFLICT(site_id, day) DO UPDATE SET
        requests = requests + excluded.requests,
        bytes = bytes + excluded.bytes,
        errors = errors + excluded.errors,
        response_ms = response_ms + excluded.response_ms
    `);
    this.writeVisitorStats = db.prepare(`
      INSERT INTO site_visitor_stats (site_id, ip, country, requests, bytes, errors, last_request_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(site_id, ip, country) DO UPDATE SET
        requests = requests + excluded.requests,
        bytes = bytes + excluded.bytes,
        errors = errors + excluded.errors,
        last_request_at = CURRENT_TIMESTAMP
    `);
    this.pruneVisitorStats = db.prepare(`
      DELETE FROM site_visitor_stats
      WHERE site_id = ? AND (
        last_request_at < datetime('now', ?)
        OR rowid NOT IN (
        SELECT rowid FROM site_visitor_stats WHERE site_id = ? ORDER BY last_request_at DESC LIMIT 5000
        )
      )
    `);
    this.recordStatsTransaction = db.transaction((entries, visitors) => {
      for (const [siteId, values] of entries) {
        this.writeTotalStats.run(siteId, values.requests, values.bytes, values.errors, values.responseMs);
        this.writeDailyStats.run(siteId, values.requests, values.bytes, values.errors, values.responseMs);
      }
      for (const values of visitors) {
        this.writeVisitorStats.run(values.siteId, values.ip, values.country, values.requests, values.bytes, values.errors);
      }
    });
    this.writeRuntimeLog = db.prepare('INSERT INTO runtime_logs (site_id, level, message, context_json) VALUES (?, ?, ?, ?)');
    this.writeRuntimeLogsTransaction = db.transaction((rows) => {
      for (const row of rows) {
        try {
          this.writeRuntimeLog.run(row.siteId, row.level, row.message, row.contextJson);
        } catch (error) {
          const foreignKeyFailure = row.siteId != null && (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY constraint failed/i.test(error.message));
          if (!foreignKeyFailure) throw error;
          this.writeRuntimeLog.run(null, row.level, row.message, row.contextJson);
        }
      }
    });
    this.pruneRuntimeLogs = db.prepare("DELETE FROM runtime_logs WHERE created_at < datetime('now', ?)");
    try {
      const retention = Math.min(Math.max(Number(db.prepare("SELECT value FROM settings WHERE key = 'log_retention_days'").get()?.value || 30), 1), 3650);
      this.pruneRuntimeLogs.run(`-${retention} days`);
    } catch (error) {
      console.error(`[orchestrator] Could not prune runtime logs during startup: ${error.message}`);
    }
    this.healthTimer = setInterval(() => this.runHealthChecks(), 5000);
    this.healthTimer.unref?.();
    this.statsTimer = setInterval(() => {
      try { this.flushStats(); }
      catch (error) { this.log(null, 'error', `Could not flush request statistics: ${error.message}`); }
    }, STATS_FLUSH_INTERVAL_MS);
    this.statsTimer.unref?.();
    this.firewallTimer = setInterval(() => {
      const cutoff = Date.now() - 120_000;
      for (const [key, value] of this.firewallHits) if (value.windowStart < cutoff) this.firewallHits.delete(key);
    }, 60_000);
    this.firewallTimer.unref?.();
  }

  setOperations(operations) { this.operations = operations; }

  pumpMinifiers() {
    if (this.minifyStopping) return;
    while (this.minifyWorkers.size < MINIFY_WORKERS && this.minifyQueue.length) {
      const job = this.minifyQueue.shift();
      let worker;
      try {
        worker = new Worker(path.join(__dirname, 'minify-worker.js'), { workerData: job.task });
      } catch (error) {
        job.reject(error);
        continue;
      }
      this.minifyWorkers.add(worker);
      let result = null;
      let workerError = null;
      const finish = () => {
        this.minifyWorkers.delete(worker);
        if (workerError) job.reject(workerError);
        else if (!result?.ok) job.reject(new Error(result?.error || 'Asset transformation worker failed.'));
        else job.resolve(result.output);
        this.pumpMinifiers();
      };
      worker.once('message', (message) => { result = message; });
      worker.once('error', (error) => { workerError = error; });
      worker.once('exit', (code) => {
        if (code !== 0 && !workerError) workerError = new Error(`Asset transformation worker exited with code ${code}.`);
        finish();
      });
    }
  }

  runMinifier(task) {
    if (this.minifyStopping) return Promise.reject(new Error('Asset transformation is shutting down.'));
    if (this.minifyWorkers.size + this.minifyQueue.length >= MINIFY_QUEUE_LIMIT) {
      return Promise.reject(new Error('Asset transformation queue is full.'));
    }
    return new Promise((resolve, reject) => {
      this.minifyQueue.push({ task, resolve, reject });
      this.pumpMinifiers();
    });
  }

  pumpCompressions() {
    if (this.compressionStopping) return;
    while (this.compressionActive < COMPRESSION_WORKERS && this.compressionQueue.length) {
      const job = this.compressionQueue.shift();
      this.compressionActive += 1;
      const operation = Promise.resolve()
        .then(job.work)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.compressionOperations.delete(operation);
          this.compressionActive = Math.max(0, this.compressionActive - 1);
          this.pumpCompressions();
        });
      this.compressionOperations.add(operation);
    }
  }

  runCompression(work) {
    if (this.compressionStopping) return Promise.reject(new Error('Static compression is shutting down.'));
    if (this.compressionActive + this.compressionQueue.length >= COMPRESSION_QUEUE_LIMIT) {
      return Promise.reject(new Error('Static compression queue is full.'));
    }
    return new Promise((resolve, reject) => {
      this.compressionQueue.push({ work, resolve, reject });
      this.pumpCompressions();
    });
  }

  scheduleStatsFlush() {
    if (this.statsFlushImmediate) return;
    this.statsFlushImmediate = setImmediate(() => {
      this.statsFlushImmediate = null;
      try { this.flushStats(); }
      catch (error) { this.log(null, 'error', `Could not flush request statistics: ${error.message}`); }
    });
    this.statsFlushImmediate.unref?.();
  }

  scheduleRuntimeLogFlush() {
    if (this.runtimeLogStopping || this.runtimeLogFlushImmediate) return;
    this.runtimeLogFlushImmediate = setImmediate(() => {
      this.runtimeLogFlushImmediate = null;
      this.flushRuntimeLogs();
    });
    this.runtimeLogFlushImmediate.unref?.();
  }

  flushRuntimeLogs(maxRows = 500) {
    if (!this.pendingRuntimeLogs.length) return true;
    const bounded = Math.min(Math.max(Number(maxRows) || 500, 1), 10_000);
    const rows = this.pendingRuntimeLogs.splice(0, bounded);
    try {
      this.writeRuntimeLogsTransaction(rows);
      this.runtimeLogWrites += rows.length;
      if (this.runtimeLogWrites >= 1000) {
        this.runtimeLogWrites %= 1000;
        const days = Math.min(Math.max(Number(this.db.prepare("SELECT value FROM settings WHERE key = 'log_retention_days'").get()?.value || 30), 1), 3650);
        this.pruneRuntimeLogs.run(`-${days} days`);
      }
      if (this.pendingRuntimeLogs.length) this.scheduleRuntimeLogFlush();
      return true;
    } catch (error) {
      this.pendingRuntimeLogs.unshift(...rows);
      if (this.pendingRuntimeLogs.length > 10_000) this.pendingRuntimeLogs.splice(0, this.pendingRuntimeLogs.length - 10_000);
      console.error(`[orchestrator] Could not persist runtime logs: ${error.message}`);
      return false;
    }
  }

  log(siteId, level, message, context = null) {
    let contextJson = null;
    if (context != null) {
      try { contextJson = JSON.stringify(context); }
      catch (error) { contextJson = JSON.stringify({ serializationError: error.message }); }
    }
    const event = { siteId, level, message: String(message).slice(0, 4000), context, timestamp: new Date().toISOString() };
    this.events.unshift(event);
    this.events = this.events.slice(0, 500);
    this.pendingRuntimeLogs.push({
      siteId: siteId || null,
      level: level === 'error' ? 'error' : 'info',
      message: event.message,
      contextJson
    });
    if (this.pendingRuntimeLogs.length > 10_000) this.pendingRuntimeLogs.splice(0, this.pendingRuntimeLogs.length - 10_000);
    this.scheduleRuntimeLogFlush();
    const prefix = siteId ? `[site:${siteId}]` : '[orchestrator]';
    const logger = level === 'error' ? console.error : console.log;
    logger(`${prefix} ${event.message}`);
  }

  listEvents(limit = 100) {
    this.flushRuntimeLogs();
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
    try {
      return this.db.prepare(`SELECT site_id AS siteId, level, message, context_json AS contextJson, created_at AS timestamp FROM runtime_logs ORDER BY id DESC LIMIT ?`).all(bounded)
        .map((row) => ({ ...row, context: row.contextJson ? (() => { try { return JSON.parse(row.contextJson); } catch { return null; } })() : null }));
    } catch { return this.events.slice(0, bounded); }
  }

  getSite(id) {
    return hydrateSite(this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
  }

  statusFor(id) {
    const numericId = Number(id);
    const runtime = this.running.get(numericId);
    const health = this.healthState.get(numericId) || null;
    const recentRestarts = (this.restartHistory.get(numericId) || []).filter((time) => Date.now() - time < 10 * 60_000);
    return {
      running: Boolean(runtime),
      error: this.errors.get(numericId) || null,
      pid: runtime?.child?.pid || null,
      internalPort: runtime?.internalPort || null,
      protocol: runtime?.protocol || null,
      health,
      restarts: recentRestarts.length,
      connections: runtime?.server?._connections || 0,
      webSockets: runtime?.webSockets?.size || 0,
      isolation: runtime?.isolation || siteIsolation(this.getSite(numericId)),
      anubis: Boolean(this.operations?.anubisTarget(numericId))
    };
  }

  decorate(site) {
    const runtime = this.statusFor(site.id);
    const protocol = runtime.protocol || (site.ssl_enabled ? 'https' : 'http');
    const host = hostForUrl(site.domain || (['0.0.0.0', '::'].includes(site.bind_host) ? 'localhost' : site.bind_host));
    const { EDGE_HTTP_PORT, EDGE_HTTPS_PORT } = require('./config');
    const publicProtocol = site.edge_enabled && site.ssl_enabled && EDGE_HTTPS_PORT ? 'https' : site.edge_enabled && EDGE_HTTP_PORT ? 'http' : protocol;
    const publicPort = site.edge_enabled ? (publicProtocol === 'https' ? EDGE_HTTPS_PORT : EDGE_HTTP_PORT) : site.port;
    const defaultPort = (publicProtocol === 'https' && publicPort === 443) || (publicProtocol === 'http' && publicPort === 80);
    return { ...site, runtime, url: `${publicProtocol}://${host}${defaultPort ? '' : `:${publicPort}`}` };
  }

  invalidateSiteCache(siteId = null) {
    if (siteId === null) {
      this.minifyCache.clear();
      this.minifyCacheBytes = 0;
      this.firewallCache.clear();
      return;
    }
    const site = this.getSite(siteId);
    const root = site ? path.join(SITES_DIR, site.directory_name) : null;
    for (const [key, entry] of this.minifyCache) {
      if (!root || entry.absolute?.startsWith(`${root}${path.sep}`)) {
        this.removeCachedEntry(key);
      }
    }
    this.minifyCacheBytes = Math.max(0, this.minifyCacheBytes);
    this.firewallCache.delete(Number(siteId));
  }

  privacyMode() {
    if (Date.now() - this.privacyCache.loadedAt > 60_000) {
      this.privacyCache = { mode: this.db.prepare("SELECT value FROM settings WHERE key = 'visitor_privacy_mode'").get()?.value || 'mask', loadedAt: Date.now() };
    }
    return this.privacyCache.mode;
  }

  privateIdentity(identity) {
    const mode = this.privacyMode();
    if (mode === 'none' || identity.ip === 'unknown') return identity;
    if (mode === 'hash') return { ...identity, ip: `anon-${crypto.createHmac('sha256', JWT_SECRET).update(identity.ip).digest('base64url').slice(0, 16)}` };
    if (net.isIP(identity.ip) === 4) return { ...identity, ip: identity.ip.replace(/\d+$/, '0') + '/24' };
    if (net.isIP(identity.ip) === 6) return { ...identity, ip: `${identity.ip.split(':').slice(0, 3).join(':')}::/48` };
    return identity;
  }

  queueStats(siteId, identity, bytes, errors, responseMs) {
    identity = this.privateIdentity(identity);
    const current = this.pendingStats.get(siteId) || { requests: 0, bytes: 0, errors: 0, responseMs: 0 };
    current.requests += 1;
    current.bytes += bytes;
    current.errors += errors;
    current.responseMs += responseMs;
    this.pendingStats.set(siteId, current);

    const visitorKey = `${siteId}\0${identity.ip}\0${identity.country}`;
    if (!this.pendingVisitors.has(visitorKey) && this.pendingVisitors.size >= VISITOR_PENDING_BUCKETS) {
      const oldestKey = this.pendingVisitors.keys().next().value;
      if (oldestKey !== undefined) this.pendingVisitors.delete(oldestKey);
    }
    const visitor = this.pendingVisitors.get(visitorKey) || { siteId, ip: identity.ip, country: identity.country, requests: 0, bytes: 0, errors: 0 };
    visitor.requests += 1;
    visitor.bytes += bytes;
    visitor.errors += errors;
    this.pendingVisitors.delete(visitorKey);
    this.pendingVisitors.set(visitorKey, visitor);
    if (current.requests >= 100 || this.pendingVisitors.size >= 500) this.scheduleStatsFlush();
  }

  flushStats() {
    if (!this.pendingStats.size && !this.pendingVisitors.size) return;
    const entries = [...this.pendingStats.entries()];
    const visitors = [...this.pendingVisitors.values()];
    this.pendingStats.clear();
    this.pendingVisitors.clear();
    try {
      this.recordStatsTransaction(entries, visitors);
      this.statsFlushCount += 1;
      if (this.statsFlushCount % 100 === 0) {
        const retention = `-${VISITOR_RETENTION_DAYS} days`;
        for (const siteId of new Set(visitors.map((item) => item.siteId))) this.pruneVisitorStats.run(siteId, retention, siteId);
      }
    } catch (error) {
      for (const [siteId, values] of entries) {
        const current = this.pendingStats.get(siteId) || { requests: 0, bytes: 0, errors: 0, responseMs: 0 };
        current.requests += values.requests;
        current.bytes += values.bytes;
        current.errors += values.errors;
        current.responseMs += values.responseMs;
        this.pendingStats.set(siteId, current);
      }
      for (const values of visitors) {
        const visitorKey = `${values.siteId}\0${values.ip}\0${values.country}`;
        if (!this.pendingVisitors.has(visitorKey) && this.pendingVisitors.size >= VISITOR_PENDING_BUCKETS) {
          const oldestKey = this.pendingVisitors.keys().next().value;
          if (oldestKey !== undefined) this.pendingVisitors.delete(oldestKey);
        }
        const current = this.pendingVisitors.get(visitorKey) || { ...values, requests: 0, bytes: 0, errors: 0 };
        current.requests += values.requests;
        current.bytes += values.bytes;
        current.errors += values.errors;
        this.pendingVisitors.delete(visitorKey);
        this.pendingVisitors.set(visitorKey, current);
      }
      throw error;
    }
  }

  trackResponse(site, req, res) {
    if (String(req.headers['user-agent'] || '') === 'SHAM-Health/1.0') return;
    const started = Date.now();
    const identity = requestIdentity(site, req);
    let bytes = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;
    res.write = function write(chunk, encoding, callback) {
      bytes += responseChunkBytes(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    res.end = function end(chunk, encoding, callback) {
      bytes += responseChunkBytes(chunk, encoding);
      return originalEnd.call(this, chunk, encoding, callback);
    };
    res.once('finish', () => {
      try {
        this.queueStats(site.id, identity, bytes, res.statusCode >= 400 ? 1 : 0, Math.max(0, Date.now() - started));
      } catch (error) {
        this.log(site.id, 'error', `Could not record request statistics: ${error.message}`);
      }
    });
  }

  compiledFirewall(site) {
    const key = JSON.stringify(site.firewall || {});
    const cached = this.firewallCache.get(site.id);
    if (cached?.key === key) return cached.value;
    const value = {
      blocked: buildIpBlockList(site.firewall.blockedIps),
      allowed: buildIpBlockList(site.firewall.allowedIps)
    };
    this.firewallCache.set(site.id, { key, value });
    return value;
  }

  matchingRedirect(site, req) {
    const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return req.url || '/'; } })();
    for (const rule of site.redirects || []) {
      if (!rule || typeof rule !== 'object') continue;
      const from = String(rule.from || '');
      let matches = false;
      if (rule.type === 'prefix') matches = pathname.startsWith(from);
      else matches = pathname === from;
      if (!matches) continue;
      const target = String(rule.to || '');
      if (!target || /[\r\n]/.test(target)) continue;
      return { status: [301, 302, 307, 308].includes(Number(rule.status)) ? Number(rule.status) : 308, target };
    }
    return null;
  }

  errorPage(site, status, fallback) {
    const configured = site.errorPages?.[String(status)] || site.errorPages?.default;
    if (!configured) return { type: 'text/plain; charset=utf-8', body: fallback };
    return { type: 'text/html; charset=utf-8', body: String(configured).slice(0, 256 * 1024) };
  }

  operationalGuard(site, req, res) {
    const redirect = this.matchingRedirect(site, req);
    if (redirect) {
      res.statusCode = redirect.status;
      res.setHeader('Location', redirect.target);
      res.end();
      return false;
    }
    if (site.maintenance_enabled && !/^SHAM-Health\//.test(String(req.headers['user-agent'] || ''))) {
      const page = site.maintenance_html?.trim() || '<!doctype html><meta charset="utf-8"><title>Maintenance</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#120a20;color:#f7f2ff}main{max-width:40rem;padding:2rem;text-align:center}</style><main><h1>Temporarily unavailable</h1><p>This site is undergoing maintenance. Please try again shortly.</p></main>';
      res.statusCode = 503;
      res.setHeader('Retry-After', '300');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page);
      return false;
    }
    return true;
  }

  checkAccess(site, req) {
    const identity = requestIdentity(site, req);
    if (site.domain_only && requestHostname(req) !== site.domain) {
      return { allowed: false, status: 421, message: 'This site is only available through its configured domain.', identity };
    }
    const firewall = site.firewall || {};
    if (!site.firewall_enabled || !['local', 'both'].includes(firewall.mode)) return { allowed: true, identity };

    const contentLengthHeader = req.headers['content-length'];
    const contentLength = contentLengthHeader === undefined ? 0 : Number(contentLengthHeader);
    if (firewall.maxBodyKb > 0 && req.headers['transfer-encoding'] && contentLengthHeader === undefined) {
      return { allowed: false, status: 413, message: 'Chunked request bodies are not accepted while a firewall body limit is enabled.', identity };
    }
    if (firewall.maxBodyKb > 0 && (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > firewall.maxBodyKb * 1024)) {
      return { allowed: false, status: 413, message: 'Request blocked by the site firewall.', identity };
    }
    const compiled = this.compiledFirewall(site);
    const ipVersion = net.isIP(identity.ip);
    const ipType = ipVersion === 6 ? 'ipv6' : 'ipv4';
    if (firewall.allowedIps.length && (!ipVersion || !compiled.allowed.check(identity.ip, ipType))) {
      return { allowed: false, status: 403, message: 'Request blocked by the site firewall.', identity };
    }
    if (firewall.blockedIps.length && ipVersion && compiled.blocked.check(identity.ip, ipType)) {
      return { allowed: false, status: 403, message: 'Request blocked by the site firewall.', identity };
    }
    if (firewall.allowedCountries.length && !firewall.allowedCountries.includes(identity.country)) {
      return { allowed: false, status: 403, message: 'Request blocked by the site firewall.', identity };
    }
    if (firewall.blockedCountries.includes(identity.country)) {
      return { allowed: false, status: 403, message: 'Request blocked by the site firewall.', identity };
    }
    if (firewall.blockBots && /(?:bot|crawler|spider|scraper|headless|curl|wget)/i.test(String(req.headers['user-agent'] || ''))) {
      return { allowed: false, status: 403, message: 'Automated client blocked by the site firewall.', identity };
    }
    if (firewall.rateLimitPerMinute > 0) {
      const key = `${site.id}:${identity.ip}`;
      const now = Date.now();
      if (!this.firewallHits.has(key) && this.firewallHits.size >= FIREWALL_RATE_LIMIT_BUCKETS) {
        const oldestKey = this.firewallHits.keys().next().value;
        if (oldestKey !== undefined) this.firewallHits.delete(oldestKey);
      }
      let hit = this.firewallHits.get(key);
      if (!hit || now - hit.windowStart >= 60_000) hit = { windowStart: now, count: 0 };
      hit.count += 1;
      this.firewallHits.delete(key);
      this.firewallHits.set(key, hit);
      if (hit.count > firewall.rateLimitPerMinute) {
        return {
          allowed: false,
          status: 429,
          message: 'Too many requests. Try again shortly.',
          identity,
          retryAfter: Math.max(1, Math.ceil((hit.windowStart + 60_000 - now) / 1000))
        };
      }
    }
    return { allowed: true, identity };
  }

  guardRequest(site, req, res) {
    if (!this.operationalGuard(site, req, res)) return false;
    const result = this.checkAccess(site, req);
    if (result.allowed) return true;
    if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
    res.statusCode = result.status;
    const page = this.errorPage(site, result.status, result.message);
    res.setHeader('Content-Type', page.type);
    res.end(page.body);
    return false;
  }

  publicServer(site, handler) {
    if (site.ssl_enabled) {
      if (!site.domain || !hasCertificate(site.domain)) throw new Error('SSL is enabled but the certificate files are missing.');
      const certificate = certbotPaths(site.domain);
      return {
        protocol: 'https',
        server: https.createServer({ key: fs.readFileSync(certificate.key), cert: fs.readFileSync(certificate.cert) }, handler)
      };
    }
    return { protocol: 'http', server: http.createServer(handler) };
  }

  applyHeaders(site, res, req = null) {
    const preset = site.security_preset || 'balanced';
    if (preset !== 'off') {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', preset === 'strict' ? 'no-referrer' : 'strict-origin-when-cross-origin');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      if (site.ssl_enabled) res.setHeader('Strict-Transport-Security', preset === 'strict' ? 'max-age=31536000; includeSubDomains' : 'max-age=31536000');
      const csp = site.csp || (preset === 'strict'
        ? "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests"
        : preset === 'balanced' ? "object-src 'none'; base-uri 'self'; frame-ancestors 'none'" : '');
      if (csp) res.setHeader('Content-Security-Policy', csp);
    }
    for (const [name, value] of Object.entries(site.headers || {})) res.setHeader(name, value);
    if (req) {
      const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/'; } })();
      for (const rule of site.cacheRules || []) {
        if (!rule || typeof rule !== 'object') continue;
        const pattern = String(rule.path || '');
        if (!pattern || !(rule.type === 'prefix' ? pathname.startsWith(pattern) : pathname === pattern)) continue;
        const seconds = Math.min(Math.max(Number(rule.seconds) || 0, 0), 31536000);
        res.setHeader('Cache-Control', seconds > 0 ? `public, max-age=${seconds}${rule.immutable ? ', immutable' : ''}` : 'no-store');
        break;
      }
    }
  }

  removeCachedEntry(key) {
    const entry = this.minifyCache.get(key);
    if (!entry) return;
    this.minifyCache.delete(key);
    this.minifyCacheBytes = Math.max(0, this.minifyCacheBytes - Number(entry.cacheBytes || cacheEntryBytes(entry)));
    if (entry.cacheKey === key) entry.cacheKey = null;
  }

  touchCachedEntry(entry) {
    const key = entry?.cacheKey;
    if (!key || this.minifyCache.get(key) !== entry) return;
    this.minifyCache.delete(key);
    this.minifyCache.set(key, entry);
  }

  trimMinifyCache(protectedKey = null) {
    while (this.minifyCacheBytes > MINIFY_CACHE_BYTES && this.minifyCache.size) {
      let candidate = this.minifyCache.keys().next().value;
      if (candidate === protectedKey && this.minifyCache.size > 1) {
        candidate = [...this.minifyCache.keys()].find((key) => key !== protectedKey);
      }
      this.removeCachedEntry(candidate);
    }
  }

  cacheMinified(key, absolute, entry) {
    entry.encoded ||= {};
    entry.encodedPending ||= {};
    entry.cacheBytes = cacheEntryBytes(entry);
    entry.cacheKey = null;
    if (entry.cacheBytes > MINIFY_CACHE_BYTES) return;
    this.removeCachedEntry(key);
    for (const [existingKey, existing] of this.minifyCache) {
      if (existing.absolute === absolute && existingKey !== key) this.removeCachedEntry(existingKey);
    }
    entry.cacheKey = key;
    this.minifyCache.set(key, entry);
    this.minifyCacheBytes += entry.cacheBytes;
    this.trimMinifyCache(key);
  }

  async minifiedFile(site, absolute) {
    const stat = await fs.promises.stat(absolute);
    if (stat.size > MINIFY_MAX_BYTES) return null;
    const key = `${absolute}:${stat.mtimeMs}:${stat.size}:${site.minify ? 1 : 0}:${site.obfuscate ? 1 : 0}`;
    const cached = this.minifyCache.get(key);
    if (cached) {
      this.minifyCache.delete(key);
      this.minifyCache.set(key, cached);
      return cached;
    }
    if (this.minifyPending.has(key)) return this.minifyPending.get(key);

    const pending = (async () => {
      const extension = path.extname(absolute).toLowerCase();
      if (this.minifyWorkers.size + this.minifyQueue.length >= MINIFY_QUEUE_LIMIT) {
        const now = Date.now();
        if (now - this.minifyBusyLoggedAt > 60_000) {
          this.minifyBusyLoggedAt = now;
          this.log(site.id, 'error', 'Asset transformation queue is full; temporarily serving original files.');
        }
        return null;
      }
      const source = await fs.promises.readFile(absolute, 'utf8');
      let output = source;
      try {
        output = await this.runMinifier({
          source,
          extension,
          minify: Boolean(site.minify),
          obfuscate: Boolean(site.obfuscate)
        });
      } catch (error) {
        this.log(site.id, 'error', `Asset transformation failed for ${path.basename(absolute)}; serving the original file: ${error.message}`);
        output = source;
      }
      const data = Buffer.from(output, 'utf8');
      const digest = crypto.createHash('sha256').update(data).digest('base64url').slice(0, 24);
      const entry = {
        absolute,
        data,
        bytes: data.length,
        lastModified: stat.mtime.toUTCString(),
        etag: `"${digest}"`
      };
      this.cacheMinified(key, absolute, entry);
      return entry;
    })();

    this.minifyPending.set(key, pending);
    try { return await pending; }
    finally { this.minifyPending.delete(key); }
  }

  acceptedEncoding(req) {
    const accepted = new Map();
    for (const item of String(req.headers['accept-encoding'] || '').toLowerCase().split(',')) {
      const [nameRaw, ...parameters] = item.trim().split(';');
      const name = nameRaw.trim();
      if (!name) continue;
      let quality = 1;
      for (const parameter of parameters) {
        const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameter.trim());
        if (match) quality = Number(match[1]);
      }
      accepted.set(name, Math.max(accepted.get(name) || 0, quality));
    }
    const wildcard = accepted.get('*') || 0;
    const brotli = accepted.has('br') ? accepted.get('br') : wildcard;
    const gzip = accepted.has('gzip') ? accepted.get('gzip') : wildcard;
    if (brotli > 0 && brotli >= gzip) return 'br';
    if (gzip > 0) return 'gzip';
    return null;
  }

  async encodedData(entry, encoding) {
    if (!encoding || entry.data.length < 1024) return { data: entry.data, encoding: null };
    entry.encoded ||= {};
    entry.encodedPending ||= {};
    if (entry.encoded[encoding]) {
      this.touchCachedEntry(entry);
      return { data: entry.encoded[encoding], encoding };
    }
    if (entry.encodedPending[encoding]) {
      try { return { data: await entry.encodedPending[encoding], encoding }; }
      catch { return { data: entry.data, encoding: null }; }
    }

    const pending = this.runCompression(() => encoding === 'br'
      ? brotliAsync(entry.data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : gzipAsync(entry.data, { level: 6 }));
    entry.encodedPending[encoding] = pending;
    try {
      const data = await pending;
      entry.encoded[encoding] = data;
      const key = entry.cacheKey;
      if (key && this.minifyCache.get(key) === entry) {
        const previousBytes = Number(entry.cacheBytes || entry.bytes || 0);
        entry.cacheBytes = cacheEntryBytes(entry);
        this.minifyCacheBytes += entry.cacheBytes - previousBytes;
        this.touchCachedEntry(entry);
        this.trimMinifyCache(key);
      }
      return { data, encoding };
    } catch (error) {
      const now = Date.now();
      if (now - this.compressionBusyLoggedAt > 60_000) {
        this.compressionBusyLoggedAt = now;
        this.log(null, 'error', `Static compression was skipped; serving the original response: ${error.message}`);
      }
      return { data: entry.data, encoding: null };
    } finally {
      delete entry.encodedPending[encoding];
    }
  }

  async plainFile(site, absolute) {
    const stat = await fs.promises.stat(absolute);
    if (stat.size > MINIFY_MAX_BYTES) return null;
    const key = `plain:${absolute}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.minifyCache.get(key);
    if (cached) {
      this.touchCachedEntry(cached);
      return cached;
    }
    const data = await fs.promises.readFile(absolute);
    const digest = crypto.createHash('sha256').update(data).digest('base64url').slice(0, 24);
    const entry = { absolute, data, bytes: data.length, lastModified: stat.mtime.toUTCString(), etag: `"${digest}"` };
    this.cacheMinified(key, absolute, entry);
    return entry;
  }

  async precompressedFile(absolute, encoding) {
    if (!encoding) return null;
    const candidate = `${absolute}.${encoding === 'br' ? 'br' : 'gz'}`;
    try {
      const [sourceStat, encodedStat] = await Promise.all([fs.promises.stat(absolute), fs.promises.stat(candidate)]);
      if (!encodedStat.isFile() || encodedStat.mtimeMs < sourceStat.mtimeMs) return null;
      return { path: candidate, stat: encodedStat, encoding };
    } catch { return null; }
  }

  async sendEntry(site, absolute, entry, req, res) {
    res.type(path.extname(absolute));
    res.setHeader('ETag', entry.etag);
    res.setHeader('Last-Modified', entry.lastModified);
    res.setHeader('Cache-Control', site.cache_seconds > 0 ? `public, max-age=${site.cache_seconds}` : 'no-cache');
    let encoded = { data: entry.data, encoding: null };
    if (site.compression && COMPRESSIBLE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      encoded = await this.encodedData(entry, this.acceptedEncoding(req));
      res.setHeader('Vary', 'Accept-Encoding');
      if (encoded.encoding) res.setHeader('Content-Encoding', encoded.encoding);
    }
    res.setHeader('Content-Length', String(encoded.data.length));
    if (req.fresh) { res.status(304).end(); return true; }
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(encoded.data);
    return true;
  }

  async sendPlainOptimized(site, absolute, req, res) {
    const encoding = site.compression ? this.acceptedEncoding(req) : null;
    const sidecar = await this.precompressedFile(absolute, encoding);
    if (sidecar) {
      const etag = `W/"${Math.floor(sidecar.stat.mtimeMs).toString(16)}-${sidecar.stat.size.toString(16)}-${sidecar.encoding}"`;
      res.type(path.extname(absolute));
      res.setHeader('Content-Encoding', sidecar.encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', sidecar.stat.mtime.toUTCString());
      res.setHeader('Cache-Control', site.cache_seconds > 0 ? `public, max-age=${site.cache_seconds}` : 'no-cache');
      if (req.fresh) { res.status(304).end(); return true; }
      res.setHeader('Content-Length', String(sidecar.stat.size));
      if (req.method === 'HEAD') { res.end(); return true; }
      fs.createReadStream(sidecar.path).on('error', (error) => {
        if (!res.headersSent) res.status(404).end();
        else res.destroy(error);
      }).pipe(res);
      return true;
    }
    const entry = await this.plainFile(site, absolute);
    return entry ? this.sendEntry(site, absolute, entry, req, res) : false;
  }

  async sendMinified(site, absolute, req, res) {
    const entry = await this.minifiedFile(site, absolute);
    if (!entry) return false;
    return this.sendEntry(site, absolute, entry, req, res);
  }

  createStaticApp(site, root, entry) {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      this.applyHeaders(site, res, req);
      next();
    });

    app.use(async (req, res, next) => {
      if (!['GET', 'HEAD'].includes(req.method) || req.path === '/') return next();
      try {
        const decoded = decodeURIComponent(req.path);
        const relative = safeRelativePath(decoded.replace(/^\/+/, ''), 'Request path');
        const absolute = path.resolve(root, ...relative.split('/'));
        if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) return res.sendStatus(404);
        try {
          await fs.promises.access(absolute);
          if (!(await realFileInsideAsync(root, absolute))) return res.sendStatus(404);
        } catch (error) {
          if (error.code !== 'ENOENT') return res.sendStatus(404);
        }
        next();
      } catch {
        res.sendStatus(404);
      }
    });

    app.use(async (req, res, next) => {
      if (!['GET', 'HEAD'].includes(req.method)) return next();
      try {
        const decoded = decodeURIComponent(req.path);
        const relative = decoded === '/' ? site.entry_file : safeRelativePath(decoded.replace(/^\/+/, ''), 'Request path');
        const absolute = path.resolve(root, ...relative.split('/'));
        const extension = path.extname(absolute).toLowerCase();
        if (!COMPRESSIBLE_EXTENSIONS.has(extension)) return next();
        if (!(await realFileInsideAsync(root, absolute))) return next();
        const transformed = (site.minify || site.obfuscate) && ['.html', '.htm', '.css', '.js', '.mjs'].includes(extension);
        if (transformed ? await this.sendMinified(site, absolute, req, res) : site.compression && await this.sendPlainOptimized(site, absolute, req, res)) return;
        next();
      } catch (error) {
        this.log(site.id, 'error', `Could not serve an optimized asset: ${error.message}`);
        next();
      }
    });

    app.use(express.static(root, {
      index: false,
      dotfiles: 'deny',
      fallthrough: true,
      maxAge: Math.max(0, site.cache_seconds) * 1000
    }));

    app.use(async (req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(404);
      if (req.path === '/' || site.spa_fallback) {
        if (!(await realFileInsideAsync(root, entry))) return res.status(404).type('text/plain').send('Entry file not found');
        if ((site.minify || site.obfuscate) && ['.html', '.htm'].includes(path.extname(entry).toLowerCase())) {
          if (await this.sendMinified(site, entry, req, res)) return;
        } else if (site.compression && await this.sendPlainOptimized(site, entry, req, res)) return;
        return res.sendFile(entry);
      }
      const page = this.errorPage(site, 404, 'Not found');
      res.status(404).type(page.type).send(page.body);
    });
    return app;
  }

  async dependencyFingerprint(root) {
    const hash = crypto.createHash('sha256');
    for (const filename of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
      const absolute = path.join(root, filename);
      if (await realFileInsideAsync(root, absolute)) {
        hash.update(filename);
        hash.update(await fs.promises.readFile(absolute));
      }
    }
    return hash.digest('hex');
  }

  async dependenciesAreCurrent(root) {
    const marker = path.join(root, '.sham', 'dependency-state.json');
    try {
      const [modules, markerText] = await Promise.all([
        fs.promises.stat(path.join(root, 'node_modules')),
        fs.promises.readFile(marker, 'utf8')
      ]);
      if (!modules.isDirectory()) return false;
      const stored = JSON.parse(markerText);
      return stored.fingerprint === await this.dependencyFingerprint(root);
    } catch {
      return false;
    }
  }

  async ensureDependencies(site) {
    const root = path.join(SITES_DIR, site.directory_name);
    if (await this.dependenciesAreCurrent(root)) {
      this.log(site.id, 'info', 'Dependencies are already current; skipped npm install.');
      return;
    }
    await this.runInstall(site);
  }

  acquireInstallSlot() {
    if (this.installStopping) return Promise.reject(new Error('Dependency installation is shutting down.'));
    if (this.installActive < NPM_INSTALL_WORKERS) {
      this.installActive += 1;
      return Promise.resolve();
    }
    if (this.installQueue.length >= NPM_INSTALL_QUEUE_LIMIT) {
      return Promise.reject(new Error('Too many dependency installations are queued. Try again shortly.'));
    }
    return new Promise((resolve, reject) => this.installQueue.push({ resolve, reject }));
  }

  releaseInstallSlot() {
    const next = this.installQueue.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.installActive = Math.max(0, this.installActive - 1);
  }

  async runInstall(siteOrId) {
    const site = typeof siteOrId === 'object' ? siteOrId : this.getSite(siteOrId);
    if (!site) throw new Error('Site not found.');
    if (this.installing.has(site.id)) return this.installing.get(site.id);
    const operation = (async () => {
      await this.acquireInstallSlot();
      try { return await this._runInstall(site); }
      finally { this.releaseInstallSlot(); }
    })();
    this.installing.set(site.id, operation);
    try { return await operation; }
    finally { this.installing.delete(site.id); }
  }

  async _runInstall(site) {
    const root = path.join(SITES_DIR, site.directory_name);
    const packageFile = path.join(root, 'package.json');
    if (!(await realFileInsideAsync(root, packageFile))) throw new Error('A regular package.json file was not found in this website.');
    this.log(site.id, 'info', 'Running npm install --omit=dev…');
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await new Promise((resolve, reject) => {
      const child = spawn(command, ['install', '--omit=dev', '--no-audit', '--no-fund'], processOptions({
        cwd: root,
        env: buildEnvironment({ NODE_ENV: 'production' }),
        stdio: ['ignore', 'pipe', 'pipe']
      }));
      this.installProcesses.set(site.id, child);
      let output = '';
      let settled = false;
      let timedOut = false;
      let timer;
      let forceTimer;
      let fallbackTimer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        clearTimeout(fallbackTimer);
        if (this.installProcesses.get(site.id) === child) this.installProcesses.delete(site.id);
        callback(value);
      };
      const logChunk = (level, chunk) => {
        const text = chunk.toString();
        output = appendTail(output, text);
        for (const line of text.split(/\r?\n/).filter(Boolean)) this.log(site.id, level, `npm: ${line.slice(0, 1000)}`);
      };
      child.stdout.on('data', (chunk) => logChunk('info', chunk));
      child.stderr.on('data', (chunk) => logChunk('error', chunk));
      timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, 'SIGTERM');
        forceTimer = setTimeout(() => {
          terminateChild(child, 'SIGKILL');
          fallbackTimer = setTimeout(() => finish(reject, new Error('npm install timed out and did not exit after termination.')), 3000);
          fallbackTimer.unref?.();
        }, 2000);
        forceTimer.unref?.();
      }, NPM_INSTALL_TIMEOUT_MS);
      timer.unref?.();
      child.once('error', (error) => finish(reject, new Error(`npm could not start: ${error.message}`)));
      child.once('close', (code) => {
        if (timedOut) finish(reject, new Error('npm install timed out.'));
        else if (code === 0) finish(resolve);
        else finish(reject, new Error(`npm install exited with code ${code}. ${output.trim().slice(-1200)}`));
      });
    });
    const markerDir = path.join(root, '.sham');
    await fs.promises.mkdir(markerDir, { recursive: true });
    await fs.promises.writeFile(path.join(markerDir, 'dependency-state.json'), JSON.stringify({
      fingerprint: await this.dependencyFingerprint(root),
      installedAt: new Date().toISOString()
    }, null, 2), { mode: 0o600 });
    this.log(site.id, 'info', 'npm install completed.');
  }

  async startStatic(site, root, entry) {
    const app = this.createStaticApp(site, root, entry);
    const handler = (req, res) => {
      this.trackResponse(site, req, res);
      if (!this.guardRequest(site, req, res)) return;
      app(req, res);
    };
    const created = this.publicServer(site, handler);
    created.server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    created.server.headersTimeout = Math.min(60_000, HTTP_REQUEST_TIMEOUT_MS);
    created.server.keepAliveTimeout = 5000;
    if (site.max_connections > 0) created.server.maxConnections = site.max_connections;
    await listen(created.server, site.port, site.bind_host);
    return { server: created.server, app, protocol: created.protocol, type: 'static' };
  }

  async startNodeContainer(site, root, entry) {
    if (site.install_dependencies) await this.ensureDependencies(site);
    const internalPort = await freePort();
    const dataDir = path.join(SITE_DATA_DIR, String(site.id));
    await fs.promises.mkdir(dataDir, { recursive: true });
    const image = String(site.container_image || 'node:22-alpine').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(image)) throw new Error('Container image is invalid.');
    const rootMount = process.env.SHAM_DOCKER_HOST_DATA_PATH
      ? path.join(path.resolve(process.env.SHAM_DOCKER_HOST_DATA_PATH), 'sites', site.directory_name)
      : root;
    if (fs.existsSync('/.dockerenv') && !process.env.SHAM_DOCKER_HOST_DATA_PATH) {
      throw new Error('Docker-isolated sites require SHAM_DOCKER_HOST_DATA_PATH when SHAM itself runs in Docker.');
    }
    const dataMount = process.env.SHAM_DOCKER_HOST_DATA_PATH
      ? path.join(path.resolve(process.env.SHAM_DOCKER_HOST_DATA_PATH), 'site-data', String(site.id))
      : dataDir;
    const env = { NODE_ENV: 'production', PORT: String(internalPort), HOST: '0.0.0.0', SHAM_PUBLIC_PORT: String(site.port), SHAM_SITE_ID: String(site.id), SHAM_SITE_DOMAIN: site.domain || '', ...(this.operations?.siteEnvironment(site.id, 'runtime') || {}) };
    const containerizedControlPlane = fs.existsSync('/.dockerenv');
    const args = ['run', '--rm', '--name', dockerContainerName(site.id), '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only', '--pids-limit', String(site.pids_limit || 128), '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-v', `${rootMount}:/app:ro`, '-v', `${dataMount}:/data:rw`, '-w', '/app'];
    let internalHost = '127.0.0.1';
    if (containerizedControlPlane) {
      const network = site.outbound_network ? DOCKER_EGRESS_NETWORK : DOCKER_INTERNAL_NETWORK;
      if (!network) throw new Error(`Docker-isolated sites require ${site.outbound_network ? 'SHAM_DOCKER_EGRESS_NETWORK' : 'SHAM_DOCKER_INTERNAL_NETWORK'} when SHAM runs in Docker.`);
      args.push('--network', network);
      internalHost = dockerContainerName(site.id);
    } else {
      args.push('-p', `127.0.0.1:${internalPort}:${internalPort}`);
      if (!site.outbound_network) args.push('--network', await ensureDockerInternalNetwork());
    }
    if (site.memory_limit_mb > 0) args.push('--memory', `${site.memory_limit_mb}m`);
    if (site.cpu_limit > 0) args.push('--cpus', String(site.cpu_limit));
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
    args.push(image, 'node', entry.startsWith(root) ? path.relative(root, entry) : site.node_entry);
    const child = spawn(DOCKER_BIN, args, processOptions({ env: operatorEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }));
    child.stdout.on('data', (chunk) => this.log(site.id, 'info', `container: ${chunk.toString().trim().slice(0, 1200)}`));
    child.stderr.on('data', (chunk) => this.log(site.id, 'error', `container: ${chunk.toString().trim().slice(0, 1200)}`));
    try { await waitForPort(internalPort, child, NODE_START_TIMEOUT_MS, internalHost); }
    catch (error) { terminateChild(child); await terminateAndWait(child); throw error; }
    return this.createNodeProxyRuntime(site, child, internalPort, 'docker', internalHost);
  }

  async createNodeProxyRuntime(site, child, internalPort, isolation = 'process', internalHost = '127.0.0.1') {
    const proxy = httpProxy.createProxyServer({ target: `http://${hostForUrl(internalHost)}:${internalPort}`, ws: true, xfwd: true, changeOrigin: false, timeout: HTTP_REQUEST_TIMEOUT_MS, proxyTimeout: HTTP_REQUEST_TIMEOUT_MS });
    proxy.on('proxyRes', (_proxyRes, proxyReq, res) => { this.applyHeaders(site, res, proxyReq); const current = this.errors.get(site.id); if (current?.startsWith('Proxy: ')) this.errors.delete(site.id); });
    proxy.on('error', (error, _req, responseOrSocket) => {
      this.errors.set(site.id, `Proxy: ${error.message}`);
      if (typeof responseOrSocket?.writeHead === 'function') {
        const page = this.errorPage(site, 502, 'Hosted Node.js server is unavailable.');
        if (!responseOrSocket.headersSent) responseOrSocket.writeHead(502, { 'Content-Type': page.type });
        responseOrSocket.end(page.body);
      } else responseOrSocket?.destroy?.();
    });
    const handler = (req, res) => { this.trackResponse(site, req, res); this.applyHeaders(site, res, req); if (!this.guardRequest(site, req, res)) return; proxy.web(req, res); };
    let created;
    try {
      created = this.publicServer(site, handler);
      created.server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
      created.server.headersTimeout = Math.min(60_000, HTTP_REQUEST_TIMEOUT_MS);
      created.server.keepAliveTimeout = 5000;
      if (site.max_connections > 0) created.server.maxConnections = site.max_connections;
      const webSockets = new Set();
      created.server.on('upgrade', (req, socket, head) => {
        const access = this.checkAccess(site, req);
        if (!access.allowed || !this.operationalGuard(site, req, { setHeader() {}, end() {}, set statusCode(_v) {} })) { socket.end(`HTTP/1.1 ${access.status || 503} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
        webSockets.add(socket);
        socket.once('close', () => webSockets.delete(socket));
        proxy.ws(req, socket, head);
      });
      await listen(created.server, site.port, site.bind_host);
      if (child.exitCode !== null || child.signalCode !== null) { proxy.close(); await closeServer(created.server); throw new Error(`${isolation === 'docker' ? 'Container' : 'Node process'} exited during startup.`); }
      const runtime = { server: created.server, protocol: created.protocol, type: 'node', proxy, child, internalPort, internalHost, stopping: false, exited: false, isolation, webSockets };
      child.once('exit', (code, signal) => {
        runtime.exited = true;
        if (runtime.stopping) return;
        if (this.running.get(site.id) === runtime) this.running.delete(site.id);
        const message = `${isolation === 'docker' ? 'Container' : 'Node process'} exited${code !== null ? ` with code ${code}` : ''}${signal ? ` after ${signal}` : ''}.`;
        this.errors.set(site.id, message); this.log(site.id, 'error', message); closeServer(runtime.server).catch(() => {}); runtime.proxy.close();
        if (site.restart_policy === 'always' || (site.restart_policy === 'on-failure' && code !== 0)) this.scheduleRestart(site, message).catch(() => {});
      });
      return runtime;
    } catch (error) { proxy.close(); await terminateAndWait(child); throw error; }
  }

  async startNode(site, root, entry) {
    if (site.runtime_isolation === 'docker') return this.startNodeContainer(site, root, entry);
    if (site.install_dependencies) await this.ensureDependencies(site);
    const internalPort = await freePort();
    const nodeArgs = site.memory_limit_mb > 0 ? [`--max-old-space-size=${site.memory_limit_mb}`, entry] : [entry];
    const child = spawn(process.execPath, nodeArgs, processOptions({
      cwd: root,
      env: runtimeEnvironment({
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: String(internalPort),
        HOST: '127.0.0.1',
        SHAM_PUBLIC_PORT: String(site.port),
        SHAM_SITE_ID: String(site.id),
        SHAM_SITE_DOMAIN: site.domain || '',
        ...(this.operations?.siteEnvironment(site.id, 'runtime') || {})
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    }));
    let logWindowStarted = Date.now();
    let logLines = 0;
    let suppressedLines = 0;
    const logChunk = (level, chunk) => {
      const now = Date.now();
      if (now - logWindowStarted >= 1000) {
        if (suppressedLines) this.log(site.id, 'error', `node: suppressed ${suppressedLines} excessive log lines`);
        logWindowStarted = now;
        logLines = 0;
        suppressedLines = 0;
      }
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        if (logLines >= 200) {
          suppressedLines += 1;
          continue;
        }
        logLines += 1;
        this.log(site.id, level, `node: ${line.slice(0, 1000)}`);
      }
    };
    child.stdout.on('data', (chunk) => logChunk('info', chunk));
    child.stderr.on('data', (chunk) => logChunk('error', chunk));

    try {
      await waitForPort(internalPort, child, NODE_START_TIMEOUT_MS);
    } catch (error) {
      await terminateAndWait(child);
      throw error;
    }

    return this.createNodeProxyRuntime(site, child, internalPort, 'process');
  }

  async start(siteOrId) {
    const site = typeof siteOrId === 'object' ? siteOrId : this.getSite(siteOrId);
    if (!site) throw new Error('Site not found.');
    if (this.running.has(site.id)) return;
    if (this.starting.has(site.id)) return this.starting.get(site.id);
    const operation = this._start(site);
    this.starting.set(site.id, operation);
    try { return await operation; }
    finally { this.starting.delete(site.id); }
  }

  async _start(site) {
    if (this.running.has(site.id)) return;

    const root = path.join(SITES_DIR, site.directory_name);
    const requiredRelative = site.runtime_type === 'node' ? site.node_entry : site.entry_file;
    const entry = path.join(root, ...requiredRelative.split('/'));
    if (!realFileInside(root, entry)) throw new Error(`Required file is missing or unsafe: ${requiredRelative}`);

    try {
      const runtime = site.runtime_type === 'node'
        ? await this.startNode(site, root, entry)
        : await this.startStatic(site, root, entry);
      this.running.set(site.id, runtime);
      try { await this.operations?.afterSiteStart(site, runtime); } catch (hookError) { this.running.delete(site.id); runtime.proxy?.close(); await closeServer(runtime.server); if (runtime.child) await terminateAndWait(runtime.child); throw new Error(`Site started but its protection layer failed: ${hookError.message}`); }
      if (runtime.exited || (runtime.child && (runtime.child.exitCode !== null || runtime.child.signalCode !== null))) {
        if (this.running.get(site.id) === runtime) this.running.delete(site.id);
        runtime.proxy?.close();
        await closeServer(runtime.server);
        const detail = runtime.child?.exitCode !== null ? `code ${runtime.child.exitCode}` : `signal ${runtime.child?.signalCode}`;
        throw new Error(`Node process exited with ${detail} during startup.`);
      }
      this.errors.delete(site.id);
      this.healthState.set(site.id, { status: 'starting', lastCheckAt: null, latencyMs: null, failures: 0, message: null });
      this.log(site.id, 'info', `Started ${site.name} (${site.runtime_type}) on ${site.bind_host}:${site.port}${site.ssl_enabled ? ' with TLS' : ''}`);
    } catch (error) {
      this.errors.set(site.id, error.message);
      this.log(site.id, 'error', `Could not start: ${error.message}`);
      throw error;
    }
  }

  async stop(id) {
    const numericId = Number(id);
    const restartTimer = this.restartTimers.get(numericId);
    if (restartTimer) { clearTimeout(restartTimer); this.restartTimers.delete(numericId); }
    if (this.starting.has(numericId)) {
      try { await this.starting.get(numericId); } catch { /* Startup already failed. */ }
    }
    const runtime = this.running.get(numericId);
    if (!runtime) {
      this.errors.delete(numericId);
      return;
    }
    runtime.stopping = true;
    await this.operations?.beforeSiteStop(this.getSite(numericId) || { id: numericId }, runtime).catch((error) => this.log(numericId, 'error', `Protection shutdown failed: ${error.message}`));
    await closeServer(runtime.server);
    runtime.proxy?.close();
    if (runtime.child && runtime.child.exitCode === null && runtime.child.signalCode === null) {
      await terminateAndWait(runtime.child, 5000);
    }
    if (runtime.isolation === 'docker') {
      await new Promise((resolve) => {
        const cleanup = spawn(DOCKER_BIN, ['rm', '-f', dockerContainerName(numericId)], { env: operatorEnvironment(), stdio: 'ignore' });
        cleanup.once('exit', resolve); cleanup.once('error', resolve); setTimeout(resolve, 5000).unref?.();
      });
    }
    this.running.delete(numericId);
    this.errors.delete(numericId);
    this.healthState.set(numericId, { status: 'stopped', lastCheckAt: new Date().toISOString(), latencyMs: null, failures: 0, message: null });
    this.log(numericId, 'info', 'Stopped site');
  }

  forgetSite(id) {
    const numericId = Number(id);
    this.pendingStats.delete(numericId);
    for (const [key, value] of this.pendingVisitors) if (value.siteId === numericId) this.pendingVisitors.delete(key);
    this.firewallCache.delete(numericId);
    for (const key of this.firewallHits.keys()) if (key.startsWith(`${numericId}:`)) this.firewallHits.delete(key);
    this.errors.delete(numericId);
    this.healthState.delete(numericId);
    this.restartHistory.delete(numericId);
    const timer = this.restartTimers.get(numericId);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(numericId);
    this.events = this.events.filter((event) => event.siteId !== numericId);
    for (const row of this.pendingRuntimeLogs) if (Number(row.siteId) === numericId) row.siteId = null;
  }

  async checkHealth(site, runtime) {
    const current = this.healthState.get(site.id) || { failures: 0, lastRun: 0 };
    if (Date.now() - Number(current.lastRun || 0) < site.health_check_interval * 1000) return;
    current.lastRun = Date.now();
    const started = Date.now();
    const client = runtime.protocol === 'https' ? https : http;
    const host = ['0.0.0.0', '::', 'localhost'].includes(site.bind_host) ? '127.0.0.1' : site.bind_host;
    const result = await new Promise((resolve) => {
      const request = client.request({ host, port: site.port, path: site.health_check_path || '/', method: 'GET', headers: { Host: site.domain || host, 'User-Agent': 'SHAM-Health/1.0' }, rejectUnauthorized: false, timeout: Math.min(5000, HTTP_REQUEST_TIMEOUT_MS) }, (response) => {
        response.resume();
        const statusCode = Number(response.statusCode || 0);
        resolve({
          ok: statusCode >= 200 && statusCode < 400,
          degraded: statusCode >= 400 && statusCode < 500,
          statusCode
        });
      });
      request.once('timeout', () => { request.destroy(); resolve({ ok: false, message: 'Health check timed out.' }); });
      request.once('error', (error) => resolve({ ok: false, message: error.message }));
      request.end();
    });
    current.lastCheckAt = new Date().toISOString();
    current.latencyMs = Date.now() - started;
    current.statusCode = result.statusCode || null;
    current.message = result.message || (result.degraded ? `Health endpoint returned HTTP ${result.statusCode}.` : null);
    current.failures = result.ok || result.degraded ? 0 : Number(current.failures || 0) + 1;
    current.status = result.ok ? 'healthy' : result.degraded ? 'degraded' : current.failures >= 3 ? 'unhealthy' : 'degraded';
    this.healthState.set(site.id, current);
    if (!result.ok && !result.degraded && current.failures === 3) {
      this.log(site.id, 'error', `Health check failed three times: ${current.message || `HTTP ${current.statusCode}`}`);
      await this.scheduleRestart(site, 'Health check failure');
    }
  }

  runHealthChecks() {
    if (this.healthStopping) return Promise.resolve();
    if (this.healthCheckPromise) return this.healthCheckPromise;
    const operation = Promise.allSettled([...this.running.entries()].map(async ([id, runtime]) => {
      const site = this.getSite(id);
      if (site) await this.checkHealth(site, runtime);
    })).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) {
        this.log(null, 'error', `Health monitor could not check ${failures.length} site${failures.length === 1 ? '' : 's'}.`, {
          errors: failures.slice(0, 5).map((failure) => String(failure.reason?.message || failure.reason || 'Unknown health-check error'))
        });
      }
    }).finally(() => {
      if (this.healthCheckPromise === operation) this.healthCheckPromise = null;
    });
    this.healthCheckPromise = operation;
    return operation;
  }

  async scheduleRestart(siteOrId, reason) {
    const site = typeof siteOrId === 'object' ? siteOrId : this.getSite(siteOrId);
    if (!site || !site.enabled || site.restart_policy === 'never' || this.restartTimers.has(site.id)) return;
    const history = (this.restartHistory.get(site.id) || []).filter((time) => Date.now() - time < 10 * 60_000);
    if (history.length >= site.max_restarts) {
      this.errors.set(site.id, `Crash-loop protection stopped automatic restarts after ${history.length} attempts in 10 minutes.`);
      this.log(site.id, 'error', `Crash-loop protection engaged. Last reason: ${reason}`);
      return;
    }
    const delay = Math.min(30_000, 1000 * (2 ** history.length));
    const timer = setTimeout(async () => {
      this.restartTimers.delete(site.id);
      history.push(Date.now());
      this.restartHistory.set(site.id, history);
      try { await this.restart(site.id); this.log(site.id, 'info', `Automatically restarted after ${reason}.`); }
      catch (error) { this.log(site.id, 'error', `Automatic restart failed: ${error.message}`); await this.scheduleRestart(site.id, error.message); }
    }, delay);
    timer.unref?.();
    this.restartTimers.set(site.id, timer);
  }

  async handleResourceLimit(id, kind) {
    const site = this.getSite(id);
    const runtime = this.running.get(Number(id));
    if (!site || !runtime || runtime.resourceLimitTriggered) return;
    runtime.resourceLimitTriggered = true;
    this.log(site.id, 'error', `${kind} resource limit exceeded; stopping the site process.`);
    await this.stop(site.id);
    await this.scheduleRestart(site, `${kind} resource limit`);
  }

  async restart(id) {
    await this.stop(id);
    await this.start(id);
  }

  async startEnabledSites() {
    const sites = this.db.prepare('SELECT * FROM sites WHERE enabled = 1 ORDER BY id').all().map(hydrateSite);
    for (const site of sites) {
      try { await this.start(site); }
      catch (error) {
        this.errors.set(site.id, error.message);
        this.log(site.id, 'error', `Could not start: ${error.message}`);
      }
    }
  }

  async stopAll() {
    clearInterval(this.statsTimer);
    clearInterval(this.firewallTimer);
    clearInterval(this.healthTimer);
    this.healthStopping = true;
    this.runtimeLogStopping = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    await this.healthCheckPromise?.catch(() => {});
    if (this.statsFlushImmediate) {
      clearImmediate(this.statsFlushImmediate);
      this.statsFlushImmediate = null;
    }
    if (this.runtimeLogFlushImmediate) {
      clearImmediate(this.runtimeLogFlushImmediate);
      this.runtimeLogFlushImmediate = null;
    }
    this.minifyStopping = true;
    this.compressionStopping = true;
    for (const job of this.compressionQueue.splice(0)) job.reject(new Error('Static compression stopped during shutdown.'));
    await Promise.allSettled([...this.compressionOperations]);
    const queuedMinifiers = this.minifyQueue.splice(0);
    for (const job of queuedMinifiers) job.reject(new Error('Asset transformation stopped during shutdown.'));
    await Promise.allSettled([...this.minifyWorkers].map((worker) => worker.terminate()));

    this.installStopping = true;
    const queuedInstalls = this.installQueue.splice(0);
    for (const job of queuedInstalls) job.reject(new Error('Dependency installation stopped during shutdown.'));
    const installChildren = [...this.installProcesses.values()];
    await Promise.allSettled(installChildren.map((child) => terminateAndWait(child, 2000)));
    await Promise.allSettled([...this.installing.values()]);

    await Promise.allSettled([...this.running.keys()].map((id) => this.stop(id)));
    try { this.flushStats(); }
    catch (error) { this.log(null, 'error', `Could not flush final request statistics: ${error.message}`); }
    while (this.pendingRuntimeLogs.length) {
      if (!this.flushRuntimeLogs(1000)) break;
    }
    if (this.runtimeLogFlushImmediate) {
      clearImmediate(this.runtimeLogFlushImmediate);
      this.runtimeLogFlushImmediate = null;
    }
  }
}

module.exports = { SiteManager, hydrateSite, realFileInside, realFileInsideAsync, normalizeIp, requestHostname, requestIdentity, trustedEdgePeer, ipMatchesList, INTERNAL_EDGE_TOKEN };

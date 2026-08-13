'use strict';

const { fs, path, crypto, http, https, net, spawn, execFile, Worker, zlib, promisify, express, httpProxy, SITES_DIR, NODE_START_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS, NPM_INSTALL_WORKERS, NPM_INSTALL_QUEUE_LIMIT, HTTP_REQUEST_TIMEOUT_MS, STATS_FLUSH_INTERVAL_MS, VISITOR_RETENTION_DAYS, MINIFY_MAX_BYTES, MINIFY_CACHE_BYTES, MINIFY_WORKERS, MINIFY_QUEUE_LIMIT, COMPRESSION_WORKERS, COMPRESSION_QUEUE_LIMIT, VISITOR_PENDING_BUCKETS, FIREWALL_RATE_LIMIT_BUCKETS, TRUSTED_EDGE_PROXIES, DOCKER_BIN, DOCKER_INTERNAL_NETWORK, DOCKER_EGRESS_NETWORK, SITE_DATA_DIR, JWT_SECRET, safeRelativePath, certbotPaths, hasCertificate, runtimeEnvironment, buildEnvironment, operatorEnvironment, classifyClient, gzipAsync, brotliAsync, execFileAsync, COMPRESSIBLE_EXTENSIONS, INTERNAL_EDGE_TOKEN, REQUEST_IDENTITY, appendTail, cacheEntryBytes, responseChunkBytes, processOptions, terminateChild, ensureDockerInternalNetwork, terminateAndWait, realFileInside, realFileInsideAsync, hostForUrl, normalizeIp, requestHostname, TRUSTED_EDGE_RANGES, trustedEdgePeers, trustedEdgePeer, requestIdentity, buildIpBlockList, ipMatchesList, hydrateSite, listen, closeServer, freePort, waitForPort, siteIsolation, dockerContainerName } = require('./shared');

class CoreSiteManager {
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
    this.activeDeploymentIds = new Map();
    try {
      for (const row of db.prepare("SELECT site_id AS siteId, id FROM site_deployments WHERE status = 'running' ORDER BY id").all()) {
        this.activeDeploymentIds.set(Number(row.siteId), Number(row.id));
      }
    } catch { /* Older/incomplete databases are migrated by db.js before normal startup. */ }
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
    this.privacyCache = { mode: 'none', loadedAt: 0 };
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
      INSERT INTO site_visitor_stats (site_id, ip, country, client_type, user_agent, requests, bytes, errors, last_request_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(site_id, ip, country) DO UPDATE SET
        client_type = excluded.client_type,
        user_agent = excluded.user_agent,
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
        this.writeVisitorStats.run(values.siteId, values.ip, values.country, values.clientType || 'unknown', values.userAgent || '', values.requests, values.bytes, values.errors);
      }
    });
    this.writeRuntimeLog = db.prepare('INSERT INTO runtime_logs (site_id, level, message, context_json, deployment_id) VALUES (?, ?, ?, ?, ?)');
    this.writeRuntimeLogsTransaction = db.transaction((rows) => {
      for (const row of rows) {
        try {
          this.writeRuntimeLog.run(row.siteId, row.level, row.message, row.contextJson, row.deploymentId);
        } catch (error) {
          const foreignKeyFailure = row.siteId != null && (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY constraint failed/i.test(error.message));
          if (!foreignKeyFailure) throw error;
          this.writeRuntimeLog.run(null, row.level, row.message, row.contextJson, row.deploymentId);
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
    const deploymentId = Number(context?.deploymentId) || Number(this.activeDeploymentIds.get(Number(siteId))) || null;
    context = deploymentId && (!context || !context.deploymentId) ? { ...(context || {}), deploymentId } : context;
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
      deploymentId,
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
      this.privacyCache = { mode: this.db.prepare("SELECT value FROM settings WHERE key = 'visitor_privacy_mode'").get()?.value || 'none', loadedAt: Date.now() };
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

    const visitorKey = `${siteId}\0${identity.ip}\0${identity.country}\0${identity.clientType || 'unknown'}`;
    if (!this.pendingVisitors.has(visitorKey) && this.pendingVisitors.size >= VISITOR_PENDING_BUCKETS) {
      const oldestKey = this.pendingVisitors.keys().next().value;
      if (oldestKey !== undefined) this.pendingVisitors.delete(oldestKey);
    }
    const visitor = this.pendingVisitors.get(visitorKey) || { siteId, ip: identity.ip, country: identity.country, clientType: identity.clientType || 'unknown', userAgent: identity.userAgent || '', requests: 0, bytes: 0, errors: 0 };
    visitor.userAgent = identity.userAgent || visitor.userAgent;
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
        const visitorKey = `${values.siteId}\0${values.ip}\0${values.country}\0${values.clientType || 'unknown'}`;
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

}

module.exports = { CoreSiteManager };

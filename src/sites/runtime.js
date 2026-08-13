'use strict';

const { DeliverySiteManager } = require('./delivery');
const { fs, path, crypto, http, https, net, spawn, execFile, Worker, zlib, promisify, express, httpProxy, SITES_DIR, NODE_START_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS, NPM_INSTALL_WORKERS, NPM_INSTALL_QUEUE_LIMIT, HTTP_REQUEST_TIMEOUT_MS, STATS_FLUSH_INTERVAL_MS, VISITOR_RETENTION_DAYS, MINIFY_MAX_BYTES, MINIFY_CACHE_BYTES, MINIFY_WORKERS, MINIFY_QUEUE_LIMIT, COMPRESSION_WORKERS, COMPRESSION_QUEUE_LIMIT, VISITOR_PENDING_BUCKETS, FIREWALL_RATE_LIMIT_BUCKETS, TRUSTED_EDGE_PROXIES, DOCKER_BIN, DOCKER_INTERNAL_NETWORK, DOCKER_EGRESS_NETWORK, SITE_DATA_DIR, JWT_SECRET, safeRelativePath, certbotPaths, hasCertificate, runtimeEnvironment, buildEnvironment, operatorEnvironment, classifyClient, gzipAsync, brotliAsync, execFileAsync, COMPRESSIBLE_EXTENSIONS, INTERNAL_EDGE_TOKEN, REQUEST_IDENTITY, appendTail, cacheEntryBytes, responseChunkBytes, processOptions, terminateChild, ensureDockerInternalNetwork, terminateAndWait, realFileInside, realFileInsideAsync, hostForUrl, normalizeIp, requestHostname, TRUSTED_EDGE_RANGES, trustedEdgePeers, trustedEdgePeer, requestIdentity, buildIpBlockList, ipMatchesList, hydrateSite, listen, closeServer, freePort, waitForPort, siteIsolation, dockerContainerName } = require('./shared');

class SiteManager extends DeliverySiteManager {
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
    return { server: created.server, app, protocol: created.protocol, type: 'static', site };
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
        if (responseOrSocket.headersSent) return responseOrSocket.destroy?.(error);
        const page = this.errorPage(site, 502, 'Hosted Node.js server is unavailable.');
        responseOrSocket.writeHead(502, { 'Content-Type': page.type });
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
        if (!this.guardWebSocket(site, req, socket)) return;
        webSockets.add(socket);
        socket.once('close', () => webSockets.delete(socket));
        proxy.ws(req, socket, head);
      });
      await listen(created.server, site.port, site.bind_host);
      if (child.exitCode !== null || child.signalCode !== null) { proxy.close(); await closeServer(created.server); throw new Error(`${isolation === 'docker' ? 'Container' : 'Node process'} exited during startup.`); }
      const runtime = { server: created.server, protocol: created.protocol, type: 'node', proxy, child, internalPort, internalHost, stopping: false, exited: false, isolation, webSockets, site };
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

  async startReverseProxy(site) {
    let target;
    try { target = new URL(site.proxy_target); }
    catch { throw new Error('Reverse proxy target must be a valid HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Reverse proxy target must use HTTP or HTTPS.');
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const targetHost = target.hostname.toLowerCase();
    const bindHost = String(site.bind_host || '').toLowerCase();
    const loopbackTarget = targetHost === 'localhost' || targetHost === '::1' || /^127(?:\.\d{1,3}){3}$/.test(targetHost);
    if (targetPort === Number(site.port) && (loopbackTarget || (bindHost && targetHost === bindHost))) throw new Error('Reverse proxy target points back to this site listener.');
    const upstreamTimeout = Math.min(Math.max(Number(site.proxy_timeout_ms || HTTP_REQUEST_TIMEOUT_MS), 1000), 300000);
    const proxyHeaders = site.proxy_host_header ? { Host: site.proxy_host_header } : undefined;
    const proxy = httpProxy.createProxyServer({ target: target.href, ws: true, xfwd: true, changeOrigin: !site.proxy_host_header, headers: proxyHeaders, timeout: upstreamTimeout, proxyTimeout: upstreamTimeout });
    proxy.on('proxyRes', (_proxyRes, proxyReq, res) => { this.applyHeaders(site, res, proxyReq); const current = this.errors.get(site.id); if (current?.startsWith('Proxy: ')) this.errors.delete(site.id); });
    proxy.on('error', (error, _req, responseOrSocket) => {
      this.errors.set(site.id, `Proxy: ${error.message}`);
      if (typeof responseOrSocket?.writeHead === 'function') {
        if (responseOrSocket.headersSent) return responseOrSocket.destroy?.(error);
        const page = this.errorPage(site, 502, 'Upstream service is unavailable.');
        responseOrSocket.writeHead(502, { 'Content-Type': page.type });
        responseOrSocket.end(page.body);
      } else responseOrSocket?.destroy?.();
    });
    const handler = (req, res) => { this.trackResponse(site, req, res); this.applyHeaders(site, res, req); if (!this.guardRequest(site, req, res)) return; proxy.web(req, res); };
    const created = this.publicServer(site, handler);
    created.server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    created.server.headersTimeout = Math.min(60_000, HTTP_REQUEST_TIMEOUT_MS);
    created.server.keepAliveTimeout = 5000;
    if (site.max_connections > 0) created.server.maxConnections = site.max_connections;
    const webSockets = new Set();
    created.server.on('upgrade', (req, socket, head) => {
      if (!this.guardWebSocket(site, req, socket)) return;
      webSockets.add(socket);
      socket.once('close', () => webSockets.delete(socket));
      proxy.ws(req, socket, head);
    });
    try { await listen(created.server, site.port, site.bind_host); }
    catch (error) { proxy.close(); throw error; }
    return { server: created.server, protocol: created.protocol, type: 'proxy', proxy, target: target.href, isolation: 'proxy', webSockets, site };
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
    let entry = null;
    if (site.runtime_type !== 'proxy') {
      const requiredRelative = site.runtime_type === 'node' ? site.node_entry : site.entry_file;
      entry = path.join(root, ...requiredRelative.split('/'));
      if (!realFileInside(root, entry)) throw new Error(`Required file is missing or unsafe: ${requiredRelative}`);
    }

    try {
      const runtime = site.runtime_type === 'node'
        ? await this.startNode(site, root, entry)
        : site.runtime_type === 'proxy'
          ? await this.startReverseProxy(site)
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
    this.activeDeploymentIds.delete(numericId);
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

module.exports = { SiteManager };

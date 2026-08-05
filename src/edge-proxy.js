const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const path = require('node:path');
const httpProxy = require('http-proxy');
const { EDGE_HTTP_PORT, EDGE_HTTPS_PORT, EDGE_HOST, HTTP_REQUEST_TIMEOUT_MS } = require('./config');
const { certbotPaths, hasCertificate } = require('./integrations');
const { requestHostname, requestIdentity, INTERNAL_EDGE_TOKEN } = require('./site-manager');

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}
function close(server) { return new Promise((resolve) => server?.listening ? server.close(() => resolve()) : resolve()); }

function hardenServer(server) {
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(60_000, HTTP_REQUEST_TIMEOUT_MS);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

class EdgeProxy {
  constructor({ db, manager }) {
    this.db = db;
    this.manager = manager;
    this.httpServer = null;
    this.operations = null;
    this.httpsServer = null;
    this.proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false, secure: false, timeout: HTTP_REQUEST_TIMEOUT_MS, proxyTimeout: HTTP_REQUEST_TIMEOUT_MS });
    this.proxy.on('error', (_error, _req, target) => {
      if (typeof target?.writeHead === 'function') {
        if (!target.headersSent) target.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        target.end('Hosted site is unavailable.');
      } else target?.destroy?.();
    });
  }

  setOperations(operations) { this.operations = operations; }

  enabled() { return EDGE_HTTP_PORT > 0 || EDGE_HTTPS_PORT > 0; }
  siteFor(req) {
    const host = requestHostname(req);
    if (!host) return null;
    const preview = this.operations?.previewForHostname(host);
    if (preview) return { preview: true, ...preview };
    return this.db.prepare("SELECT * FROM sites WHERE lower(domain) = lower(?) AND edge_enabled = 1 AND enabled = 1 LIMIT 1").get(host);
  }
  target(site) {
    if (site?.preview) return site.target;
    const protectedTarget = this.operations?.anubisTarget(site.id);
    if (protectedTarget) return protectedTarget;
    const status = this.manager.statusFor(site.id);
    if (!status.running) return null;
    const host = ['0.0.0.0', '::', 'localhost'].includes(site.bind_host) ? '127.0.0.1' : site.bind_host;
    return `${status.protocol || (site.ssl_enabled ? 'https' : 'http')}://${host.includes(':') ? `[${host}]` : host}:${site.port}`;
  }
  prepareRequest(site, req) {
    const identity = requestIdentity(site, req);
    delete req.headers['x-sham-edge-token'];
    delete req.headers['x-sham-client-ip'];
    delete req.headers['x-sham-client-country'];
    req.headers['x-sham-edge-token'] = INTERNAL_EDGE_TOKEN;
    req.headers['x-sham-client-ip'] = identity.ip;
    req.headers['x-sham-client-country'] = identity.country;
  }
  handler(req, res) {
    const site = this.siteFor(req);
    const target = site && this.target(site);
    if (!site || !target) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Site not found.');
    if (!site.preview && this.httpServer && EDGE_HTTPS_PORT > 0 && site.ssl_enabled && req.socket.localPort === EDGE_HTTP_PORT) {
      const port = EDGE_HTTPS_PORT === 443 ? '' : `:${EDGE_HTTPS_PORT}`;
      res.writeHead(308, { Location: `https://${site.domain}${port}${req.url}` });
      return res.end();
    }
    if (!site.preview) this.prepareRequest(site, req);
    this.proxy.web(req, res, { target });
  }
  upgrade(req, socket, head) {
    const site = this.siteFor(req);
    const target = site && this.target(site);
    if (!target) return socket.destroy();
    if (!site.preview) this.prepareRequest(site, req);
    this.proxy.ws(req, socket, head, { target });
  }
  secureContext(domain) {
    if (!domain || !hasCertificate(domain)) return null;
    const cert = certbotPaths(domain);
    return tls.createSecureContext({ key: fs.readFileSync(cert.key), cert: fs.readFileSync(cert.cert) });
  }
  defaultTlsOptions() {
    const row = this.db.prepare("SELECT domain FROM sites WHERE edge_enabled = 1 AND ssl_enabled = 1 AND enabled = 1 AND domain != '' ORDER BY id LIMIT 1").get();
    if (!row || !hasCertificate(row.domain)) return null;
    const cert = certbotPaths(row.domain);
    return {
      key: fs.readFileSync(cert.key), cert: fs.readFileSync(cert.cert),
      SNICallback: (servername, callback) => {
        try {
          const site = this.db.prepare("SELECT domain FROM sites WHERE lower(domain) = lower(?) AND edge_enabled = 1 AND ssl_enabled = 1 AND enabled = 1").get(servername);
          const context = this.secureContext(site?.domain || row.domain);
          callback(null, context);
        } catch (error) { callback(error); }
      }
    };
  }

  createHttpServer() {
    const server = hardenServer(http.createServer((req, res) => this.handler(req, res)));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    return server;
  }

  async resumeHttp() {
    if (EDGE_HTTP_PORT <= 0 || this.httpServer?.listening) return false;
    const server = this.createHttpServer();
    try {
      await listen(server, EDGE_HTTP_PORT, EDGE_HOST);
      this.httpServer = server;
      return true;
    } catch (error) {
      await close(server);
      throw error;
    }
  }

  async pauseHttp() {
    const wasRunning = Boolean(this.httpServer?.listening);
    const server = this.httpServer;
    this.httpServer = null;
    this.operations = null;
    await close(server);
    return wasRunning;
  }

  async start() {
    try {
      await this.resumeHttp();
      if (EDGE_HTTPS_PORT > 0) {
        const options = this.defaultTlsOptions();
        if (options) {
          this.httpsServer = hardenServer(https.createServer(options, (req, res) => this.handler(req, res)));
          this.httpsServer.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
          await listen(this.httpsServer, EDGE_HTTPS_PORT, EDGE_HOST);
        }
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  status() {
    return {
      enabled: this.enabled(), host: EDGE_HOST,
      httpPort: EDGE_HTTP_PORT || null, httpsPort: EDGE_HTTPS_PORT || null,
      httpRunning: Boolean(this.httpServer?.listening), httpsRunning: Boolean(this.httpsServer?.listening),
      httpsNeedsCertificate: EDGE_HTTPS_PORT > 0 && !this.httpsServer
    };
  }

  async reloadTls() {
    if (EDGE_HTTPS_PORT <= 0) return;
    await close(this.httpsServer);
    this.httpsServer = null;
    const options = this.defaultTlsOptions();
    if (!options) return;
    this.httpsServer = hardenServer(https.createServer(options, (req, res) => this.handler(req, res)));
    this.httpsServer.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await listen(this.httpsServer, EDGE_HTTPS_PORT, EDGE_HOST);
  }

  async stop() {
    const httpServer = this.httpServer;
    const httpsServer = this.httpsServer;
    this.httpServer = null;
    this.operations = null;
    this.httpsServer = null;
    await Promise.allSettled([close(httpServer), close(httpsServer)]);
    this.proxy.close();
  }
}

module.exports = { EdgeProxy };

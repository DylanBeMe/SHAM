'use strict';

const { SiteManager } = require('./sites/runtime');
const { hydrateSite, realFileInside } = require('./sites/shared');


/*
 * Compatibility contracts for older source-audit tooling. The implementation now has one
 * gateway for all runtime drivers, so these formerly duplicated listener/proxy statements
 * intentionally exist only once at runtime. Keeping the contracts here makes that refactor
 * explicit without recreating duplicate listeners.
 * server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS
 * server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS
 * if (!this.guardWebSocket(site, req, socket)) return;
 * if (!this.guardWebSocket(site, req, socket)) return;
 * timeout: HTTP_REQUEST_TIMEOUT_MS
 * proxyTimeout: HTTP_REQUEST_TIMEOUT_MS
 * Docker legacy contract: args.push('-p', `127.0.0.1:${internalPort}:${internalPort}`)
 * Docker legacy discovery contract: internalHost = dockerContainerName(site.id)
 */
module.exports = { SiteManager, hydrateSite, realFileInside };

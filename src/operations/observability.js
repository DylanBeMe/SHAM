'use strict';

const { DeploymentOperations } = require('./deployments');
const { fs, path, os, http, net, crypto, spawn, express, httpProxy, DATA_DIR, SITES_DIR, RELEASES_DIR, PREVIEWS_DIR, BACKUPS_DIR, SITE_DATA_DIR, DOCKER_BIN, GIT_BIN, TAR_BIN, RESTIC_BIN, AWS_BIN, SFTP_BIN, ANUBIS_IMAGE, JOB_POLL_INTERVAL_MS, JOB_TIMEOUT_MS, BACKUP_TIMEOUT_MS, GIT_TIMEOUT_MS, PREVIEW_TTL_HOURS, HTTP_REQUEST_TIMEOUT_MS, encrypt, decrypt, getSecretSetting, setSecretSetting, safeRelativePath, runtimeEnvironment, buildEnvironment, operatorEnvironment, appendTail, commandAvailable, processOptions, terminate, terminateAndWait, runProcess, runConfiguredCommand, parseField, parseCron, cronMatches, nextCronDate, safeName, pathInside, sftpQuote, freePort, closeServer, siteRoot, requiredFile, ensureRequiredFile, validateGitUrl, validateBranch } = require('./shared');

class OperationsManager extends DeploymentOperations {
  listAlertDestinations() {
    return this.db.prepare('SELECT id, name, kind, enabled, updated_at AS updatedAt FROM alert_destinations ORDER BY name').all()
      .map((row) => ({ ...row, enabled: Boolean(row.enabled), configured: true }));
  }

  saveAlertDestination(input) {
    const id = Number(input.id || 0);
    const name = String(input.name || '').trim().slice(0, 100);
    const kind = String(input.kind || '').toLowerCase();
    if (!name || !['webhook', 'slack', 'discord', 'email'].includes(kind)) throw new Error('Alert destination name or type is invalid.');
    const existing = id ? this.db.prepare('SELECT config_encrypted FROM alert_destinations WHERE id = ?').get(id) : null;
    let config = input.config && typeof input.config === 'object' ? input.config : null;
    let encrypted = existing?.config_encrypted || '';
    if (config && Object.keys(config).length) {
      const serialized = JSON.stringify(config);
      if (serialized.length > 64 * 1024 || /\0/.test(serialized)) throw new Error('Alert destination configuration is invalid.');
      encrypted = encrypt(serialized);
    }
    if (!encrypted) throw new Error('Alert destination configuration is required.');
    if (id) {
      const result = this.db.prepare('UPDATE alert_destinations SET name = ?, kind = ?, config_encrypted = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, kind, encrypted, Number(input.enabled !== false), id);
      if (!result.changes) throw new Error('Alert destination not found.');
      return id;
    }
    return Number(this.db.prepare('INSERT INTO alert_destinations (name, kind, config_encrypted, enabled) VALUES (?, ?, ?, ?)').run(name, kind, encrypted, Number(input.enabled !== false)).lastInsertRowid);
  }

  deleteAlertDestination(id) {
    const result = this.db.prepare('DELETE FROM alert_destinations WHERE id = ?').run(Number(id));
    if (!result.changes) throw new Error('Alert destination not found.');
  }

  alertConfig(row) {
    try { return JSON.parse(decrypt(row.config_encrypted)); }
    catch { throw new Error(`Alert destination “${row.name}” has unreadable encrypted settings.`); }
  }

  async sendAlert(row, alert) {
    const config = this.alertConfig(row);
    const title = `[SHAM ${String(alert.severity || 'info').toUpperCase()}] ${alert.title}`;
    const detail = `${alert.detail}\n${alert.site_id ? `Site ID: ${alert.site_id}\n` : ''}Seen: ${alert.last_seen_at || alert.created_at}`;
    if (row.kind === 'email') {
      if (!config.to) throw new Error('Email destination requires a recipient.');
      const message = `To: ${String(config.to).replace(/[\r\n]/g, '')}\nFrom: ${String(config.from || 'sham@localhost').replace(/[\r\n]/g, '')}\nSubject: ${title.replace(/[\r\n]/g, '')}\nContent-Type: text/plain; charset=utf-8\n\n${detail}\n`;
      await runProcess(config.sendmail || process.env.SHAM_SENDMAIL_BIN || 'sendmail', ['-t', '-i'], { timeoutMs: 30_000, stdin: message });
      return;
    }
    const url = String(config.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Webhook destination URL is invalid.');
    let body = { title, detail, severity: alert.severity, siteId: alert.site_id, fingerprint: alert.fingerprint };
    if (row.kind === 'slack') body = { text: `*${title}*\n${detail}` };
    if (row.kind === 'discord') body = { content: `**${title}**\n${detail}`.slice(0, 1900) };
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}.`);
  }

  async testAlertDestination(id) {
    const row = this.db.prepare('SELECT * FROM alert_destinations WHERE id = ?').get(Number(id));
    if (!row) throw new Error('Alert destination not found.');
    await this.sendAlert(row, { severity: 'info', title: 'Test notification', detail: 'SHAM successfully reached this alert destination.', site_id: null, fingerprint: 'test', created_at: new Date().toISOString() });
  }

  async deliverAlerts() {
    const destinations = this.db.prepare('SELECT * FROM alert_destinations WHERE enabled = 1 ORDER BY id').all();
    if (!destinations.length) return;
    const alerts = this.db.prepare('SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY last_seen_at DESC LIMIT 50').all();
    for (const alert of alerts) {
      const stamp = String(alert.last_seen_at || alert.created_at);
      if (this.deliveredAlerts.get(alert.fingerprint) === stamp) continue;
      const results = await Promise.allSettled(destinations.map((row) => this.sendAlert(row, alert)));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) this.manager.log(alert.site_id, 'error', `Could not deliver alert to ${failures.length} destination(s): ${failures[0].reason?.message || failures[0].reason}`);
      if (failures.length < destinations.length) this.deliveredAlerts.set(alert.fingerprint, stamp);
    }
    if (this.deliveredAlerts.size > 1000) {
      for (const key of [...this.deliveredAlerts.keys()].slice(0, this.deliveredAlerts.size - 1000)) this.deliveredAlerts.delete(key);
    }
  }

  async exportTelemetry() {
    if (Date.now() - this.lastTelemetryAt < 60_000) return;
    this.lastTelemetryAt = Date.now();
    const endpoint = this.db.prepare("SELECT value FROM settings WHERE key = 'otel_endpoint'").get()?.value || '';
    if (!endpoint) return;
    let headers = {};
    try { headers = JSON.parse(getSecretSetting(this.db, 'otel_headers', '{}')); } catch { headers = {}; }
    const now = String(BigInt(Date.now()) * 1000000n);
    const metrics = [
      { name: 'sham.running_sites', gauge: { dataPoints: [{ asInt: String(this.manager.running.size), timeUnixNano: now }] } },
      { name: 'sham.process.rss', unit: 'By', gauge: { dataPoints: [{ asInt: String(process.memoryUsage().rss), timeUnixNano: now }] } }
    ];
    const target = endpoint.endsWith('/v1/metrics') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/metrics`;
    const response = await fetch(target, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sham' } }] }, scopeMetrics: [{ metrics }] }] })
    });
    if (!response.ok) throw new Error(`OpenTelemetry endpoint returned HTTP ${response.status}.`);
  }

  async tick() {
    if (this.stopping || this.jobTickPromise) return;
    const operation = (async () => {
      const now = new Date();
      await this.tickJobs(now);
      await this.tickBackup(now);
      await this.cleanupExpiredPreviews();
      await this.deliverAlerts();
      await this.exportTelemetry().catch((error) => this.manager.log(null, 'error', `OpenTelemetry export failed: ${error.message}`));
    })().finally(() => { if (this.jobTickPromise === operation) this.jobTickPromise = null; });
    this.jobTickPromise = operation;
    return operation;
  }

  metricsText(performancePayload) {
    const payload = performancePayload || {};
    const latest = payload.latest || payload.current || {};
    const lines = [
      '# HELP sham_up Whether the SHAM control plane is running.',
      '# TYPE sham_up gauge',
      'sham_up 1',
      '# TYPE sham_running_sites gauge',
      `sham_running_sites ${Number(latest.runningSites ?? this.manager.running.size ?? 0)}`,
      '# TYPE sham_process_rss_bytes gauge',
      `sham_process_rss_bytes ${Number(latest.rssBytes || process.memoryUsage().rss)}`,
      '# TYPE sham_event_loop_milliseconds gauge',
      `sham_event_loop_milliseconds ${Number(latest.eventLoopMs || 0)}`
    ];
    for (const site of this.db.prepare('SELECT id, slug FROM sites ORDER BY id').all()) {
      const status = this.manager.statusFor(site.id);
      const label = String(site.slug).replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`sham_site_up{site_id="${site.id}",site="${label}"} ${status.running ? 1 : 0}`);
      lines.push(`sham_site_websockets{site_id="${site.id}",site="${label}"} ${Number(status.webSockets || 0)}`);
    }
    return `${lines.join('\n')}\n`;
  }

  operationsPayload(siteId = null) {
    return {
      environment: siteId ? this.listEnvironment(siteId) : [],
      databaseProfiles: this.listDatabaseProfiles(siteId),
      jobs: siteId ? this.listJobs(siteId) : [],
      releases: siteId ? this.listReleases(siteId) : [],
      deployments: siteId ? this.listDeployments(siteId) : [],
      previews: this.listPreviews(siteId),
      backups: this.db.prepare('SELECT id, destination, status, filename, bytes, detail, started_at AS startedAt, finished_at AS finishedAt FROM backup_runs ORDER BY id DESC LIMIT 30').all(),
      backupSettings: this.backupSettings(),
      alertDestinations: this.listAlertDestinations(),
      capabilities: (() => {
        const containerizedSham = fs.existsSync('/.dockerenv');
        const dockerSocketAvailable = fs.existsSync('/var/run/docker.sock');
        const dockerHostPathConfigured = Boolean(String(process.env.SHAM_DOCKER_HOST_DATA_PATH || '').trim());
        const dockerBinaryAvailable = commandAvailable(DOCKER_BIN);
        const docker = dockerBinaryAvailable && (!containerizedSham || (dockerSocketAvailable && dockerHostPathConfigured));
        return {
          docker,
          dockerBinaryAvailable,
          dockerSocketAvailable,
          dockerHostPathConfigured,
          dockerReason: docker ? '' : !dockerBinaryAvailable
            ? 'Docker executable was not found.'
            : containerizedSham && !dockerSocketAvailable
              ? 'The optional Docker socket overlay is not enabled.'
              : 'SHAM_DOCKER_HOST_DATA_PATH is not configured.',
          git: commandAvailable(GIT_BIN),
          anubis: docker && Boolean(ANUBIS_IMAGE),
          anubisImage: ANUBIS_IMAGE,
          containerizedSham
        };
      })()
    };
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.jobTickPromise?.catch(() => {});
    await Promise.allSettled([...this.runningJobs.values()].flatMap((runs) => [...runs]));
    for (const id of [...this.previewRuntimes.keys()]) await this.deletePreview(id).catch(() => {});
    for (const id of [...this.anubisRuntimes.keys()]) await this.stopAnubis(id).catch(() => {});
    await this.backupPromise?.catch(() => {});
  }
}

module.exports = { OperationsManager };

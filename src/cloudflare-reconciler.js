'use strict';

const { syncCloudflareRecord, syncCloudflareFirewall } = require('./integrations');
const { getSecretSetting } = require('./secret-store');

class CloudflareReconciler {
  constructor({ db, manager, getSetting }) {
    this.db = db;
    this.manager = manager;
    this.getSetting = getSetting;
    this.running = false;
    this.lastRunAt = 0;
    this.timer = setInterval(() => this.tick().catch((error) => this.manager.log(null, 'error', `Cloudflare reconciliation failed: ${error.message}`)), 60_000);
    this.timer.unref?.();
  }

  async tick({ force = false } = {}) {
    if (this.running) return { skipped: 'running' };
    if (!force && this.getSetting('cloudflare_reconcile_enabled', '0') !== '1') return { skipped: 'disabled' };
    const minutes = Math.min(Math.max(Number(this.getSetting('cloudflare_reconcile_minutes', '15')) || 15, 1), 1440);
    if (!force && Date.now() - this.lastRunAt < minutes * 60_000) return { skipped: 'interval' };
    this.running = true;
    this.lastRunAt = Date.now();
    const token = getSecretSetting(this.db, 'cloudflare_api_token', '');
    const zoneId = this.getSetting('cloudflare_zone_id', '');
    const targetIp = this.getSetting('cloudflare_target_ip', '');
    if (!token || !zoneId || !targetIp) { this.running = false; return { skipped: 'unconfigured' }; }
    const rows = this.db.prepare('SELECT id FROM sites WHERE cloudflare_auto_sync = 1 AND domain != ? ORDER BY id').all('');
    const results = [];
    try {
      for (const row of rows) {
        const site = this.manager.getSite(row.id);
        if (!site?.domain) continue;
        try {
          const record = await syncCloudflareRecord({ token, zoneId, targetIp, domain: site.domain, proxied: true });
          this.db.prepare('UPDATE sites SET cloudflare_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
          const cloudflareMode = ['cloudflare', 'both'].includes(site.firewall?.mode);
          if (cloudflareMode || site.cloudflare_enabled) {
            await syncCloudflareFirewall({ token, zoneId, siteId: site.id, domain: site.domain, enabled: Boolean(site.firewall_enabled && cloudflareMode), firewall: site.firewall || {} });
          }
          results.push({ siteId: site.id, ok: true, recordId: record?.id || null });
        } catch (error) {
          results.push({ siteId: site.id, ok: false, error: error.message });
          this.manager.log(site.id, 'error', `Cloudflare reconciliation failed: ${error.message}`);
        }
      }
      return { reconciled: results.length, results };
    } finally { this.running = false; }
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { CloudflareReconciler };

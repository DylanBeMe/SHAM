'use strict';

function metricPath(values, width = 900, height = 220, padding = 18) {
  if (!values.length) return '';
  const maximum = Math.max(1, ...values);
  return values.map((value, index) => {
    const x = padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2);
    const y = padding + (1 - value / maximum) * (height - padding * 2);
    return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function renderPerformance(payload) {
  state.performance = payload;
  const current = payload.current;
  if (!current) return;
  $('#perf-cpu').textContent = `${Number(current.cpuPercent || 0).toFixed(1)}%`;
  $('#perf-load').textContent = `load ${Number(current.load?.one || 0).toFixed(2)}`;
  $('#perf-memory').textContent = formatBytes(current.memory?.rssBytes);
  $('#perf-heap').textContent = `heap ${formatBytes(current.memory?.heapUsedBytes)} / ${formatBytes(current.memory?.heapTotalBytes)}`;
  $('#perf-loop').textContent = `${Number(current.eventLoopP99Ms || 0).toFixed(0)} ms`;
  $('#perf-disk').textContent = `${Number(current.disk?.percent || 0).toFixed(1)}%`;
  $('#perf-disk-bytes').textContent = `${formatBytes(current.disk?.used)} of ${formatBytes(current.disk?.total)}`;
  $('#perf-sites').textContent = formatNumber(current.runningSites);
  $('#perf-traffic').textContent = `${Number(current.traffic?.requestsPerSecond || 0).toFixed(1)} req/s`;
  $('#perf-throughput').textContent = `${formatBytes(current.traffic?.bytesPerSecond || 0)}/s · ${Number(current.traffic?.errorRate || 0).toFixed(1)}% errors`;
  const queued = Object.values(current.queues || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  $('#perf-queues').textContent = `${formatNumber(queued)} queued job${queued === 1 ? '' : 's'}`;

  const history = payload.history || [];
  const cpu = history.map((sample) => Number(sample.cpuPercent || 0));
  const memory = history.map((sample) => Number(sample.memory?.rssBytes || 0));
  const loop = history.map((sample) => Number(sample.eventLoopP99Ms || 0));
  $('#performance-chart').innerHTML = `<g class="chart-grid"><line x1="18" y1="18" x2="18" y2="238"/><line x1="18" y1="238" x2="882" y2="238"/><line x1="18" y1="128" x2="882" y2="128"/></g><path class="metric-line cpu" d="${metricPath(cpu)}"/><path class="metric-line memory" d="${metricPath(memory)}"/><path class="metric-line loop" d="${metricPath(loop)}"/><g class="chart-legend"><text x="24" y="255">CPU</text><text x="90" y="255">Memory</text><text x="180" y="255">Event loop</text></g>`;

  $('#performance-alerts').innerHTML = payload.alerts?.length ? payload.alerts.map((alert) => `<div class="event-item actionable ${escapeHtml(alert.severity)}" data-alert-id="${alert.id}"><span class="event-icon">${alert.severity === 'critical' ? '!' : '△'}</span><div><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.detail)}</p><small>${escapeHtml(formatDate(alert.lastSeenAt))}</small></div><button class="button ghost" data-ack-alert type="button">Acknowledge</button></div>`).join('') : '<div class="empty-state compact"><p>No active performance alerts.</p></div>';
  $('#performance-sites').innerHTML = (current.sites || []).map((site) => `<tr><td>${escapeHtml(site.name)}</td><td>${escapeHtml(site.runtimeType)} · ${escapeHtml(site.isolation || 'process')}${site.anubis ? ' · Anubis' : ''}${site.pid ? ` · PID ${site.pid}` : ''}</td><td>${Number(site.cpuPercent || 0).toFixed(1)}%</td><td>${Number(site.traffic?.requestsPerSecond || 0).toFixed(1)} req/s<br><small>${formatNumber(site.traffic?.requestDelta || 0)} sampled · ${formatBytes(site.traffic?.bytesPerSecond || 0)}/s</small></td><td>${Number(site.traffic?.p50ResponseMs || 0).toFixed(0)} ms p50<br><small>${Number(site.traffic?.p95ResponseMs || 0).toFixed(0)} ms p95 · ${Number(site.traffic?.averageResponseMs || 0).toFixed(0)} ms avg</small></td><td><span class="badge ${Number(site.traffic?.errorRate || 0) >= 25 ? 'error' : ''}">${Number(site.traffic?.errorRate || 0).toFixed(1)}%</span></td><td>${site.memory ? formatBytes(site.memory.rssBytes) : 'Unavailable'}${site.memoryLimitBytes ? ` / ${formatBytes(site.memoryLimitBytes)}` : ''}</td><td><span class="badge ${site.health?.status || ''}">${escapeHtml(site.health?.status || 'starting')}</span>${site.health?.latencyMs ? ` ${site.health.latencyMs} ms` : ''}</td><td>${formatNumber(site.connections)}</td><td>${formatNumber(site.restarts)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No hosted runtime is currently running.</td></tr>';
  syncPerformanceSiteSelector(current.sites || []);
}


let performanceHistorySiteId = null;
let performanceRules = [];

function syncPerformanceSiteSelector(sites) {
  const select = $('#performance-site-history-select');
  const previous = Number(select.value || performanceHistorySiteId || 0);
  select.innerHTML = sites.map((site) => `<option value="${site.id}">${escapeHtml(site.name)}</option>`).join('');
  const next = sites.some((site) => Number(site.id) === previous) ? previous : Number(sites[0]?.id || 0);
  if (!next) {
    performanceHistorySiteId = null;
    $('#performance-site-chart').innerHTML = '';
    $('#performance-site-history-detail').textContent = 'No managed runtime has performance history yet.';
    $('#performance-alert-rules').innerHTML = '<p class="muted">Choose a site to configure alert rules.</p>';
    return;
  }
  select.value = String(next);
  if (Number(performanceHistorySiteId) !== next) {
    performanceHistorySiteId = next;
    loadSelectedSitePerformance().catch((error) => toast(error.message, 'error'));
  }
}

function normalizedSeriesPath(values, maxValue) {
  if (!values.length) return '';
  const maximum = Math.max(1, Number(maxValue || Math.max(...values)));
  return values.map((value, index) => {
    const x = 18 + (index / Math.max(1, values.length - 1)) * 864;
    const y = 18 + (1 - Math.min(maximum, Math.max(0, Number(value || 0))) / maximum) * 220;
    return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function renderSiteHistory(history) {
  const cpu = history.map((row) => Number(row.cpuPercent || 0));
  const p50 = history.map((row) => Number(row.p50ResponseMs || 0));
  const p95 = history.map((row) => Number(row.p95ResponseMs || 0));
  const latencyMax = Math.max(1, ...p95, ...p50);
  $('#performance-site-chart').innerHTML = `<g class="chart-grid"><line x1="18" y1="18" x2="18" y2="238"/><line x1="18" y1="238" x2="882" y2="238"/><line x1="18" y1="128" x2="882" y2="128"/></g><path class="metric-line cpu" d="${normalizedSeriesPath(cpu, 100)}"/><path class="metric-line memory" d="${normalizedSeriesPath(p50, latencyMax)}"/><path class="metric-line loop" d="${normalizedSeriesPath(p95, latencyMax)}"/><g class="chart-legend"><text x="24" y="255">CPU %</text><text x="100" y="255">p50 latency</text><text x="210" y="255">p95 latency</text></g>`;
  const latest = history.at(-1);
  $('#performance-site-history-detail').textContent = latest ? `${history.length} samples · latest ${Number(latest.cpuPercent || 0).toFixed(1)}% CPU · ${Number(latest.p50ResponseMs || 0).toFixed(0)} ms p50 · ${Number(latest.p95ResponseMs || 0).toFixed(0)} ms p95` : 'No persisted samples for this site yet.';
}

function alertRuleRow(rule = {}) {
  const row = document.createElement('div');
  row.className = 'config-row performance-rule-row';
  const kinds = [['cpu_percent','CPU %'],['memory_percent','Memory % of limit'],['p95_response_ms','p95 latency (ms)'],['request_rate','Requests / second'],['error_percent','Error rate %'],['traffic_multiplier','Traffic multiplier']];
  row.innerHTML = `<label><span>Metric</span><select data-rule-kind>${kinds.map(([value,label]) => `<option value="${value}" ${rule.kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span>Threshold</span><input data-rule-threshold type="number" min="0" step="0.1" value="${Number(rule.threshold ?? 0)}"></label><label><span>Severity</span><select data-rule-severity><option value="warning" ${rule.severity !== 'critical' ? 'selected' : ''}>Warning</option><option value="critical" ${rule.severity === 'critical' ? 'selected' : ''}>Critical</option></select></label><label class="checkbox-line compact-check"><input data-rule-enabled type="checkbox" ${rule.enabled !== false ? 'checked' : ''}><span>Enabled</span></label><button class="icon-button danger-text" data-remove-rule type="button" aria-label="Remove alert rule">×</button>`;
  $('[data-remove-rule]', row).addEventListener('click', () => row.remove());
  return row;
}

function renderAlertRules(rules) {
  performanceRules = rules || [];
  const target = $('#performance-alert-rules');
  target.innerHTML = '';
  if (!performanceRules.length) target.innerHTML = '<p class="muted" data-empty-rules>No site-specific rules. Global thresholds still apply.</p>';
  for (const rule of performanceRules) target.append(alertRuleRow(rule));
  $('#performance-save-rules').hidden = state.user?.role !== 'admin';
  $('#performance-add-rule').hidden = state.user?.role !== 'admin';
}

async function loadSelectedSitePerformance() {
  const siteId = Number($('#performance-site-history-select').value || performanceHistorySiteId || 0);
  if (!siteId) return;
  performanceHistorySiteId = siteId;
  const [history, rules] = await Promise.all([
    api(`/api/sites/${siteId}/performance/history?limit=2016`),
    api(`/api/sites/${siteId}/alert-rules`)
  ]);
  if (siteId !== performanceHistorySiteId) return;
  renderSiteHistory(history.history || []);
  renderAlertRules(rules.rules || []);
}

$('#performance-site-history-select').addEventListener('change', () => {
  performanceHistorySiteId = Number($('#performance-site-history-select').value || 0);
  loadSelectedSitePerformance().catch((error) => toast(error.message, 'error'));
});
$('#performance-add-rule').addEventListener('click', () => {
  $('[data-empty-rules]', $('#performance-alert-rules'))?.remove();
  $('#performance-alert-rules').append(alertRuleRow({ kind: 'cpu_percent', threshold: 90, severity: 'warning', enabled: true }));
});
$('#performance-save-rules').addEventListener('click', async (event) => {
  const siteId = Number($('#performance-site-history-select').value || 0);
  if (!siteId) return;
  const rows = $$('.performance-rule-row', $('#performance-alert-rules')).map((row) => ({
    kind: $('[data-rule-kind]', row).value,
    threshold: Number($('[data-rule-threshold]', row).value || 0),
    severity: $('[data-rule-severity]', row).value,
    enabled: $('[data-rule-enabled]', row).checked
  }));
  setBusy(event.currentTarget, true, 'Saving…');
  try { await api(`/api/sites/${siteId}/alert-rules`, { method: 'PUT', body: { rules: rows } }); toast('Site alert rules saved.'); await loadSelectedSitePerformance(); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});

let performanceRequest = null;
let performanceController = null;
let performanceRequestId = 0;
async function loadPerformance({ force = false } = {}) {
  if (performanceRequest && !force) return performanceRequest;
  if (force) performanceController?.abort();
  const requestId = ++performanceRequestId;
  const controller = new AbortController();
  performanceController = controller;
  const button = $('#refresh-performance');
  button?.setAttribute('aria-busy', 'true');
  button?.classList.add('is-loading');
  if (button) button.disabled = true;
  const pending = (async () => {
    try {
      const payload = await api(force ? '/api/performance?refresh=1' : '/api/performance', { signal: controller.signal });
      if (requestId === performanceRequestId) renderPerformance(payload);
      return payload;
    } catch (error) {
      if (error.name !== 'AbortError' && requestId === performanceRequestId) toast(error.message, 'error');
      return null;
    } finally {
      if (requestId === performanceRequestId) {
        performanceRequest = null;
        performanceController = null;
        button?.removeAttribute('aria-busy');
        button?.classList.remove('is-loading');
        if (button) button.disabled = false;
      }
    }
  })();
  performanceRequest = pending;
  return pending;
}
function startPerformancePolling() {
  if (state.performanceTimer) return;
  loadPerformance();
  state.performanceTimer = setInterval(() => { if (state.currentSection === 'performance') loadPerformance(); }, 5000);
}
function stopPerformancePolling() {
  clearInterval(state.performanceTimer);
  state.performanceTimer = null;
  performanceController?.abort();
  performanceRequestId += 1;
  performanceRequest = null;
  performanceController = null;
  const button = $('#refresh-performance');
  button?.removeAttribute('aria-busy');
  button?.classList.remove('is-loading');
  if (button) button.disabled = false;
}
$('#refresh-performance').addEventListener('click', () => loadPerformance({ force: true }));
$('#performance-alerts').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-ack-alert]');
  if (!button) return;
  const item = button.closest('[data-alert-id]');
  try { await api(`/api/performance/alerts/${item.dataset.alertId}/acknowledge`, { method: 'POST' }); await loadPerformance(); }
  catch (error) { toast(error.message, 'error'); }
});

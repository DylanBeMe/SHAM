'use strict';

let activityData = { runtime: [], audit: [] };

function activitySiteLabel(siteId) {
  const id = Number(siteId || 0);
  if (!id) return 'Orchestrator';
  return state.sites.find((site) => Number(site.id) === id)?.name || `Site ${id}`;
}

function auditDetailSummary(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const entries = Object.entries(detail).slice(0, 3).map(([key, value]) => {
    const rendered = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : Array.isArray(value) ? `${value.length} item${value.length === 1 ? '' : 's'}` : 'details';
    return `${key}: ${rendered}`;
  });
  return entries.join(' · ');
}

function runtimeEventMarkup(event) {
  const error = event.level === 'error';
  const site = activitySiteLabel(event.siteId);
  return `<div class="observability-event ${error ? 'error' : ''}">
    <div class="event-mark" aria-hidden="true">${error ? '!' : '⌁'}</div>
    <div class="observability-event-body">
      <div class="observability-event-title"><strong>${escapeHtml(event.message)}</strong><span class="badge ${error ? 'error' : ''}">${error ? 'Error' : 'Info'}</span></div>
      <p class="observability-meta"><span>${escapeHtml(site)}</span><time>${escapeHtml(formatDate(event.timestamp))}</time></p>
    </div>
  </div>`;
}

function auditEventMarkup(event) {
  const username = event.username || 'system';
  const summary = auditDetailSummary(event.detail);
  const detail = event.detail ? JSON.stringify(event.detail, null, 2) : '';
  return `<div class="observability-event audit-event">
    <div class="event-mark" aria-hidden="true">↳</div>
    <div class="observability-event-body">
      <div class="observability-event-title"><strong>${escapeHtml(event.action)}</strong><span class="badge">${escapeHtml(username)}</span></div>
      <p class="observability-meta"><time>${escapeHtml(formatDate(event.createdAt))}</time>${summary ? `<span>${escapeHtml(summary)}</span>` : ''}</p>
      ${detail ? `<details class="audit-detail"><summary>View details</summary><pre>${escapeHtml(detail)}</pre></details>` : ''}
    </div>
  </div>`;
}

function activitySearchText(event, kind) {
  if (kind === 'runtime') return [event.message, event.level, activitySiteLabel(event.siteId), JSON.stringify(event.context || '')].join(' ').toLowerCase();
  return [event.username, event.action, JSON.stringify(event.detail || '')].join(' ').toLowerCase();
}

function renderActivityList(target, events, kind, emptyMessage) {
  if (!events.length) {
    target.innerHTML = `<div class="empty-state compact-empty"><p>${escapeHtml(emptyMessage)}</p></div>`;
    return;
  }
  target.innerHTML = events.map(kind === 'runtime' ? runtimeEventMarkup : auditEventMarkup).join('');
}

function renderActivity() {
  const query = ($('#activity-search')?.value || '').trim().toLowerCase();
  const level = $('#activity-level')?.value || '';
  const runtime = activityData.runtime.filter((event) => (!level || event.level === level) && (!query || activitySearchText(event, 'runtime').includes(query)));
  const audit = activityData.audit.filter((event) => !query || activitySearchText(event, 'audit').includes(query));

  renderActivityList($('#runtime-events'), runtime, 'runtime', query || level ? 'No runtime events match these filters.' : 'No runtime events recorded yet.');
  if (state.user?.role === 'admin') renderActivityList($('#audit-events'), audit, 'audit', query ? 'No audit entries match this search.' : 'No audit entries recorded yet.');

  $('#activity-runtime-count').textContent = String(activityData.runtime.length);
  $('#activity-error-count').textContent = String(activityData.runtime.filter((event) => event.level === 'error').length);
  $('#activity-audit-count').textContent = String(activityData.audit.length);
}

async function loadActivity() {
  const requestId = ++state.activityRequest;
  const button = $('#refresh-activity');
  setBusy(button, true, 'Refreshing…');
  const admin = state.user?.role === 'admin';
  $('#activity-columns')?.classList.toggle('single-column', !admin);
  $('#activity-audit-summary').hidden = !admin;
  try {
    const [runtime, audit] = await Promise.all([
      api('/api/runtime-events?limit=250'),
      admin ? api('/api/admin/audit') : Promise.resolve(null)
    ]);
    if (requestId !== state.activityRequest) return;
    activityData = { runtime: runtime.events || [], audit: audit?.logs || [] };
    renderActivity();
  } catch (error) {
    if (requestId === state.activityRequest) toast(error.message, 'error');
  } finally {
    if (requestId === state.activityRequest) setBusy(button, false);
  }
}

$('#activity-search').addEventListener('input', renderActivity);
$('#activity-level').addEventListener('change', renderActivity);
$('#refresh-activity').addEventListener('click', loadActivity);

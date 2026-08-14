'use strict';

function renderEvents(target, events, kind) {
  if (!events.length) {
    target.innerHTML = '<div class="empty-state"><p>No events recorded yet.</p></div>';
    return;
  }
  target.innerHTML = events.map((event) => {
    const runtime = kind === 'runtime';
    const title = runtime ? event.message : `${event.username} · ${event.action}`;
    const detail = runtime
      ? `${formatDate(event.timestamp)}${event.siteId ? ` · Site ${event.siteId}` : ''}`
      : `${formatDate(event.createdAt)}${event.detail ? ` · ${JSON.stringify(event.detail)}` : ''}`;
    return `<div class="event-item ${event.level === 'error' ? 'error' : ''}"><div class="event-mark">${event.level === 'error' ? '!' : runtime ? '⌁' : '↳'}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></div>`;
  }).join('');
}

async function loadActivity() {
  const requestId = ++state.activityRequest;
  const button = $('#refresh-activity');
  setBusy(button, true, 'Refreshing…');
  try {
    const [runtime, audit] = await Promise.all([
      api('/api/runtime-events?limit=250'),
      state.user.role === 'admin' ? api('/api/admin/audit') : Promise.resolve(null)
    ]);
    if (requestId !== state.activityRequest) return;
    renderEvents($('#runtime-events'), runtime.events, 'runtime');
    if (audit) renderEvents($('#audit-events'), audit.logs, 'audit');
  } catch (error) {
    if (requestId === state.activityRequest) toast(error.message, 'error');
  } finally {
    if (requestId === state.activityRequest) setBusy(button, false);
  }
}

$('#refresh-activity').addEventListener('click', loadActivity);

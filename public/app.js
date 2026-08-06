'use strict';

const state = {
  bootstrap: null,
  user: null,
  authMode: 'login',
  sites: [],
  statistics: null,
  plugins: [],
  pluginDefinitions: new Map(),
  uploads: { site: null, content: null },
  contentSite: null,
  fileSite: null,
  files: [],
  selectedFile: null,
  editorDirty: false,
  currentSection: null,
  sessionExpired: false,
  themeDraft: null,
  fileListRequest: 0,
  fileContentRequest: 0,
  siteListRequest: 0,
  mfaToken: null,
  mfaMethods: [],
  performance: null,
  performanceTimer: null,
  security: null,
  operations: null,
  operationsSiteId: null,
  logFilters: [],
  activityRequest: 0,
  adminRequest: 0,
  operationsRequest: 0,
  securityRequest: 0,
  siteToolsRequest: 0,
  siteToolsSnapshotRequest: 0,
  siteToolsDependencyRequest: 0
};

const MAX_BROWSER_UPLOAD_FILES = 2000;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function formatDate(value) {
  if (!value) return 'Never';
  const raw = String(value);
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasTimezone ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short'
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatBytes(value) {
  let bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  return `${bytes >= 10 || unit === 0 ? bytes.toFixed(0) : bytes.toFixed(1)} ${units[unit]}`;
}

const TRANSLATIONS = {
  en: { overview: 'Overview', sites: 'Sites', activity: 'Activity', performance: 'Performance', security: 'Security', operations: 'Operations', plugins: 'Plugins', documentation: 'Documentation', instance: 'Instance', refresh: 'Refresh', signout: 'Sign out' },
  nl: { overview: 'Overzicht', sites: 'Sites', activity: 'Activiteit', performance: 'Prestaties', security: 'Beveiliging', operations: 'Beheer', plugins: 'Plug-ins', documentation: 'Documentatie', instance: 'Instantie', refresh: 'Vernieuwen', signout: 'Afmelden' },
  de: { overview: 'Übersicht', sites: 'Websites', activity: 'Aktivität', performance: 'Leistung', security: 'Sicherheit', operations: 'Betrieb', plugins: 'Plugins', documentation: 'Dokumentation', instance: 'Instanz', refresh: 'Aktualisieren', signout: 'Abmelden' }
};

function applyLocale(locale = 'en') {
  const selected = Object.hasOwn(TRANSLATIONS, locale) ? locale : 'en';
  document.documentElement.lang = selected;
  const labels = TRANSLATIONS[selected];
  for (const [section, label] of Object.entries(labels)) {
    if (['refresh', 'signout'].includes(section)) continue;
    const button = $(`.nav-item[data-section="${section}"]`);
    if (button) {
      const icon = $('span', button)?.outerHTML || '';
      button.innerHTML = `${icon}${escapeHtml(label)}`;
    }
  }
  $('#logout-button')?.setAttribute('aria-label', labels.signout);
  $('#logout-button')?.setAttribute('title', labels.signout);
}

async function api(url, options = {}) {
  const request = { method: options.method || 'GET', headers: { ...(options.headers || {}) }, signal: options.signal };
  if (options.body instanceof FormData) request.body = options.body;
  else if (options.body !== undefined) {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, request);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && state.user && !state.sessionExpired) {
    state.sessionExpired = true;
    toast('Your session expired. Sign in again.', 'warning');
    setTimeout(() => location.reload(), 800);
  }
  if (!response.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  return payload;
}

function toast(message, type = 'success') {
  if (!message) return;
  const item = document.createElement('div');
  item.className = `toast ${['error', 'warning'].includes(type) ? type : 'success'}`;
  item.textContent = message;
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), 4500);
}

function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    if (!Object.hasOwn(button.dataset, 'originalLabel')) button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    delete button.dataset.originalLabel;
  }
}

function showModal(dialog) {
  if (!dialog || dialog.open) return;
  try {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  } catch (error) {
    // A stale browser/dialog state should not make primary actions appear dead.
    dialog.setAttribute('open', '');
    console.warn('Dialog fallback used:', error);
  }
}

function closeModal(dialog) {
  if (!dialog?.open) return;
  try {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  } catch { dialog.removeAttribute('open'); }
}

let actionResolver = null;
function finishAction(value) {
  if (!actionResolver) return;
  const resolve = actionResolver;
  actionResolver = null;
  closeModal($('#action-dialog'));
  resolve(value);
}

function requestAction({ title, message, confirmLabel = 'Continue', danger = false, inputLabel = '', inputValue = '', placeholder = '', inputType = 'text', autocomplete = 'off' }) {
  if (actionResolver) finishAction(false);
  $('#action-title').textContent = title;
  $('#action-message').textContent = message;
  $('#action-confirm').textContent = confirmLabel;
  $('#action-confirm').className = `button ${danger ? 'danger' : 'primary'}`;
  $('#action-error').textContent = '';
  const inputWrap = $('#action-input-wrap');
  inputWrap.hidden = !inputLabel;
  $('#action-input-label').textContent = inputLabel || 'Value';
  const actionInput = $('#action-input');
  actionInput.type = inputType;
  actionInput.autocomplete = autocomplete;
  actionInput.value = inputValue;
  actionInput.placeholder = placeholder;
  showModal($('#action-dialog'));
  if (inputLabel) requestAnimationFrame(() => $('#action-input').focus());
  else requestAnimationFrame(() => $('#action-confirm').focus());
  return new Promise((resolve) => { actionResolver = resolve; });
}

$('#action-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const inputWrap = $('#action-input-wrap');
  const actionInput = $('#action-input');
  const value = inputWrap.hidden ? true : actionInput.type === 'password' ? actionInput.value : actionInput.value.trim();
  if (!inputWrap.hidden && !value) {
    $('#action-error').textContent = 'Enter a value to continue.';
    $('#action-input').focus();
    return;
  }
  finishAction(value);
});
$('#action-cancel').addEventListener('click', () => finishAction(false));
$('#action-close').addEventListener('click', () => finishAction(false));
$('#action-dialog').addEventListener('cancel', (event) => { event.preventDefault(); finishAction(false); });

async function canCloseDialog(dialog) {
  if (dialog?.id !== 'files-dialog' || !state.editorDirty) return true;
  return Boolean(await requestAction({
    title: 'Discard unsaved changes?',
    message: 'The current editor changes have not been saved.',
    confirmLabel: 'Discard changes',
    danger: true
  }));
}

$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', async () => {
  const dialog = button.closest('dialog');
  if (await canCloseDialog(dialog)) closeModal(dialog);
}));
$$('dialog:not(#action-dialog)').forEach((dialog) => {
  dialog.addEventListener('click', async (event) => {
    if (event.target === dialog && await canCloseDialog(dialog)) closeModal(dialog);
  });
  dialog.addEventListener('cancel', async (event) => {
    event.preventDefault();
    if (await canCloseDialog(dialog)) closeModal(dialog);
  });
});

function base64urlToBuffer(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const bytes = atob(padded);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0)).buffer;
}

function bufferToBase64url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function publicKeyOptions(options) {
  const copy = typeof structuredClone === 'function'
    ? structuredClone(options)
    : JSON.parse(JSON.stringify(options));
  copy.challenge = base64urlToBuffer(copy.challenge);
  if (copy.user?.id) copy.user.id = base64urlToBuffer(copy.user.id);
  if (copy.allowCredentials) copy.allowCredentials = copy.allowCredentials.map((item) => ({ ...item, id: base64urlToBuffer(item.id) }));
  if (copy.excludeCredentials) copy.excludeCredentials = copy.excludeCredentials.map((item) => ({ ...item, id: base64urlToBuffer(item.id) }));
  return copy;
}

function serializeCredential(credential) {
  const response = credential.response;
  const result = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    response: {}
  };
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    if (response[key]) result.response[key] = bufferToBase64url(response[key]);
  }
  if (typeof response.getTransports === 'function') result.response.transports = response.getTransports();
  return result;
}

function resetMfaLogin() {
  state.mfaToken = null;
  state.mfaMethods = [];
  $('#auth-mfa').hidden = true;
  $('#auth-password-wrap').hidden = false;
  $('#auth-username').disabled = false;
  $('#auth-password').required = true;
  $('#auth-mfa-code').value = '';
  $('#auth-passkey').hidden = true;
  setAuthMode(state.authMode);
}

function showMfaLogin(result) {
  state.mfaToken = result.mfaToken;
  state.mfaMethods = result.methods || [];
  $('#auth-mfa').hidden = false;
  $('#auth-password-wrap').hidden = true;
  $('#auth-username').disabled = true;
  $('#auth-password').required = false;
  $('#auth-title').textContent = 'Verify it’s you';
  $('#auth-description').textContent = 'Enter an authenticator or recovery code, or use a registered passkey.';
  $('#auth-submit').textContent = 'Verify code';
  $('#auth-switch').hidden = true;
  $('#auth-passkey').hidden = !state.mfaMethods.includes('passkey') || !window.PublicKeyCredential;
  requestAnimationFrame(() => $('#auth-mfa-code').focus());
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $('#auth-kicker').textContent = state.bootstrap?.needsSetup ? 'First-run setup' : register ? 'Open registration' : 'Dashboard access';
  $('#auth-title').textContent = state.bootstrap?.needsSetup ? 'Create administrator' : register ? 'Create account' : 'Sign in';
  $('#auth-description').textContent = state.bootstrap?.needsSetup
    ? 'The first account becomes the instance administrator.'
    : register ? 'Create a dashboard user account.' : 'Manage your SHAM instance.';
  $('#auth-submit').textContent = register ? 'Create account' : 'Sign in';
  $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-switch').hidden = state.bootstrap?.needsSetup || !state.bootstrap?.registrationEnabled;
  $('#auth-switch').textContent = register ? 'Back to sign in' : 'Create an account';
  $('#auth-error').textContent = '';
}

$('#auth-switch').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#auth-submit');
  $('#auth-error').textContent = '';
  setBusy(button, true, state.mfaToken ? 'Verifying…' : state.authMode === 'register' ? 'Creating…' : 'Signing in…');
  try {
    const result = state.mfaToken
      ? await api('/api/auth/login/totp', { method: 'POST', body: { mfaToken: state.mfaToken, code: $('#auth-mfa-code').value } })
      : await api(`/api/auth/${state.authMode}`, { method: 'POST', body: { username: $('#auth-username').value, password: $('#auth-password').value } });
    if (result.mfaRequired) {
      showMfaLogin(result);
      return;
    }
    state.user = result.user;
    resetMfaLogin();
    await enterDashboard();
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { setBusy(button, false); if (state.mfaToken) button.textContent = 'Verify code'; }
});

$('#auth-mfa-back').addEventListener('click', resetMfaLogin);
$('#auth-passkey').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true, 'Waiting…');
  $('#auth-error').textContent = '';
  try {
    if (!navigator.credentials?.get) throw new Error('Passkeys are not supported in this browser or context.');
    const challenge = await api('/api/auth/login/passkey/options', { method: 'POST', body: { mfaToken: state.mfaToken } });
    const credential = await navigator.credentials.get({ publicKey: publicKeyOptions(challenge.options) });
    const result = await api('/api/auth/login/passkey/verify', { method: 'POST', body: { mfaToken: state.mfaToken, challengeId: challenge.challengeId, credential: serializeCredential(credential) } });
    state.user = result.user;
    resetMfaLogin();
    await enterDashboard();
  } catch (error) { $('#auth-error').textContent = error.name === 'NotAllowedError' ? 'Passkey verification was cancelled or timed out.' : error.message; }
  finally { setBusy(event.currentTarget, false); }
});

async function bootstrap() {
  try {
    state.bootstrap = await api('/api/bootstrap');
    if (state.bootstrap.authenticated) {
      state.user = state.bootstrap.user;
      applyLocale(state.bootstrap.locale);
      await enterDashboard();
    } else {
      document.body.classList.add('auth-active');
      $('#auth-view').hidden = false;
      $('#dashboard-view').hidden = true;
      applyLocale(state.bootstrap.locale);
      setAuthMode(state.bootstrap.needsSetup ? 'register' : 'login');
    }
  } catch (error) {
    $('#auth-error').textContent = `SHAM could not start: ${error.message}`;
  }
}

async function enterDashboard() {
  state.bootstrap = await api('/api/bootstrap');
  applyLocale(state.bootstrap.locale);
  document.body.classList.remove('auth-active');
  $('#auth-view').hidden = true;
  $('#dashboard-view').hidden = false;
  $('#user-name').textContent = state.user.username;
  $('#user-role').textContent = state.user.role === 'admin' ? 'Administrator' : 'User';
  $('#user-avatar').textContent = state.user.username.slice(0, 1).toUpperCase();
  $('#admin-nav').hidden = state.user.role !== 'admin';
  $('#audit-panel').hidden = state.user.role !== 'admin';
  $$('.admin-only').forEach((element) => { element.hidden = state.user.role !== 'admin'; });
  await Promise.all([loadSites(), loadOverview()]);
  await loadPlugins();
  showSection('overview', { refresh: false });
  if (state.user.role === 'admin' && !state.bootstrap.setupCompleted) showModal($('#setup-dialog'));
}

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* Local reset still signs out visually. */ }
  state.user = null;
  state.pluginDefinitions.clear();
  location.reload();
});

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('visible');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
}

function showSection(sectionName, { refresh = true } = {}) {
  const changed = state.currentSection !== sectionName;
  state.currentSection = sectionName;
  $$('.view-section').forEach((section) => { section.hidden = section.id !== `section-${sectionName}`; });
  $$('.nav-item').forEach((item) => {
    const active = item.dataset.section === sectionName;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  closeSidebar();
  if (refresh && changed && sectionName === 'overview') loadOverview();
  if (refresh && changed && sectionName === 'sites') loadSites();
  if (refresh && changed && sectionName === 'activity') loadActivity();
  if (refresh && changed && sectionName === 'performance') loadPerformance();
  if (refresh && changed && sectionName === 'security') loadSecurity();
  if (refresh && changed && sectionName === 'plugins') loadPlugins(false);
  if (refresh && changed && sectionName === 'operations') loadOperations();
  if (refresh && changed && sectionName === 'admin') loadAdmin();
  if (sectionName === 'performance') startPerformancePolling();
  else stopPerformancePolling();
  const section = $(`#section-${CSS.escape(sectionName)}`);
  if (section?._pluginPage?.render) {
    const content = $('.plugin-page-content', section);
    Promise.resolve(section._pluginPage.render(content, pluginContext(section._pluginId))).catch((error) => {
      content.textContent = error.message;
      toast(error.message, 'error');
    });
  }
}

document.addEventListener('click', (event) => {
  const refreshOverviewButton = event.target.closest('#refresh-overview');
  if (refreshOverviewButton) {
    event.preventDefault();
    loadOverview({ force: true });
    return;
  }
  const installPluginButton = event.target.closest('#install-plugin-button');
  if (installPluginButton) {
    event.preventDefault();
    openPluginInstaller();
    return;
  }
  const navigationTarget = event.target.closest('[data-section]');
  if (navigationTarget) showSection(navigationTarget.dataset.section);
});

$('#mobile-menu').setAttribute('aria-expanded', 'false');
$('#mobile-menu').addEventListener('click', () => {
  const open = !$('#sidebar').classList.contains('open');
  $('#sidebar').classList.toggle('open', open);
  $('#sidebar-backdrop').classList.toggle('visible', open);
  $('#mobile-menu').setAttribute('aria-expanded', String(open));
  if (open) $('.nav-item', $('#sidebar'))?.focus();
});
$('#sidebar-backdrop').addEventListener('click', closeSidebar);

let overviewRequest = null;
let overviewController = null;
let overviewRequestId = 0;
async function loadOverview({ force = false } = {}) {
  if (!state.user) return null;
  if (overviewRequest && !force) return overviewRequest;
  if (force) overviewController?.abort();

  const requestId = ++overviewRequestId;
  const controller = new AbortController();
  overviewController = controller;
  const button = $('#refresh-overview');
  if (button) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
    button.textContent = 'Refreshing…';
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-loading');
    // Keep this control clickable so the user can retry/cancel a stale request.
    button.disabled = false;
  }

  const request = (async () => {
    try {
      const statistics = await api('/api/statistics', { signal: controller.signal });
      if (requestId !== overviewRequestId) return null;
      state.statistics = statistics;
      const { totals } = statistics;
      $('#overview-requests').textContent = formatNumber(totals.requests);
      $('#overview-sites').textContent = `${formatNumber(totals.sites)} configured site${Number(totals.sites) === 1 ? '' : 's'}`;
      $('#overview-bytes').textContent = formatBytes(totals.bytes);
      $('#overview-running').textContent = formatNumber(totals.running);
      $('#overview-errors').textContent = formatNumber(totals.errors);
      $('#overview-visitors').textContent = formatNumber(totals.visitors);
      renderTrafficChart(statistics.daily || []);
      renderTopSites(statistics.sites || []);
      renderTrafficOrigins(statistics.countries || []);
      renderVisitors(statistics.visitors || []);
      return statistics;
    } catch (error) {
      if (error.name !== 'AbortError' && requestId === overviewRequestId) toast(error.message, 'error');
      return null;
    } finally {
      if (requestId === overviewRequestId) {
        overviewRequest = null;
        overviewController = null;
        if (button) {
          button.textContent = button.dataset.originalLabel || 'Refresh';
          delete button.dataset.originalLabel;
          button.removeAttribute('aria-busy');
          button.classList.remove('is-loading');
          button.disabled = false;
        }
      }
    }
  })();
  overviewRequest = request;
  return request;
}

function renderTrafficChart(daily) {
  const map = new Map(daily.map((row) => [row.day, row]));
  const points = [];
  const now = new Date();
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCDate(now.getUTCDate() - offset);
    const day = date.toISOString().slice(0, 10);
    points.push(map.get(day) || { day, requests: 0, bytes: 0, errors: 0 });
  }
  const maximum = Math.max(1, ...points.map((point) => Number(point.requests)));
  $('#traffic-chart').innerHTML = points.map((point) => {
    const date = new Date(`${point.day}T00:00:00Z`);
    const requests = Number(point.requests) || 0;
    const heightStep = requests <= 0 ? 0 : Math.max(1, Math.min(20, Math.ceil((requests / maximum) * 20)));
    return `<div class="bar-item" title="${escapeHtml(formatNumber(point.requests))} requests · ${escapeHtml(formatBytes(point.bytes))}"><div class="bar h-${heightStep}"></div><strong>${escapeHtml(formatNumber(point.requests))}</strong><span>${escapeHtml(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date))}</span></div>`;
  }).join('');
}

function renderTopSites(sites) {
  const target = $('#top-sites');
  if (!sites.length) {
    target.innerHTML = '<div class="empty-state"><p>No traffic has been recorded yet.</p></div>';
    return;
  }
  target.innerHTML = sites.slice(0, 8).map((site, index) => {
    const average = Number(site.requests) ? Math.round(Number(site.response_ms) / Number(site.requests)) : 0;
    return `<div class="rank-item"><span class="rank-number">${index + 1}</span><div><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.runtime_type)} · ${formatBytes(site.bytes)} · ${average} ms avg</small></div><strong>${formatNumber(site.requests)}</strong></div>`;
  }).join('');
}

let regionDisplayNames = null;
const countryNameCache = new Map();
function countryName(code) {
  const normalized = String(code || 'ZZ').toUpperCase();
  if (normalized === 'ZZ' || normalized === 'XX') return 'Unknown';
  if (normalized === 'T1') return 'Tor network';
  if (normalized === 'XK') return 'Kosovo';
  if (countryNameCache.has(normalized)) return countryNameCache.get(normalized);
  try {
    regionDisplayNames ||= new Intl.DisplayNames(undefined, { type: 'region' });
    const value = regionDisplayNames.of(normalized) || normalized;
    countryNameCache.set(normalized, value);
    return value;
  } catch { return normalized; }
}

function siteDisplayUrl(site) {
  if (site.domain) return site.url;
  try {
    const parsed = new URL(site.url);
    if (['localhost', '127.0.0.1', '0.0.0.0', '[::]', '::'].includes(parsed.hostname)) parsed.hostname = location.hostname;
    return parsed.toString().replace(/\/$/, '');
  } catch { return site.url; }
}

function trafficLevel(value, maximum) {
  if (value <= 0 || maximum <= 0) return 0;
  // Logarithmic scaling keeps lower-volume countries visible without letting one hotspot flatten the map.
  const ratio = Math.log1p(value) / Math.log1p(maximum);
  if (ratio <= .2) return 1;
  if (ratio <= .4) return 2;
  if (ratio <= .6) return 3;
  if (ratio <= .8) return 4;
  return 5;
}

function renderTrafficOrigins(countries) {
  const rows = countries
    .map((row) => ({
      ...row,
      country: String(row.country || 'ZZ').toUpperCase(),
      requests: Number(row.requests || 0),
      visitors: Number(row.visitors || 0),
      bytes: Number(row.bytes || 0)
    }))
    .sort((a, b) => b.requests - a.requests || a.country.localeCompare(b.country));
  const byCountry = new Map(rows.map((row) => [row.country, row]));
  const knownRows = rows.filter((row) => row.country !== 'ZZ' && row.country !== 'XX' && row.country !== 'T1');
  const maximum = Math.max(1, ...knownRows.map((row) => row.requests));
  const geometry = window.SHAM_WORLD_MAP?.countries || [];
  const geometryCodes = new Set(geometry.map((country) => country.code));
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const knownRequests = knownRows.reduce((sum, row) => sum + row.requests, 0);
  const unknownRequests = Math.max(0, totalRequests - knownRequests);
  const coverage = totalRequests > 0 ? (knownRequests / totalRequests) * 100 : 0;
  const mappedRequests = knownRows.filter((row) => geometryCodes.has(row.country)).reduce((sum, row) => sum + row.requests, 0);
  const map = $('#traffic-map');

  if (!geometry.length) {
    map.innerHTML = '<div class="map-empty"><strong>Map data unavailable</strong><span>Country totals are still listed below.</span></div>';
  } else {
    const paths = geometry.map((country) => {
      const row = byCountry.get(country.code);
      const level = trafficLevel(Number(row?.requests || 0), maximum);
      const share = totalRequests > 0 && row ? (row.requests / totalRequests) * 100 : 0;
      const label = row
        ? `${countryName(country.code)}: ${formatNumber(row.requests)} requests, ${formatNumber(row.visitors)} unique IPs, ${share.toFixed(1)} percent of recorded traffic`
        : `${countryName(country.code)}: no recorded traffic`;
      return `<path class="map-country level-${level}" data-country="${escapeHtml(country.code)}" d="${country.path}" tabindex="0" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></path>`;
    }).join('');
    map.innerHTML = `<div class="map-stage"><svg viewBox="${escapeHtml(window.SHAM_WORLD_MAP.viewBox || '0 0 1000 500')}" role="img" aria-label="Equal Earth map of request origins by country" preserveAspectRatio="xMidYMid meet"><g class="map-countries">${paths}</g></svg><div class="map-tooltip" role="status" hidden></div></div>`;

    const tooltip = $('.map-tooltip', map);
    const showTooltip = (path, clientX, clientY) => {
      const code = path?.dataset.country;
      if (!code || !tooltip) return;
      const row = byCountry.get(code);
      const share = totalRequests > 0 && row ? (row.requests / totalRequests) * 100 : 0;
      tooltip.innerHTML = `<strong>${escapeHtml(countryName(code))}</strong><span>${formatNumber(row?.requests || 0)} requests · ${formatNumber(row?.visitors || 0)} unique IPs</span><span>${formatBytes(row?.bytes || 0)} transferred${row ? ` · ${share.toFixed(1)}% of traffic` : ''}</span>`;
      const bounds = map.getBoundingClientRect();
      const x = Number.isFinite(clientX) ? clientX - bounds.left : bounds.width / 2;
      const y = Number.isFinite(clientY) ? clientY - bounds.top : bounds.height / 2;
      tooltip.hidden = false;
      const halfWidth = Math.min(bounds.width / 2, tooltip.offsetWidth / 2 + 10);
      const tooltipHeight = tooltip.offsetHeight;
      tooltip.style.left = `${Math.max(halfWidth, Math.min(bounds.width - halfWidth, x))}px`;
      tooltip.style.top = `${Math.max(10, Math.min(bounds.height - 10, y))}px`;
      tooltip.classList.toggle('below', y - tooltipHeight - 18 < 0);
      $$('.map-country.is-active', map).forEach((item) => item.classList.remove('is-active'));
      $$(`.map-country[data-country="${CSS.escape(code)}"]`, map).forEach((item) => item.classList.add('is-active'));
    };
    const hideTooltip = () => {
      if (tooltip) tooltip.hidden = true;
      $$('.map-country.is-active', map).forEach((item) => item.classList.remove('is-active'));
    };
    map.onpointermove = (event) => {
      const path = event.target.closest?.('.map-country');
      if (path) showTooltip(path, event.clientX, event.clientY);
      else hideTooltip();
    };
    map.onpointerleave = hideTooltip;
    map.onfocusin = (event) => {
      const path = event.target.closest?.('.map-country');
      if (!path) return;
      const box = path.getBoundingClientRect();
      showTooltip(path, box.left + box.width / 2, box.top + box.height / 2);
    };
    map.onfocusout = (event) => {
      if (!map.contains(event.relatedTarget)) hideTooltip();
    };
  }

  $('#traffic-map-legend').innerHTML = '<span>Fewer requests</span><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><i class="level-4"></i><i class="level-5"></i><span>More requests</span>';
  const mapStatus = $('#traffic-map-status');
  if (!totalRequests) mapStatus.textContent = 'No traffic has been recorded yet.';
  else {
    const unmappedRequests = Math.max(0, knownRequests - mappedRequests);
    mapStatus.textContent = `${coverage.toFixed(1)}% of requests include trusted country data. ${formatNumber(unknownRequests)} request${unknownRequests === 1 ? '' : 's'} are unknown${unmappedRequests ? `; ${formatNumber(unmappedRequests)} geolocated requests use territories not present in the bundled map` : ''}.`;
  }

  const ranking = $('#country-ranking');
  ranking.innerHTML = rows.length
    ? rows.slice(0, 10).map((row) => {
      const contents = `<span title="${escapeHtml(countryName(row.country))}">${escapeHtml(countryName(row.country))}</span><strong>${formatNumber(row.requests)} <small>req</small></strong><em>${formatNumber(row.visitors)} IPs</em>`;
      return geometryCodes.has(row.country)
        ? `<button class="country-chip" data-map-country="${escapeHtml(row.country)}" type="button">${contents}</button>`
        : `<div class="country-chip noninteractive">${contents}</div>`;
    }).join('')
    : '<p class="muted">Country traffic will appear after requests are recorded through a trusted Cloudflare edge.</p>';
  ranking.onclick = (event) => {
    const button = event.target.closest('[data-map-country]');
    if (!button) return;
    const path = $(`.map-country[data-country="${CSS.escape(button.dataset.mapCountry)}"]`, map);
    if (path) path.focus();
    else toast(`${countryName(button.dataset.mapCountry)} is not represented in the bundled map geometry.`, 'warning');
  };
}

function renderVisitors(visitors) {
  const target = $('#visitor-table');
  if (!visitors.length) {
    target.innerHTML = '<tr><td colspan="5" class="muted">No visitor activity has been recorded yet.</td></tr>';
    return;
  }
  target.innerHTML = visitors.map((visitor) => `<tr>
    <td>${escapeHtml(visitor.ip)}</td>
    <td>${escapeHtml(countryName(visitor.country))}</td>
    <td>${escapeHtml(visitor.site_name)}</td>
    <td>${formatNumber(visitor.requests)}</td>
    <td>${escapeHtml(formatDate(visitor.last_request_at))}</td>
  </tr>`).join('');
}


async function loadSites() {
  if (!state.user) return;
  const requestId = ++state.siteListRequest;
  const refreshButton = $('#refresh-sites');
  setBusy(refreshButton, true, 'Refreshing…');
  try {
    const result = await api('/api/sites');
    if (requestId !== state.siteListRequest) return;
    state.sites = result.sites;
    renderSites();
  } catch (error) {
    if (requestId === state.siteListRequest) toast(error.message, 'error');
  } finally {
    if (requestId === state.siteListRequest) setBusy(refreshButton, false);
  }
}

function renderSites() {
  closeSiteActionMenu();
  const grid = $('#site-grid');
  const empty = $('#empty-sites');
  empty.hidden = state.sites.length > 0;
  grid.hidden = state.sites.length === 0;
  const running = state.sites.filter((site) => site.runtime.running).length;
  $('#site-summary').textContent = `${state.sites.length} configured · ${running} running`;
  grid.innerHTML = state.sites.map((site) => {
    const statusClass = site.runtime.error ? 'error' : site.runtime.running ? 'running' : '';
    const statusText = site.runtime.error ? 'Error' : site.runtime.running ? 'Running' : 'Stopped';
    const protocol = site.runtime.protocol || (site.ssl_enabled ? 'https' : 'http');
    const displayUrl = siteDisplayUrl(site);
    return `<article class="site-card" data-site-id="${site.id}">
      <div class="site-card-head"><div class="site-title"><h2>${escapeHtml(site.name)}</h2><a href="${escapeHtml(displayUrl)}" target="_blank" rel="noopener">${escapeHtml(displayUrl)}</a></div><span class="status-pill ${statusClass}">${statusText}</span></div>
      <div class="site-meta">
        <div class="meta-cell"><span>Runtime</span><strong>${site.runtime_type === 'node' ? 'Node.js' : 'Static'}${site.minify ? ' · Minified' : ''}${site.obfuscate ? ' · Obfuscated' : ''}</strong></div>
        <div class="meta-cell"><span>Listener</span><strong>${escapeHtml(site.bind_host)}:${site.port}</strong></div>
        <div class="meta-cell"><span>Entry</span><strong>${escapeHtml(site.runtime_type === 'node' ? site.node_entry : site.entry_file)}</strong></div>
        <div class="meta-cell"><span>Protection</span><strong>${site.domain_only ? 'Domain only · ' : ''}${site.firewall_enabled ? `${escapeHtml(site.firewall?.mode || 'local')} firewall · ` : ''}${site.cloudflare_enabled ? 'Cloudflare · ' : ''}${site.ssl_enabled ? 'SSL' : protocol.toUpperCase()}</strong></div>
      </div>
      ${site.runtime.error ? `<p class="site-error">${escapeHtml(site.runtime.error)}</p>` : ''}
      <div class="site-actions">
        <button class="button ${site.runtime.running ? 'danger' : 'primary'}" data-action="toggle" type="button">${site.runtime.running ? 'Stop' : 'Start'}</button>
        ${site.runtime_type === 'node' && site.runtime.running ? '<button class="button secondary" data-action="restart" type="button">Restart</button>' : ''}
        <button class="button secondary" data-action="files" type="button">Files</button>
        <button class="button secondary site-menu-trigger" data-action-menu type="button" aria-haspopup="menu" aria-expanded="false">More</button>
      </div>
    </article>`;
  }).join('');
}

function siteActionButtons(site) {
  return `<button data-action="edit" type="button" role="menuitem">Site settings</button>
    <button data-action="content" type="button" role="menuitem">Replace all files</button>
    <button data-action="tools" type="button" role="menuitem">Snapshots & security scan</button>
    ${state.user.role === 'admin' ? '<button data-action="operations" type="button" role="menuitem">Deployment operations</button>' : ''}
    ${site.runtime_type === 'node' ? '<button data-action="install" type="button" role="menuitem">Run npm install</button>' : ''}
    ${state.user.role === 'admin' && site.domain ? '<button data-action="cloudflare" type="button" role="menuitem">Sync Cloudflare DNS</button><button data-action="cloudflare-firewall" type="button" role="menuitem">Sync Cloudflare firewall</button><button data-action="certificate" type="button" role="menuitem">Issue / renew SSL</button><button data-action="certificate-wildcard" type="button" role="menuitem">Issue wildcard SSL</button>' : ''}
    <button class="danger-text" data-action="delete" type="button" role="menuitem">Delete site</button>`;
}

let siteMenuTrigger = null;
function closeSiteActionMenu({ restoreFocus = false } = {}) {
  const menu = $('#site-action-menu');
  if (menu.dataset.open !== '1') return;
  menu.dataset.open = '0';
  if (typeof menu.hidePopover === 'function') {
    try { menu.hidePopover(); } catch { menu.hidden = true; }
  } else menu.hidden = true;
  if (siteMenuTrigger) {
    siteMenuTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && siteMenuTrigger.isConnected) siteMenuTrigger.focus();
  }
  siteMenuTrigger = null;
}

function positionSiteActionMenu(trigger) {
  const menu = $('#site-action-menu');
  const triggerBox = trigger.getBoundingClientRect();
  const menuBox = menu.getBoundingClientRect();
  const gap = 8;
  const edge = 10;
  const availableBelow = window.innerHeight - triggerBox.bottom - edge;
  const availableAbove = triggerBox.top - edge;
  const openBelow = availableBelow >= Math.min(menuBox.height, 260) || availableBelow >= availableAbove;
  const top = openBelow
    ? Math.min(triggerBox.bottom + gap, window.innerHeight - menuBox.height - edge)
    : Math.max(edge, triggerBox.top - menuBox.height - gap);
  const left = Math.max(edge, Math.min(triggerBox.right - menuBox.width, window.innerWidth - menuBox.width - edge));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(edge, top))}px`;
}

function openSiteActionMenu(trigger, site) {
  closeSiteActionMenu();
  const menu = $('#site-action-menu');
  menu.dataset.siteId = String(site.id);
  menu.innerHTML = siteActionButtons(site);
  menu.hidden = false;
  menu.dataset.open = '1';
  siteMenuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  if (typeof menu.showPopover === 'function') {
    try { menu.showPopover(); } catch { /* The fixed-position fallback remains visible. */ }
  }
  requestAnimationFrame(() => {
    positionSiteActionMenu(trigger);
    $('button', menu)?.focus();
  });
}

function nextPort() {
  const used = new Set(state.sites.map((site) => Number(site.port)));
  let port = 4100;
  while (used.has(port)) port += 1;
  return port;
}

function updateRuntimeFields() {
  const node = $('#site-runtime').value === 'node';
  $('#static-fields').hidden = node;
  $('#node-fields').hidden = !node;
  $('#site-entry').required = !node;
  $('#site-node-entry').required = node;
}

$('#site-runtime').addEventListener('change', updateRuntimeFields);

function clearUpload(kind) {
  state.uploads[kind] = null;
  const label = kind === 'site' ? $('#upload-label') : $('#content-upload-label');
  label.textContent = kind === 'site' ? 'Drop a ZIP or project folder' : 'Drop a ZIP or project folder';
  const inputs = kind === 'site' ? ['#zip-input', '#folder-input'] : ['#content-zip-input', '#content-folder-input'];
  inputs.forEach((selector) => { $(selector).value = ''; });
}

function setUpload(kind, selection) {
  state.uploads[kind] = selection;
  const label = kind === 'site' ? $('#upload-label') : $('#content-upload-label');
  if (selection.archive) label.textContent = `${selection.archive.name} · ${formatBytes(selection.archive.size)}`;
  else label.textContent = `${selection.files.length} files · ${formatBytes(selection.files.reduce((sum, file) => sum + Number(file.size || 0), 0))}`;
}

async function validatedArchive(file) {
  if (!file) throw new Error('Choose a ZIP archive.');
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Choose a file with a .zip extension.');
  if (!file.size) throw new Error('The selected ZIP archive is empty.');
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const zipSignature = signature.length === 4 && signature[0] === 0x50 && signature[1] === 0x4b
    && ((signature[2] === 0x03 && signature[3] === 0x04)
      || (signature[2] === 0x05 && signature[3] === 0x06)
      || (signature[2] === 0x07 && signature[3] === 0x08));
  if (!zipSignature) throw new Error('The selected file does not appear to be a standard ZIP archive.');
  return file;
}

function commonBrowserTopDirectory(paths) {
  if (!paths.length) return null;
  const first = String(paths[0]).replaceAll('\\', '/').split('/');
  if (first.length < 2) return null;
  return paths.every((item) => String(item).replaceAll('\\', '/').startsWith(`${first[0]}/`)) ? first[0] : null;
}

function folderContainsEntry(selection, entryFile) {
  if (!selection?.files?.length) return false;
  const paths = selection.paths.map((item) => String(item).replaceAll('\\', '/').replace(/^\.\//, ''));
  const stripTop = commonBrowserTopDirectory(paths);
  const normalizedEntry = String(entryFile || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return paths.some((item) => (stripTop && item.startsWith(`${stripTop}/`) ? item.slice(stripTop.length + 1) : item) === normalizedEntry);
}

function folderSelection(fileList) {
  const files = [...fileList];
  if (files.length > MAX_BROWSER_UPLOAD_FILES) throw new Error(`Select at most ${MAX_BROWSER_UPLOAD_FILES} files at once.`);
  return { files, paths: files.map((file) => file.webkitRelativePath || file.name) };
}

async function readDroppedEntry(entry, prefix = '', counter = { count: 0 }) {
  if (entry.isFile) {
    counter.count += 1;
    if (counter.count > MAX_BROWSER_UPLOAD_FILES) throw new Error(`Drop at most ${MAX_BROWSER_UPLOAD_FILES} files at once.`);
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path: `${prefix}${file.name}` }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    entries.push(...batch);
  }
  const nested = await Promise.all(entries.map((child) => readDroppedEntry(child, `${prefix}${entry.name}/`, counter)));
  return nested.flat();
}

async function dropSelection(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  if (items.length && items.some((item) => item.webkitGetAsEntry?.())) {
    const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    const counter = { count: 0 };
    const results = (await Promise.all(entries.map((entry) => readDroppedEntry(entry, '', counter)))).flat();
    if (results.length === 1 && results[0].file.name.toLowerCase().endsWith('.zip')) return { archive: await validatedArchive(results[0].file) };
    return { files: results.map((item) => item.file), paths: results.map((item) => item.path) };
  }
  const files = [...dataTransfer.files];
  if (files.length > MAX_BROWSER_UPLOAD_FILES) throw new Error(`Drop at most ${MAX_BROWSER_UPLOAD_FILES} files at once.`);
  if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) return { archive: await validatedArchive(files[0]) };
  return { files, paths: files.map((file) => file.name) };
}

function bindUploadControls(kind, controls) {
  const zone = $(controls.zone);
  $(controls.zipButton).addEventListener('click', () => $(controls.zipInput).click());
  $(controls.folderButton).addEventListener('click', () => $(controls.folderInput).click());
  $(controls.zipInput).addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try { setUpload(kind, { archive: await validatedArchive(file) }); }
    catch (error) { event.target.value = ''; toast(error.message, 'error'); }
  });
  $(controls.folderInput).addEventListener('change', (event) => {
    try {
      if (event.target.files.length) setUpload(kind, folderSelection(event.target.files));
    } catch (error) {
      event.target.value = '';
      toast(error.message, 'error');
    }
  });
  ['dragenter', 'dragover'].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.remove('dragover');
  }));
  zone.addEventListener('drop', async (event) => {
    try {
      const selection = await dropSelection(event.dataTransfer);
      if (!selection.archive && !selection.files?.length) throw new Error('No files were found in the drop.');
      setUpload(kind, selection);
    } catch (error) { toast(error.message, 'error'); }
  });
}

bindUploadControls('site', { zone: '#drop-zone', zipButton: '#choose-zip', folderButton: '#choose-folder', zipInput: '#zip-input', folderInput: '#folder-input' });
bindUploadControls('content', { zone: '#content-drop-zone', zipButton: '#content-choose-zip', folderButton: '#content-choose-folder', zipInput: '#content-zip-input', folderInput: '#content-folder-input' });

function updateObfuscationFields() {
  const enabled = $('#site-obfuscate').checked;
  $('#site-obfuscation-warning').hidden = !enabled;
  $('#site-obfuscation-scan').disabled = !enabled || !$('#site-id').value;
  if (!enabled) {
    $('#site-obfuscation-report').innerHTML = '';
    $('#site-obfuscation-ack').checked = false;
  }
}

function renderObfuscationReport(report) {
  const target = $('#site-obfuscation-report');
  const severity = report.risk === 'high' ? 'error' : report.risk === 'medium' ? 'warning' : 'success';
  const summary = report.warningCount
    ? `${report.warningCount} compatibility warning${report.warningCount === 1 ? '' : 's'} found in ${report.scannedFiles} scanned files.`
    : `No known compatibility patterns were found in ${report.scannedFiles} scanned files.`;
  const warnings = (report.warnings || []).slice(0, 12).map((warning) => `<li><strong>${escapeHtml(warning.path)}:${warning.line}</strong> — ${escapeHtml(warning.message)}</li>`).join('');
  const skipped = report.skippedFiles?.length ? `<p>${formatNumber(report.skippedFiles.length)} file(s) were skipped, so the report is incomplete.</p>` : '';
  target.innerHTML = `<div class="compatibility-summary ${severity}"><strong>${escapeHtml(summary)}</strong><p>${escapeHtml(report.note || '')}</p>${skipped}${warnings ? `<ul>${warnings}</ul>` : ''}</div>`;
}

$('#site-obfuscate').addEventListener('change', updateObfuscationFields);
$('#site-obfuscation-scan').addEventListener('click', async () => {
  const id = $('#site-id').value;
  if (!id) return;
  const button = $('#site-obfuscation-scan');
  setBusy(button, true, 'Scanning…');
  $('#site-obfuscation-report').innerHTML = '<p class="muted">Scanning project files…</p>';
  try {
    const result = await api(`/api/sites/${id}/obfuscation-report`);
    renderObfuscationReport(result.report);
  } catch (error) {
    $('#site-obfuscation-report').innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  } finally { setBusy(button, false); updateObfuscationFields(); }
});

function openNewSite() {
  $('#site-form').reset();
  $('#site-id').value = '';
  $('#site-dialog-kicker').textContent = 'New deployment';
  $('#site-dialog-title').textContent = 'Add a site';
  $('#site-save').textContent = 'Upload site';
  $('#upload-section').hidden = false;
  $('#site-enabled').parentElement.hidden = false;
  $('#site-runtime').value = 'static';
  $('#site-port').value = nextPort();
  $('#site-host').value = '127.0.0.1';
  $('#site-entry').value = 'index.html';
  $('#site-node-entry').value = 'server.js';
  $('#site-cache').value = '0';
  $('#site-headers').value = '{}';
  $('#site-obfuscate').checked = false;
  $('#site-obfuscation-ack').checked = false;
  $('#site-obfuscation-report').innerHTML = '';
  $('#site-domain-only').checked = false;
  $('#site-compression').checked = true;
  $('#site-edge').checked = false;
  $('#site-security-preset').value = 'balanced';
  $('#site-csp').value = '';
  $('#site-health-path').value = '/';
  $('#site-health-interval').value = '30';
  $('#site-restart-policy').value = 'on-failure';
  $('#site-max-restarts').value = '5';
  $('#site-memory-limit').value = '0';
  $('#site-max-connections').value = '0';
  $('#runtime-safety-options').open = false;
  $('#site-firewall-enabled').checked = false;
  $('#site-firewall-mode').value = 'local';
  $('#site-firewall-action').value = 'managed_challenge';
  $('#site-firewall-rate').value = '0';
  $('#site-firewall-body').value = '0';
  $('#site-firewall-blocked-ips').value = '';
  $('#site-firewall-allowed-ips').value = '';
  $('#site-firewall-blocked-countries').value = '';
  $('#site-firewall-allowed-countries').value = '';
  $('#site-firewall-bots').checked = false;
  $('#firewall-options').open = false;
  $('#site-runtime-isolation').value = 'process';
  $('#site-container-image').value = 'node:22-alpine';
  $('#site-cpu-limit').value = '0';
  $('#site-pids-limit').value = '128';
  $('#site-outbound-network').checked = true;
  $('#site-anubis-enabled').checked = false;
  $('#site-anubis-preset').value = 'balanced';
  $('#site-anubis-difficulty').value = '4';
  $('#site-anubis-policy').value = '';
  $('#site-release-mode').checked = false;
  $('#site-git-url').value = '';
  $('#site-git-branch').value = 'main';
  $('#site-preview-domain').value = '';
  $('#site-maintenance-enabled').checked = false;
  $('#site-maintenance-html').value = '';
  $('#site-redirects').value = '[]';
  $('#site-error-pages').value = '{}';
  $('#site-cache-rules').value = '[]';
  $('#isolation-options').open = false;
  $('#delivery-options').open = false;
  $('#site-form-error').textContent = '';
  clearUpload('site');
  updateRuntimeFields();
  updateFirewallFields();
  updateObfuscationFields();
  updateIsolationFields();
  showModal($('#site-dialog'));
}

function updateIsolationFields() {
  const docker = $('#site-runtime-isolation').value === 'docker';
  const nodeRuntime = $('#site-runtime').value === 'node';
  for (const id of ['site-container-image', 'site-cpu-limit', 'site-pids-limit', 'site-outbound-network']) {
    const field = $(`#${id}`);
    field.disabled = !docker || !nodeRuntime;
  }
  const anubis = $('#site-anubis-enabled').checked;
  $('#site-anubis-preset').disabled = !anubis;
  $('#site-anubis-difficulty').disabled = !anubis;
  $('#site-anubis-policy').disabled = !anubis || $('#site-anubis-preset').value !== 'custom';
}

$('#site-runtime-isolation').addEventListener('change', updateIsolationFields);
$('#site-anubis-enabled').addEventListener('change', updateIsolationFields);
$('#site-anubis-preset').addEventListener('change', updateIsolationFields);

$('#new-site-button').addEventListener('click', openNewSite);
$$('[data-open-new-site]').forEach((button) => button.addEventListener('click', openNewSite));
$('#refresh-sites').addEventListener('click', loadSites);

function openEditSite(site) {
  $('#site-form').reset();
  $('#site-id').value = site.id;
  $('#site-dialog-kicker').textContent = 'Deployment settings';
  $('#site-dialog-title').textContent = `Edit ${site.name}`;
  $('#site-save').textContent = 'Save settings';
  $('#upload-section').hidden = true;
  $('#site-enabled').parentElement.hidden = true;
  $('#site-name').value = site.name;
  $('#site-runtime').value = site.runtime_type;
  $('#site-port').value = site.port;
  $('#site-host').value = site.bind_host;
  $('#site-domain').value = site.domain || '';
  $('#site-entry').value = site.entry_file;
  $('#site-node-entry').value = site.node_entry;
  $('#site-cache').value = site.cache_seconds;
  $('#site-headers').value = JSON.stringify(site.headers || {}, null, 2);
  $('#site-spa').checked = site.spa_fallback;
  $('#site-minify').checked = site.minify;
  $('#site-obfuscate').checked = site.obfuscate;
  $('#site-obfuscation-ack').checked = Boolean(site.obfuscation_risk_acknowledged);
  $('#site-obfuscation-report').innerHTML = '';
  $('#site-install').checked = site.install_dependencies;
  $('#site-ssl').checked = site.ssl_enabled;
  $('#site-domain-only').checked = site.domain_only;
  $('#site-compression').checked = site.compression !== false;
  $('#site-edge').checked = Boolean(site.edge_enabled);
  $('#site-security-preset').value = site.security_preset || 'balanced';
  $('#site-csp').value = site.csp || '';
  $('#site-health-path').value = site.health_check_path || '/';
  $('#site-health-interval').value = site.health_check_interval || 30;
  $('#site-restart-policy').value = site.restart_policy || 'on-failure';
  $('#site-max-restarts').value = site.max_restarts ?? 5;
  $('#site-memory-limit').value = site.memory_limit_mb || 0;
  $('#site-max-connections').value = site.max_connections || 0;
  $('#runtime-safety-options').open = Boolean(site.edge_enabled || site.memory_limit_mb || site.max_connections || site.security_preset === 'strict' || site.csp);
  $('#site-firewall-enabled').checked = site.firewall_enabled;
  $('#site-firewall-mode').value = site.firewall?.mode || 'local';
  $('#site-firewall-action').value = site.firewall?.cloudflareAction || 'managed_challenge';
  $('#site-firewall-rate').value = site.firewall?.rateLimitPerMinute || 0;
  $('#site-firewall-body').value = site.firewall?.maxBodyKb || 0;
  $('#site-firewall-blocked-ips').value = (site.firewall?.blockedIps || []).join('\n');
  $('#site-firewall-allowed-ips').value = (site.firewall?.allowedIps || []).join('\n');
  $('#site-firewall-blocked-countries').value = (site.firewall?.blockedCountries || []).join(', ');
  $('#site-firewall-allowed-countries').value = (site.firewall?.allowedCountries || []).join(', ');
  $('#site-firewall-bots').checked = Boolean(site.firewall?.blockBots);
  $('#firewall-options').open = site.firewall_enabled;
  $('#site-runtime-isolation').value = site.runtime_isolation || 'process';
  $('#site-container-image').value = site.container_image || 'node:22-alpine';
  $('#site-cpu-limit').value = site.cpu_limit || 0;
  $('#site-pids-limit').value = site.pids_limit || 128;
  $('#site-outbound-network').checked = site.outbound_network !== false;
  $('#site-anubis-enabled').checked = Boolean(site.anubis_enabled);
  $('#site-anubis-preset').value = site.anubis_preset || 'balanced';
  $('#site-anubis-difficulty').value = site.anubis_difficulty || 4;
  $('#site-anubis-policy').value = site.anubis_policy || '';
  $('#site-release-mode').checked = Boolean(site.release_mode);
  $('#site-git-url').value = site.git_url || '';
  $('#site-git-branch').value = site.git_branch || 'main';
  $('#site-preview-domain').value = site.preview_domain || '';
  $('#site-maintenance-enabled').checked = Boolean(site.maintenance_enabled);
  $('#site-maintenance-html').value = site.maintenance_html || '';
  $('#site-redirects').value = JSON.stringify(site.redirects || [], null, 2);
  $('#site-error-pages').value = JSON.stringify(site.errorPages || site.error_pages || {}, null, 2);
  $('#site-cache-rules').value = JSON.stringify(site.cacheRules || site.cache_rules || [], null, 2);
  $('#isolation-options').open = Boolean(site.runtime_isolation === 'docker' || site.anubis_enabled);
  $('#delivery-options').open = Boolean(site.release_mode || site.git_url || site.preview_domain || site.maintenance_enabled || (site.redirects || []).length || Object.keys(site.errorPages || {}).length || (site.cacheRules || []).length);
  $('#site-form-error').textContent = '';
  updateRuntimeFields();
  updateFirewallFields();
  updateObfuscationFields();
  updateIsolationFields();
  showModal($('#site-dialog'));
}

function appendConfiguration(formData) {
  formData.append('name', $('#site-name').value);
  formData.append('runtimeType', $('#site-runtime').value);
  formData.append('port', $('#site-port').value);
  formData.append('bindHost', $('#site-host').value);
  formData.append('domain', $('#site-domain').value);
  formData.append('entryFile', $('#site-entry').value || 'index.html');
  formData.append('nodeEntry', $('#site-node-entry').value || 'server.js');
  formData.append('cacheSeconds', $('#site-cache').value || '0');
  formData.append('headers', $('#site-headers').value || '{}');
  formData.append('spaFallback', String($('#site-spa').checked));
  formData.append('minify', String($('#site-minify').checked));
  formData.append('obfuscate', String($('#site-obfuscate').checked));
  formData.append('obfuscationRiskAcknowledged', String($('#site-obfuscation-ack').checked));
  formData.append('installDependencies', String($('#site-install').checked));
  formData.append('sslEnabled', String($('#site-ssl').checked));
  formData.append('domainOnly', String($('#site-domain-only').checked));
  formData.append('compression', String($('#site-compression').checked));
  formData.append('edgeEnabled', String($('#site-edge').checked));
  formData.append('securityPreset', $('#site-security-preset').value);
  formData.append('csp', $('#site-csp').value);
  formData.append('healthCheckPath', $('#site-health-path').value || '/');
  formData.append('healthCheckInterval', $('#site-health-interval').value || '30');
  formData.append('restartPolicy', $('#site-restart-policy').value);
  formData.append('maxRestarts', $('#site-max-restarts').value || '5');
  formData.append('memoryLimitMb', $('#site-memory-limit').value || '0');
  formData.append('maxConnections', $('#site-max-connections').value || '0');
  formData.append('firewallEnabled', String($('#site-firewall-enabled').checked));
  formData.append('firewallMode', $('#site-firewall-mode').value);
  formData.append('firewallCloudflareAction', $('#site-firewall-action').value);
  formData.append('firewallRateLimit', $('#site-firewall-rate').value || '0');
  formData.append('firewallMaxBodyKb', $('#site-firewall-body').value || '0');
  formData.append('firewallBlockedIps', $('#site-firewall-blocked-ips').value);
  formData.append('firewallAllowedIps', $('#site-firewall-allowed-ips').value);
  formData.append('firewallBlockedCountries', $('#site-firewall-blocked-countries').value);
  formData.append('firewallAllowedCountries', $('#site-firewall-allowed-countries').value);
  formData.append('firewallBlockBots', String($('#site-firewall-bots').checked));
  formData.append('runtimeIsolation', $('#site-runtime-isolation').value);
  formData.append('containerImage', $('#site-container-image').value);
  formData.append('cpuLimit', $('#site-cpu-limit').value || '0');
  formData.append('pidsLimit', $('#site-pids-limit').value || '128');
  formData.append('outboundNetwork', String($('#site-outbound-network').checked));
  formData.append('anubisEnabled', String($('#site-anubis-enabled').checked));
  formData.append('anubisPreset', $('#site-anubis-preset').value);
  formData.append('anubisDifficulty', $('#site-anubis-difficulty').value || '4');
  formData.append('anubisPolicy', $('#site-anubis-policy').value);
  formData.append('releaseMode', String($('#site-release-mode').checked));
  formData.append('gitUrl', $('#site-git-url').value);
  formData.append('gitBranch', $('#site-git-branch').value || 'main');
  formData.append('previewDomain', $('#site-preview-domain').value);
  formData.append('maintenanceEnabled', String($('#site-maintenance-enabled').checked));
  formData.append('maintenanceHtml', $('#site-maintenance-html').value);
  formData.append('redirects', $('#site-redirects').value || '[]');
  formData.append('errorPages', $('#site-error-pages').value || '{}');
  formData.append('cacheRules', $('#site-cache-rules').value || '[]');
  formData.append('enabled', String($('#site-enabled').checked));
}

function appendUpload(formData, selection) {
  if (selection.archive) formData.append('archive', selection.archive, selection.archive.name);
  else {
    selection.files.forEach((file) => formData.append('files', file, file.name));
    formData.append('relativePaths', JSON.stringify(selection.paths));
  }
}

$('#site-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#site-id').value;
  const button = $('#site-save');
  $('#site-form-error').textContent = '';
  setBusy(button, true, id ? 'Saving…' : 'Uploading…');
  try {
    let result;
    if (id) {
      result = await api(`/api/sites/${id}`, {
        method: 'PUT',
        body: {
          name: $('#site-name').value,
          runtimeType: $('#site-runtime').value,
          port: $('#site-port').value,
          bindHost: $('#site-host').value,
          domain: $('#site-domain').value,
          entryFile: $('#site-entry').value || 'index.html',
          nodeEntry: $('#site-node-entry').value || 'server.js',
          cacheSeconds: $('#site-cache').value || '0',
          headers: $('#site-headers').value || '{}',
          spaFallback: $('#site-spa').checked,
          minify: $('#site-minify').checked,
          obfuscate: $('#site-obfuscate').checked,
          obfuscationRiskAcknowledged: $('#site-obfuscation-ack').checked,
          installDependencies: $('#site-install').checked,
          sslEnabled: $('#site-ssl').checked,
          domainOnly: $('#site-domain-only').checked,
          compression: $('#site-compression').checked,
          edgeEnabled: $('#site-edge').checked,
          securityPreset: $('#site-security-preset').value,
          csp: $('#site-csp').value,
          healthCheckPath: $('#site-health-path').value || '/',
          healthCheckInterval: $('#site-health-interval').value || '30',
          restartPolicy: $('#site-restart-policy').value,
          maxRestarts: $('#site-max-restarts').value || '5',
          memoryLimitMb: $('#site-memory-limit').value || '0',
          maxConnections: $('#site-max-connections').value || '0',
          firewallEnabled: $('#site-firewall-enabled').checked,
          firewallMode: $('#site-firewall-mode').value,
          firewallCloudflareAction: $('#site-firewall-action').value,
          firewallRateLimit: $('#site-firewall-rate').value || '0',
          firewallMaxBodyKb: $('#site-firewall-body').value || '0',
          firewallBlockedIps: $('#site-firewall-blocked-ips').value,
          firewallAllowedIps: $('#site-firewall-allowed-ips').value,
          firewallBlockedCountries: $('#site-firewall-blocked-countries').value,
          firewallAllowedCountries: $('#site-firewall-allowed-countries').value,
          firewallBlockBots: $('#site-firewall-bots').checked,
          runtimeIsolation: $('#site-runtime-isolation').value,
          containerImage: $('#site-container-image').value,
          cpuLimit: $('#site-cpu-limit').value || '0',
          pidsLimit: $('#site-pids-limit').value || '128',
          outboundNetwork: $('#site-outbound-network').checked,
          anubisEnabled: $('#site-anubis-enabled').checked,
          anubisPreset: $('#site-anubis-preset').value,
          anubisDifficulty: $('#site-anubis-difficulty').value || '4',
          anubisPolicy: $('#site-anubis-policy').value,
          releaseMode: $('#site-release-mode').checked,
          gitUrl: $('#site-git-url').value,
          gitBranch: $('#site-git-branch').value || 'main',
          previewDomain: $('#site-preview-domain').value,
          maintenanceEnabled: $('#site-maintenance-enabled').checked,
          maintenanceHtml: $('#site-maintenance-html').value,
          redirects: $('#site-redirects').value || '[]',
          errorPages: $('#site-error-pages').value || '{}',
          cacheRules: $('#site-cache-rules').value || '[]'
        }
      });
    } else {
      if (!state.uploads.site) throw new Error('Choose a ZIP archive or project folder.');
      const entryFile = $('#site-runtime').value === 'node' ? ($('#site-node-entry').value || 'server.js') : ($('#site-entry').value || 'index.html');
      if (!state.uploads.site.archive && !folderContainsEntry(state.uploads.site, entryFile)) {
        throw new Error(`The selected folder does not contain the configured entry file “${entryFile}” after removing its top-level folder.`);
      }
      const formData = new FormData();
      appendConfiguration(formData);
      appendUpload(formData, state.uploads.site);
      result = await api('/api/sites', { method: 'POST', body: formData });
    }
    closeModal($('#site-dialog'));
    toast(result.warning || (id ? 'Site settings saved.' : 'Site uploaded.'), result.warning ? 'warning' : 'success');
    await Promise.all([loadSites(), loadOverview()]);
  } catch (error) {
    $('#site-form-error').textContent = error.message;
  } finally { setBusy(button, false); }
});

function openContent(site) {
  state.contentSite = site;
  $('#content-site-id').value = site.id;
  $('#content-title').textContent = `Replace ${site.name}`;
  $('#content-form-error').textContent = '';
  clearUpload('content');
  showModal($('#content-dialog'));
}

$('#content-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const selection = state.uploads.content;
  const button = $('#content-form button[type="submit"]');
  $('#content-form-error').textContent = '';
  setBusy(button, true, 'Replacing…');
  try {
    if (!selection) throw new Error('Choose a ZIP archive or project folder.');
    const entryFile = state.contentSite?.runtime_type === 'node' ? state.contentSite.node_entry : state.contentSite?.entry_file;
    if (!selection.archive && entryFile && !folderContainsEntry(selection, entryFile)) {
      throw new Error(`The selected folder does not contain this site's entry file “${entryFile}” after removing its top-level folder.`);
    }
    const formData = new FormData();
    appendUpload(formData, selection);
    const result = await api(`/api/sites/${$('#content-site-id').value}/content`, { method: 'PUT', body: formData });
    closeModal($('#content-dialog'));
    const snapshotNote = result.rollbackSnapshot ? ` Rollback snapshot #${result.rollbackSnapshot.id} was retained.` : '';
    toast(`${result.warning || 'Project files replaced.'}${snapshotNote}`, result.warning ? 'warning' : 'success');
    await Promise.all([loadSites(), loadOverview()]);
  } catch (error) { $('#content-form-error').textContent = error.message; }
  finally { setBusy(button, false); }
});

async function handleSiteAction(site, action, button) {
  if (action === 'edit') return openEditSite(site);
  if (action === 'content') return openContent(site);
  if (action === 'files') return openFiles(site);
  if (action === 'tools') return openSiteTools(site);
  if (action === 'operations') { state.operationsSiteId = site.id; showSection('operations'); return; }
  if (action === 'delete') {
    if (!(await requestAction({ title: `Delete ${site.name}?`, message: 'This permanently removes the site configuration and every stored project file.', confirmLabel: 'Delete site', danger: true }))) return;
    setBusy(button, true, 'Deleting…');
    try {
      await api(`/api/sites/${site.id}`, { method: 'DELETE' });
      toast('Site deleted.');
      await Promise.all([loadSites(), loadOverview()]);
    } catch (error) { toast(error.message, 'error'); setBusy(button, false); }
    return;
  }
  const labels = { toggle: site.runtime.running ? 'Stopping…' : 'Starting…', restart: 'Restarting…', install: 'Installing…', cloudflare: 'Syncing DNS…', 'cloudflare-firewall': 'Syncing firewall…', certificate: 'Issuing…', 'certificate-wildcard': 'Issuing wildcard…' };
  setBusy(button, true, labels[action] || 'Working…');
  try {
    if (action === 'toggle') await api(`/api/sites/${site.id}/toggle`, { method: 'PATCH', body: { enabled: !site.runtime.running } });
    if (action === 'restart') await api(`/api/sites/${site.id}/restart`, { method: 'POST' });
    if (action === 'install') {
      const result = await api(`/api/sites/${site.id}/npm-install`, { method: 'POST' });
      const snapshotNote = result.rollbackSnapshot ? ` Rollback snapshot #${result.rollbackSnapshot.id} was retained.` : '';
      toast(`${result.warning || result.message}${snapshotNote}`, result.warning ? 'warning' : 'success');
    }
    if (action === 'cloudflare') {
      const result = await api(`/api/admin/sites/${site.id}/cloudflare`, { method: 'POST' });
      toast(result.warning || `Cloudflare proxy enabled for ${result.record.name}.`, result.warning ? 'warning' : 'success');
    }
    if (action === 'cloudflare-firewall') {
      const result = await api(`/api/admin/sites/${site.id}/cloudflare-firewall`, { method: 'POST' });
      toast(result.message || 'Cloudflare firewall synchronized.');
    }
    if (action === 'certificate' || action === 'certificate-wildcard') {
      const wildcard = action === 'certificate-wildcard';
      if (wildcard && !(await requestAction({ title: 'Issue wildcard certificate?', message: `This requests both ${site.domain} and *.${site.domain} using Cloudflare DNS validation.`, confirmLabel: 'Issue wildcard' }))) return;
      const result = await api(`/api/admin/sites/${site.id}/certificate`, { method: 'POST', body: { wildcard } });
      toast(result.warning || result.message, result.warning ? 'warning' : 'success');
    }
    await Promise.all([loadSites(), loadOverview()]);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
}

$('#site-grid').addEventListener('click', async (event) => {
  const menuTrigger = event.target.closest('[data-action-menu]');
  if (menuTrigger) {
    const card = menuTrigger.closest('[data-site-id]');
    const site = state.sites.find((item) => item.id === Number(card?.dataset.siteId));
    if (site) openSiteActionMenu(menuTrigger, site);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const card = button.closest('[data-site-id]');
  const site = state.sites.find((item) => item.id === Number(card?.dataset.siteId));
  if (site) await handleSiteAction(site, button.dataset.action, button);
});

$('#site-action-menu').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const site = state.sites.find((item) => item.id === Number($('#site-action-menu').dataset.siteId));
  const trigger = siteMenuTrigger;
  closeSiteActionMenu();
  if (site) await handleSiteAction(site, button.dataset.action, trigger || button);
});

$('#site-action-menu').addEventListener('toggle', (event) => {
  if (event.newState === 'closed' && $('#site-action-menu').dataset.open === '1') closeSiteActionMenu();
});

$('#site-action-menu').addEventListener('keydown', (event) => {
  const buttons = $$('[role="menuitem"]', event.currentTarget);
  const index = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSiteActionMenu({ restoreFocus: true });
  } else if (event.key === 'ArrowDown' && buttons.length) {
    event.preventDefault();
    buttons[(index + 1 + buttons.length) % buttons.length].focus();
  } else if (event.key === 'ArrowUp' && buttons.length) {
    event.preventDefault();
    buttons[(index - 1 + buttons.length) % buttons.length].focus();
  }
});

document.addEventListener('click', (event) => {
  if (event.target.closest('#site-action-menu, [data-action-menu]')) return;
  closeSiteActionMenu();
});

let siteMenuPositionFrame = null;
function refreshSiteActionMenuPosition() {
  if (!siteMenuTrigger || $('#site-action-menu').dataset.open !== '1') return;
  if (siteMenuPositionFrame) cancelAnimationFrame(siteMenuPositionFrame);
  siteMenuPositionFrame = requestAnimationFrame(() => {
    siteMenuPositionFrame = null;
    if (!siteMenuTrigger?.isConnected) return closeSiteActionMenu();
    const box = siteMenuTrigger.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= window.innerHeight || box.right <= 0 || box.left >= window.innerWidth) {
      closeSiteActionMenu();
      return;
    }
    positionSiteActionMenu(siteMenuTrigger);
  });
}
window.addEventListener('resize', refreshSiteActionMenuPosition);
$('.workspace').addEventListener('scroll', refreshSiteActionMenuPosition, { passive: true });

$('#site-firewall-enabled').addEventListener('change', (event) => {
  if (event.target.checked) $('#firewall-options').open = true;
  updateFirewallFields();
});
$('#site-firewall-mode').addEventListener('change', updateFirewallFields);

function updateFirewallFields() {
  const enabled = $('#site-firewall-enabled').checked;
  const mode = $('#site-firewall-mode').value;
  const local = enabled && ['local', 'both'].includes(mode);
  const cloudflare = enabled && ['cloudflare', 'both'].includes(mode);
  ['#site-firewall-rate', '#site-firewall-body', '#site-firewall-bots'].forEach((selector) => { $(selector).disabled = !local; });
  $('#site-firewall-action').disabled = !cloudflare;
}
$('#site-domain-only').addEventListener('change', (event) => {
  if (event.target.checked && !$('#site-domain').value.trim()) {
    toast('Enter a domain before enabling domain-only access.', 'warning');
    $('#site-domain').focus();
  }
});

function resetEditor(message = 'Select a text file') {
  state.selectedFile = null;
  state.editorDirty = false;
  $('#editor-path').textContent = message;
  $('#editor-meta').textContent = '';
  $('#document-editor').value = '';
  $('#document-editor').disabled = true;
  $('#save-file').disabled = true;
  $('#editor-status').textContent = '';
  renderFileList();
}

async function openFiles(site) {
  state.fileListRequest += 1;
  state.fileContentRequest += 1;
  state.fileSite = site;
  state.files = [];
  $('#files-site-id').value = site.id;
  $('#files-title').textContent = `${site.name} files`;
  $('#restart-file-site').textContent = site.runtime.running ? 'Restart site' : 'Start site';
  resetEditor();
  $('#file-search').value = '';
  showModal($('#files-dialog'));
  await loadFiles();
}

async function loadFiles() {
  if (!state.fileSite) return;
  const siteId = state.fileSite.id;
  const requestId = ++state.fileListRequest;
  try {
    const result = await api(`/api/sites/${siteId}/files`);
    if (!state.fileSite || state.fileSite.id !== siteId || requestId !== state.fileListRequest) return;
    state.files = result.files;
    renderFileList();
  } catch (error) {
    if (state.fileSite?.id === siteId && requestId === state.fileListRequest) toast(error.message, 'error');
  }
}

function renderFileList() {
  const query = $('#file-search').value.trim().toLowerCase();
  const matches = state.files.filter((file) => file.path.toLowerCase().includes(query));
  const visible = matches.slice(0, 500);
  const notice = matches.length > visible.length
    ? `<p class="file-limit-note muted">Showing 500 of ${formatNumber(matches.length)} matches. Refine the filter to find more.</p>`
    : '';
  $('#file-list').innerHTML = visible.length
    ? `${visible.map((file) => `<button class="file-item ${state.selectedFile?.path === file.path ? 'active' : ''}" data-file-path="${escapeHtml(file.path)}" type="button" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</button>`).join('')}${notice}`
    : '<p class="muted">No matching files.</p>';
}

$('#file-search').addEventListener('input', renderFileList);

$('#file-list').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-file-path]');
  if (!item) return;
  if (state.editorDirty && !(await requestAction({ title: 'Discard unsaved changes?', message: 'Opening another file will discard the current editor changes.', confirmLabel: 'Discard changes', danger: true }))) return;
  await openEditorFile(item.dataset.filePath);
});

async function openEditorFile(filePath) {
  if (!state.fileSite) return false;
  const siteId = state.fileSite.id;
  const requestId = ++state.fileContentRequest;
  try {
    const file = await api(`/api/sites/${siteId}/files/content?path=${encodeURIComponent(filePath)}`);
    if (!state.fileSite || state.fileSite.id !== siteId || requestId !== state.fileContentRequest) return false;
    state.selectedFile = file;
    state.editorDirty = false;
    $('#editor-path').textContent = file.path;
    $('#editor-meta').textContent = `${formatBytes(file.size)} · ${formatDate(file.modifiedAt)}`;
    $('#document-editor').value = file.content;
    $('#document-editor').disabled = false;
    $('#save-file').disabled = false;
    $('#editor-status').textContent = 'Saved';
    renderFileList();
    return true;
  } catch (error) {
    if (state.fileSite?.id === siteId && requestId === state.fileContentRequest) toast(error.message, 'error');
    return false;
  }
}

$('#document-editor').addEventListener('input', () => {
  if (!state.selectedFile) return;
  state.editorDirty = true;
  $('#editor-status').textContent = 'Unsaved changes';
});

$('#document-editor').addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const editor = event.target;
    const start = editor.selectionStart;
    editor.setRangeText('  ', start, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    $('#save-file').click();
  }
});

$('#new-file').addEventListener('click', async () => {
  if (state.editorDirty && !(await requestAction({ title: 'Discard unsaved changes?', message: 'Creating a new file will discard the current editor changes.', confirmLabel: 'Discard changes', danger: true }))) return;
  const pathValue = await requestAction({ title: 'Create a file', message: 'Use a relative path inside this site.', confirmLabel: 'Create file', inputLabel: 'Relative file path', placeholder: 'src/config.json' });
  if (!pathValue) return;
  state.selectedFile = { path: pathValue, content: '', size: 0, modifiedAt: null };
  state.editorDirty = true;
  $('#editor-path').textContent = pathValue;
  $('#editor-meta').textContent = 'New file';
  $('#document-editor').value = '';
  $('#document-editor').disabled = false;
  $('#save-file').disabled = false;
  $('#editor-status').textContent = 'Not saved';
  $('#document-editor').focus();
  renderFileList();
});

$('#save-file').addEventListener('click', async () => {
  if (!state.selectedFile) return;
  const button = $('#save-file');
  setBusy(button, true, 'Saving…');
  try {
    const result = await api(`/api/sites/${state.fileSite.id}/files/content`, {
      method: 'PUT',
      body: { path: state.selectedFile.path, content: $('#document-editor').value }
    });
    state.editorDirty = false;
    $('#editor-status').textContent = result.restartRecommended ? 'Saved · restart recommended' : 'Saved';
    toast(result.restartRecommended ? 'File saved. Restart the Node.js site to load server-side changes.' : 'File saved.');
    await loadFiles();
    await openEditorFile(state.selectedFile.path);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#replace-file').addEventListener('click', async () => {
  if (state.editorDirty && !(await requestAction({ title: 'Discard unsaved changes?', message: 'Replacing this file will discard the current editor changes.', confirmLabel: 'Discard and replace', danger: true }))) return;
  let target = state.selectedFile?.path;
  if (!target) target = await requestAction({ title: 'Replace a file', message: 'Choose the destination path, then select the replacement file.', confirmLabel: 'Choose file', inputLabel: 'Relative destination path', placeholder: 'assets/logo.svg' });
  if (!target) return;
  $('#single-file-input').dataset.path = target;
  $('#single-file-input').click();
});

$('#single-file-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  const target = event.target.dataset.path;
  event.target.value = '';
  if (!file || !target) return;
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('path', target);
  const button = $('#replace-file');
  setBusy(button, true, 'Replacing…');
  try {
    const result = await api(`/api/sites/${state.fileSite.id}/files/upload`, { method: 'PUT', body: formData });
    toast(result.restartRecommended ? 'File replaced. Restart the Node.js site to load changes.' : 'File replaced.');
    state.editorDirty = false;
    await loadFiles();
    if (!(await openEditorFile(target))) resetEditor('Preview unavailable for this file');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#delete-file').addEventListener('click', async () => {
  if (!state.selectedFile) return toast('Select a file first.', 'error');
  if (!(await requestAction({ title: `Delete ${state.selectedFile.path}?`, message: 'This file will be permanently removed from the site.', confirmLabel: 'Delete file', danger: true }))) return;
  const button = $('#delete-file');
  setBusy(button, true, 'Deleting…');
  try {
    const result = await api(`/api/sites/${state.fileSite.id}/files?path=${encodeURIComponent(state.selectedFile.path)}`, { method: 'DELETE' });
    toast(result.warning || 'File deleted.', result.warning ? 'warning' : 'success');
    resetEditor();
    await Promise.all([loadFiles(), loadSites()]);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#restart-file-site').addEventListener('click', async (event) => {
  if (!state.fileSite) return;
  const wasRunning = state.fileSite.runtime.running;
  setBusy(event.target, true, wasRunning ? 'Restarting…' : 'Starting…');
  try {
    await api(`/api/sites/${state.fileSite.id}/restart`, { method: 'POST' });
    toast(wasRunning ? 'Site restarted.' : 'Site started.');
    await loadSites();
    state.fileSite = state.sites.find((site) => site.id === state.fileSite.id) || state.fileSite;
    event.target.textContent = 'Restart site';
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.target, false); }
});

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

function withClientTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function pluginContext(pluginId) {
  return {
    api,
    toast,
    pluginId,
    getSites: () => [...state.sites],
    getUser: () => ({ ...state.user }),
    refresh: async () => Promise.all([loadSites(), loadOverview()])
  };
}

window.SHAM = {
  _loadingPluginId: null,
  registerPlugin(definition) {
    if (!definition?.id) throw new Error('Plugin client must provide an ID.');
    const id = String(definition.id);
    if (window.SHAM._loadingPluginId && id !== window.SHAM._loadingPluginId) throw new Error(`Plugin client ID must match ${window.SHAM._loadingPluginId}.`);
    state.pluginDefinitions.set(id, definition);
    renderPluginExtensions();
  },
  api,
  toast,
  getSites: () => [...state.sites],
  getUser: () => ({ ...state.user })
};

let pluginLoadPromise = null;
let pluginLoadPending = false;
let pluginScriptReloadPending = false;
function loadPlugins(reloadScripts = true) {
  if (!state.user) return Promise.resolve();
  pluginLoadPending = true;
  pluginScriptReloadPending ||= reloadScripts;
  if (pluginLoadPromise) return pluginLoadPromise;

  pluginLoadPromise = (async () => {
    while (pluginLoadPending && state.user) {
      const userId = state.user.id;
      const shouldReloadScripts = pluginScriptReloadPending;
      pluginLoadPending = false;
      pluginScriptReloadPending = false;
      try {
        const result = await api('/api/plugins');
        if (!state.user || state.user.id !== userId) continue;
        state.plugins = result.plugins;
        renderPlugins();
        if (!shouldReloadScripts) continue;
        for (const [pluginId, definition] of state.pluginDefinitions) {
          try {
            await withClientTimeout(
              Promise.resolve().then(() => definition.deactivate?.(pluginContext(pluginId))),
              5_000,
              'Client cleanup exceeded 5 seconds.'
            );
          } catch (error) { toast(`Could not unload ${pluginId}: ${error.message}`, 'warning'); }
        }
        if (!state.user || state.user.id !== userId) continue;
        $$('script[data-sham-plugin]').forEach((script) => script.remove());
        state.pluginDefinitions.clear();
        renderPluginExtensions();
        for (const plugin of state.plugins.filter((item) => item.enabled && item.hasClient)) {
          const script = document.createElement('script');
          script.src = `/api/plugins/${encodeURIComponent(plugin.id)}/client.js?v=${encodeURIComponent(plugin.updatedAt || Date.now())}`;
          script.dataset.shamPlugin = plugin.id;
          script.addEventListener('error', () => toast(`Could not load the ${plugin.name} client.`, 'error'));
          document.body.append(script);
        }
      } catch (error) { if (state.user?.id === userId) toast(error.message, 'error'); }
    }
  })().finally(() => {
    pluginLoadPromise = null;
    if (pluginLoadPending && state.user) void loadPlugins(pluginScriptReloadPending);
  });
  return pluginLoadPromise;
}

function settingInput(plugin, setting) {
  const value = plugin.settings?.[setting.key] ?? setting.default ?? '';
  const disabled = state.user.role !== 'admin' ? 'disabled' : '';
  if (setting.type === 'checkbox') return `<label class="checkbox-line"><input data-plugin-setting="${escapeHtml(setting.key)}" type="checkbox" ${value ? 'checked' : ''} ${disabled}><span>${escapeHtml(setting.label)}</span></label>`;
  if (setting.type === 'textarea') return `<label><span>${escapeHtml(setting.label)}</span><textarea data-plugin-setting="${escapeHtml(setting.key)}" ${disabled}>${escapeHtml(value)}</textarea>${setting.description ? `<small>${escapeHtml(setting.description)}</small>` : ''}</label>`;
  if (setting.type === 'password') {
    const configured = Boolean(plugin.secretConfigured?.[setting.key]);
    return `<div class="secret-setting"><label><span>${escapeHtml(setting.label)}</span><input data-plugin-setting="${escapeHtml(setting.key)}" type="password" value="" autocomplete="new-password" placeholder="${configured ? 'Saved secret · leave blank to keep' : 'Enter secret'}" ${disabled}>${setting.description ? `<small>${escapeHtml(setting.description)}</small>` : ''}</label>${configured && state.user.role === 'admin' ? `<label class="checkbox-line secret-clear"><input data-plugin-secret-clear="${escapeHtml(setting.key)}" type="checkbox"><span>Clear saved secret</span></label>` : ''}</div>`;
  }
  return `<label><span>${escapeHtml(setting.label)}</span><input data-plugin-setting="${escapeHtml(setting.key)}" type="${setting.type === 'number' ? 'number' : 'text'}" value="${escapeHtml(value)}" ${disabled}>${setting.description ? `<small>${escapeHtml(setting.description)}</small>` : ''}</label>`;
}

function renderPlugins() {
  const grid = $('#plugins-grid');
  if (!state.plugins.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">◇</div><h2>No plugins installed</h2><p>Download an example from Documentation or install a reviewed plugin ZIP.</p></div>';
    return;
  }
  grid.innerHTML = state.plugins.map((plugin) => `<article class="plugin-card" data-plugin-id="${escapeHtml(plugin.id)}">
    <div class="plugin-card-header"><div><h2>${escapeHtml(plugin.name)} <span class="muted">v${escapeHtml(plugin.version)}</span></h2><p>${escapeHtml(plugin.description || 'No description provided.')}</p></div><span class="plugin-type">${escapeHtml(plugin.type)}</span></div>
    <div class="plugin-trust-row">
      <span class="badge ${plugin.signatureStatus === 'verified' ? 'success' : 'warning'}">${plugin.signatureStatus === 'verified' ? 'Signed · verified' : 'Unsigned'}</span>
      <span class="badge">${escapeHtml(plugin.isolation === 'worker' ? 'Worker isolated' : 'In process')}</span>
    </div>
    <div class="permission-list" aria-label="Plugin permissions">${(plugin.permissions || []).length ? (plugin.permissions || []).map((permission) => `<span>${escapeHtml(permission)}</span>`).join('') : '<span>No privileged permissions</span>'}</div>
    <label class="switch-row"><span>${plugin.enabled ? 'Enabled' : 'Disabled'}</span><input data-plugin-toggle type="checkbox" ${plugin.enabled ? 'checked' : ''} ${state.user.role !== 'admin' ? 'disabled' : ''}><span class="switch"></span></label>
    <div class="plugin-actions">${plugin.settingsSchema?.length ? '<button class="button secondary" data-plugin-action="settings" type="button">Settings page</button>' : ''}${state.user.role === 'admin' ? '<button class="button danger" data-plugin-action="delete" type="button">Delete plugin</button>' : ''}</div>
  </article>`).join('');
}

function nestedValue(value, pathValue) {
  if (!pathValue) return value;
  return String(pathValue).split('.').reduce((current, key) => current?.[key], value);
}

async function renderJsonPage(page, content, pluginId) {
  const cards = Array.isArray(page.cards) ? page.cards : [];
  content.innerHTML = `${page.description ? `<p class="muted">${escapeHtml(page.description)}</p>` : ''}${cards.length ? `<div class="stats-grid">${cards.map((card, index) => `<article class="stat-card" data-json-card="${index}"><span>${escapeHtml(card.label || '')}</span><strong>${escapeHtml(card.value || (card.action ? '…' : ''))}</strong><small>${escapeHtml(card.description || '')}</small></article>`).join('')}</div>` : ''}`;
  await Promise.all(cards.map(async (card, index) => {
    if (!card.action) return;
    const target = `[data-json-card="${index}"] strong`;
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(card.action)}`);
      $(target, content).textContent = String(nestedValue(result, card.valuePath) ?? '');
    } catch (error) {
      $(target, content).textContent = 'Error';
      $(target, content).title = error.message;
    }
  }));
}

function renderPluginExtensions() {
  $('#plugin-nav').innerHTML = '';
  $('#plugin-sections').innerHTML = '';
  $('#plugin-dashboard').innerHTML = '';
  const usedSections = new Set();

  for (const plugin of state.plugins.filter((item) => item.settingsSchema?.length)) {
    const sectionName = `plugin-settings-${plugin.id}`;
    usedSections.add(sectionName);
    const nav = document.createElement('button');
    nav.className = 'nav-item';
    nav.type = 'button';
    nav.dataset.section = sectionName;
    nav.innerHTML = `<span>⚙</span>${escapeHtml(plugin.name)} settings`;
    $('#plugin-nav').append(nav);

    const section = document.createElement('section');
    section.id = `section-${sectionName}`;
    section.className = 'view-section';
    section.hidden = true;
    section.dataset.pluginSettingsId = plugin.id;
    section.innerHTML = `<header class="page-header"><div><p class="eyebrow">Plugin settings</p><h1>${escapeHtml(plugin.name)}</h1><p class="muted">Configure this plugin independently from its lifecycle controls.</p></div><button class="button secondary" data-section="plugins" type="button">Back to plugins</button></header><article class="panel plugin-settings-page"><div class="plugin-settings">${plugin.settingsSchema.map((setting) => settingInput(plugin, setting)).join('')}</div>${state.user.role === 'admin' ? '<div class="form-actions"><button class="button primary" data-plugin-settings-save type="button">Save settings</button></div>' : '<p class="muted">Administrator access is required to change plugin settings.</p>'}</article>`;
    $('#plugin-sections').append(section);
  }
  for (const [pluginId, definition] of state.pluginDefinitions) {
    const dashboardCards = (definition.dashboardCards || definition.ui?.dashboardCards || []).slice(0, 50);
    for (const card of dashboardCards) {
      const article = document.createElement('article');
      article.className = 'stat-card';
      if (typeof card.render === 'function') {
        Promise.resolve(card.render(article, pluginContext(pluginId))).catch((error) => { article.textContent = error.message; });
      } else {
        article.innerHTML = `<span>${escapeHtml(card.label || definition.name || pluginId)}</span><strong>${escapeHtml(card.value || (card.action ? '…' : ''))}</strong><small>${escapeHtml(card.description || '')}</small>`;
        if (card.action) {
          api(`/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(card.action)}`)
            .then((result) => { $('strong', article).textContent = String(nestedValue(result, card.valuePath) ?? ''); })
            .catch((error) => { $('strong', article).textContent = 'Error'; article.title = error.message; });
        }
      }
      $('#plugin-dashboard').append(article);
    }
    const pages = (definition.pages || definition.ui?.pages || []).slice(0, 30);
    for (const page of pages) {
      const pageId = String(page.id || page.title || 'page').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
      const baseSectionName = `plugin-${pluginId}-${pageId}`;
      let sectionName = baseSectionName;
      let suffix = 2;
      while (usedSections.has(sectionName)) sectionName = `${baseSectionName}-${suffix++}`;
      usedSections.add(sectionName);
      const nav = document.createElement('button');
      nav.className = 'nav-item';
      nav.type = 'button';
      nav.dataset.section = sectionName;
      nav.innerHTML = `<span>·</span>${escapeHtml(page.title || definition.name || pluginId)}`;
      $('#plugin-nav').append(nav);
      const section = document.createElement('section');
      section.id = `section-${sectionName}`;
      section.className = 'view-section';
      section.hidden = true;
      section.innerHTML = `<header class="page-header"><div><p class="eyebrow">Plugin · ${escapeHtml(definition.name || pluginId)}</p><h1>${escapeHtml(page.title || definition.name || pluginId)}</h1><p class="muted">${escapeHtml(page.description || '')}</p></div></header><article class="panel plugin-page-content plugin-surface"></article>`;
      section._pluginId = pluginId;
      if (typeof page.render === 'function') section._pluginPage = page;
      else section._pluginPage = { render: (content) => renderJsonPage(page, content, pluginId) };
      $('#plugin-sections').append(section);
    }
  }

  if (state.currentSection?.startsWith('plugin-')) {
    const current = $(`#section-${CSS.escape(state.currentSection)}`);
    if (current) showSection(state.currentSection, { refresh: false });
    else showSection('plugins', { refresh: false });
  }
}

$('#plugins-grid').addEventListener('change', async (event) => {
  const toggle = event.target.closest('[data-plugin-toggle]');
  if (!toggle) return;
  const card = toggle.closest('[data-plugin-id]');
  toggle.disabled = true;
  try {
    await api(`/api/admin/plugins/${encodeURIComponent(card.dataset.pluginId)}/toggle`, { method: 'PATCH', body: { enabled: toggle.checked } });
    toast(toggle.checked ? 'Plugin enabled.' : 'Plugin disabled.');
    await loadPlugins(true);
  } catch (error) {
    toggle.checked = !toggle.checked;
    toast(error.message, 'error');
  } finally { toggle.disabled = false; }
});

$('#plugins-grid').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-plugin-action]');
  if (!button) return;
  const card = button.closest('[data-plugin-id]');
  const id = card.dataset.pluginId;
  const action = button.dataset.pluginAction;
  if (action === 'settings') return showSection(`plugin-settings-${id}`);
  if (action === 'delete' && !(await requestAction({ title: `Delete plugin ${id}?`, message: 'The plugin files and saved settings will be permanently removed.', confirmLabel: 'Delete plugin', danger: true }))) return;
  setBusy(button, true, 'Deleting…');
  try {
    await api(`/api/admin/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Plugin deleted.');
    await loadPlugins(true);
  } catch (error) { toast(error.message, 'error'); setBusy(button, false); }
});

$('#plugin-sections').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-plugin-settings-save]');
  if (!button) return;
  const section = button.closest('[data-plugin-settings-id]');
  const id = section.dataset.pluginSettingsId;
  const settings = {};
  const clearSecrets = $$('[data-plugin-secret-clear]:checked', section).map((input) => input.dataset.pluginSecretClear);
  $$('[data-plugin-setting]', section).forEach((input) => {
    settings[input.dataset.pluginSetting] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  });
  setBusy(button, true, 'Saving…');
  try {
    await api(`/api/admin/plugins/${encodeURIComponent(id)}/settings`, { method: 'PUT', body: { settings, clearSecrets } });
    toast('Plugin settings saved.');
    await loadPlugins(true);
    showSection(`plugin-settings-${id}`, { refresh: false });
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

function openPluginInstaller() {
  if (state.user?.role !== 'admin') {
    toast('Administrator access is required to install plugins.', 'error');
    return;
  }
  $('#plugin-form').reset();
  $('#plugin-form-error').textContent = '';
  $('#plugin-file-status').textContent = 'Choose a ZIP containing plugin.json.';
  showModal($('#plugin-dialog'));
  requestAnimationFrame(() => $('#plugin-file').focus());
}

$('#plugin-file').addEventListener('change', () => {
  const file = $('#plugin-file').files[0];
  $('#plugin-file-status').textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'Choose a ZIP containing plugin.json.';
});

$('#plugin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#plugin-file').files[0];
  const button = $('#plugin-form button[type="submit"]');
  $('#plugin-form-error').textContent = '';
  setBusy(button, true, 'Installing…');
  try {
    if (!file) throw new Error('Choose a plugin ZIP archive.');
    if (!/\.zip$/i.test(file.name) && !['application/zip', 'application/x-zip-compressed'].includes(file.type)) throw new Error('Plugins must be installed from a ZIP archive.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Plugin archives may not exceed 20 MB.');
    const data = new FormData();
    data.append('plugin', file, file.name);
    data.append('allowUnsigned', String($('#plugin-unsigned-ack').checked));
    await api('/api/admin/plugins', { method: 'POST', body: data });
    closeModal($('#plugin-dialog'));
    toast('Plugin installed. Review its settings, then enable it.');
    await loadPlugins(true);
  } catch (error) { $('#plugin-form-error').textContent = error.message; }
  finally { setBusy(button, false); }
});

function selectDocumentationTab(tab, { focus = false } = {}) {
  $$('[data-doc-tab]').forEach((item) => {
    const active = item === tab;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
  });
  $('#docs-usage').hidden = tab.dataset.docTab !== 'usage';
  $('#docs-development').hidden = tab.dataset.docTab !== 'development';
  if (focus) tab.focus();
}

$$('[data-doc-tab]').forEach((tab) => {
  tab.addEventListener('click', () => selectDocumentationTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('[data-doc-tab]');
    const current = tabs.indexOf(tab);
    const target = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs.at(-1)
        : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    selectDocumentationTab(target, { focus: true });
  });
});

async function loadAdmin() {
  if (state.user.role !== 'admin') return;
  const requestId = ++state.adminRequest;
  const button = $('#refresh-users');
  setBusy(button, true, 'Refreshing…');
  try {
    const [settings, users] = await Promise.all([api('/api/admin/settings'), api('/api/admin/users')]);
    if (requestId !== state.adminRequest) return;
    $('#registration-toggle').checked = settings.registrationEnabled;
    $('#registration-label').textContent = settings.registrationEnabled ? 'Open' : 'Locked';
    const integrations = settings.integrations;
    $('#cloudflare-zone').value = integrations.cloudflareZoneId || '';
    $('#cloudflare-ip').value = integrations.cloudflareTargetIp || '';
    $('#certbot-email').value = integrations.certbotEmail || '';
    $('#cloudflare-token').value = '';
    $('#clear-cloudflare-token').checked = false;
    $('#cloudflare-token').disabled = false;
    $('#cloudflare-token-status').textContent = integrations.cloudflareTokenConfigured ? 'A token is currently saved.' : 'No token is saved.';
    const security = settings.security || {};
    $('#visitor-privacy').value = security.visitorPrivacyMode || 'mask';
    $('#log-retention').value = security.logRetentionDays || 30;
    $('#alert-cpu').value = security.alertCpuPercent || 90;
    $('#alert-loop').value = security.alertEventLoopMs || 250;
    $('#alert-disk').value = security.alertDiskPercent || 90;
    $('#alert-traffic').value = security.alertTrafficMultiplier || 5;
    $('#alert-errors').value = security.alertErrorPercent || 25;
    $('#allow-unsigned-plugins').checked = Boolean(security.allowUnsignedPlugins);
    $('#plugin-trusted-keys').value = JSON.stringify(security.pluginTrustedKeys || [], null, 2);
    const edge = security.edge || {};
    $('#edge-status').textContent = edge.enabled
      ? `Shared edge proxy: HTTP ${edge.httpRunning ? `listening on ${edge.host}:${edge.httpPort}` : 'not listening'} · HTTPS ${edge.httpsRunning ? `listening on ${edge.host}:${edge.httpsPort}` : edge.httpsNeedsCertificate ? 'waiting for an installed certificate' : 'not configured'}.`
      : 'Shared edge proxy is disabled. Set SHAM_EDGE_HTTP_PORT and/or SHAM_EDGE_HTTPS_PORT to publish domain-routed sites through common ports.';
    $('#rotate-master-key').disabled = Boolean(security.masterKeyExternal);
    $('#rotate-master-key').title = security.masterKeyExternal ? 'Rotation is controlled by SHAM_MASTER_KEY.' : '';
    renderUsers(users.users);
  } catch (error) { if (requestId === state.adminRequest) toast(error.message, 'error'); }
  finally { if (requestId === state.adminRequest) setBusy(button, false); }
}

function renderUsers(users) {
  $('#users-table').innerHTML = users.map((user) => `<tr data-user-id="${user.id}">
    <td><div class="table-user"><span class="table-avatar">${escapeHtml(user.username.slice(0,1).toUpperCase())}</span>${escapeHtml(user.username)}${user.id === state.user.id ? ' (you)' : ''}</div></td>
    <td><select data-field="role" ${user.id === state.user.id ? 'disabled' : ''}><option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
    <td><label class="switch-row"><span>${user.active ? 'Active' : 'Disabled'}</span><input data-field="active" type="checkbox" ${user.active ? 'checked' : ''} ${user.id === state.user.id ? 'disabled' : ''}><span class="switch"></span></label></td>
    <td>${escapeHtml(formatDate(user.createdAt))}</td>
    <td><div class="site-actions"><button class="button secondary" data-user-action="save" type="button">Save</button><button class="button danger" data-user-action="delete" type="button" ${user.id === state.user.id ? 'disabled' : ''}>Delete</button></div></td>
  </tr>`).join('');
}

$('#registration-toggle').addEventListener('change', async (event) => {
  event.target.disabled = true;
  try {
    const result = await api('/api/admin/settings/registration', { method: 'PATCH', body: { enabled: event.target.checked } });
    $('#registration-label').textContent = result.registrationEnabled ? 'Open' : 'Locked';
    toast(result.registrationEnabled ? 'Registration opened.' : 'Registration locked.');
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, 'error');
  } finally { event.target.disabled = false; }
});

$('#clear-cloudflare-token').addEventListener('change', (event) => {
  $('#cloudflare-token').disabled = event.target.checked;
  if (event.target.checked) $('#cloudflare-token').value = '';
});

$('#integrations-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#integrations-form button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    const result = await api('/api/admin/settings/integrations', {
      method: 'PUT',
      body: {
        cloudflareApiToken: $('#cloudflare-token').value,
        clearCloudflareToken: $('#clear-cloudflare-token').checked,
        cloudflareZoneId: $('#cloudflare-zone').value,
        cloudflareTargetIp: $('#cloudflare-ip').value,
        certbotEmail: $('#certbot-email').value
      }
    });
    $('#cloudflare-token').value = '';
    $('#clear-cloudflare-token').checked = false;
    $('#cloudflare-token').disabled = false;
    $('#cloudflare-token-status').textContent = result.integrations.cloudflareTokenConfigured ? 'A token is currently saved.' : 'No token is saved.';
    toast('Integration settings saved.');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#renew-certificates').addEventListener('click', async (event) => {
  setBusy(event.target, true, 'Renewing…');
  try {
    const result = await api('/api/admin/certificates/renew', { method: 'POST' });
    toast(result.warning || result.message, result.warning ? 'warning' : 'success');
    await loadSites();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.target, false); }
});

$('#users-table').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-user-action]');
  if (!button) return;
  const row = button.closest('[data-user-id]');
  const id = Number(row.dataset.userId);
  const action = button.dataset.userAction;
  if (action === 'delete' && !(await requestAction({ title: 'Delete this user?', message: 'This dashboard account will permanently lose access.', confirmLabel: 'Delete user', danger: true }))) return;
  setBusy(button, true, action === 'save' ? 'Saving…' : 'Deleting…');
  try {
    if (action === 'save') {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { role: $('[data-field="role"]', row).value, active: $('[data-field="active"]', row).checked } });
      toast('User updated.');
    } else {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      toast('User deleted.');
    }
    await loadAdmin();
  } catch (error) { toast(error.message, 'error'); setBusy(button, false); }
});

$('#refresh-users').addEventListener('click', loadAdmin);


function operationsSite() {
  const id = Number($('#operations-site')?.value || state.operationsSiteId || 0);
  return state.sites.find((site) => site.id === id) || null;
}

function setOperationsTab(name, { focus = false } = {}) {
  $$('[data-operations-tab]').forEach((button) => {
    const active = button.dataset.operationsTab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(`#operations-${button.dataset.operationsTab}`).hidden = !active;
    if (active && focus) button.focus();
  });
}

$$('[data-operations-tab]').forEach((button) => {
  button.addEventListener('click', () => setOperationsTab(button.dataset.operationsTab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('[data-operations-tab]');
    const current = tabs.indexOf(button);
    const next = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs.at(-1)
        : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    setOperationsTab(next.dataset.operationsTab, { focus: true });
  });
});

function addEnvironmentRow(variable = {}) {
  const row = document.createElement('div');
  row.className = 'config-row env-row';
  row.innerHTML = `<label><span>Key</span><input data-env-key maxlength="128" value="${escapeHtml(variable.key || '')}" placeholder="API_TOKEN"></label>
    <label><span>Value</span><input data-env-value type="${variable.secret ? 'password' : 'text'}" value="${escapeHtml(variable.value || '')}" placeholder="${variable.secret ? 'Leave blank to preserve' : 'Value'}"></label>
    <label><span>Scope</span><select data-env-scope><option value="runtime">Runtime</option><option value="build">Build</option><option value="both">Build + runtime</option></select></label>
    <label class="checkbox-line compact-check"><input data-env-secret type="checkbox" ${variable.secret ? 'checked' : ''}><span>Secret</span></label>
    <button class="icon-button danger-text" data-remove-config-row type="button" aria-label="Remove environment variable">×</button>`;
  $('[data-env-scope]', row).value = variable.scope || 'runtime';
  $('[data-env-secret]', row).addEventListener('change', (event) => { $('[data-env-value]', row).type = event.target.checked ? 'password' : 'text'; });
  $('[data-remove-config-row]', row).addEventListener('click', () => row.remove());
  $('#environment-rows').append(row);
}

function clearJobForm() {
  $('#job-form').reset();
  $('#job-id').value = '';
  $('#job-schedule').value = '0 3 * * *';
  $('#job-timeout').value = '900';
  $('#job-enabled').checked = true;
}

function renderOperationsSite(payload) {
  const site = payload?.site;
  if (!site) return;
  $('#release-mode-status').textContent = site.release_mode ? 'Atomic releases' : 'Direct files';
  $('#release-mode-status').className = `badge ${site.release_mode ? 'success' : ''}`;
  $('#git-url').value = site.git_url || '';
  $('#git-branch').value = site.git_branch || 'main';
  $('#git-install-dependencies').checked = Boolean(site.install_dependencies);
  $('#export-site-config').href = `/api/sites/${site.id}/config/export`;

  const releases = payload.releases || [];
  $('#release-list').innerHTML = releases.length ? releases.map((release) => `<div class="event-item"><div><strong>${escapeHtml(release.version)}</strong><span>${escapeHtml(release.source)} · ${escapeHtml(formatDate(release.createdAt))}${release.commitSha ? ` · ${escapeHtml(release.commitSha.slice(0, 12))}` : ''}</span></div>${release.active ? '<span class="badge success">Active</span>' : `<button class="button secondary" data-release-rollback="${release.id}" type="button">Roll back</button>`}</div>`).join('') : '<p class="muted">No atomic releases yet. The first Git deployment creates one.</p>';

  const previews = payload.previews || [];
  $('#preview-list').innerHTML = previews.length ? previews.map((preview) => `<div class="event-item"><div><strong><a href="http://${escapeHtml(preview.hostname)}" target="_blank" rel="noopener">${escapeHtml(preview.hostname)}</a></strong><span>Expires ${escapeHtml(formatDate(preview.expiresAt))} · port ${preview.port}</span></div><button class="button danger" data-preview-delete="${preview.id}" type="button">Remove</button></div>`).join('') : '<p class="muted">No active previews.</p>';

  $('#environment-rows').innerHTML = '';
  for (const variable of payload.environment || []) addEnvironmentRow(variable);
  if (!(payload.environment || []).length) addEnvironmentRow();

  $('#site-database-profiles').innerHTML = (payload.databaseProfiles || []).length
    ? payload.databaseProfiles.map((profile) => `<label class="check-card"><input type="checkbox" value="${profile.id}" ${profile.attached ? 'checked' : ''}><span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.type)} → ${escapeHtml(profile.envKey)}</small></span></label>`).join('')
    : '<p class="muted">No instance database profiles are configured.</p>';

  $('#job-list').innerHTML = (payload.jobs || []).length ? payload.jobs.map((job) => `<div class="event-item"><div><strong>${escapeHtml(job.name)}</strong><span><code>${escapeHtml(job.schedule)}</code> · next ${escapeHtml(formatDate(job.next_run_at))} · ${job.last_status || 'never run'}</span><small>${escapeHtml(job.command)}</small></div><div class="inline-actions"><button class="button secondary" data-job-run="${job.id}" type="button" ${job.running ? 'disabled' : ''}>${job.running ? 'Running…' : 'Run now'}</button><button class="button ghost" data-job-edit="${job.id}" type="button">Edit</button><button class="button danger" data-job-delete="${job.id}" type="button">Delete</button></div></div>`).join('') : '<p class="muted">No scheduled tasks.</p>';
  $('#job-list').dataset.jobs = JSON.stringify(payload.jobs || []);
}

function renderOperationsInstance(payload) {
  const settings = payload.settings || {};
  const backup = payload.backupSettings || {};
  const tunnel = payload.cloudflareTunnel || {};
  const tunnelState = {
    disabled: ['Disabled', ''],
    stopped: ['Stopped', ''],
    'needs-token': ['Token required', 'warning'],
    unavailable: ['Unavailable', 'error'],
    starting: ['Connecting', 'warning'],
    connected: ['Connected', 'success'],
    backoff: ['Restarting', 'warning'],
    error: ['Error', 'error']
  }[tunnel.state] || ['Unknown', 'warning'];
  $('#cloudflare-tunnel-status').textContent = tunnelState[0];
  $('#cloudflare-tunnel-status').className = `badge ${tunnelState[1]}`.trim();
  $('#cloudflare-tunnel-enabled').checked = Boolean(tunnel.enabled);
  $('#cloudflare-tunnel-token').value = '';
  $('#cloudflare-tunnel-token').disabled = false;
  $('#clear-cloudflare-tunnel-token').checked = false;
  $('#cloudflare-tunnel-token-status').textContent = tunnel.tokenConfigured
    ? tunnel.tokenReadable === false ? 'A token is saved but cannot be decrypted. Replace or clear it.' : 'A tunnel token is currently saved.'
    : 'No tunnel token is saved.';
  $('#cloudflare-tunnel-token-status').dataset.configured = tunnel.tokenConfigured ? '1' : '0';
  $('#cloudflare-tunnel-token-status').dataset.readable = tunnel.tokenReadable === false ? '0' : '1';
  const tunnelDetails = [];
  if (!tunnel.enabled) tunnelDetails.push('The connector is disabled.');
  else if (!tunnel.available) tunnelDetails.push(`${tunnel.command || 'cloudflared'} is not installed or executable.`);
  else if (tunnel.connected) tunnelDetails.push(`Connected${tunnel.connectedAt ? ` since ${formatDate(tunnel.connectedAt)}` : ''}${tunnel.pid ? ` · process ${tunnel.pid}` : ''}.`);
  else if (tunnel.running) tunnelDetails.push(`Connector process is running${tunnel.startedAt ? ` since ${formatDate(tunnel.startedAt)}` : ''} and is waiting for an edge connection.`);
  else tunnelDetails.push('The connector is not running.');
  if (tunnel.restartCount) tunnelDetails.push(`${tunnel.restartCount} supervised restart${tunnel.restartCount === 1 ? '' : 's'} recorded.`);
  if (tunnel.lastError) tunnelDetails.push(tunnel.lastError);
  $('#cloudflare-tunnel-detail').textContent = tunnelDetails.join(' ');
  $('#cloudflare-tunnel-detail').className = `notice span-2 ${['error', 'unavailable', 'backoff', 'needs-token'].includes(tunnel.state) ? 'warning' : ''}`.trim();
  $('#restart-cloudflare-tunnel').disabled = !tunnel.enabled || !tunnel.tokenConfigured || !tunnel.available;
  $('#backup-provider').value = backup.provider || 'local';
  $('#backup-schedule').value = backup.schedule || '0 2 * * *';
  $('#backup-enabled').checked = Boolean(backup.enabled);
  const config = backup.config || {};
  $('#backup-destination').value = config.destination || config.repository || config.remotePath || '';
  $('#backup-retention').value = config.retention || 14;
  $('#backup-options').value = JSON.stringify(config, null, 2);
  $('#backup-secret-status').textContent = (backup.secretFields || []).length ? `Stored encrypted credentials: ${(backup.secretFields || []).join(', ')}. Leave those keys absent or blank to preserve them.` : 'Credentials entered here are encrypted and are never returned by the API.';
  $('#backup-list').innerHTML = (payload.backups || []).length ? payload.backups.slice(0, 12).map((backupRun) => `<div class="event-item"><div><strong>${escapeHtml(backupRun.filename || 'Backup')}</strong><span>${escapeHtml(backupRun.destination)} · ${formatBytes(backupRun.bytes)} · ${escapeHtml(formatDate(backupRun.finishedAt || backupRun.startedAt))}</span>${backupRun.detail ? `<small>${escapeHtml(backupRun.detail)}</small>` : ''}</div><span class="badge ${backupRun.status === 'success' ? 'success' : backupRun.status === 'failed' ? 'error' : 'warning'}">${escapeHtml(backupRun.status)}</span></div>`).join('') : '<p class="muted">No backup runs recorded.</p>';

  $('#prometheus-enabled').checked = Boolean(settings.prometheusEnabled);
  $('#prometheus-token').value = '';
  $('#prometheus-token').disabled = false;
  $('#clear-prometheus-token').checked = false;
  $('#prometheus-token-status').textContent = settings.prometheusTokenConfigured ? 'A metrics token is currently saved.' : 'No metrics token is saved.';
  $('#prometheus-token-status').dataset.configured = settings.prometheusTokenConfigured ? '1' : '0';
  $('#otel-endpoint').value = settings.otelEndpoint || '';
  $('#otel-headers').value = '{}';
  $('#otel-headers').disabled = false;
  $('#clear-otel-headers').checked = false;
  $('#otel-headers-status').textContent = settings.otelHeadersConfigured ? 'OpenTelemetry headers are currently saved.' : 'No OpenTelemetry headers are saved.';
  $('#public-status-enabled').checked = Boolean(settings.publicStatusEnabled);
  $('#public-status-title').value = settings.publicStatusTitle || 'SHAM service status';
  $('#instance-locale').value = settings.locale || 'en';
  $('#update-channel').value = settings.updateChannel || 'stable';

  $('#alert-destination-list').innerHTML = (payload.alertDestinations || []).length ? payload.alertDestinations.map((destination) => `<div class="event-item"><div><strong>${escapeHtml(destination.name)}</strong><span>${escapeHtml(destination.kind)} · ${destination.enabled ? 'enabled' : 'disabled'}</span></div><div class="inline-actions"><button class="button secondary" data-alert-test="${destination.id}" type="button">Test</button><button class="button danger" data-alert-delete="${destination.id}" type="button">Delete</button></div></div>`).join('') : '<p class="muted">No alert destinations.</p>';

  $('#database-profile-list').innerHTML = (payload.databaseProfiles || []).length ? payload.databaseProfiles.map((profile) => `<div class="event-item"><div><strong>${escapeHtml(profile.name)}</strong><span>${escapeHtml(profile.type)} · ${escapeHtml(profile.envKey)}</span></div><button class="button danger" data-database-delete="${profile.id}" type="button">Delete</button></div>`).join('') : '<p class="muted">No database profiles.</p>';

  const update = payload.update || {};
  const pending = update.pending || update.staged || null;
  $('#update-status').textContent = pending ? 'Restart required' : 'Idle';
  $('#update-status').className = `badge ${pending ? 'warning' : 'success'}`;
  $('#update-detail').textContent = pending ? `Version ${pending.version || 'unknown'} is staged. Restart SHAM to apply it.` : 'No update is staged.';
  $('#cancel-update').disabled = !pending;

  const capabilities = payload.capabilities || {};
  const items = [
    ['Docker isolation', capabilities.docker, capabilities.dockerReason],
    ['Git releases', capabilities.git, capabilities.git ? '' : 'Git executable was not found.'],
    ['Cloudflare Tunnel', capabilities.cloudflared, capabilities.cloudflared ? '' : 'The cloudflared executable was not found.'],
    ['Anubis', capabilities.anubis, capabilities.anubis ? '' : (capabilities.dockerReason || 'Anubis requires Docker isolation support.')],
    ['External backup', backup.configured, backup.configured ? '' : 'Configure and test an external backup destination.'],
    ['Public status', settings.publicStatusEnabled, settings.publicStatusEnabled ? '' : 'Public status is disabled.']
  ];
  $('#operations-capabilities').innerHTML = items.map(([label, ready, reason]) => `<span class="capability ${ready ? 'ready' : ''}"${reason ? ` title="${escapeHtml(reason)}"` : ''}>${ready ? '✓' : '○'} ${escapeHtml(label)}</span>`).join('');

  const site = operationsSite();
  const checklist = [
    ['Create at least one site', state.sites.length > 0],
    ['Use a domain and shared edge proxy', Boolean(site?.domain && site?.edge_enabled)],
    ['Enable multi-factor authentication', Boolean(state.security?.user?.totpEnabled || (state.security?.passkeys || []).length)],
    ['Configure external backups', Boolean(backup.configured)],
    ['Configure an alert destination', Boolean((payload.alertDestinations || []).length)],
    ['Enable isolated runtime for untrusted Node code', site?.runtime_type !== 'node' || site?.runtime_isolation === 'docker']
  ];
  $('#setup-checklist').innerHTML = `<div class="panel-heading"><div><h2>Readiness checklist</h2><p class="muted">Recommended safeguards before exposing production sites.</p></div><span class="badge">${checklist.filter(([, ready]) => ready).length}/${checklist.length}</span></div><div class="checklist-grid">${checklist.map(([label, ready]) => `<div class="checklist-item ${ready ? 'complete' : ''}"><span>${ready ? '✓' : '○'}</span><strong>${escapeHtml(label)}</strong></div>`).join('')}</div>`;
}

async function loadOperations() {
  if (state.user?.role !== 'admin') return;
  const requestId = ++state.operationsRequest;
  const button = $('#refresh-operations');
  setBusy(button, true, 'Refreshing…');
  const selector = $('#operations-site');
  const previous = Number(selector.value || state.operationsSiteId || state.sites[0]?.id || 0);
  selector.innerHTML = state.sites.length ? state.sites.map((site) => `<option value="${site.id}">${escapeHtml(site.name)}</option>`).join('') : '<option value="">No sites configured</option>';
  if (state.sites.some((site) => site.id === previous)) selector.value = String(previous);
  state.operationsSiteId = Number(selector.value || 0) || null;
  try {
    const [instance, sitePayload, security, filters] = await Promise.all([
      api('/api/admin/operations'),
      state.operationsSiteId ? api(`/api/sites/${state.operationsSiteId}/operations`) : Promise.resolve(null),
      api('/api/security'),
      api('/api/log-filters')
    ]);
    if (requestId !== state.operationsRequest) return;
    state.logFilters = filters.filters || [];
    $('#log-saved-filter').innerHTML = '<option value="">Saved filters…</option>' + state.logFilters.map((filter) => `<option value="${filter.id}">${escapeHtml(filter.name)}</option>`).join('');
    state.security = security;
    state.operations = { instance, site: sitePayload };
    renderOperationsInstance(instance);
    if (sitePayload) renderOperationsSite(sitePayload);
  } catch (error) { if (requestId === state.operationsRequest) toast(error.message, 'error'); }
  finally { if (requestId === state.operationsRequest) setBusy(button, false); }
}

$('#operations-site').addEventListener('change', () => { state.operationsSiteId = Number($('#operations-site').value || 0) || null; loadOperations(); });
$('#refresh-operations').addEventListener('click', loadOperations);
$('#add-env-row').addEventListener('click', () => addEnvironmentRow());

$('#environment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const site = operationsSite();
  if (!site) return;
  const variables = $$('.env-row', $('#environment-rows')).map((row) => ({
    key: $('[data-env-key]', row).value,
    value: $('[data-env-value]', row).value,
    scope: $('[data-env-scope]', row).value,
    secret: $('[data-env-secret]', row).checked
  })).filter((item) => item.key.trim());
  const button = $('#environment-form button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try { await api(`/api/sites/${site.id}/environment`, { method: 'PUT', body: { variables } }); toast('Environment saved and runtime refreshed.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#save-site-databases').addEventListener('click', async (event) => {
  const site = operationsSite();
  if (!site) return;
  setBusy(event.currentTarget, true, 'Saving…');
  try {
    const profileIds = $$('#site-database-profiles input:checked').map((input) => Number(input.value));
    await api(`/api/sites/${site.id}/database-profiles`, { method: 'PUT', body: { profileIds } });
    toast('Database profile attachments saved.');
    await loadOperations();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});

$('#import-site-config').addEventListener('click', () => $('#import-site-config-file').click());
$('#import-site-config-file').addEventListener('change', async (event) => {
  const site = operationsSite();
  const file = event.currentTarget.files[0];
  if (!site || !file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Configuration files are limited to 1 MB.');
    const payload = JSON.parse(await file.text());
    const result = await api(`/api/sites/${site.id}/config/import`, { method: 'POST', body: payload });
    toast(result.warning || 'Configuration imported.', result.warning ? 'warning' : 'success');
    await Promise.all([loadSites(), loadOperations()]);
  } catch (error) { toast(error.message, 'error'); }
  finally { event.currentTarget.value = ''; }
});

$('#git-deploy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const site = operationsSite();
  if (!site) return;
  const button = $('#git-deploy');
  setBusy(button, true, 'Deploying…');
  try {
    await api(`/api/sites/${site.id}/deploy/git`, { method: 'POST', body: { url: $('#git-url').value, branch: $('#git-branch').value, deployKey: $('#git-deploy-key').value, installDependencies: $('#git-install-dependencies').checked } });
    $('#git-deploy-key').value = '';
    toast('Git release validated and activated.');
    await Promise.all([loadSites(), loadOperations()]);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#create-preview').addEventListener('click', async (event) => {
  const site = operationsSite();
  if (!site) return;
  const hostname = await requestAction({ title: 'Create preview', message: 'Use a temporary hostname routed by the shared edge proxy.', confirmLabel: 'Create preview', inputLabel: 'Preview hostname', inputValue: site.preview_domain ? `preview-${site.id}.${site.preview_domain}` : `preview-${site.id}.${site.domain || 'local.invalid'}`, placeholder: 'preview.example.com' });
  if (!hostname) return;
  setBusy(event.currentTarget, true, 'Creating…');
  try { await api(`/api/sites/${site.id}/previews`, { method: 'POST', body: { hostname, ttlHours: 24 } }); toast('Preview created for 24 hours.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});

$('#release-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-release-rollback]');
  if (!button || !(await requestAction({ title: 'Roll back this release?', message: 'SHAM will atomically replace the active release and restart the site.', confirmLabel: 'Roll back', danger: true }))) return;
  const site = operationsSite();
  setBusy(button, true, 'Rolling back…');
  try { await api(`/api/sites/${site.id}/releases/${button.dataset.releaseRollback}/rollback`, { method: 'POST' }); toast('Release rolled back.'); await Promise.all([loadSites(), loadOperations()]); }
  catch (error) { toast(error.message, 'error'); setBusy(button, false); }
});

$('#preview-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-preview-delete]');
  if (!button) return;
  const site = operationsSite();
  setBusy(button, true, 'Removing…');
  try { await api(`/api/sites/${site.id}/previews/${button.dataset.previewDelete}`, { method: 'DELETE' }); toast('Preview removed.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); setBusy(button, false); }
});

$('#job-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const site = operationsSite();
  if (!site) return;
  const button = $('#job-form button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    await api(`/api/sites/${site.id}/jobs`, { method: 'POST', body: { id: Number($('#job-id').value || 0) || undefined, name: $('#job-name').value, schedule: $('#job-schedule').value, command: $('#job-command').value, timeoutSeconds: $('#job-timeout').value, enabled: $('#job-enabled').checked, allowOverlap: $('#job-overlap').checked } });
    clearJobForm(); toast('Scheduled task saved.'); await loadOperations();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
$('#clear-job').addEventListener('click', clearJobForm);
$('#job-list').addEventListener('click', async (event) => {
  const site = operationsSite();
  const run = event.target.closest('[data-job-run]');
  const edit = event.target.closest('[data-job-edit]');
  const remove = event.target.closest('[data-job-delete]');
  if (edit) {
    const jobs = JSON.parse($('#job-list').dataset.jobs || '[]');
    const job = jobs.find((item) => item.id === Number(edit.dataset.jobEdit));
    if (!job) return;
    $('#job-id').value = job.id; $('#job-name').value = job.name; $('#job-schedule').value = job.schedule; $('#job-command').value = job.command; $('#job-timeout').value = job.timeout_seconds; $('#job-enabled').checked = job.enabled; $('#job-overlap').checked = job.allow_overlap; $('#job-name').focus();
  } else if (run) {
    setBusy(run, true, 'Running…');
    try { await api(`/api/sites/${site.id}/jobs/${run.dataset.jobRun}/run`, { method: 'POST' }); toast('Task completed.'); await loadOperations(); }
    catch (error) { toast(error.message, 'error'); setBusy(run, false); }
  } else if (remove && await requestAction({ title: 'Delete scheduled task?', message: 'Its historical run records will also be removed.', confirmLabel: 'Delete task', danger: true })) {
    try { await api(`/api/sites/${site.id}/jobs/${remove.dataset.jobDelete}`, { method: 'DELETE' }); toast('Task deleted.'); await loadOperations(); }
    catch (error) { toast(error.message, 'error'); }
  }
});

$('#log-saved-filter').addEventListener('change', () => {
  const filter = state.logFilters.find((item) => item.id === Number($('#log-saved-filter').value));
  if (!filter) return;
  $('#log-query').value = filter.filter?.query || '';
  $('#log-level').value = filter.filter?.level || '';
  $('#log-since').value = filter.filter?.since || '';
});
$('#save-log-filter').addEventListener('click', async () => {
  const name = await requestAction({ title: 'Save log filter', message: 'Save the current query for quick reuse.', confirmLabel: 'Save filter', inputLabel: 'Filter name', placeholder: 'Recent errors' });
  if (!name) return;
  try {
    await api('/api/log-filters', { method: 'POST', body: { name, filter: { query: $('#log-query').value, level: $('#log-level').value, since: $('#log-since').value } } });
    toast('Log filter saved.'); await loadOperations();
  } catch (error) { toast(error.message, 'error'); }
});
$('#delete-log-filter').addEventListener('click', async () => {
  const id = Number($('#log-saved-filter').value || 0);
  if (!id) return toast('Choose a saved filter first.', 'warning');
  try { await api(`/api/log-filters/${id}`, { method: 'DELETE' }); toast('Log filter deleted.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
});

$('#search-runtime-logs').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true, 'Searching…');
  try {
    const params = new URLSearchParams({ limit: '300' });
    const site = operationsSite();
    if (site) params.set('siteId', String(site.id));
    if ($('#log-query').value) params.set('query', $('#log-query').value);
    if ($('#log-level').value) params.set('level', $('#log-level').value);
    if ($('#log-since').value) params.set('since', new Date($('#log-since').value).toISOString());
    const result = await api(`/api/runtime-logs/search?${params}`);
    $('#operations-log-results').innerHTML = result.logs.length ? result.logs.map((log) => `<div class="event-item ${log.level === 'error' ? 'critical' : ''}"><div><strong>${escapeHtml(log.level)}</strong><span>${escapeHtml(formatDate(log.createdAt))}</span><small>${escapeHtml(log.message)}</small></div></div>`).join('') : '<p class="muted">No matching log records.</p>';
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});

$('#clear-cloudflare-tunnel-token').addEventListener('change', (event) => {
  $('#cloudflare-tunnel-token').disabled = event.currentTarget.checked;
  if (event.currentTarget.checked) $('#cloudflare-tunnel-token').value = '';
});

$('#cloudflare-tunnel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#cloudflare-tunnel-form button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    const enabled = $('#cloudflare-tunnel-enabled').checked;
    const clearToken = $('#clear-cloudflare-tunnel-token').checked;
    const token = $('#cloudflare-tunnel-token').value.trim();
    const tokenConfigured = $('#cloudflare-tunnel-token-status').dataset.configured === '1';
    const tokenReadable = $('#cloudflare-tunnel-token-status').dataset.readable !== '0';
    if (enabled && (clearToken || (!tokenConfigured && !token))) throw new Error('Set a tunnel token before enabling the connector.');
    if (enabled && tokenConfigured && !tokenReadable && !token) throw new Error('Replace the unreadable tunnel token before enabling the connector.');
    await api('/api/admin/cloudflare-tunnel', { method: 'PUT', body: { enabled, token: token || undefined, clearToken } });
    $('#cloudflare-tunnel-token').value = '';
    toast('Cloudflare Tunnel settings saved.');
    await loadOperations();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#restart-cloudflare-tunnel').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true, 'Restarting…');
  try {
    await api('/api/admin/cloudflare-tunnel/restart', { method: 'POST' });
    toast('Cloudflare Tunnel connector restarted.');
    await loadOperations();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});

$('#backup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#backup-form button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    let config = JSON.parse($('#backup-options').value || '{}');
    const destination = $('#backup-destination').value.trim();
    if (destination) {
      const provider = $('#backup-provider').value;
      if (provider === 'restic') config.repository = destination;
      else if (provider === 'sftp') config.remotePath = destination;
      else config.destination = destination;
    }
    config.retention = Number($('#backup-retention').value || 14);
    await api('/api/admin/operations/settings', { method: 'PUT', body: { backup: { enabled: $('#backup-enabled').checked, provider: $('#backup-provider').value, schedule: $('#backup-schedule').value, config } } });
    toast('Backup settings saved.'); await loadOperations();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
$('#run-backup').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true, 'Backing up…');
  try { await api('/api/admin/backups/run', { method: 'POST', body: { provider: $('#backup-provider').value } }); toast('Backup completed.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});

$('#clear-prometheus-token').addEventListener('change', (event) => {
  $('#prometheus-token').disabled = event.currentTarget.checked;
  if (event.currentTarget.checked) $('#prometheus-token').value = '';
});
$('#clear-otel-headers').addEventListener('change', (event) => {
  $('#otel-headers').disabled = event.currentTarget.checked;
  if (event.currentTarget.checked) $('#otel-headers').value = '{}';
});
$('#copy-metrics-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/metrics`);
    toast('Metrics URL copied. Configure your scraper with the saved bearer token.');
  } catch { toast(`Metrics URL: ${location.origin}/metrics`, 'warning'); }
});

$('#observability-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#observability-form button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    const clearPrometheusToken = $('#clear-prometheus-token').checked;
    const prometheusToken = $('#prometheus-token').value.trim();
    const tokenConfigured = $('#prometheus-token-status').dataset.configured === '1';
    if ($('#prometheus-enabled').checked && (clearPrometheusToken || (!tokenConfigured && !prometheusToken))) throw new Error('Set a metrics token before enabling the Prometheus endpoint.');
    const clearOtelHeaders = $('#clear-otel-headers').checked;
    const otelHeaders = clearOtelHeaders ? {} : JSON.parse($('#otel-headers').value || '{}');
    if (!otelHeaders || typeof otelHeaders !== 'object' || Array.isArray(otelHeaders)) throw new Error('OpenTelemetry headers must be a JSON object.');
    await api('/api/admin/operations/settings', { method: 'PUT', body: {
      prometheusEnabled: $('#prometheus-enabled').checked,
      prometheusToken: prometheusToken || undefined,
      clearPrometheusToken,
      otelEndpoint: $('#otel-endpoint').value,
      otelHeaders: Object.keys(otelHeaders).length ? otelHeaders : undefined,
      clearOtelHeaders,
      publicStatusEnabled: $('#public-status-enabled').checked,
      publicStatusTitle: $('#public-status-title').value,
      locale: $('#instance-locale').value,
      updateChannel: $('#update-channel').value,
      setupCompleted: true
    } });
    $('#prometheus-token').value = ''; applyLocale($('#instance-locale').value); toast('Observability settings saved.'); await loadOperations();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#add-database-profile').addEventListener('click', async () => {
  const name = await requestAction({ title: 'New database profile', message: 'Create an encrypted reusable connection profile.', confirmLabel: 'Next', inputLabel: 'Profile name', placeholder: 'Production PostgreSQL' });
  if (!name) return;
  const connection = await requestAction({ title: 'Connection value', message: 'The value is encrypted at rest and never returned by the API.', confirmLabel: 'Next', inputLabel: 'Connection string', inputType: 'password', autocomplete: 'new-password', placeholder: 'postgres://…' });
  if (!connection) return;
  const envKey = await requestAction({ title: 'Environment variable', message: 'Choose the variable name exposed to attached sites.', confirmLabel: 'Create profile', inputLabel: 'Variable name', inputValue: 'DATABASE_URL' });
  if (!envKey) return;
  try { await api('/api/admin/database-profiles', { method: 'POST', body: { name, type: 'custom', envKey, connection } }); toast('Database profile created.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
});
$('#database-profile-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-database-delete]');
  if (!button || !(await requestAction({ title: 'Delete database profile?', message: 'It will be detached from every site. The hosted databases are not modified.', confirmLabel: 'Delete profile', danger: true }))) return;
  try { await api(`/api/admin/database-profiles/${button.dataset.databaseDelete}`, { method: 'DELETE' }); toast('Database profile deleted.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
});

$('#add-alert-destination').addEventListener('click', async () => {
  const name = await requestAction({ title: 'New alert destination', message: 'Add a webhook, Slack, Discord, or sendmail target.', confirmLabel: 'Next', inputLabel: 'Destination name', placeholder: 'On-call webhook' });
  if (!name) return;
  const kind = await requestAction({ title: 'Destination type', message: 'Enter webhook, slack, discord, or email.', confirmLabel: 'Next', inputLabel: 'Type', inputValue: 'webhook' });
  if (!kind) return;
  const configText = await requestAction({ title: 'Destination configuration', message: 'Webhook types use {"url":"https://…"}; email uses {"to":"ops@example.com"}.', confirmLabel: 'Save destination', inputLabel: 'JSON configuration', inputValue: '{}'});
  if (!configText) return;
  try { await api('/api/admin/alert-destinations', { method: 'POST', body: { name, kind, config: JSON.parse(configText), enabled: true } }); toast('Alert destination saved.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
});
$('#alert-destination-list').addEventListener('click', async (event) => {
  const test = event.target.closest('[data-alert-test]');
  const remove = event.target.closest('[data-alert-delete]');
  if (test) {
    setBusy(test, true, 'Sending…');
    try { await api(`/api/admin/alert-destinations/${test.dataset.alertTest}/test`, { method: 'POST' }); toast('Test alert sent.'); }
    catch (error) { toast(error.message, 'error'); }
    finally { setBusy(test, false); }
  } else if (remove && await requestAction({ title: 'Delete alert destination?', message: 'Future alerts will no longer be delivered there.', confirmLabel: 'Delete destination', danger: true })) {
    try { await api(`/api/admin/alert-destinations/${remove.dataset.alertDelete}`, { method: 'DELETE' }); toast('Alert destination deleted.'); await loadOperations(); }
    catch (error) { toast(error.message, 'error'); }
  }
});

$('#update-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#update-archive').files[0];
  if (!file) return;
  const formData = new FormData(); formData.append('archive', file, file.name); formData.append('allowUnsigned', String($('#update-allow-unsigned').checked));
  const button = $('#update-form button[type="submit"]');
  setBusy(button, true, 'Validating…');
  try { const result = await api('/api/admin/update', { method: 'POST', body: formData }); toast(result.message, 'warning'); $('#update-archive').value = ''; $('#update-allow-unsigned').checked = false; await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
$('#cancel-update').addEventListener('click', async () => {
  try { await api('/api/admin/update', { method: 'DELETE' }); toast('Staged update cancelled.'); await loadOperations(); }
  catch (error) { toast(error.message, 'error'); }
});

$('#setup-open-security').addEventListener('click', () => { $('#setup-dialog').close(); showSection('security'); });
$('#setup-open-operations').addEventListener('click', () => { $('#setup-dialog').close(); showSection('operations'); });
$('#setup-finish').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true, 'Saving…');
  try {
    await api('/api/admin/operations/settings', { method: 'PUT', body: { setupCompleted: true } });
    state.bootstrap.setupCompleted = true;
    $('#setup-dialog').close();
    toast('Initial setup marked complete. The readiness checklist remains available under Operations.');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});

function copyTheme(theme) {
  return { name: theme.name, custom: { ...theme.custom } };
}

function populateThemeDialog() {
  state.themeDraft = copyTheme(window.SHAM_THEME.get());
  const custom = state.themeDraft.custom;
  $('#theme-accent').value = custom.accent;
  $('#theme-accent-secondary').value = custom.accentSecondary;
  $('#theme-background').value = custom.background;
  $('#theme-panel').value = custom.panel;
  $('#theme-text').value = custom.text;
  $('#theme-radius').value = String(custom.radius);
  $('#theme-radius-value').textContent = String(custom.radius);
  updateThemePicker();
}

function updateThemePicker() {
  $$('.theme-preset').forEach((button) => {
    const active = button.dataset.themePreset === state.themeDraft.name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
    button.setAttribute('role', 'radio');
    button.tabIndex = active ? 0 : -1;
  });
  $('#custom-theme-fields').hidden = state.themeDraft.name !== 'custom';
  updateThemeValidation();
}

$('#theme-button').addEventListener('click', () => {
  populateThemeDialog();
  showModal($('#theme-dialog'));
});

$('.theme-presets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme-preset]');
  if (!button) return;
  state.themeDraft.name = button.dataset.themePreset;
  updateThemePicker();
});

$('.theme-presets').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = $$('.theme-preset');
  const current = Math.max(0, buttons.indexOf(document.activeElement));
  let next = current;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else next = (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  state.themeDraft.name = buttons[next].dataset.themePreset;
  updateThemePicker();
  buttons[next].focus();
});

function readCustomTheme() {
  return {
    accent: $('#theme-accent').value,
    accentSecondary: $('#theme-accent-secondary').value,
    background: $('#theme-background').value,
    panel: $('#theme-panel').value,
    text: $('#theme-text').value,
    radius: Number($('#theme-radius').value)
  };
}

function updateThemeValidation() {
  const error = $('#theme-form-error');
  if (!error || state.themeDraft?.name !== 'custom') {
    if (error) error.textContent = '';
    return true;
  }
  const result = window.SHAM_THEME.validateCustom(readCustomTheme());
  error.textContent = result.valid ? `Contrast check passed (${result.minimum.toFixed(1)}:1 minimum).` : result.message;
  error.classList.toggle('success-text', result.valid);
  return result.valid;
}

$$('#custom-theme-fields input').forEach((input) => input.addEventListener('input', () => {
  if (input.id === 'theme-radius') $('#theme-radius-value').textContent = input.value;
  updateThemeValidation();
}));
$('#theme-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.themeDraft.custom = readCustomTheme();
  if (!updateThemeValidation()) return;
  const persisted = window.SHAM_THEME.save(state.themeDraft);
  closeModal($('#theme-dialog'));
  const label = state.themeDraft.name === 'custom' ? 'Custom' : state.themeDraft.name[0].toUpperCase() + state.themeDraft.name.slice(1);
  toast(persisted ? `${label} theme applied.` : `${label} theme applied for this session; browser storage is unavailable.`, persisted ? 'success' : 'warning');
});
$('#theme-reset').addEventListener('click', () => {
  const persisted = window.SHAM_THEME.reset();
  populateThemeDialog();
  toast(persisted ? 'Theme reset to purple.' : 'Theme reset for this session; browser storage is unavailable.', persisted ? 'success' : 'warning');
});


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
  $('#performance-sites').innerHTML = (current.sites || []).map((site) => `<tr><td>${escapeHtml(site.name)}</td><td>${escapeHtml(site.runtimeType)} · ${escapeHtml(site.isolation || 'process')}${site.anubis ? ' · Anubis' : ''}${site.pid ? ` · PID ${site.pid}` : ''}</td><td>${Number(site.traffic?.requestsPerSecond || 0).toFixed(1)} req/s<br><small>${formatNumber(site.traffic?.requestDelta || 0)} sampled</small></td><td>${formatBytes(site.traffic?.bytesPerSecond || 0)}/s<br><small>${Number(site.traffic?.averageResponseMs || 0).toFixed(0)} ms avg</small></td><td><span class="badge ${Number(site.traffic?.errorRate || 0) >= 25 ? 'error' : ''}">${Number(site.traffic?.errorRate || 0).toFixed(1)}%</span></td><td>${site.memory ? formatBytes(site.memory.rssBytes) : 'Unavailable'}${site.memoryLimitBytes ? ` / ${formatBytes(site.memoryLimitBytes)}` : ''}</td><td><span class="badge ${site.health?.status || ''}">${escapeHtml(site.health?.status || 'starting')}</span>${site.health?.latencyMs ? ` ${site.health.latencyMs} ms` : ''}</td><td>${formatNumber(site.connections)}</td><td>${formatNumber(site.restarts)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No hosted runtime is currently running.</td></tr>';
}

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

function showRecoveryCodes(codes) {
  $('#recovery-codes').textContent = (codes || []).join('\n');
  showModal($('#recovery-dialog'));
}

function renderSecurity(data) {
  state.security = data;
  const enabled = Boolean(data.user?.totpEnabled);
  $('#totp-status').textContent = enabled ? 'Enabled' : 'Disabled';
  $('#totp-status').className = `badge ${enabled ? 'success' : ''}`;
  $('#recovery-summary').textContent = enabled ? `${formatNumber(data.recoveryCodesRemaining)} unused recovery code${data.recoveryCodesRemaining === 1 ? '' : 's'} remain.` : 'Enable TOTP to create recovery codes.';
  $('#regenerate-recovery').disabled = !enabled;
  $('#totp-content').innerHTML = enabled
    ? '<p class="muted">Your account requires an authenticator or recovery code after password login.</p><button class="button danger" data-totp-action="disable" type="button">Disable TOTP</button>'
    : '<p class="muted">Compatible with standard authenticator applications.</p><button class="button primary" data-totp-action="setup" type="button">Set up authenticator</button>';
  $('#passkey-list').innerHTML = data.passkeys?.length ? data.passkeys.map((key) => `<div class="event-item actionable" data-passkey-id="${key.id}"><span class="event-icon">⌾</span><div><strong>${escapeHtml(key.name)}</strong><p>${key.lastUsedAt ? `Last used ${escapeHtml(formatDate(key.lastUsedAt))}` : 'Not used yet'} · added ${escapeHtml(formatDate(key.createdAt))}</p></div><button class="button danger" data-delete-passkey type="button">Delete</button></div>`).join('') : '<div class="empty-state compact"><p>No passkeys are registered.</p></div>';
}
async function loadSecurity() {
  const requestId = ++state.securityRequest;
  const button = $('#refresh-security');
  setBusy(button, true, 'Refreshing…');
  try {
    const data = await api('/api/security');
    if (requestId === state.securityRequest) renderSecurity(data);
  } catch (error) {
    if (requestId === state.securityRequest) toast(error.message, 'error');
  } finally {
    if (requestId === state.securityRequest) setBusy(button, false);
  }
}
$('#refresh-security').addEventListener('click', loadSecurity);
$('#totp-content').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-totp-action]');
  if (!button) return;
  try {
    if (button.dataset.totpAction === 'setup') {
      const password = await requestAction({ title: 'Set up TOTP', message: 'Confirm your current password before adding a new authenticator.', confirmLabel: 'Continue', inputLabel: 'Password', inputType: 'password', autocomplete: 'current-password' });
      if (!password) return;
      const setup = await api('/api/security/totp/setup', { method: 'POST', body: { password } });
      $('#totp-content').innerHTML = `<div class="totp-setup"><label><span>Secret</span><input value="${escapeHtml(setup.secret)}" readonly></label><label><span>Setup URI</span><textarea rows="3" readonly>${escapeHtml(setup.otpauthUrl)}</textarea></label><label><span>Current six-digit code</span><input id="totp-setup-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></label><div class="inline-actions"><button class="button primary" data-enable-totp data-setup-id="${escapeHtml(setup.setupId)}" type="button">Verify and enable</button><button class="button ghost" data-cancel-totp type="button">Cancel</button></div></div>`;
      $('#totp-setup-code').focus();
    } else {
      const password = await requestAction({ title: 'Disable TOTP?', message: 'Confirm your password. This reduces account protection.', confirmLabel: 'Disable TOTP', danger: true, inputLabel: 'Password', inputType: 'password', autocomplete: 'current-password' });
      if (!password) return;
      await api('/api/security/totp/disable', { method: 'POST', body: { password } });
      toast('TOTP disabled.', 'warning');
      await loadSecurity();
    }
  } catch (error) { toast(error.message, 'error'); }
});
$('#totp-content').addEventListener('click', async (event) => {
  const enable = event.target.closest('[data-enable-totp]');
  if (event.target.closest('[data-cancel-totp]')) return loadSecurity();
  if (!enable) return;
  setBusy(enable, true, 'Verifying…');
  try {
    const result = await api('/api/security/totp/enable', { method: 'POST', body: { setupId: enable.dataset.setupId, code: $('#totp-setup-code').value } });
    state.user = result.user;
    showRecoveryCodes(result.recoveryCodes);
    await loadSecurity();
  } catch (error) { toast(error.message, 'error'); setBusy(enable, false); }
});
$('#regenerate-recovery').addEventListener('click', async () => {
  const password = await requestAction({ title: 'Regenerate recovery codes?', message: 'All existing recovery codes will stop working.', confirmLabel: 'Regenerate', danger: true, inputLabel: 'Password', inputType: 'password', autocomplete: 'current-password' });
  if (!password) return;
  try { const result = await api('/api/security/recovery-codes/regenerate', { method: 'POST', body: { password } }); showRecoveryCodes(result.recoveryCodes); await loadSecurity(); }
  catch (error) { toast(error.message, 'error'); }
});
$('#copy-recovery-codes').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#recovery-codes').textContent); toast('Recovery codes copied.'); }
  catch { toast('Could not access the clipboard. Copy the codes manually.', 'warning'); }
});
$('#add-passkey').addEventListener('click', async (event) => {
  const name = await requestAction({ title: 'Add a passkey', message: 'Choose a recognizable name for this device or security key.', confirmLabel: 'Continue', inputLabel: 'Passkey name', placeholder: 'Laptop, phone, security key' });
  if (!name) return;
  const password = await requestAction({ title: 'Confirm passkey enrollment', message: 'Confirm your current password before registering the new passkey.', confirmLabel: 'Register passkey', inputLabel: 'Password', inputType: 'password', autocomplete: 'current-password' });
  if (!password) return;
  setBusy(event.currentTarget, true, 'Waiting…');
  try {
    if (!navigator.credentials?.create) throw new Error('Passkeys require a supported browser and secure context.');
    const challenge = await api('/api/security/passkeys/options', { method: 'POST', body: { password } });
    const credential = await navigator.credentials.create({ publicKey: publicKeyOptions(challenge.options) });
    await api('/api/security/passkeys/register', { method: 'POST', body: { challengeId: challenge.challengeId, name, credential: serializeCredential(credential) } });
    toast('Passkey added.');
    await loadSecurity();
  } catch (error) { toast(error.name === 'NotAllowedError' ? 'Passkey creation was cancelled or timed out.' : error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});
$('#passkey-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-passkey]');
  if (!button) return;
  const item = button.closest('[data-passkey-id]');
  const password = await requestAction({ title: 'Delete this passkey?', message: 'Confirm your password. This credential will no longer sign in to SHAM.', confirmLabel: 'Delete passkey', danger: true, inputLabel: 'Password', inputType: 'password', autocomplete: 'current-password' });
  if (!password) return;
  try { await api(`/api/security/passkeys/${item.dataset.passkeyId}`, { method: 'DELETE', body: { password } }); await loadSecurity(); toast('Passkey deleted.'); }
  catch (error) { toast(error.message, 'error'); }
});

let toolsSite = null;
function siteToolsRequestIsCurrent(site, requestId) {
  return Boolean(site && toolsSite?.id === site.id && requestId === state.siteToolsRequest);
}
function selectSiteTool(name, { focus = false } = {}) {
  const tabs = $$('[data-site-tool-tab]');
  const activeTab = tabs.find((button) => button.dataset.siteToolTab === name) || tabs[0];
  for (const button of tabs) {
    const active = button === activeTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  $('#site-tools-snapshots').hidden = activeTab.dataset.siteToolTab !== 'snapshots';
  $('#site-tools-dependencies').hidden = activeTab.dataset.siteToolTab !== 'dependencies';
  if (focus) activeTab.focus();
}
function renderSnapshots(snapshots) {
  $('#snapshot-list').innerHTML = snapshots.length ? snapshots.map((item) => `<div class="event-item actionable" data-snapshot-id="${item.id}"><span class="event-icon">↶</span><div><strong>${escapeHtml(item.label || `Snapshot ${item.id}`)}</strong><p>${formatBytes(item.bytes)} · ${escapeHtml(formatDate(item.createdAt))}</p></div><div class="inline-actions"><button class="button secondary" data-restore-snapshot type="button">Restore</button><button class="button danger" data-delete-snapshot type="button">Delete</button></div></div>`).join('') : '<div class="empty-state compact"><p>No snapshots yet.</p></div>';
}
async function loadSnapshots(site = toolsSite) {
  if (!site) return;
  const sessionId = state.siteToolsRequest;
  const requestId = ++state.siteToolsSnapshotRequest;
  try {
    const data = await api(`/api/sites/${site.id}/snapshots`);
    if (siteToolsRequestIsCurrent(site, sessionId) && requestId === state.siteToolsSnapshotRequest) renderSnapshots(data.snapshots || []);
  } catch (error) {
    if (siteToolsRequestIsCurrent(site, sessionId) && requestId === state.siteToolsSnapshotRequest) toast(error.message, 'error');
  }
}
function renderDependencyReport(result) {
  if (!result) { $('#dependency-report').innerHTML = '<div class="empty-state compact"><p>No dependency scan has run for this site.</p></div>'; return; }
  const vulnerabilities = result.vulnerabilities || {};
  const findings = result.findings || [];
  $('#dependency-report').innerHTML = `<div class="stats-grid compact-stats"><article class="stat-card"><span>Critical</span><strong>${formatNumber(vulnerabilities.critical)}</strong></article><article class="stat-card"><span>High</span><strong>${formatNumber(vulnerabilities.high)}</strong></article><article class="stat-card"><span>Moderate</span><strong>${formatNumber(vulnerabilities.moderate)}</strong></article><article class="stat-card"><span>Total</span><strong>${formatNumber(vulnerabilities.total)}</strong></article></div><p class="notice ${result.registryAvailable ? '' : 'warning'}">${result.registryAvailable ? `npm audit completed using ${escapeHtml(result.lockfile || 'the lockfile')}.` : `Registry audit was unavailable: ${escapeHtml(result.registryError || 'No lockfile is present.')}`}</p><div class="event-list">${findings.length ? findings.map((finding) => `<div class="event-item ${escapeHtml(finding.severity)}"><span class="event-icon">△</span><div><strong>${escapeHtml(finding.code)}</strong><p>${escapeHtml(finding.message)}</p></div></div>`).join('') : '<div class="empty-state compact"><p>No static dependency warnings.</p></div>'}</div><small class="muted">Scanned ${escapeHtml(formatDate(result.scannedAt))}</small>`;
}
async function openSiteTools(site) {
  toolsSite = site;
  const sessionId = ++state.siteToolsRequest;
  const snapshotRequestId = ++state.siteToolsSnapshotRequest;
  const dependencyRequestId = ++state.siteToolsDependencyRequest;
  $('#site-tools-id').value = site.id;
  $('#site-tools-title').textContent = `${site.name} safety tools`;
  $('#snapshot-list').innerHTML = '<div class="empty-state compact"><p>Loading snapshots…</p></div>';
  $('#dependency-report').innerHTML = '<div class="empty-state compact"><p>Loading the latest scan…</p></div>';
  $('#run-dependency-scan').disabled = site.runtime_type !== 'node';
  selectSiteTool('snapshots');
  showModal($('#site-tools-dialog'));
  const [snapshots, scan] = await Promise.allSettled([api(`/api/sites/${site.id}/snapshots`), api(`/api/sites/${site.id}/dependency-scan`)]);
  if (!siteToolsRequestIsCurrent(site, sessionId)) return;
  if (snapshotRequestId === state.siteToolsSnapshotRequest) {
    if (snapshots.status === 'fulfilled') renderSnapshots(snapshots.value.snapshots || []);
    else { renderSnapshots([]); toast(snapshots.reason.message, 'error'); }
  }
  if (dependencyRequestId === state.siteToolsDependencyRequest) {
    if (scan.status === 'fulfilled') renderDependencyReport(scan.value.result);
    else { renderDependencyReport(null); toast(scan.reason.message, 'error'); }
  }
}
$$('[data-site-tool-tab]').forEach((button) => {
  button.addEventListener('click', () => selectSiteTool(button.dataset.siteToolTab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('[data-site-tool-tab]');
    const current = tabs.indexOf(button);
    const target = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs.at(-1)
        : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    selectSiteTool(target.dataset.siteToolTab, { focus: true });
  });
});
$('#site-tools-dialog').addEventListener('close', () => {
  state.siteToolsRequest += 1;
  toolsSite = null;
});
$('#create-snapshot').addEventListener('click', async (event) => {
  const label = await requestAction({ title: 'Create snapshot', message: 'Choose a short label for this restore point.', confirmLabel: 'Create snapshot', inputLabel: 'Label', placeholder: 'Before deployment' });
  const site = toolsSite;
  if (!label || !site) return;
  setBusy(event.currentTarget, true, 'Creating…');
  try {
    await api(`/api/sites/${site.id}/snapshots`, { method: 'POST', body: { label } });
    if (toolsSite?.id === site.id) await loadSnapshots(site);
    toast(`Snapshot created for ${site.name}.`);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});
$('#snapshot-list').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-snapshot-id]');
  const site = toolsSite;
  if (!item || !site) return;
  if (event.target.closest('[data-restore-snapshot]')) {
    if (!(await requestAction({ title: 'Restore this snapshot?', message: 'SHAM creates an automatic rollback point, replaces the project files, and restarts the runtime.', confirmLabel: 'Restore snapshot', danger: true }))) return;
    try {
      const result = await api(`/api/sites/${site.id}/snapshots/${item.dataset.snapshotId}/restore`, { method: 'POST' });
      toast(result.warning ? `Snapshot restored. ${result.warning}` : `Snapshot restored. Rollback point ${result.rollbackSnapshot.id} was retained.`, result.warning ? 'warning' : 'success');
      await Promise.all([toolsSite?.id === site.id ? loadSnapshots(site) : Promise.resolve(), loadSites()]);
    } catch (error) { toast(error.message, 'error'); }
  } else if (event.target.closest('[data-delete-snapshot]')) {
    if (!(await requestAction({ title: 'Delete this snapshot?', message: 'This restore point will be permanently removed.', confirmLabel: 'Delete snapshot', danger: true }))) return;
    try {
      await api(`/api/sites/${site.id}/snapshots/${item.dataset.snapshotId}`, { method: 'DELETE' });
      if (toolsSite?.id === site.id) await loadSnapshots(site);
    } catch (error) { toast(error.message, 'error'); }
  }
});
$('#run-dependency-scan').addEventListener('click', async (event) => {
  const site = toolsSite;
  if (!site) return;
  const sessionId = state.siteToolsRequest;
  const requestId = ++state.siteToolsDependencyRequest;
  setBusy(event.currentTarget, true, 'Scanning…');
  try {
    const data = await api(`/api/sites/${site.id}/dependency-scan`, { method: 'POST' });
    if (!siteToolsRequestIsCurrent(site, sessionId) || requestId !== state.siteToolsDependencyRequest) return;
    renderDependencyReport(data.result);
    toast('Dependency scan completed.');
  } catch (error) {
    if (siteToolsRequestIsCurrent(site, sessionId) && requestId === state.siteToolsDependencyRequest) toast(error.message, 'error');
  } finally { setBusy(event.currentTarget, false); }
});

$('#security-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#security-settings-form button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    const result = await api('/api/admin/settings/security', { method: 'PUT', body: {
      visitorPrivacyMode: $('#visitor-privacy').value,
      logRetentionDays: Number($('#log-retention').value),
      alertCpuPercent: Number($('#alert-cpu').value),
      alertEventLoopMs: Number($('#alert-loop').value),
      alertDiskPercent: Number($('#alert-disk').value),
      alertTrafficMultiplier: Number($('#alert-traffic').value),
      alertErrorPercent: Number($('#alert-errors').value),
      allowUnsignedPlugins: $('#allow-unsigned-plugins').checked,
      pluginTrustedKeys: $('#plugin-trusted-keys').value
    } });
    $('#plugin-trusted-keys').value = JSON.stringify(result.security.pluginTrustedKeys || [], null, 2);
    toast('Security settings saved.');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
$('#rotate-master-key').addEventListener('click', async () => {
  const password = await requestAction({ title: 'Rotate the encryption key?', message: 'SHAM re-encrypts saved integration, plugin, and TOTP secrets. Keep a storage backup before continuing.', confirmLabel: 'Rotate key', danger: true, inputLabel: 'Password', inputType: 'password', autocomplete: 'current-password' });
  if (!password) return;
  try { await api('/api/admin/security/rotate-master-key', { method: 'POST', body: { password } }); toast('Master encryption key rotated.'); }
  catch (error) { toast(error.message, 'error'); }
});

bootstrap();

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
  siteToolsDependencyRequest: 0,
  siteWorkspaceId: null,
  siteWorkspaceTab: 'overview',
  siteWorkspaceDeploymentsRequest: 0,
  siteWorkspaceLogsRequest: 0,
  wizardStep: 1,
  gitRepositories: [],
  commandIndex: 0
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
  en: { overview: 'Dashboard', sites: 'Sites', activity: 'Observability', performance: 'Performance', security: 'Security', operations: 'Settings', plugins: 'Extensions', documentation: 'Documentation', instance: 'Instance', refresh: 'Refresh', signout: 'Sign out' },
  nl: { overview: 'Dashboard', sites: 'Sites', activity: 'Observatie', performance: 'Prestaties', security: 'Beveiliging', operations: 'Instellingen', plugins: 'Extensies', documentation: 'Documentatie', instance: 'Instantie', refresh: 'Vernieuwen', signout: 'Afmelden' },
  de: { overview: 'Dashboard', sites: 'Websites', activity: 'Observability', performance: 'Leistung', security: 'Sicherheit', operations: 'Einstellungen', plugins: 'Erweiterungen', documentation: 'Dokumentation', instance: 'Instanz', refresh: 'Aktualisieren', signout: 'Abmelden' }
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

function mergeInstanceAdministration() {
  if (state.user?.role !== 'admin') return;
  const source = $('#section-admin');
  const target = $('#operations-instance');
  if (!source || !target || target.dataset.adminMerged === '1') return;
  const wrapper = document.createElement('div');
  wrapper.className = 'merged-instance-administration';
  while (source.firstChild) wrapper.append(source.firstChild);
  target.append(wrapper);
  target.dataset.adminMerged = '1';
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
  $('#audit-panel').hidden = state.user.role !== 'admin';
  $$('.admin-only').forEach((element) => { element.hidden = state.user.role !== 'admin'; });
  mergeInstanceAdministration();
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

$('#help-button').addEventListener('click', () => showSection('documentation'));
$('#open-performance').addEventListener('click', () => showSection('performance'));

function commandItems() {
  const items = [
    { label: 'Dashboard', hint: 'Open overview', run: () => showSection('overview') },
    { label: 'Sites', hint: 'Open site list', run: () => showSection('sites') },
    { label: 'Observability', hint: 'Events and audit', run: () => showSection('activity') },
    { label: 'Metrics & alerts', hint: 'Performance', run: () => showSection('performance') },
    { label: 'Security', hint: 'Account protection', run: () => showSection('security') },
    { label: 'Settings', hint: 'Operations and instance', run: () => showSection('operations') },
    { label: 'New site', hint: 'Deploy', run: openNewSite }
  ];
  for (const site of state.sites) {
    items.push({ label: `Open ${site.name}`, hint: siteDisplayUrl(site), run: () => openSiteWorkspace(site) });
    if (site.runtime.running && site.runtime_type !== 'static') items.push({ label: `Restart ${site.name}`, hint: 'Runtime action', run: () => handleSiteAction(site, 'restart', null) });
    if (state.user?.role === 'admin' && site.git_url) items.push({ label: `Deploy ${site.name}`, hint: `${site.git_branch || 'main'} · Git`, run: async () => { await api(`/api/sites/${site.id}/deploy/git`, { method: 'POST', body: {} }); toast(`${site.name} deployed.`); await loadSites(); } });
    items.push({ label: `Logs for ${site.name}`, hint: 'Site workspace', run: () => openSiteWorkspace(site, 'logs') });
  }
  return items;
}

function renderCommands() {
  const query = $('#command-search').value.trim().toLowerCase();
  const items = commandItems().filter((item) => !query || `${item.label} ${item.hint}`.toLowerCase().includes(query)).slice(0, 30);
  state.commandItems = items;
  state.commandIndex = Math.min(state.commandIndex, Math.max(0, items.length - 1));
  $('#command-results').innerHTML = items.length ? items.map((item, index) => `<button class="command-item ${index === state.commandIndex ? 'active' : ''}" data-command-index="${index}" type="button" role="option" aria-selected="${index === state.commandIndex}"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.hint)}</small></button>`).join('') : '<div class="empty-state compact"><p>No matching command.</p></div>';
}

function openCommandPalette() {
  state.commandIndex = 0;
  $('#command-search').value = '';
  renderCommands();
  showModal($('#command-dialog'));
  requestAnimationFrame(() => $('#command-search').focus());
}

async function runCommand(index) {
  const item = state.commandItems?.[Number(index)];
  if (!item) return;
  closeModal($('#command-dialog'));
  try { await item.run(); } catch (error) { toast(error.message, 'error'); }
}

$('#command-button').addEventListener('click', openCommandPalette);
$('#command-search').addEventListener('input', () => { state.commandIndex = 0; renderCommands(); });
$('#command-search').addEventListener('keydown', (event) => {
  const count = state.commandItems?.length || 0;
  if (event.key === 'ArrowDown' && count) { event.preventDefault(); state.commandIndex = (state.commandIndex + 1) % count; renderCommands(); }
  else if (event.key === 'ArrowUp' && count) { event.preventDefault(); state.commandIndex = (state.commandIndex - 1 + count) % count; renderCommands(); }
  else if (event.key === 'Enter') { event.preventDefault(); runCommand(state.commandIndex); }
});
$('#command-results').addEventListener('click', (event) => { const item = event.target.closest('[data-command-index]'); if (item) runCommand(item.dataset.commandIndex); });
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); }
});

function showSection(sectionName, { refresh = true } = {}) {
  if (sectionName === 'admin') {
    sectionName = 'operations';
    if (typeof setOperationsTab === 'function') setOperationsTab('instance');
  }
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
  if (refresh && changed && sectionName === 'operations') {
    loadOperations();
    if (state.user?.role === 'admin') loadAdmin();
  }
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

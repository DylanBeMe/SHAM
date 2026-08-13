'use strict';

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

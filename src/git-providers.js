'use strict';

const { getSecretSetting, setSecretSetting } = require('./secret-store');

const PROVIDERS = Object.freeze({
  github: {
    label: 'GitHub',
    host: 'github.com',
    tokenKey: 'git_provider_github_token',
    repositoriesUrl: 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    headers(token) {
      return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'SHAM/1.0',
        'X-GitHub-Api-Version': '2022-11-28'
      };
    },
    map(repository) {
      return {
        id: String(repository.id),
        name: String(repository.name || ''),
        fullName: String(repository.full_name || repository.name || ''),
        url: String(repository.clone_url || ''),
        defaultBranch: String(repository.default_branch || 'main'),
        private: Boolean(repository.private),
        updatedAt: String(repository.updated_at || '')
      };
    },
    basicUser: 'x-access-token'
  },
  gitlab: {
    label: 'GitLab',
    host: 'gitlab.com',
    tokenKey: 'git_provider_gitlab_token',
    repositoriesUrl: 'https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at&sort=desc',
    headers(token) {
      return { 'PRIVATE-TOKEN': token, 'User-Agent': 'SHAM/1.0' };
    },
    map(repository) {
      return {
        id: String(repository.id),
        name: String(repository.name || ''),
        fullName: String(repository.path_with_namespace || repository.name || ''),
        url: String(repository.http_url_to_repo || ''),
        defaultBranch: String(repository.default_branch || 'main'),
        private: String(repository.visibility || '').toLowerCase() !== 'public',
        updatedAt: String(repository.last_activity_at || '')
      };
    },
    basicUser: 'oauth2'
  }
});

function providerDefinition(provider) {
  const key = String(provider || '').trim().toLowerCase();
  const definition = PROVIDERS[key];
  if (!definition) throw new Error('Git provider must be GitHub or GitLab.');
  return { key, ...definition };
}

function providerStatuses(db) {
  return Object.entries(PROVIDERS).map(([provider, definition]) => ({
    provider,
    label: definition.label,
    configured: Boolean(getSecretSetting(db, definition.tokenKey, ''))
  }));
}

function saveProviderToken(db, provider, { token, clearToken = false } = {}) {
  const definition = providerDefinition(provider);
  const incoming = token === undefined || token === null ? '' : String(token).trim();
  if (incoming && (incoming.length > 8192 || /[\s\0]/.test(incoming))) throw new Error(`${definition.label} token must be a single value no longer than 8192 characters.`);
  if (incoming && clearToken) throw new Error('Choose either a replacement token or disconnect the provider.');
  if (!incoming && !clearToken) throw new Error(`Enter a ${definition.label} access token or choose disconnect.`);
  setSecretSetting(db, definition.tokenKey, clearToken ? '' : incoming);
  return providerStatuses(db);
}

async function listProviderRepositories(db, provider) {
  const definition = providerDefinition(provider);
  const token = getSecretSetting(db, definition.tokenKey, '');
  if (!token) throw new Error(`${definition.label} is not connected. Connect it from Settings → Instance first.`);
  const response = await fetch(definition.repositoriesUrl, {
    method: 'GET',
    headers: definition.headers(token),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const retry = response.status === 401 || response.status === 403 ? ' Check the saved token and its repository-read permissions.' : '';
    throw new Error(`${definition.label} repository lookup failed with HTTP ${response.status}.${retry}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`${definition.label} returned an unexpected repository response.`);
  return payload.map(definition.map).filter((repository) => repository.fullName && /^https:\/\//i.test(repository.url)).slice(0, 100);
}

function providerForRepositoryUrl(repositoryUrl) {
  let parsed;
  try { parsed = new URL(String(repositoryUrl || '')); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  return Object.entries(PROVIDERS).find(([, definition]) => parsed.hostname.toLowerCase() === definition.host)?.[0] || null;
}

function repositoryPath(repositoryUrl, provider) {
  const definition = providerDefinition(provider);
  let parsed;
  try { parsed = new URL(String(repositoryUrl || '')); } catch { throw new Error('Repository URL is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== definition.host) throw new Error(`Repository URL is not hosted on ${definition.label}.`);
  const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!pathname || pathname.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${definition.label} repository path is invalid.`);
  return pathname;
}

function normalizeWebhookBaseUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.length > 2048 || /[\0\r\n]/.test(input)) throw new Error('Public SHAM URL is too long or invalid.');
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('Public SHAM URL must be a valid HTTP or HTTPS origin.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Public SHAM URL must be a valid HTTP or HTTPS origin without credentials, query parameters, or fragments.');
  if (parsed.pathname && parsed.pathname !== '/') throw new Error('Public SHAM URL must be an origin without an additional path.');
  return parsed.origin;
}

async function providerRequest(definition, token, url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { ...definition.headers(token), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const permission = [401, 403, 404].includes(response.status) ? ` Check the saved ${definition.label} token and its repository/webhook permissions.` : '';
    throw new Error(`${definition.label} webhook configuration failed with HTTP ${response.status}.${permission}`);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function ensureProviderWebhook(db, repositoryUrl, callbackUrl, secret) {
  const provider = providerForRepositoryUrl(repositoryUrl);
  if (!provider) throw new Error('Automatic webhooks require a connected GitHub or GitLab HTTPS repository.');
  const definition = providerDefinition(provider);
  const token = getSecretSetting(db, definition.tokenKey, '');
  if (!token) throw new Error(`${definition.label} is not connected. Connect it from Settings → Instance first.`);
  const repoPath = repositoryPath(repositoryUrl, provider);
  const target = new URL(callbackUrl);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Webhook callback URL is invalid.');
  const webhookSecret = String(secret || '');
  if (!webhookSecret || webhookSecret.length > 8192 || /[\0\r\n]/.test(webhookSecret)) throw new Error('Webhook secret is invalid.');

  if (provider === 'github') {
    const base = `https://api.github.com/repos/${repoPath.split('/').map(encodeURIComponent).join('/')}/hooks`;
    const hooks = await providerRequest(definition, token, `${base}?per_page=100`);
    const existing = Array.isArray(hooks) ? hooks.find((hook) => String(hook?.config?.url || '') === target.toString()) : null;
    const body = { name: 'web', active: true, events: ['push'], config: { url: target.toString(), content_type: 'json', secret: webhookSecret, insecure_ssl: '0' } };
    const hook = existing
      ? await providerRequest(definition, token, `${base}/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body })
      : await providerRequest(definition, token, base, { method: 'POST', body });
    return { provider, action: existing ? 'updated' : 'created', id: String(hook?.id || existing?.id || ''), url: target.toString() };
  }

  const project = encodeURIComponent(repoPath);
  const base = `https://gitlab.com/api/v4/projects/${project}/hooks`;
  const hooks = await providerRequest(definition, token, base);
  const existing = Array.isArray(hooks) ? hooks.find((hook) => String(hook?.url || '') === target.toString()) : null;
  const body = { url: target.toString(), token: webhookSecret, push_events: true, enable_ssl_verification: target.protocol === 'https:' };
  const hook = existing
    ? await providerRequest(definition, token, `${base}/${encodeURIComponent(existing.id)}`, { method: 'PUT', body })
    : await providerRequest(definition, token, base, { method: 'POST', body });
  return { provider, action: existing ? 'updated' : 'created', id: String(hook?.id || existing?.id || ''), url: target.toString() };
}

function applyGitProviderCredentials(db, repositoryUrl, environment) {
  const provider = providerForRepositoryUrl(repositoryUrl);
  if (!provider) return null;
  const definition = providerDefinition(provider);
  const token = getSecretSetting(db, definition.tokenKey, '');
  if (!token) return null;
  const authorization = Buffer.from(`${definition.basicUser}:${token}`).toString('base64');
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_CONFIG_COUNT = '1';
  environment.GIT_CONFIG_KEY_0 = `http.https://${definition.host}/.extraHeader`;
  environment.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${authorization}`;
  return provider;
}

module.exports = {
  PROVIDERS,
  providerDefinition,
  providerStatuses,
  saveProviderToken,
  listProviderRepositories,
  providerForRepositoryUrl,
  applyGitProviderCredentials,
  normalizeWebhookBaseUrl,
  ensureProviderWebhook
};

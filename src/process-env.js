'use strict';

const BASE_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR'
]);

const NETWORK_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'NPM_CONFIG_REGISTRY', 'npm_config_registry'
]);

const OPERATOR_KEYS = new Set([
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'
]);

function pickEnvironment(keys) {
  const environment = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function mergeSafe(base, extra = {}) {
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    const name = String(key);
    if (!name || /[=\0]/.test(name)) throw new Error(`Environment variable name “${name || '?'}” is invalid.`);
    const text = String(value);
    if (text.includes('\0')) throw new Error(`Environment variable ${name} contains a null byte.`);
    base[name] = text;
  }
  return base;
}

function runtimeEnvironment(extra = {}) {
  return mergeSafe(pickEnvironment(BASE_KEYS), extra);
}

function buildEnvironment(extra = {}) {
  return mergeSafe(pickEnvironment(new Set([...BASE_KEYS, ...NETWORK_KEYS])), extra);
}

function operatorEnvironment(extra = {}) {
  return mergeSafe(pickEnvironment(new Set([...BASE_KEYS, ...NETWORK_KEYS, ...OPERATOR_KEYS])), extra);
}

module.exports = { runtimeEnvironment, buildEnvironment, operatorEnvironment };

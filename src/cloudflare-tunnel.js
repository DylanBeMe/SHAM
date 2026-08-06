'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CLOUDFLARED_BIN } = require('./config');
const { operatorEnvironment } = require('./process-env');
const { getSecretSetting, setSecretSetting } = require('./secret-store');

const TOKEN_SETTING = 'cloudflare_tunnel_token';
const ENABLED_SETTING = 'cloudflare_tunnel_enabled';
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_LOG_LENGTH = 24 * 1024;

function appendTail(current, text, limit = MAX_LOG_LENGTH) {
  const combined = `${current}${text}`;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function commandAvailable(command) {
  const value = String(command || '').trim();
  if (!value) return false;
  const candidates = (path.isAbsolute(value) || value.includes(path.sep))
    ? [value]
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap((directory) => {
      const candidate = path.join(directory, value);
      return process.platform === 'win32' && !path.extname(candidate)
        ? [candidate, `${candidate}.exe`, `${candidate}.cmd`]
        : [candidate];
    });
  return candidates.some((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; }
    catch { return false; }
  });
}

function processOptions(options = {}) {
  return { ...options, detached: process.platform !== 'win32', windowsHide: true };
}

function terminate(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* Process already exited. */ }
  }
}

function terminateAndWait(child, graceMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let forceTimer;
    let fallbackTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(fallbackTimer);
      resolve();
    };
    child.once('exit', finish);
    child.once('close', finish);
    forceTimer = setTimeout(() => terminate(child, 'SIGKILL'), graceMs);
    fallbackTimer = setTimeout(finish, graceMs + 3000);
    forceTimer.unref?.();
    fallbackTimer.unref?.();
    terminate(child, 'SIGTERM');
  });
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /[\s\0]/.test(token)) {
    throw new Error('Cloudflare Tunnel token must be a single value no longer than 16 KiB.');
  }
  return token;
}

class DatabaseTunnelSettingsStore {
  constructor(db) {
    this.db = db;
  }

  status() {
    const enabled = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_SETTING)?.value === '1';
    const storedToken = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_SETTING)?.value || '';
    return { enabled, tokenConfigured: Boolean(storedToken) };
  }

  token() {
    return getSecretSetting(this.db, TOKEN_SETTING, '');
  }

  save({ enabled, token, clearToken = false }) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(ENABLED_SETTING, enabled ? '1' : '0');
      if (token !== undefined) setSecretSetting(this.db, TOKEN_SETTING, token);
      else if (clearToken) setSecretSetting(this.db, TOKEN_SETTING, '');
    });
    transaction();
    return this.status();
  }
}

class CloudflareTunnelManager {
  constructor({
    settingsStore,
    command = CLOUDFLARED_BIN,
    spawnProcess = spawn,
    commandAvailableCheck = commandAvailable,
    terminateProcess = terminateAndWait,
    environment = operatorEnvironment,
    log = () => {},
    now = () => new Date(),
    restartBaseMs = 1000,
    restartMaxMs = 30_000,
    stableAfterMs = 60_000
  } = {}) {
    if (!settingsStore) throw new Error('Cloudflare Tunnel settings store is required.');
    this.settingsStore = settingsStore;
    this.command = command;
    this.spawnProcess = spawnProcess;
    this.commandAvailableCheck = commandAvailableCheck;
    this.terminateProcess = terminateProcess;
    this.environment = environment;
    this.log = log;
    this.now = now;
    this.restartBaseMs = Math.max(100, Number(restartBaseMs) || 1000);
    this.restartMaxMs = Math.max(this.restartBaseMs, Number(restartMaxMs) || 30_000);
    this.stableAfterMs = Math.max(100, Number(stableAfterMs) || 60_000);

    this.available = false;
    this.child = null;
    this.restartTimer = null;
    this.stableTimer = null;
    this.operationTail = Promise.resolve();
    this.generation = 0;
    this.shuttingDown = false;
    this.state = 'stopped';
    this.startedAt = null;
    this.connectedAt = null;
    this.lastExit = null;
    this.lastError = '';
    this.lastLog = '';
    this.tokenReadable = true;
    this.restartCount = 0;
    this.consecutiveFailures = 0;
    this.lastForwardedLogAt = 0;
    this.outputBuffers = { stdout: '', stderr: '' };
  }

  _enqueue(operation) {
    const run = this.operationTail.catch(() => {}).then(operation);
    this.operationTail = run;
    return run;
  }

  _configuration() {
    try { return this.settingsStore.status(); }
    catch (error) {
      this.lastError = `Could not read Cloudflare Tunnel settings: ${error.message}`;
      return { enabled: false, tokenConfigured: false };
    }
  }

  status() {
    const configuration = this._configuration();
    this.available = Boolean(this.commandAvailableCheck(this.command));
    const childRunning = Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
    return {
      available: this.available,
      command: this.command,
      enabled: configuration.enabled,
      tokenConfigured: configuration.tokenConfigured,
      tokenReadable: this.tokenReadable,
      state: this.state,
      running: childRunning,
      connected: childRunning && this.state === 'connected',
      pid: childRunning ? this.child.pid || null : null,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      restartCount: this.restartCount,
      lastExit: this.lastExit,
      lastError: this.lastError,
      lastLog: this.lastLog.trim()
    };
  }

  start() {
    return this._enqueue(() => this._reconcile({ forceRestart: false }));
  }

  configure(input = {}) {
    return this._enqueue(async () => {
      const current = this._configuration();
      const enabled = Object.prototype.hasOwnProperty.call(input, 'enabled') ? Boolean(input.enabled) : current.enabled;
      const clearToken = Boolean(input.clearToken);
      const hasToken = Object.prototype.hasOwnProperty.call(input, 'token') && String(input.token || '').trim() !== '';
      const token = hasToken ? validateToken(input.token) : undefined;
      if (clearToken && token !== undefined) throw new Error('Choose either a new tunnel token or clear the saved token.');
      const tokenConfigured = token !== undefined ? true : clearToken ? false : current.tokenConfigured;
      if (enabled && !tokenConfigured) throw new Error('Set a Cloudflare Tunnel token before enabling the connector.');
      if (enabled && token === undefined && !clearToken) {
        try { validateToken(this.settingsStore.token()); this.tokenReadable = true; }
        catch {
          this.tokenReadable = false;
          throw new Error('The saved Cloudflare Tunnel token cannot be read. Replace it or disable and clear it.');
        }
      }

      this.settingsStore.save({ enabled, token, clearToken });
      this.tokenReadable = true;
      this.lastError = '';
      await this._reconcile({ forceRestart: true });
      return this.status();
    });
  }

  restart() {
    return this._enqueue(async () => {
      const configuration = this._configuration();
      if (!configuration.enabled) throw new Error('Enable Cloudflare Tunnel before restarting it.');
      if (!configuration.tokenConfigured) throw new Error('Set a Cloudflare Tunnel token before restarting it.');
      this.lastError = '';
      await this._reconcile({ forceRestart: true });
      return this.status();
    });
  }

  async _reconcile({ forceRestart }) {
    const configuration = this._configuration();
    this.available = Boolean(this.commandAvailableCheck(this.command));
    if (this.shuttingDown) return this.status();
    if (!configuration.enabled) {
      await this._stopChild('disabled');
      return this.status();
    }
    if (!configuration.tokenConfigured) {
      await this._stopChild('needs-token');
      this.lastError = 'No Cloudflare Tunnel token is configured.';
      return this.status();
    }
    if (!this.available) {
      await this._stopChild('unavailable');
      this.lastError = `Cloudflare Tunnel is enabled, but ${this.command} is not executable.`;
      return this.status();
    }
    if (forceRestart) await this._stopChild('stopped');
    if (!this.child) await this._launch();
    return this.status();
  }

  async _launch() {
    if (this.shuttingDown) return;
    this._clearRestartTimer();
    let token;
    try {
      token = validateToken(this.settingsStore.token());
      this.tokenReadable = true;
    } catch (error) {
      this.tokenReadable = false;
      this.state = 'error';
      this.lastError = `The saved Cloudflare Tunnel token could not be read: ${error.message}`;
      this.log('error', this.lastError);
      return;
    }

    const generation = ++this.generation;
    this.outputBuffers = { stdout: '', stderr: '' };
    this.startedAt = this.now().toISOString();
    this.connectedAt = null;
    this.lastExit = null;
    this.state = 'starting';

    let child;
    try {
      child = this.spawnProcess(
        this.command,
        ['tunnel', '--no-autoupdate', 'run'],
        processOptions({ env: this.environment({ TUNNEL_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] })
      );
    } catch (error) {
      this.lastError = `${this.command} could not start: ${error.message}`;
      this.state = 'error';
      this._scheduleRestart(generation);
      return;
    }

    this.child = child;
    let settled = false;
    const finish = (code, signal, error = null) => {
      if (settled) return;
      settled = true;
      this._handleExit({ child, generation, code, signal, error });
    };
    child.stdout?.on('data', (chunk) => this._consumeOutput('stdout', chunk, token, generation));
    child.stderr?.on('data', (chunk) => this._consumeOutput('stderr', chunk, token, generation));
    child.once('error', (error) => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal));

    this._clearStableTimer();
    this.stableTimer = setTimeout(() => {
      if (generation !== this.generation || this.child !== child) return;
      this.consecutiveFailures = 0;
    }, this.stableAfterMs);
    this.stableTimer.unref?.();
    this.log('info', 'Cloudflare Tunnel connector started.');
  }

  _consumeOutput(stream, chunk, token, generation) {
    if (generation !== this.generation) return;
    const text = `${this.outputBuffers[stream] || ''}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`;
    const lines = text.split(/\r?\n/);
    this.outputBuffers[stream] = (lines.pop() || '').slice(-4096);
    for (const rawLine of lines) this._consumeLine(rawLine, token, generation);
  }

  _consumeLine(rawLine, token, generation) {
    if (generation !== this.generation) return;
    const line = String(rawLine || '').replaceAll(token, '[redacted]').replace(/[\r\n\0]/g, ' ').trim().slice(0, 2000);
    if (!line) return;
    this.lastLog = appendTail(this.lastLog, `${line}\n`);

    if (/registered tunnel connection|connection .* registered|tunnel connection registered/i.test(line)) {
      if (this.state !== 'connected') {
        this.state = 'connected';
        this.connectedAt = this.now().toISOString();
        this.lastError = '';
        this.log('info', 'Cloudflare Tunnel connected to the Cloudflare edge.');
      }
      return;
    }

    const errorLine = /(?:^|[\s"=])(error|fatal|err)(?:[\s"=:]|$)|failed|unable to/i.test(line);
    if (errorLine) {
      this.lastError = line;
      const now = Date.now();
      if (now - this.lastForwardedLogAt >= 5000) {
        this.lastForwardedLogAt = now;
        this.log('error', `Cloudflare Tunnel: ${line}`);
      }
    }
  }

  _handleExit({ child, generation, code, signal, error }) {
    if (generation !== this.generation || this.child !== child) return;
    this.child = null;
    this._clearStableTimer();
    const description = error ? error.message : `exit ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
    this.lastExit = { code: code ?? null, signal: signal || null, at: this.now().toISOString() };
    this.lastError = error ? `${this.command} could not start: ${description}` : `Cloudflare Tunnel stopped with ${description}.`;
    this.state = 'error';
    this.log('error', this.lastError);
    this._scheduleRestart(generation);
  }

  _scheduleRestart(generation) {
    if (this.shuttingDown || generation !== this.generation || this.restartTimer) return;
    const configuration = this._configuration();
    if (!configuration.enabled || !configuration.tokenConfigured) return;
    const exponent = Math.min(this.consecutiveFailures, 10);
    const delay = Math.min(this.restartMaxMs, this.restartBaseMs * (2 ** exponent));
    this.consecutiveFailures += 1;
    this.restartCount += 1;
    this.state = 'backoff';
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._enqueue(async () => {
        if (this.shuttingDown || generation !== this.generation || this.child) return;
        this.available = Boolean(this.commandAvailableCheck(this.command));
        if (!this.available) {
          this.state = 'unavailable';
          this.lastError = `Cloudflare Tunnel is enabled, but ${this.command} is not executable.`;
          return;
        }
        await this._launch();
      }).catch((error) => {
        this.state = 'error';
        this.lastError = error.message;
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  _clearRestartTimer() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  _clearStableTimer() {
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  async _stopChild(nextState = 'stopped') {
    this._clearRestartTimer();
    this._clearStableTimer();
    this.outputBuffers = { stdout: '', stderr: '' };
    const child = this.child;
    this.child = null;
    this.generation += 1;
    if (child) await this.terminateProcess(child);
    this.state = nextState;
    this.startedAt = null;
    this.connectedAt = null;
  }

  shutdown() {
    return this._enqueue(async () => {
      this.shuttingDown = true;
      await this._stopChild('stopped');
      return this.status();
    });
  }
}

module.exports = {
  CloudflareTunnelManager,
  DatabaseTunnelSettingsStore,
  commandAvailable,
  terminateAndWait,
  validateToken,
  TOKEN_SETTING,
  ENABLED_SETTING
};

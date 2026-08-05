const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const express = require('express');
const httpProxy = require('http-proxy');
const {
  DATA_DIR, SITES_DIR, RELEASES_DIR, PREVIEWS_DIR, BACKUPS_DIR, SITE_DATA_DIR,
  DOCKER_BIN, GIT_BIN, TAR_BIN, RESTIC_BIN, AWS_BIN, SFTP_BIN, ANUBIS_IMAGE,
  JOB_POLL_INTERVAL_MS, JOB_TIMEOUT_MS, BACKUP_TIMEOUT_MS, GIT_TIMEOUT_MS,
  PREVIEW_TTL_HOURS, HTTP_REQUEST_TIMEOUT_MS
} = require('./config');
const { encrypt, decrypt, getSecretSetting, setSecretSetting } = require('./secret-store');
const { safeRelativePath } = require('./validation');
const { runtimeEnvironment, buildEnvironment, operatorEnvironment } = require('./process-env');

function appendTail(current, text, limit = 128 * 1024) {
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
  return { ...options, detached: process.platform !== 'win32' };
}

function terminate(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* Already exited. */ }
  }
}

function terminateAndWait(child, graceMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(force); clearTimeout(fallback); resolve(); };
    child.once('exit', finish);
    const force = setTimeout(() => terminate(child, 'SIGKILL'), graceMs);
    const fallback = setTimeout(finish, graceMs + 3000);
    force.unref?.(); fallback.unref?.();
    terminate(child, 'SIGTERM');
  });
}

function runProcess(command, args, { cwd, env, timeoutMs = 60_000, onLine = () => {}, stdin = null, environmentMode = 'operator' } = {}) {
  return new Promise((resolve, reject) => {
    const environment = environmentMode === 'runtime' ? runtimeEnvironment(env) : environmentMode === 'build' ? buildEnvironment(env) : operatorEnvironment(env);
    const child = spawn(command, args, processOptions({ cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }));
    let output = '';
    let settled = false;
    let timedOut = false;
    let forceTimer;
    let fallbackTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(fallbackTimer);
      callback(value);
    };
    const consume = (level, chunk) => {
      const text = chunk.toString();
      output = appendTail(output, text);
      for (const line of text.split(/\r?\n/).filter(Boolean)) onLine(level, line.slice(0, 2000));
    };
    child.stdout.on('data', (chunk) => consume('info', chunk));
    child.stderr.on('data', (chunk) => consume('error', chunk));
    child.once('error', (error) => finish(reject, new Error(`${command} could not start: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (timedOut) finish(reject, new Error(`${command} timed out.`));
      else if (code === 0) finish(resolve, { output: output.trim(), code, signal });
      else finish(reject, new Error(`${command} exited with ${code ?? signal}. ${output.trim().slice(-1600)}`));
    });
    child.stdin.on('error', (error) => {
      if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) finish(reject, new Error(`${command} stdin failed: ${error.message}`));
    });
    if (stdin !== null) child.stdin.end(String(stdin)); else child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        terminate(child, 'SIGKILL');
        fallbackTimer = setTimeout(() => finish(reject, new Error(`${command} timed out and did not exit after termination.`)), 3000);
        fallbackTimer.unref?.();
      }, 2500);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

function parseField(field, minimum, maximum) {
  const values = new Set();
  for (const part of String(field).split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1) throw new Error('Invalid cron step.');
    let start = minimum;
    let end = maximum;
    if (rangeRaw !== '*') {
      const [startRaw, endRaw] = rangeRaw.split('-');
      start = Number(startRaw);
      end = endRaw === undefined ? start : Number(endRaw);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || end > maximum || start > end) throw new Error('Invalid cron range.');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseCron(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Schedule must contain five cron fields: minute hour day month weekday.');
  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    days: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    weekdays: parseField(parts[4], 0, 6),
    dayWildcard: parts[2] === '*',
    weekdayWildcard: parts[4] === '*'
  };
}

function cronMatches(expression, date) {
  const schedule = parseCron(expression);
  const dayMatches = schedule.days.has(date.getDate());
  const weekdayMatches = schedule.weekdays.has(date.getDay());
  const calendarMatches = schedule.dayWildcard && schedule.weekdayWildcard
    ? true
    : schedule.dayWildcard
      ? weekdayMatches
      : schedule.weekdayWildcard
        ? dayMatches
        : dayMatches || weekdayMatches;
  return schedule.minutes.has(date.getMinutes())
    && schedule.hours.has(date.getHours())
    && schedule.months.has(date.getMonth() + 1)
    && calendarMatches;
}

function nextCronDate(expression, after = new Date()) {
  parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    if (cronMatches(expression, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error('Schedule does not produce a run within one year.');
}

function safeName(value, fallback = 'item') {
  return String(value || fallback).normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || fallback;
}

function pathInside(base, candidate) {
  const root = path.resolve(base);
  const target = path.resolve(candidate);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function sftpQuote(value, label = 'SFTP path') {
  const text = String(value || '');
  if (!text || /[\r\n\0]/.test(text)) throw new Error(`${label} is invalid.`);
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 3000).unref?.();
  });
}

function siteRoot(site) {
  return path.join(SITES_DIR, site.directory_name);
}

function requiredFile(site) {
  return site.runtime_type === 'node' ? site.node_entry : site.entry_file;
}

async function ensureRequiredFile(site, root) {
  const relative = safeRelativePath(requiredFile(site), 'Required runtime file');
  const absolute = path.join(root, ...relative.split('/'));
  const rootReal = await fs.promises.realpath(root);
  const fileReal = await fs.promises.realpath(absolute).catch(() => '');
  if (!fileReal.startsWith(`${rootReal}${path.sep}`) || !(await fs.promises.stat(fileReal).catch(() => null))?.isFile()) {
    throw new Error(`Required file “${relative}” is missing from the release.`);
  }
}

function validateGitUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.length > 2048 || /[\r\n\0\s]/.test(url)) throw new Error('Git repository URL is invalid.');
  if (/^git@/i.test(url)) {
    if (!/^git@(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):[A-Za-z0-9._~+\/-]+$/.test(url)) throw new Error('The git@ repository URL is invalid.');
    return url;
  }
  if (!/^(?:https?:\/\/|ssh:\/\/)/i.test(url)) throw new Error('Git URL must use HTTPS or SSH. Local file:// repositories are not allowed.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Git repository URL is invalid.'); }
  if (!parsed.hostname) throw new Error('Git repository URL must include a host.');
  if (parsed.password || (/^https?:$/i.test(parsed.protocol) && parsed.username)) {
    throw new Error('Git credentials must not be embedded in the repository URL. Use a deploy key or external credential helper.');
  }
  return url;
}

function validateBranch(value) {
  const branch = String(value || 'main').trim();
  if (!branch || branch.length > 200 || branch.startsWith('-') || /[\s~^:?*\[\\]/.test(branch) || branch.includes('..')) throw new Error('Git branch or tag is invalid.');
  return branch;
}

class OperationsManager {
  constructor({ db, manager, snapshotManager, edgeProxy = null }) {
    this.db = db;
    this.manager = manager;
    this.snapshotManager = snapshotManager;
    this.edgeProxy = edgeProxy;
    this.runningJobs = new Map();
    this.previewRuntimes = new Map();
    this.anubisRuntimes = new Map();
    this.stopping = false;
    this.jobTickPromise = null;
    this.backupPromise = null;
    this.lastBackupMinute = '';
    this.deliveredAlerts = new Map();
    this.lastTelemetryAt = 0;
    this.ensureJobSchedules();
    this.clearStalePreviews();
    this.timer = setInterval(() => this.tick().catch((error) => this.manager.log(null, 'error', `Operations scheduler failed: ${error.message}`)), JOB_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  setEdgeProxy(edgeProxy) { this.edgeProxy = edgeProxy; }

  ensureJobSchedules() {
    for (const job of this.db.prepare('SELECT id, schedule FROM site_jobs').all()) {
      try {
        const next = nextCronDate(job.schedule).toISOString();
        this.db.prepare('UPDATE site_jobs SET next_run_at = COALESCE(next_run_at, ?) WHERE id = ?').run(next, job.id);
      } catch (error) {
        this.db.prepare('UPDATE site_jobs SET enabled = 0, next_run_at = NULL WHERE id = ?').run(job.id);
        this.manager.log(null, 'error', `Disabled invalid scheduled job ${job.id}: ${error.message}`);
      }
    }
  }

  clearStalePreviews() {
    const rows = this.db.prepare('SELECT directory_name FROM preview_deployments').all();
    this.db.prepare('DELETE FROM preview_deployments').run();
    for (const row of rows) fs.promises.rm(path.join(PREVIEWS_DIR, row.directory_name), { recursive: true, force: true }).catch(() => {});
  }

  siteEnvironment(siteId, scope = 'runtime') {
    const result = {};
    for (const row of this.db.prepare("SELECT key, value, secret, scope FROM site_env WHERE site_id = ? AND (scope = ? OR scope = 'both') ORDER BY key").all(siteId, scope)) {
      try { result[row.key] = row.secret ? decrypt(row.value) : row.value; }
      catch (error) { this.manager.log(siteId, 'error', `Could not decrypt environment variable ${row.key}: ${error.message}`); }
    }
    for (const profile of this.db.prepare(`
      SELECT profiles.env_key, profiles.connection_value
      FROM database_profiles AS profiles
      JOIN site_database_profiles AS links ON links.profile_id = profiles.id
      WHERE links.site_id = ?
    `).all(siteId)) {
      try { result[profile.env_key] = decrypt(profile.connection_value); }
      catch (error) { this.manager.log(siteId, 'error', `Could not decrypt database profile ${profile.env_key}: ${error.message}`); }
    }
    return result;
  }

  listEnvironment(siteId) {
    return this.db.prepare('SELECT id, key, value, secret, scope, updated_at AS updatedAt FROM site_env WHERE site_id = ? ORDER BY key').all(siteId)
      .map((row) => ({ ...row, value: row.secret ? '' : row.value, secret: Boolean(row.secret), configured: true }));
  }

  saveEnvironment(siteId, variables) {
    if (!Array.isArray(variables) || variables.length > 200) throw new Error('Environment variables must be an array with at most 200 entries.');
    const keep = [];
    const upsert = this.db.prepare(`
      INSERT INTO site_env (site_id, key, value, secret, scope, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, scope = excluded.scope, updated_at = CURRENT_TIMESTAMP
    `);
    const transaction = this.db.transaction(() => {
      for (const item of variables) {
        const key = String(item.key || '').trim().toUpperCase();
        if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || key.startsWith('SHAM_') || ['PORT', 'HOST', 'NODE_ENV'].includes(key)) throw new Error(`Environment variable “${key || '?'}” is invalid or reserved.`);
        const scope = ['runtime', 'build', 'both'].includes(item.scope) ? item.scope : 'runtime';
        const secret = Boolean(item.secret);
        const existing = this.db.prepare('SELECT value, secret FROM site_env WHERE site_id = ? AND key = ?').get(siteId, key);
        let value = item.value === undefined || item.value === null ? '' : String(item.value);
        if (value.length > 64 * 1024 || /\0/.test(value)) throw new Error(`Environment variable ${key} is too large or invalid.`);
        if (secret && !value && existing?.secret && !item.clear) value = existing.value;
        else value = secret ? encrypt(value) : value;
        upsert.run(siteId, key, value, Number(secret), scope);
        keep.push(key);
      }
      if (keep.length) this.db.prepare(`DELETE FROM site_env WHERE site_id = ? AND key NOT IN (${keep.map(() => '?').join(',')})`).run(siteId, ...keep);
      else this.db.prepare('DELETE FROM site_env WHERE site_id = ?').run(siteId);
    });
    transaction();
    return this.listEnvironment(siteId);
  }

  listDatabaseProfiles(siteId = null) {
    const profiles = this.db.prepare('SELECT id, name, type, env_key AS envKey, updated_at AS updatedAt FROM database_profiles ORDER BY name').all();
    if (siteId == null) return profiles;
    const attached = new Set(this.db.prepare('SELECT profile_id FROM site_database_profiles WHERE site_id = ?').all(siteId).map((row) => row.profile_id));
    return profiles.map((profile) => ({ ...profile, attached: attached.has(profile.id) }));
  }

  saveDatabaseProfile(input) {
    const id = Number(input.id || 0);
    const name = String(input.name || '').trim().slice(0, 100);
    const type = String(input.type || 'custom').trim().toLowerCase().slice(0, 40);
    const envKey = String(input.envKey || 'DATABASE_URL').trim().toUpperCase();
    if (!name || !/^[a-z0-9_-]+$/.test(type) || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(envKey)) throw new Error('Database profile name, type, or environment key is invalid.');
    const existing = id ? this.db.prepare('SELECT connection_value FROM database_profiles WHERE id = ?').get(id) : null;
    let connection = String(input.connection || '');
    if (!connection && existing) connection = existing.connection_value;
    else {
      if (!connection || connection.length > 16 * 1024 || /[\r\n\0]/.test(connection)) throw new Error('Connection value is invalid.');
      connection = encrypt(connection);
    }
    if (id) {
      const result = this.db.prepare('UPDATE database_profiles SET name = ?, type = ?, env_key = ?, connection_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, type, envKey, connection, id);
      if (!result.changes) throw new Error('Database profile not found.');
      return id;
    }
    return Number(this.db.prepare('INSERT INTO database_profiles (name, type, env_key, connection_value) VALUES (?, ?, ?, ?)').run(name, type, envKey, connection).lastInsertRowid);
  }

  attachDatabaseProfiles(siteId, profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM site_database_profiles WHERE site_id = ?').run(siteId);
      const insert = this.db.prepare('INSERT INTO site_database_profiles (site_id, profile_id) VALUES (?, ?)');
      for (const id of ids) insert.run(siteId, id);
    });
    transaction();
    return this.listDatabaseProfiles(siteId);
  }

  deleteDatabaseProfile(id) {
    const result = this.db.prepare('DELETE FROM database_profiles WHERE id = ?').run(Number(id));
    if (!result.changes) throw new Error('Database profile not found.');
  }

  listJobs(siteId) {
    return this.db.prepare(`SELECT jobs.*, (SELECT status FROM job_runs WHERE job_id = jobs.id ORDER BY id DESC LIMIT 1) AS last_status FROM site_jobs AS jobs WHERE site_id = ? ORDER BY name`).all(siteId)
      .map((row) => ({ ...row, enabled: Boolean(row.enabled), allow_overlap: Boolean(row.allow_overlap), running: Boolean(this.runningJobs.get(row.id)?.size) }));
  }

  saveJob(siteId, input) {
    const id = Number(input.id || 0);
    const name = String(input.name || '').trim().slice(0, 100);
    const schedule = String(input.schedule || '').trim();
    const command = String(input.command || '').trim();
    if (!name || !command || command.length > 4000 || /\0/.test(command)) throw new Error('Job name and command are required.');
    const next = nextCronDate(schedule).toISOString();
    const timeout = Math.min(Math.max(Number(input.timeoutSeconds) || JOB_TIMEOUT_MS / 1000, 5), 86400);
    if (id) {
      const result = this.db.prepare(`UPDATE site_jobs SET name = ?, schedule = ?, command = ?, enabled = ?, timeout_seconds = ?, allow_overlap = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`)
        .run(name, schedule, command, Number(input.enabled !== false), timeout, Number(Boolean(input.allowOverlap)), next, id, siteId);
      if (!result.changes) throw new Error('Scheduled job not found.');
      return id;
    }
    return Number(this.db.prepare('INSERT INTO site_jobs (site_id, name, schedule, command, enabled, timeout_seconds, allow_overlap, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(siteId, name, schedule, command, Number(input.enabled !== false), timeout, Number(Boolean(input.allowOverlap)), next).lastInsertRowid);
  }

  deleteJob(siteId, id) {
    if (this.runningJobs.get(Number(id))?.size) throw new Error('Stop or wait for the running job before deleting it.');
    const result = this.db.prepare('DELETE FROM site_jobs WHERE id = ? AND site_id = ?').run(Number(id), siteId);
    if (!result.changes) throw new Error('Scheduled job not found.');
  }

  async executeSiteCommand(site, command, timeoutMs, onLine) {
    const root = siteRoot(site);
    if (site.runtime_isolation === 'docker') {
      return runProcess(DOCKER_BIN, ['exec', `sham-site-${site.id}`, 'sh', '-lc', command], { timeoutMs, onLine });
    }
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    return runProcess(shell, args, { cwd: root, env: this.siteEnvironment(site.id, 'runtime'), timeoutMs, onLine, environmentMode: 'runtime' });
  }

  async runJob(jobId, trigger = 'manual') {
    const job = this.db.prepare('SELECT * FROM site_jobs WHERE id = ?').get(Number(jobId));
    if (!job) throw new Error('Scheduled job not found.');
    const activeRuns = this.runningJobs.get(job.id) || new Set();
    if (activeRuns.size && !job.allow_overlap) throw new Error('This job is already running.');
    const site = this.manager.getSite(job.site_id);
    if (!site) throw new Error('Site not found.');
    const runId = Number(this.db.prepare("INSERT INTO job_runs (job_id, status, output) VALUES (?, 'running', '')").run(job.id).lastInsertRowid);
    const started = Date.now();
    let output = '';
    let operation;
    operation = this.executeSiteCommand(site, job.command, Math.min(job.timeout_seconds * 1000, 86400_000), (level, line) => {
      output = appendTail(output, `[${level}] ${line}\n`);
      this.manager.log(site.id, level, `job ${job.name}: ${line}`);
    }).then(() => {
      this.db.prepare("UPDATE job_runs SET status = 'success', output = ?, finished_at = CURRENT_TIMESTAMP, duration_ms = ? WHERE id = ?").run(output, Date.now() - started, runId);
      this.manager.log(site.id, 'info', `Scheduled job “${job.name}” completed (${trigger}).`);
      return { runId, status: 'success' };
    }, (error) => {
      output = appendTail(output, `\n${error.message}`);
      this.db.prepare("UPDATE job_runs SET status = 'failed', output = ?, finished_at = CURRENT_TIMESTAMP, duration_ms = ? WHERE id = ?").run(output, Date.now() - started, runId);
      this.manager.log(site.id, 'error', `Scheduled job “${job.name}” failed: ${error.message}`);
      throw error;
    }).finally(() => {
      activeRuns.delete(operation);
      if (!activeRuns.size && this.runningJobs.get(job.id) === activeRuns) this.runningJobs.delete(job.id);
    });
    activeRuns.add(operation);
    this.runningJobs.set(job.id, activeRuns);
    return operation;
  }

  async tickJobs(now) {
    const due = this.db.prepare("SELECT id, schedule FROM site_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20").all(now.toISOString());
    for (const job of due) {
      const next = nextCronDate(job.schedule, now).toISOString();
      this.db.prepare('UPDATE site_jobs SET last_started_at = CURRENT_TIMESTAMP, next_run_at = ? WHERE id = ?').run(next, job.id);
      this.runJob(job.id, 'schedule').catch(() => {});
    }
  }

  _backupSettings() {
    let config = {};
    try { config = JSON.parse(getSecretSetting(this.db, 'backup_config', '{}')); } catch { config = {}; }
    return {
      enabled: this.db.prepare("SELECT value FROM settings WHERE key = 'backup_enabled'").get()?.value === '1',
      provider: this.db.prepare("SELECT value FROM settings WHERE key = 'backup_provider'").get()?.value || 'local',
      schedule: this.db.prepare("SELECT value FROM settings WHERE key = 'backup_schedule'").get()?.value || '0 3 * * *',
      configured: Boolean(Object.keys(config).length),
      config
    };
  }

  backupSettings() {
    const settings = this._backupSettings();
    const sensitive = new Set(['password', 'accessKey', 'secretKey', 'sessionToken', 'privateKey', 'passphrase']);
    const config = {};
    const secretFields = [];
    for (const [key, value] of Object.entries(settings.config || {})) {
      if (sensitive.has(key)) {
        if (value !== undefined && value !== null && String(value) !== '') secretFields.push(key);
      } else config[key] = value;
    }
    return { ...settings, config, secretFields };
  }

  saveBackupSettings(input) {
    const provider = String(input.provider || 'local');
    if (!['local', 'restic', 's3', 'sftp'].includes(provider)) throw new Error('Backup provider must be local, restic, s3, or sftp.');
    const schedule = String(input.schedule || '0 3 * * *');
    parseCron(schedule);
    const incoming = input.config && typeof input.config === 'object' && !Array.isArray(input.config) ? input.config : {};
    const existing = this._backupSettings().config || {};
    const sensitive = new Set(['password', 'accessKey', 'secretKey', 'sessionToken', 'privateKey', 'passphrase']);
    const config = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) throw new Error(`Backup option “${key}” is invalid.`);
      if (sensitive.has(key) && (value === '' || value === null || value === undefined)) continue;
      if (value === undefined) continue;
      config[key] = value;
    }
    for (const key of Array.isArray(input.clearSecrets) ? input.clearSecrets : []) {
      if (sensitive.has(String(key))) delete config[String(key)];
    }
    const serialized = JSON.stringify(config);
    if (serialized.length > 128 * 1024 || serialized.includes('\0')) throw new Error('Backup provider configuration is too large or invalid.');
    this.db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'backup_enabled'").run(input.enabled ? '1' : '0');
    this.db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'backup_provider'").run(provider);
    this.db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'backup_schedule'").run(schedule);
    setSecretSetting(this.db, 'backup_config', serialized);
    return this.backupSettings();
  }

  async createBackup({ provider = null } = {}) {
    if (this.backupPromise) return this.backupPromise;
    const operation = this._createBackup(provider).finally(() => { if (this.backupPromise === operation) this.backupPromise = null; });
    this.backupPromise = operation;
    return operation;
  }

  async _createBackup(providerOverride) {
    const settings = this._backupSettings();
    const provider = providerOverride || settings.provider;
    if (!['local', 'restic', 's3', 'sftp'].includes(provider)) throw new Error('Backup provider is invalid.');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `sham-backup-${stamp}.tar.gz`;
    const localPath = path.join(BACKUPS_DIR, filename);
    const runId = Number(this.db.prepare("INSERT INTO backup_runs (destination, status, filename) VALUES (?, 'running', ?)").run(provider, filename).lastInsertRowid);
    let databaseSnapshotDirectory = '';

    try {
      await fs.promises.writeFile(localPath, '', { flag: 'wx', mode: 0o600 });
      databaseSnapshotDirectory = await fs.promises.mkdtemp(path.join(DATA_DIR, 'tmp', 'backup-db-'));
      await this.db.backup(path.join(databaseSnapshotDirectory, 'sham.db'));
      await runProcess(TAR_BIN, [
        '--exclude=./tmp', '--exclude=./backups', '--exclude=./updates',
        '--exclude=./sham.db', '--exclude=./sham.db-wal', '--exclude=./sham.db-shm',
        '-czf', localPath, '-C', DATA_DIR, '.', '-C', databaseSnapshotDirectory, 'sham.db'
      ], { timeoutMs: BACKUP_TIMEOUT_MS, onLine: (level, line) => this.manager.log(null, level, `backup: ${line}`) });
      await runProcess(TAR_BIN, ['-tzf', localPath], { timeoutMs: Math.min(BACKUP_TIMEOUT_MS, 10 * 60 * 1000) });
      await fs.promises.chmod(localPath, 0o600);

      const stat = await fs.promises.stat(localPath);
      const config = settings.config || {};
      let destination = provider;
      let externalLocalDirectory = null;

      if (provider === 'local' && config.destination) {
        if (String(config.destination).includes('\0')) throw new Error('Local backup destination is invalid.');
        await fs.promises.mkdir(path.resolve(String(config.destination)), { recursive: true, mode: 0o700 });
        externalLocalDirectory = await fs.promises.realpath(path.resolve(String(config.destination)));
        const dataRoot = await fs.promises.realpath(DATA_DIR);
        const builtInBackupRoot = await fs.promises.realpath(BACKUPS_DIR);
        if (pathInside(dataRoot, externalLocalDirectory) && externalLocalDirectory !== builtInBackupRoot) {
          throw new Error('External local backups must be stored outside SHAM_DATA_PATH to avoid recursive archives.');
        }
        const target = path.join(externalLocalDirectory, filename);
        if (path.resolve(target) !== path.resolve(localPath)) {
          await fs.promises.copyFile(localPath, target, fs.constants.COPYFILE_EXCL);
          await fs.promises.chmod(target, 0o600);
        }
        destination = target;
      } else if (provider === 'restic') {
        if (!config.repository || !config.password) throw new Error('Restic repository and password are required.');
        await runProcess(RESTIC_BIN, ['backup', localPath, '--tag', 'sham'], {
          timeoutMs: BACKUP_TIMEOUT_MS,
          env: { RESTIC_REPOSITORY: config.repository, RESTIC_PASSWORD: config.password }
        });
        destination = String(config.repository);
      } else if (provider === 's3') {
        const s3Destination = String(config.destination || '');
        if (!/^s3:\/\/[A-Za-z0-9][A-Za-z0-9._-]{1,62}(?:\/[^\r\n\0]*)?$/.test(s3Destination)) {
          throw new Error('S3 destination must be a valid s3:// bucket path.');
        }
        const target = `${s3Destination.replace(/\/$/, '')}/${filename}`;
        const args = ['s3', 'cp', localPath, target];
        if (config.endpoint) args.push('--endpoint-url', String(config.endpoint));
        await runProcess(AWS_BIN, args, {
          timeoutMs: BACKUP_TIMEOUT_MS,
          env: {
            AWS_ACCESS_KEY_ID: config.accessKey || '',
            AWS_SECRET_ACCESS_KEY: config.secretKey || '',
            AWS_SESSION_TOKEN: config.sessionToken || '',
            AWS_DEFAULT_REGION: config.region || ''
          }
        });
        destination = target;
      } else if (provider === 'sftp') {
        if (!config.host || !config.remotePath) throw new Error('SFTP host and remote path are required.');
        const host = String(config.host);
        const user = String(config.user || '');
        if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/.test(host) || (user && !/^[A-Za-z0-9._-]+$/.test(user))) {
          throw new Error('SFTP host or user is invalid.');
        }
        const target = user ? `${user}@${host}` : host;
        const args = ['-b', '-'];
        let keyPath = '';
        try {
          if (config.privateKey) {
            keyPath = path.join(DATA_DIR, 'tmp', `sftp-key-${crypto.randomUUID()}`);
            await fs.promises.writeFile(keyPath, String(config.privateKey), { mode: 0o600 });
            args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
          }
          if (config.port) {
            const sftpPort = Number(config.port);
            if (!Number.isInteger(sftpPort) || sftpPort < 1 || sftpPort > 65535) throw new Error('SFTP port is invalid.');
            args.push('-P', String(sftpPort));
          }
          args.push(target);
          const remote = `${String(config.remotePath).replace(/\/$/, '')}/${filename}`;
          await runProcess(SFTP_BIN, args, {
            timeoutMs: BACKUP_TIMEOUT_MS,
            stdin: `put ${sftpQuote(localPath, 'Local backup path')} ${sftpQuote(remote, 'Remote backup path')}\n`
          });
          destination = `${target}:${remote}`;
        } finally {
          if (keyPath) await fs.promises.rm(keyPath, { force: true }).catch(() => {});
        }
      }

      this.db.prepare("UPDATE backup_runs SET destination = ?, status = 'success', bytes = ?, detail = 'Archive integrity verified', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(String(destination).slice(0, 2000), stat.size, runId);
      const retention = Math.min(Math.max(Number(config.retention) || 14, 1), 365);
      const localBackups = (await fs.promises.readdir(BACKUPS_DIR)).filter((name) => /^sham-backup-.*\.tar\.gz$/.test(name)).sort().reverse();
      await Promise.all(localBackups.slice(retention).map((name) => fs.promises.rm(path.join(BACKUPS_DIR, name), { force: true })));
      if (externalLocalDirectory) {
        const externalBackups = (await fs.promises.readdir(externalLocalDirectory)).filter((name) => /^sham-backup-.*\.tar\.gz$/.test(name)).sort().reverse();
        await Promise.all(externalBackups.slice(retention).map((name) => fs.promises.rm(path.join(externalLocalDirectory, name), { force: true })));
      }
      this.manager.log(null, 'info', `Backup ${filename} completed using ${provider}; archive integrity was verified.`);
      return { id: runId, filename, bytes: stat.size, provider, destination, verified: true };
    } catch (error) {
      await fs.promises.rm(localPath, { force: true }).catch(() => {});
      this.db.prepare("UPDATE backup_runs SET status = 'failed', detail = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(error.message.slice(0, 4000), runId);
      throw error;
    } finally {
      if (databaseSnapshotDirectory) await fs.promises.rm(databaseSnapshotDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async tickBackup(now) {
    const settings = this._backupSettings();
    if (!settings.enabled || !cronMatches(settings.schedule, now)) return;
    const minute = now.toISOString().slice(0, 16);
    if (this.lastBackupMinute === minute) return;
    this.lastBackupMinute = minute;
    this.createBackup({}).catch((error) => this.manager.log(null, 'error', `Scheduled backup failed: ${error.message}`));
  }

  async cloneRepository(site, { url, branch, deployKey = '', installDependencies = false }) {
    const repository = validateGitUrl(url);
    const ref = validateBranch(branch);
    const stage = path.join(SITES_DIR, `${site.directory_name}.git-${crypto.randomUUID()}`);
    const environment = this.siteEnvironment(site.id, 'build');
    let keyPath = '';
    try {
      if (deployKey) {
        keyPath = path.join(DATA_DIR, 'tmp', `git-key-${crypto.randomUUID()}`);
        await fs.promises.writeFile(keyPath, deployKey, { mode: 0o600 });
        environment.GIT_SSH_COMMAND = `ssh -i ${JSON.stringify(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
      }
      await runProcess(GIT_BIN, ['clone', '--depth', '1', '--branch', ref, '--single-branch', '--', repository, stage], { timeoutMs: GIT_TIMEOUT_MS, env: environment, environmentMode: 'build', onLine: (level, line) => this.manager.log(site.id, level, `git: ${line}`) });
      const commitSha = (await runProcess(GIT_BIN, ['rev-parse', 'HEAD'], { cwd: stage, timeoutMs: 30_000, env: environment, environmentMode: 'build' })).output.trim();
      await fs.promises.rm(path.join(stage, '.git'), { recursive: true, force: true });
      await ensureRequiredFile(site, stage);
      if (installDependencies && site.runtime_type === 'node') {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        await runProcess(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, timeoutMs: GIT_TIMEOUT_MS, env: environment, environmentMode: 'build', onLine: (level, line) => this.manager.log(site.id, level, `npm: ${line}`) });
      }
      return { stage, repository, ref, commitSha };
    } catch (error) {
      await fs.promises.rm(stage, { recursive: true, force: true });
      throw error;
    } finally {
      if (keyPath) await fs.promises.rm(keyPath, { force: true }).catch(() => {});
    }
  }

  async activateRelease(site, stage, { source, version, commitSha = null }) {
    const root = siteRoot(site);
    await ensureRequiredFile(site, stage);
    const releaseBase = path.join(RELEASES_DIR, String(site.id));
    await fs.promises.mkdir(releaseBase, { recursive: true });
    const previousArchive = path.join(releaseBase, `release-${Date.now()}-${crypto.randomUUID()}`);
    const wasRunning = this.manager.statusFor(site.id).running;
    await this.manager.stop(site.id);
    let previousMoved = false;
    let metadataCommitted = false;
    try {
      await fs.promises.rename(root, previousArchive);
      previousMoved = true;
      await fs.promises.rename(stage, root);
      if (wasRunning || site.enabled) await this.manager.start(site.id);
      const transaction = this.db.transaction(() => {
        const current = this.db.prepare('SELECT id FROM site_releases WHERE site_id = ? AND active = 1').get(site.id);
        if (current) this.db.prepare("UPDATE site_releases SET active = 0, status = 'ready', directory_name = ? WHERE id = ?").run(path.basename(previousArchive), current.id);
        else this.db.prepare("INSERT INTO site_releases (site_id, version, source, directory_name, status, active) VALUES (?, ?, 'existing', ?, 'ready', 0)").run(site.id, `pre-${Date.now()}`, path.basename(previousArchive));
        this.db.prepare('UPDATE site_releases SET active = 0 WHERE site_id = ?').run(site.id);
        this.db.prepare("INSERT INTO site_releases (site_id, version, source, directory_name, commit_sha, status, active) VALUES (?, ?, ?, '', ?, 'active', 1)").run(site.id, version, source, commitSha);
        this.db.prepare('UPDATE sites SET release_mode = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(site.id);
      });
      transaction();
      metadataCommitted = true;
    } catch (error) {
      if (!metadataCommitted) {
        await this.manager.stop(site.id).catch(() => {});
        await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
        if (previousMoved) await fs.promises.rename(previousArchive, root).catch(() => {});
        if (wasRunning || site.enabled) await this.manager.start(site.id).catch((restartError) => this.manager.log(site.id, 'error', `Release rollback runtime recovery failed: ${restartError.message}`));
      }
      throw error;
    } finally {
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
    await this.pruneReleases(site.id, 8).catch((error) => this.manager.log(site.id, 'error', `Could not prune old releases: ${error.message}`));
    return this.listReleases(site.id)[0];
  }

  async deployGit(site, input) {
    const cloned = await this.cloneRepository(site, input);
    const version = `${safeName(cloned.ref)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const release = await this.activateRelease(site, cloned.stage, { source: 'git', version, commitSha: cloned.commitSha });
    this.db.prepare('UPDATE sites SET git_url = ?, git_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(cloned.repository, cloned.ref, site.id);
    return release;
  }

  listReleases(siteId) {
    return this.db.prepare('SELECT id, version, source, commit_sha AS commitSha, status, active, created_at AS createdAt FROM site_releases WHERE site_id = ? ORDER BY active DESC, id DESC').all(siteId)
      .map((row) => ({ ...row, active: Boolean(row.active) }));
  }

  async rollbackRelease(site, releaseId) {
    const selected = this.db.prepare('SELECT * FROM site_releases WHERE id = ? AND site_id = ? AND active = 0').get(Number(releaseId), site.id);
    if (!selected?.directory_name) throw new Error('Rollback release not found.');
    const selectedPath = path.join(RELEASES_DIR, String(site.id), selected.directory_name);
    await ensureRequiredFile(site, selectedPath);
    const root = siteRoot(site);
    const currentArchive = path.join(RELEASES_DIR, String(site.id), `release-${Date.now()}-${crypto.randomUUID()}`);
    const wasRunning = this.manager.statusFor(site.id).running;
    await this.manager.stop(site.id);
    let currentMoved = false;
    let metadataCommitted = false;
    try {
      await fs.promises.rename(root, currentArchive);
      currentMoved = true;
      await fs.promises.rename(selectedPath, root);
      if (wasRunning || site.enabled) await this.manager.start(site.id);
      const transaction = this.db.transaction(() => {
        const current = this.db.prepare('SELECT id FROM site_releases WHERE site_id = ? AND active = 1').get(site.id);
        if (current) this.db.prepare("UPDATE site_releases SET active = 0, status = 'ready', directory_name = ? WHERE id = ?").run(path.basename(currentArchive), current.id);
        this.db.prepare("UPDATE site_releases SET active = 1, status = 'active', directory_name = '' WHERE id = ?").run(selected.id);
      });
      transaction();
      metadataCommitted = true;
    } catch (error) {
      if (!metadataCommitted) {
        await this.manager.stop(site.id).catch(() => {});
        await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
        if (currentMoved) await fs.promises.rename(currentArchive, root).catch(() => {});
        if (wasRunning || site.enabled) await this.manager.start(site.id).catch((restartError) => this.manager.log(site.id, 'error', `Rollback recovery failed: ${restartError.message}`));
      }
      throw error;
    }
    return this.listReleases(site.id);
  }

  async pruneReleases(siteId, keep = 8) {
    const rows = this.db.prepare('SELECT * FROM site_releases WHERE site_id = ? AND active = 0 ORDER BY id DESC').all(siteId);
    for (const row of rows.slice(keep)) {
      if (row.directory_name) await fs.promises.rm(path.join(RELEASES_DIR, String(siteId), row.directory_name), { recursive: true, force: true }).catch(() => {});
      this.db.prepare('DELETE FROM site_releases WHERE id = ?').run(row.id);
    }
  }

  async createPreview(site, { hostname = '', ttlHours = PREVIEW_TTL_HOURS } = {}) {
    const root = siteRoot(site);
    const idToken = crypto.randomUUID();
    const directoryName = `preview-${idToken}`;
    const previewRoot = path.join(PREVIEWS_DIR, directoryName);
    await fs.promises.cp(root, previewRoot, { recursive: true, force: false, filter: (source) => { const relative = path.relative(root, source); return relative !== '.sham' && !relative.startsWith(`.sham${path.sep}`); } });
    const port = await freePort();
    const previewHostname = String(hostname || `preview-${site.id}.${site.domain || 'local.invalid'}`).trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(previewHostname)) {
      await fs.promises.rm(previewRoot, { recursive: true, force: true });
      throw new Error('Preview hostname is invalid.');
    }
    const expires = new Date(Date.now() + Math.min(Math.max(Number(ttlHours) || PREVIEW_TTL_HOURS, 1), 720) * 3600_000).toISOString();
    let runtime;
    let previewChild = null;
    try {
      if (site.runtime_type === 'static') {
        const app = express();
        app.use(express.static(previewRoot, { index: site.entry_file, fallthrough: true, maxAge: 0 }));
        app.use((_req, res) => res.status(404).type('text/plain').send('Preview file not found.'));
        const server = http.createServer(app);
        server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        runtime = { server, target: `http://127.0.0.1:${port}`, root: previewRoot };
      } else {
        const entry = safeRelativePath(site.node_entry, 'Node entry file');
        previewChild = spawn(process.execPath, [entry], processOptions({ cwd: previewRoot, env: runtimeEnvironment({ ...this.siteEnvironment(site.id), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', SHAM_PREVIEW: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }));
        previewChild.stdout.on('data', (chunk) => this.manager.log(site.id, 'info', `preview: ${chunk.toString().trim().slice(0, 1000)}`));
        previewChild.stderr.on('data', (chunk) => this.manager.log(site.id, 'error', `preview: ${chunk.toString().trim().slice(0, 1000)}`));
        await new Promise((resolve, reject) => {
          const started = Date.now();
          const check = () => {
            if (previewChild.exitCode !== null || previewChild.signalCode !== null) return reject(new Error('Preview process exited during startup.'));
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.destroy(); resolve(); });
            socket.once('error', () => { socket.destroy(); if (Date.now() - started > 30_000) reject(new Error('Preview process did not begin listening.')); else setTimeout(check, 150); });
          };
          check();
        });
        runtime = { child: previewChild, target: `http://127.0.0.1:${port}`, root: previewRoot };
      }
      const result = this.db.prepare("INSERT INTO preview_deployments (site_id, hostname, port, directory_name, status, expires_at) VALUES (?, ?, ?, ?, 'running', ?)").run(site.id, previewHostname, port, directoryName, expires);
      const id = Number(result.lastInsertRowid);
      this.previewRuntimes.set(id, runtime);
      return { id, hostname: previewHostname, port, expiresAt: expires, status: 'running' };
    } catch (error) {
      if (runtime?.server) await closeServer(runtime.server);
      if (runtime?.child) await terminateAndWait(runtime.child);
      else if (previewChild) await terminateAndWait(previewChild);
      await fs.promises.rm(previewRoot, { recursive: true, force: true });
      throw error;
    }
  }

  listPreviews(siteId = null) {
    const rows = siteId == null
      ? this.db.prepare('SELECT * FROM preview_deployments ORDER BY id DESC').all()
      : this.db.prepare('SELECT * FROM preview_deployments WHERE site_id = ? ORDER BY id DESC').all(siteId);
    return rows.map((row) => ({ id: row.id, siteId: row.site_id, hostname: row.hostname, port: row.port, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at }));
  }

  previewForHostname(hostname) {
    const row = this.db.prepare("SELECT * FROM preview_deployments WHERE lower(hostname) = lower(?) AND status = 'running' AND expires_at > CURRENT_TIMESTAMP").get(hostname);
    const runtime = row && this.previewRuntimes.get(row.id);
    return runtime ? { row, target: runtime.target } : null;
  }

  async deletePreview(id) {
    const row = this.db.prepare('SELECT * FROM preview_deployments WHERE id = ?').get(Number(id));
    if (!row) throw new Error('Preview not found.');
    const runtime = this.previewRuntimes.get(row.id);
    if (runtime?.server) await closeServer(runtime.server);
    if (runtime?.child) await terminateAndWait(runtime.child);
    this.previewRuntimes.delete(row.id);
    this.db.prepare('DELETE FROM preview_deployments WHERE id = ?').run(row.id);
    await fs.promises.rm(path.join(PREVIEWS_DIR, row.directory_name), { recursive: true, force: true });
  }

  async cleanupExpiredPreviews() {
    for (const row of this.db.prepare("SELECT id FROM preview_deployments WHERE expires_at <= CURRENT_TIMESTAMP").all()) {
      await this.deletePreview(row.id).catch((error) => this.manager.log(null, 'error', `Could not clean preview ${row.id}: ${error.message}`));
    }
  }

  anubisTarget(siteId) {
    return this.anubisRuntimes.get(Number(siteId))?.target || null;
  }

  anubisPolicy(site, metricsPort = null) {
    const addMetrics = (policy) => {
      const normalized = String(policy || '').trim();
      if (!metricsPort) return `${normalized}\n`;
      return `${normalized}\nmetrics:\n  bind: \"127.0.0.1:${metricsPort}\"\n  network: tcp\n`;
    };
    if (site.anubis_policy?.trim()) return addMetrics(site.anubis_policy);
    const difficulty = Number(site.anubis_difficulty || 4);
    const common = `bots:
  - name: sham-health
    user_agent_regex: ^SHAM-Health/
    action: ALLOW
  - name: well-known
    path_regex: ^/.well-known/.*$
    action: ALLOW
  - name: favicon
    path_regex: ^/favicon\.ico$
    action: ALLOW
  - name: robots
    path_regex: ^/robots\.txt$
    action: ALLOW
`;
    if (site.anubis_preset === 'search-friendly') {
      return addMetrics(`${common}  - name: recognized-indexers
    user_agent_regex: (?i:Googlebot|Bingbot|DuckDuckBot|Applebot|InternetArchive)
    action: ALLOW
  - name: generic-browser
    user_agent_regex: Mozilla|Opera
    action: CHALLENGE
    challenge:
      algorithm: fast
      difficulty: ${difficulty}
`);
    }
    if (site.anubis_preset === 'aggressive') {
      return addMetrics(`${common}  - name: automated-client
    user_agent_regex: (?i:bot|crawler|spider|scrape|curl|wget|python|httpclient)
    action: DENY
  - name: generic-client
    user_agent_regex: .+
    action: CHALLENGE
    challenge:
      algorithm: fast
      difficulty: ${Math.min(10, difficulty + 1)}
`);
    }
    return addMetrics(`${common}  - name: generic-browser
    user_agent_regex: Mozilla|Opera
    action: CHALLENGE
    challenge:
      algorithm: fast
      difficulty: ${difficulty}
`);
  }

  dockerHostPath(localPath) {
    const resolved = path.resolve(localPath);
    const relative = path.relative(DATA_DIR, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Docker mount path is outside SHAM_DATA_PATH.');
    if (!fs.existsSync('/.dockerenv')) return resolved;
    const hostRoot = String(process.env.SHAM_DOCKER_HOST_DATA_PATH || '').trim();
    if (!hostRoot) throw new Error('Anubis requires SHAM_DOCKER_HOST_DATA_PATH when SHAM itself runs in Docker.');
    return path.join(path.resolve(hostRoot), relative);
  }

  async startAnubis(site) {
    if (!site.anubis_enabled || !site.edge_enabled) return null;
    if (this.anubisRuntimes.has(site.id)) return this.anubisRuntimes.get(site.id);
    const port = await freePort();
    let metricsPort = await freePort();
    while (metricsPort === port) metricsPort = await freePort();
    const configDir = path.join(SITE_DATA_DIR, String(site.id), 'anubis');
    await fs.promises.mkdir(configDir, { recursive: true });
    const policyPath = path.join(configDir, 'botPolicy.yaml');
    await fs.promises.writeFile(policyPath, this.anubisPolicy(site, metricsPort), { mode: 0o600 });
    const hostPolicyPath = this.dockerHostPath(policyPath);
    const networkArgs = fs.existsSync('/.dockerenv') && process.env.HOSTNAME
      ? ['--network', `container:${process.env.HOSTNAME}`]
      : ['--network', 'host'];
    const args = ['run', '--rm', '--name', `sham-anubis-${site.id}`, ...networkArgs,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only',
      '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '-v', `${hostPolicyPath}:/data/cfg/botPolicy.yaml:ro`,
      '-e', `BIND=127.0.0.1:${port}`, '-e', 'BIND_NETWORK=tcp',
      '-e', `TARGET=http://127.0.0.1:${site.port}`, '-e', 'POLICY_FNAME=/data/cfg/botPolicy.yaml',
      '-e', `DIFFICULTY=${Number(site.anubis_difficulty || 4)}`, '-e', 'SERVE_ROBOTS_TXT=true',
      '-e', `REDIRECT_DOMAINS=${site.domain}`, '-e', `COOKIE_DOMAIN=${site.domain}`, ANUBIS_IMAGE];
    const child = spawn(DOCKER_BIN, args, processOptions({ env: operatorEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }));
    child.stdout.on('data', (chunk) => this.manager.log(site.id, 'info', `anubis: ${chunk.toString().trim().slice(0, 1200)}`));
    child.stderr.on('data', (chunk) => this.manager.log(site.id, 'error', `anubis: ${chunk.toString().trim().slice(0, 1200)}`));
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (child.exitCode !== null) return reject(new Error('Anubis exited during startup. Verify Docker and the pinned image.'));
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', () => { socket.destroy(); if (Date.now() - started > 30_000) reject(new Error('Anubis did not become ready within 30 seconds.')); else setTimeout(check, 200); });
      };
      check();
    }).catch(async (error) => { terminate(child); await runProcess(DOCKER_BIN, ['rm', '-f', `sham-anubis-${site.id}`], { timeoutMs: 10_000 }).catch(() => {}); throw error; });
    const runtime = { child, port, metricsPort, target: `http://127.0.0.1:${port}`, metrics: `http://127.0.0.1:${metricsPort}/metrics` };
    child.once('exit', () => { if (this.anubisRuntimes.get(site.id) === runtime) this.anubisRuntimes.delete(site.id); });
    this.anubisRuntimes.set(site.id, runtime);
    this.manager.log(site.id, 'info', `Anubis protection started with ${site.anubis_preset} policy.`);
    return runtime;
  }

  async stopAnubis(siteId) {
    const runtime = this.anubisRuntimes.get(Number(siteId));
    if (!runtime) return;
    this.anubisRuntimes.delete(Number(siteId));
    terminate(runtime.child);
    await runProcess(DOCKER_BIN, ['rm', '-f', `sham-anubis-${siteId}`], { timeoutMs: 15_000 }).catch(() => {});
  }

  async afterSiteStart(site) {
    if (site.anubis_enabled) await this.startAnubis(site);
  }

  async beforeSiteStop(site) {
    await this.stopAnubis(site.id);
  }

  listAlertDestinations() {
    return this.db.prepare('SELECT id, name, kind, enabled, updated_at AS updatedAt FROM alert_destinations ORDER BY name').all()
      .map((row) => ({ ...row, enabled: Boolean(row.enabled), configured: true }));
  }

  saveAlertDestination(input) {
    const id = Number(input.id || 0);
    const name = String(input.name || '').trim().slice(0, 100);
    const kind = String(input.kind || '').toLowerCase();
    if (!name || !['webhook', 'slack', 'discord', 'email'].includes(kind)) throw new Error('Alert destination name or type is invalid.');
    const existing = id ? this.db.prepare('SELECT config_encrypted FROM alert_destinations WHERE id = ?').get(id) : null;
    let config = input.config && typeof input.config === 'object' ? input.config : null;
    let encrypted = existing?.config_encrypted || '';
    if (config && Object.keys(config).length) {
      const serialized = JSON.stringify(config);
      if (serialized.length > 64 * 1024 || /\0/.test(serialized)) throw new Error('Alert destination configuration is invalid.');
      encrypted = encrypt(serialized);
    }
    if (!encrypted) throw new Error('Alert destination configuration is required.');
    if (id) {
      const result = this.db.prepare('UPDATE alert_destinations SET name = ?, kind = ?, config_encrypted = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, kind, encrypted, Number(input.enabled !== false), id);
      if (!result.changes) throw new Error('Alert destination not found.');
      return id;
    }
    return Number(this.db.prepare('INSERT INTO alert_destinations (name, kind, config_encrypted, enabled) VALUES (?, ?, ?, ?)').run(name, kind, encrypted, Number(input.enabled !== false)).lastInsertRowid);
  }

  deleteAlertDestination(id) {
    const result = this.db.prepare('DELETE FROM alert_destinations WHERE id = ?').run(Number(id));
    if (!result.changes) throw new Error('Alert destination not found.');
  }

  alertConfig(row) {
    try { return JSON.parse(decrypt(row.config_encrypted)); }
    catch { throw new Error(`Alert destination “${row.name}” has unreadable encrypted settings.`); }
  }

  async sendAlert(row, alert) {
    const config = this.alertConfig(row);
    const title = `[SHAM ${String(alert.severity || 'info').toUpperCase()}] ${alert.title}`;
    const detail = `${alert.detail}\n${alert.site_id ? `Site ID: ${alert.site_id}\n` : ''}Seen: ${alert.last_seen_at || alert.created_at}`;
    if (row.kind === 'email') {
      if (!config.to) throw new Error('Email destination requires a recipient.');
      const message = `To: ${String(config.to).replace(/[\r\n]/g, '')}\nFrom: ${String(config.from || 'sham@localhost').replace(/[\r\n]/g, '')}\nSubject: ${title.replace(/[\r\n]/g, '')}\nContent-Type: text/plain; charset=utf-8\n\n${detail}\n`;
      await runProcess(config.sendmail || process.env.SHAM_SENDMAIL_BIN || 'sendmail', ['-t', '-i'], { timeoutMs: 30_000, stdin: message });
      return;
    }
    const url = String(config.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Webhook destination URL is invalid.');
    let body = { title, detail, severity: alert.severity, siteId: alert.site_id, fingerprint: alert.fingerprint };
    if (row.kind === 'slack') body = { text: `*${title}*\n${detail}` };
    if (row.kind === 'discord') body = { content: `**${title}**\n${detail}`.slice(0, 1900) };
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}.`);
  }

  async testAlertDestination(id) {
    const row = this.db.prepare('SELECT * FROM alert_destinations WHERE id = ?').get(Number(id));
    if (!row) throw new Error('Alert destination not found.');
    await this.sendAlert(row, { severity: 'info', title: 'Test notification', detail: 'SHAM successfully reached this alert destination.', site_id: null, fingerprint: 'test', created_at: new Date().toISOString() });
  }

  async deliverAlerts() {
    const destinations = this.db.prepare('SELECT * FROM alert_destinations WHERE enabled = 1 ORDER BY id').all();
    if (!destinations.length) return;
    const alerts = this.db.prepare('SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY last_seen_at DESC LIMIT 50').all();
    for (const alert of alerts) {
      const stamp = String(alert.last_seen_at || alert.created_at);
      if (this.deliveredAlerts.get(alert.fingerprint) === stamp) continue;
      const results = await Promise.allSettled(destinations.map((row) => this.sendAlert(row, alert)));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) this.manager.log(alert.site_id, 'error', `Could not deliver alert to ${failures.length} destination(s): ${failures[0].reason?.message || failures[0].reason}`);
      if (failures.length < destinations.length) this.deliveredAlerts.set(alert.fingerprint, stamp);
    }
    if (this.deliveredAlerts.size > 1000) {
      for (const key of [...this.deliveredAlerts.keys()].slice(0, this.deliveredAlerts.size - 1000)) this.deliveredAlerts.delete(key);
    }
  }

  async exportTelemetry() {
    if (Date.now() - this.lastTelemetryAt < 60_000) return;
    this.lastTelemetryAt = Date.now();
    const endpoint = this.db.prepare("SELECT value FROM settings WHERE key = 'otel_endpoint'").get()?.value || '';
    if (!endpoint) return;
    let headers = {};
    try { headers = JSON.parse(getSecretSetting(this.db, 'otel_headers', '{}')); } catch { headers = {}; }
    const now = String(BigInt(Date.now()) * 1000000n);
    const metrics = [
      { name: 'sham.running_sites', gauge: { dataPoints: [{ asInt: String(this.manager.running.size), timeUnixNano: now }] } },
      { name: 'sham.process.rss', unit: 'By', gauge: { dataPoints: [{ asInt: String(process.memoryUsage().rss), timeUnixNano: now }] } }
    ];
    const target = endpoint.endsWith('/v1/metrics') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/metrics`;
    const response = await fetch(target, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sham' } }] }, scopeMetrics: [{ metrics }] }] })
    });
    if (!response.ok) throw new Error(`OpenTelemetry endpoint returned HTTP ${response.status}.`);
  }

  async tick() {
    if (this.stopping || this.jobTickPromise) return;
    const operation = (async () => {
      const now = new Date();
      await this.tickJobs(now);
      await this.tickBackup(now);
      await this.cleanupExpiredPreviews();
      await this.deliverAlerts();
      await this.exportTelemetry().catch((error) => this.manager.log(null, 'error', `OpenTelemetry export failed: ${error.message}`));
    })().finally(() => { if (this.jobTickPromise === operation) this.jobTickPromise = null; });
    this.jobTickPromise = operation;
    return operation;
  }

  metricsText(performancePayload) {
    const payload = performancePayload || {};
    const latest = payload.latest || payload.current || {};
    const lines = [
      '# HELP sham_up Whether the SHAM control plane is running.',
      '# TYPE sham_up gauge',
      'sham_up 1',
      '# TYPE sham_running_sites gauge',
      `sham_running_sites ${Number(latest.runningSites ?? this.manager.running.size ?? 0)}`,
      '# TYPE sham_process_rss_bytes gauge',
      `sham_process_rss_bytes ${Number(latest.rssBytes || process.memoryUsage().rss)}`,
      '# TYPE sham_event_loop_milliseconds gauge',
      `sham_event_loop_milliseconds ${Number(latest.eventLoopMs || 0)}`
    ];
    for (const site of this.db.prepare('SELECT id, slug FROM sites ORDER BY id').all()) {
      const status = this.manager.statusFor(site.id);
      const label = String(site.slug).replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`sham_site_up{site_id="${site.id}",site="${label}"} ${status.running ? 1 : 0}`);
      lines.push(`sham_site_websockets{site_id="${site.id}",site="${label}"} ${Number(status.webSockets || 0)}`);
    }
    return `${lines.join('\n')}\n`;
  }

  operationsPayload(siteId = null) {
    return {
      environment: siteId ? this.listEnvironment(siteId) : [],
      databaseProfiles: this.listDatabaseProfiles(siteId),
      jobs: siteId ? this.listJobs(siteId) : [],
      releases: siteId ? this.listReleases(siteId) : [],
      previews: this.listPreviews(siteId),
      backups: this.db.prepare('SELECT id, destination, status, filename, bytes, detail, started_at AS startedAt, finished_at AS finishedAt FROM backup_runs ORDER BY id DESC LIMIT 30').all(),
      backupSettings: this.backupSettings(),
      alertDestinations: this.listAlertDestinations(),
      capabilities: (() => {
        const containerizedSham = fs.existsSync('/.dockerenv');
        const dockerSocketAvailable = fs.existsSync('/var/run/docker.sock');
        const dockerHostPathConfigured = Boolean(String(process.env.SHAM_DOCKER_HOST_DATA_PATH || '').trim());
        const dockerBinaryAvailable = commandAvailable(DOCKER_BIN);
        const docker = dockerBinaryAvailable && (!containerizedSham || (dockerSocketAvailable && dockerHostPathConfigured));
        return {
          docker,
          dockerBinaryAvailable,
          dockerSocketAvailable,
          dockerHostPathConfigured,
          dockerReason: docker ? '' : !dockerBinaryAvailable
            ? 'Docker executable was not found.'
            : containerizedSham && !dockerSocketAvailable
              ? 'The optional Docker socket overlay is not enabled.'
              : 'SHAM_DOCKER_HOST_DATA_PATH is not configured.',
          git: commandAvailable(GIT_BIN),
          anubis: docker && Boolean(ANUBIS_IMAGE),
          anubisImage: ANUBIS_IMAGE,
          containerizedSham
        };
      })()
    };
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.jobTickPromise?.catch(() => {});
    await Promise.allSettled([...this.runningJobs.values()].flatMap((runs) => [...runs]));
    for (const id of [...this.previewRuntimes.keys()]) await this.deletePreview(id).catch(() => {});
    for (const id of [...this.anubisRuntimes.keys()]) await this.stopAnubis(id).catch(() => {});
    await this.backupPromise?.catch(() => {});
  }
}

module.exports = {
  OperationsManager,
  runProcess,
  parseCron,
  cronMatches,
  nextCronDate,
  validateGitUrl,
  validateBranch
};

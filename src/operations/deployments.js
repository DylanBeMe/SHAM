'use strict';

const { ConfigurationOperations } = require('./configuration');
const { applyGitProviderCredentials, providerForRepositoryUrl, providerCommitUrl, normalizeWebhookBaseUrl, ensureProviderWebhook } = require('../git-providers');
const { fs, path, os, http, net, crypto, spawn, express, httpProxy, DATA_DIR, SITES_DIR, RELEASES_DIR, PREVIEWS_DIR, BACKUPS_DIR, SITE_DATA_DIR, DOCKER_BIN, GIT_BIN, TAR_BIN, RESTIC_BIN, AWS_BIN, SFTP_BIN, ANUBIS_IMAGE, JOB_POLL_INTERVAL_MS, JOB_TIMEOUT_MS, BACKUP_TIMEOUT_MS, GIT_TIMEOUT_MS, PREVIEW_TTL_HOURS, HTTP_REQUEST_TIMEOUT_MS, encrypt, decrypt, getSecretSetting, setSecretSetting, safeRelativePath, runtimeEnvironment, buildEnvironment, operatorEnvironment, appendTail, commandAvailable, processOptions, terminate, terminateAndWait, runProcess, runConfiguredCommand, parseField, parseCron, cronMatches, nextCronDate, safeName, pathInside, sftpQuote, freePort, closeServer, siteRoot, requiredFile, ensureRequiredFile, validateGitUrl, validateBranch } = require('./shared');

class DeploymentOperations extends ConfigurationOperations {
  async configureProviderWebhook(site, baseUrl) {
    if (!site?.git_url) return null;
    const provider = providerForRepositoryUrl(site.git_url);
    const origin = normalizeWebhookBaseUrl(baseUrl);
    if (!provider || !origin) return null;
    const secret = this.ensureDeployWebhookSecret(site.id);
    const callbackUrl = new URL(`/api/hooks/deploy/${site.id}`, `${origin}/`).toString();
    return ensureProviderWebhook(this.db, site.git_url, callbackUrl, secret);
  }

  async cloneRepository(site, { url, branch, deployKey = '', installDependencies = false, installCommand = '', buildCommand = '', buildOutputDir = '', deploymentId = null }) {
    const repository = validateGitUrl(url);
    const ref = validateBranch(branch);
    const privateKey = String(deployKey || '');
    if (privateKey.length > 128 * 1024 || privateKey.includes('\0')) throw new Error('Deploy key is too large or invalid.');
    let stage = path.join(SITES_DIR, `${site.directory_name}.git-${crypto.randomUUID()}`);
    const environment = this.siteEnvironment(site.id, 'build');
    let keyPath = '';
    try {
      if (!privateKey) applyGitProviderCredentials(this.db, repository, environment);
      if (privateKey) {
        keyPath = path.join(DATA_DIR, 'tmp', `git-key-${crypto.randomUUID()}`);
        await fs.promises.writeFile(keyPath, privateKey, { mode: 0o600 });
        environment.GIT_SSH_COMMAND = `ssh -i ${JSON.stringify(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
      }
      await runProcess(GIT_BIN, ['clone', '--depth', '1', '--branch', ref, '--single-branch', '--', repository, stage], this.trackedProcessOptions({ timeoutMs: GIT_TIMEOUT_MS, env: environment, environmentMode: 'build', onLine: (level, line) => this.manager.log(site.id, level, `git: ${line}`, { deploymentId }) }));
      const commitSha = (await runProcess(GIT_BIN, ['rev-parse', 'HEAD'], this.trackedProcessOptions({ cwd: stage, timeoutMs: 30_000, env: environment, environmentMode: 'build' }))).output.trim();
      const metadata = (await runProcess(GIT_BIN, ['log', '-1', '--format=%an%x00%s'], this.trackedProcessOptions({ cwd: stage, timeoutMs: 30_000, env: environment, environmentMode: 'build' }))).output.split('\0');
      const commitAuthor = String(metadata[0] || '').trim().slice(0, 200);
      const commitMessage = String(metadata.slice(1).join(' ').trim() || '').slice(0, 500);
      await fs.promises.rm(path.join(stage, '.git'), { recursive: true, force: true });

      const configuredInstall = String(installCommand || site.install_command || '').trim();
      const configuredBuild = String(buildCommand || site.build_command || '').trim();
      const outputDirectory = String(buildOutputDir || site.build_output_dir || '').trim();
      if (configuredInstall) {
        await runConfiguredCommand(configuredInstall, this.trackedProcessOptions({ cwd: stage, timeoutMs: GIT_TIMEOUT_MS, env: environment, environmentMode: 'build', onLine: (level, line) => this.manager.log(site.id, level, `install: ${line}`, { deploymentId }) }));
      } else if (installDependencies && site.runtime_type === 'node') {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        await runProcess(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], this.trackedProcessOptions({ cwd: stage, timeoutMs: GIT_TIMEOUT_MS, env: environment, environmentMode: 'build', onLine: (level, line) => this.manager.log(site.id, level, `npm: ${line}`, { deploymentId }) }));
      }
      if (configuredBuild) {
        await runConfiguredCommand(configuredBuild, this.trackedProcessOptions({ cwd: stage, timeoutMs: GIT_TIMEOUT_MS, env: environment, environmentMode: 'build', onLine: (level, line) => this.manager.log(site.id, level, `build: ${line}`, { deploymentId }) }));
      }
      if (outputDirectory) {
        const output = path.join(stage, ...safeRelativePath(outputDirectory, 'Build output directory').split('/'));
        const stageReal = await fs.promises.realpath(stage);
        const outputReal = await fs.promises.realpath(output).catch(() => '');
        if (!outputReal.startsWith(`${stageReal}${path.sep}`) || !(await fs.promises.stat(outputReal).catch(() => null))?.isDirectory()) throw new Error(`Build output directory “${outputDirectory}” was not produced.`);
        const deployStage = `${stage}.output`;
        await fs.promises.rename(outputReal, deployStage);
        await fs.promises.rm(stage, { recursive: true, force: true });
        stage = deployStage;
      }
      await ensureRequiredFile(site, stage);
      return { stage, repository, ref, commitSha, commitAuthor, commitMessage };
    } catch (error) {
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      if (keyPath) await fs.promises.rm(keyPath, { force: true }).catch(() => {});
    }
  }

  async activateRelease(site, stage, { source, version, commitSha = null, deploymentId = null }) {
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
        this.db.prepare("INSERT INTO site_releases (site_id, version, source, directory_name, commit_sha, deployment_id, status, active) VALUES (?, ?, ?, '', ?, ?, 'active', 1)").run(site.id, version, source, commitSha, deploymentId ? Number(deploymentId) : null);
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

  beginDeployment(siteId, source, ref = '') {
    const result = this.db.prepare("INSERT INTO site_deployments (site_id, source, status, ref) VALUES (?, ?, 'queued', ?)").run(Number(siteId), String(source || 'manual').slice(0, 50), String(ref || '').slice(0, 500));
    return Number(result.lastInsertRowid);
  }

  updateDeploymentStatus(id, status, detail = null) {
    const normalized = String(status || '').trim().toLowerCase();
    const activeStatuses = new Set(['running', 'deployed-with-warning']);
    if (!['queued', 'building', 'running', 'failed', 'rolled-back', 'superseded', 'deployed-with-warning', 'success'].includes(normalized)) throw new Error('Deployment status is invalid.');
    const row = this.db.prepare('SELECT site_id AS siteId FROM site_deployments WHERE id = ?').get(Number(id));
    const transaction = this.db.transaction(() => {
      if (activeStatuses.has(normalized) && row?.siteId) {
        this.db.prepare("UPDATE site_deployments SET status = 'superseded' WHERE site_id = ? AND id != ? AND status IN ('running', 'deployed-with-warning')").run(row.siteId, Number(id));
      }
      if (detail === null) this.db.prepare('UPDATE site_deployments SET status = ? WHERE id = ?').run(normalized, Number(id));
      else this.db.prepare('UPDATE site_deployments SET status = ?, detail = ? WHERE id = ?').run(normalized, String(detail).slice(0, 4000), Number(id));
    });
    transaction();
    if (activeStatuses.has(normalized) && row?.siteId) this.manager.activeDeploymentIds?.set(Number(row.siteId), Number(id));
  }

  finishDeployment(id, status, detail = '', metadata = {}) {
    const row = this.db.prepare('SELECT site_id AS siteId, started_at AS startedAt FROM site_deployments WHERE id = ?').get(Number(id));
    const started = row?.startedAt ? Date.parse(`${String(row.startedAt).replace(' ', 'T')}Z`) : Date.now();
    const duration = Math.max(0, Date.now() - (Number.isFinite(started) ? started : Date.now()));
    const normalizedStatus = String(status || 'failed').slice(0, 30);
    const activeStatuses = new Set(['running', 'deployed-with-warning']);
    const transaction = this.db.transaction(() => {
      if (activeStatuses.has(normalizedStatus) && row?.siteId) this.db.prepare("UPDATE site_deployments SET status = 'superseded' WHERE site_id = ? AND id != ? AND status IN ('running', 'deployed-with-warning')").run(row.siteId, Number(id));
      this.db.prepare(`UPDATE site_deployments SET status = ?, commit_sha = ?, commit_author = ?, commit_message = ?, detail = ?, duration_ms = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        normalizedStatus, String(metadata.commitSha || '').slice(0, 100), String(metadata.commitAuthor || '').slice(0, 200), String(metadata.commitMessage || '').slice(0, 500), String(detail || '').slice(0, 4000), duration, Number(id)
      );
    });
    transaction();
    if (activeStatuses.has(normalizedStatus) && row?.siteId) this.manager.activeDeploymentIds?.set(Number(row.siteId), Number(id));
  }

  recordDeployment(siteId, { source = 'manual', status = 'running', ref = '', detail = '', commitSha = '', commitAuthor = '', commitMessage = '' } = {}) {
    const id = this.beginDeployment(siteId, source, ref);
    this.finishDeployment(id, status, detail, { commitSha, commitAuthor, commitMessage });
    return id;
  }

  listDeployments(siteId, limit = 50) {
    const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const site = this.manager.getSite(Number(siteId));
    return this.db.prepare(`SELECT d.id, d.source, d.status, d.ref, d.commit_sha AS commitSha, d.commit_author AS commitAuthor, d.commit_message AS commitMessage, d.detail, d.started_at AS startedAt, d.finished_at AS finishedAt, d.duration_ms AS durationMs,
      (SELECT r.id FROM site_releases r WHERE r.site_id = d.site_id AND r.active = 0 AND (r.deployment_id = d.id OR (r.deployment_id IS NULL AND d.commit_sha <> '' AND r.commit_sha = d.commit_sha)) ORDER BY r.deployment_id = d.id DESC, r.id DESC LIMIT 1) AS releaseId,
      EXISTS(SELECT 1 FROM site_releases active WHERE active.site_id = d.site_id AND active.active = 1 AND (active.deployment_id = d.id OR (active.deployment_id IS NULL AND d.commit_sha <> '' AND active.commit_sha = d.commit_sha))) AS activeRelease,
      (SELECT COUNT(*) FROM runtime_logs logs WHERE logs.deployment_id = d.id) AS logCount
      FROM site_deployments d WHERE d.site_id = ? ORDER BY d.id DESC LIMIT ?`).all(Number(siteId), bounded)
      .map((row) => ({ ...row, activeRelease: Boolean(row.activeRelease), commitUrl: site?.git_url ? providerCommitUrl(site.git_url, row.commitSha) : '' }));
  }

  deploymentLogs(siteId, deploymentId, limit = 500) {
    const bounded = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    this.manager.flushRuntimeLogs?.();
    return this.db.prepare(`SELECT id, level, message, context_json AS contextJson, created_at AS createdAt FROM runtime_logs WHERE site_id = ? AND deployment_id = ? ORDER BY id ASC LIMIT ?`).all(Number(siteId), Number(deploymentId), bounded)
      .map((row) => ({ ...row, context: (() => { try { return JSON.parse(row.contextJson || 'null'); } catch { return null; } })(), contextJson: undefined }));
  }

  async deployGit(site, input) {
    const deploymentId = this.beginDeployment(site.id, 'git', input.branch || site.git_branch || 'main');
    const previousDeploymentId = this.manager.activeDeploymentIds?.get(Number(site.id)) || null;
    this.manager.log(site.id, 'info', 'Deployment queued.', { deploymentId });
    try {
      this.updateDeploymentStatus(deploymentId, 'building', 'Cloning repository and running the configured build pipeline.');
      const cloned = await this.cloneRepository(site, { ...input, deploymentId });
      const version = `${safeName(cloned.ref)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
      this.manager.log(site.id, 'info', `Build completed for ${cloned.commitSha.slice(0, 9)}; activating release.`, { deploymentId });
      // Runtime stop/start output during activation belongs to the deployment being activated,
      // not the previously-active release.
      this.manager.activeDeploymentIds?.set(Number(site.id), deploymentId);
      const release = await this.activateRelease(site, cloned.stage, { source: 'git', version, commitSha: cloned.commitSha, deploymentId });
      let warning = null;
      try {
        this.db.prepare('UPDATE sites SET git_url = ?, git_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(cloned.repository, cloned.ref, site.id);
        this.finishDeployment(deploymentId, 'running', 'Git deployment is the active release.', cloned);
      } catch (error) {
        warning = `Release activated, but SHAM could not finalize all deployment metadata: ${error.message}`;
        this.manager.activeDeploymentIds?.set(Number(site.id), deploymentId);
        try { this.finishDeployment(deploymentId, 'deployed-with-warning', warning, cloned); }
        catch (historyError) { this.manager.log(site.id, 'error', `Could not persist deployment warning state: ${historyError.message}`, { deploymentId }); }
        this.manager.log(site.id, 'error', warning, { deploymentId });
      }
      this.manager.log(site.id, 'info', warning ? 'Deployment activated with a metadata warning.' : 'Deployment activated successfully.', { deploymentId });
      return { ...release, deploymentId, commitAuthor: cloned.commitAuthor, commitMessage: cloned.commitMessage, commitUrl: providerCommitUrl(cloned.repository, cloned.commitSha), warning };
    } catch (error) {
      try { this.finishDeployment(deploymentId, 'failed', error.message); }
      catch (historyError) { this.manager.log(site.id, 'error', `Could not persist failed deployment state: ${historyError.message}`, { deploymentId }); }
      this.manager.log(site.id, 'error', `Deployment failed: ${error.message}`, { deploymentId });
      if (previousDeploymentId) this.manager.activeDeploymentIds?.set(Number(site.id), previousDeploymentId);
      else this.manager.activeDeploymentIds?.delete(Number(site.id));
      throw error;
    }
  }

  listReleases(siteId) {
    return this.db.prepare('SELECT id, version, source, commit_sha AS commitSha, deployment_id AS deploymentId, status, active, created_at AS createdAt FROM site_releases WHERE site_id = ? ORDER BY active DESC, id DESC').all(siteId)
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
      let historyWarning = null;
      try {
        const currentDeployment = this.db.prepare("SELECT id FROM site_deployments WHERE site_id = ? AND status IN ('running', 'deployed-with-warning') ORDER BY id DESC LIMIT 1").get(site.id);
        let activatedDeployment = selected.deployment_id
          ? this.db.prepare('SELECT id FROM site_deployments WHERE site_id = ? AND id = ?').get(site.id, selected.deployment_id)
          : null;
        if (!activatedDeployment && selected.commit_sha) activatedDeployment = this.db.prepare('SELECT id FROM site_deployments WHERE site_id = ? AND commit_sha = ? AND id != COALESCE(?, 0) ORDER BY id DESC LIMIT 1').get(site.id, selected.commit_sha, currentDeployment?.id || 0);
        if (activatedDeployment) this.manager.activeDeploymentIds?.set(Number(site.id), Number(activatedDeployment.id));
        if (currentDeployment) this.db.prepare("UPDATE site_deployments SET status = 'rolled-back' WHERE id = ?").run(currentDeployment.id);
        if (activatedDeployment) {
          this.updateDeploymentStatus(activatedDeployment.id, 'running', 'This deployment was reactivated by rollback.');
        } else {
          const rollbackDeploymentId = this.recordDeployment(site.id, { source: 'rollback', status: 'running', ref: String(selected.id), detail: `Rollback activated release ${selected.version}.`, commitSha: selected.commit_sha || '' });
          this.manager.activeDeploymentIds?.set(Number(site.id), rollbackDeploymentId);
        }
      } catch (historyError) {
        historyWarning = `Release rollback is active, but SHAM could not finalize deployment history: ${historyError.message}`;
        this.manager.log(site.id, 'error', historyWarning);
      }
      return { releases: this.listReleases(site.id), warning: historyWarning };
    } catch (error) {
      if (!metadataCommitted) {
        await this.manager.stop(site.id).catch(() => {});
        await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
        if (currentMoved) await fs.promises.rename(currentArchive, root).catch(() => {});
        if (wasRunning || site.enabled) await this.manager.start(site.id).catch((restartError) => this.manager.log(site.id, 'error', `Rollback recovery failed: ${restartError.message}`));
      }
      throw error;
    }
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
      if (site.runtime_type === 'proxy') throw new Error('Preview copies are not available for reverse-proxy sites.');
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
      runtime.hostname = previewHostname;
      runtime.expiresAt = expires;
      this.previewRuntimes.set(id, runtime);
      this.previewHostnames.set(previewHostname, id);
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
    const key = String(hostname || '').trim().toLowerCase();
    const id = this.previewHostnames.get(key);
    const runtime = id && this.previewRuntimes.get(id);
    if (!runtime) { if (id) this.previewHostnames.delete(key); return null; }
    if (Date.parse(runtime.expiresAt || '') <= Date.now()) return null;
    return { preview: true, id, hostname: key, target: runtime.target };
  }

  async deletePreview(id, expectedSiteId = null) {
    const numericId = Number(id);
    const numericSiteId = expectedSiteId == null ? null : Number(expectedSiteId);
    const row = numericSiteId == null
      ? this.db.prepare('SELECT * FROM preview_deployments WHERE id = ?').get(numericId)
      : this.db.prepare('SELECT * FROM preview_deployments WHERE id = ? AND site_id = ?').get(numericId, numericSiteId);
    if (!row) throw new Error('Preview not found.');
    const runtime = this.previewRuntimes.get(row.id);
    if (runtime?.server) await closeServer(runtime.server);
    if (runtime?.child) await terminateAndWait(runtime.child);
    this.previewRuntimes.delete(row.id);
    this.previewHostnames.delete(String(row.hostname || '').toLowerCase());
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
    }).catch(async (error) => { terminate(child); await runProcess(DOCKER_BIN, ['rm', '-f', `sham-anubis-${site.id}`], this.trackedProcessOptions({ timeoutMs: 10_000 })).catch(() => {}); throw error; });
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
    await runProcess(DOCKER_BIN, ['rm', '-f', `sham-anubis-${siteId}`], this.trackedProcessOptions({ timeoutMs: 15_000 })).catch(() => {});
  }

  async afterSiteStart(site) {
    if (site.anubis_enabled) await this.startAnubis(site);
  }

  async beforeSiteStop(site) {
    await this.stopAnubis(site.id);
  }

}

module.exports = { DeploymentOperations };

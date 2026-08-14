'use strict';

const path = require('node:path');
const { SITES_DIR, RELEASES_DIR, DATA_DIR } = require('./config');

function safeReleaseDirectory(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  if (path.basename(name) !== name || !/^release-[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('Active release directory metadata is invalid.');
  }
  return name;
}

function legacySiteRoot(site) {
  return path.join(SITES_DIR, String(site?.directory_name || ''));
}

function siteRoot(site) {
  const release = safeReleaseDirectory(site?.active_release_directory);
  if (release && Number(site?.id) > 0) return path.join(RELEASES_DIR, String(Number(site.id)), release);
  return legacySiteRoot(site);
}

function dockerHostDataPath(localPath) {
  const hostData = String(process.env.SHAM_DOCKER_HOST_DATA_PATH || '').trim();
  if (!hostData) return '';
  const absolute = path.resolve(localPath);
  const relative = path.relative(DATA_DIR, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Managed runtime path is outside SHAM data storage.');
  return path.join(path.resolve(hostData), relative);
}

module.exports = { safeReleaseDirectory, legacySiteRoot, siteRoot, dockerHostDataPath };

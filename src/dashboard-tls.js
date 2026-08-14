'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function dashboardCertificateHosts(bindHost, interfaces = os.networkInterfaces()) {
  const dns = new Set(['localhost']);
  const ips = new Set(['127.0.0.1', '::1']);
  const configured = String(bindHost || '').trim();
  if (configured && !['0.0.0.0', '::'].includes(configured)) {
    if (net.isIP(configured)) ips.add(configured);
    else if (/^[A-Za-z0-9.-]+$/.test(configured)) dns.add(configured.toLowerCase());
  }
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      const address = String(entry?.address || '').split('%')[0];
      if (address && net.isIP(address) && !entry.internal) ips.add(address);
    }
  }
  return { dns: [...dns].sort(), ips: [...ips].sort() };
}

function certificateCovers(certPath, hosts) {
  try {
    const certificate = new crypto.X509Certificate(fs.readFileSync(certPath));
    return hosts.dns.every((host) => certificate.checkHost(host))
      && hosts.ips.every((ip) => certificate.checkIP(ip));
  } catch {
    return false;
  }
}

function dashboardTlsOptions({ dataDir, bindHost, opensslBin = 'openssl' }) {
  const directory = path.join(dataDir, 'dashboard-tls');
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  const hosts = dashboardCertificateHosts(bindHost);
  const usable = fs.existsSync(keyPath) && fs.existsSync(certPath) && certificateCovers(certPath, hosts);

  if (!usable) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const temporaryKey = path.join(directory, `key.${suffix}.tmp`);
    const temporaryCert = path.join(directory, `cert.${suffix}.tmp`);
    const subjectAltName = [
      ...hosts.dns.map((host) => `DNS:${host}`),
      ...hosts.ips.map((ip) => `IP:${ip}`)
    ].join(',');
    try {
      execFileSync(opensslBin, [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '365',
        '-keyout', temporaryKey, '-out', temporaryCert,
        '-subj', '/CN=SHAM local dashboard',
        '-addext', `subjectAltName=${subjectAltName}`
      ], { stdio: 'pipe' });
      fs.chmodSync(temporaryKey, 0o600);
      fs.chmodSync(temporaryCert, 0o600);
      fs.renameSync(temporaryKey, keyPath);
      fs.renameSync(temporaryCert, certPath);
    } catch (error) {
      try { fs.rmSync(temporaryKey, { force: true }); } catch { /* Best effort. */ }
      try { fs.rmSync(temporaryCert, { force: true }); } catch { /* Best effort. */ }
      const detail = String(error?.stderr || error?.message || '').trim();
      throw new Error(`Could not generate the local dashboard certificate with ${opensslBin}.${detail ? ` ${detail}` : ''}`);
    }
  }

  try {
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(certPath, 0o600);
  } catch { /* Best effort on non-POSIX filesystems. */ }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), hosts };
}

module.exports = { dashboardCertificateHosts, certificateCovers, dashboardTlsOptions };

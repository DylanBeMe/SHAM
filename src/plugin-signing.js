const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function walk(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Plugin packages may not contain symbolic links.');
    if (entry.isDirectory()) walk(root, absolute, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll('\\', '/'));
  }
  return files;
}

function pluginDigest(root, manifest) {
  const unsignedManifest = { ...manifest };
  delete unsignedManifest.signature;
  const hash = crypto.createHash('sha256');
  hash.update('SHAM-PLUGIN-SIGNATURE-V1\0');
  hash.update(canonical(unsignedManifest));
  for (const relative of walk(root).filter((name) => name !== 'plugin.json')) {
    const data = fs.readFileSync(path.join(root, ...relative.split('/')));
    hash.update('\0');
    hash.update(relative);
    hash.update('\0');
    hash.update(crypto.createHash('sha256').update(data).digest());
  }
  return hash.digest();
}

function normalizeTrustedKeys(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 100).map((entry) => ({
    id: String(entry?.id || '').trim().slice(0, 100),
    name: String(entry?.name || entry?.id || '').trim().slice(0, 100),
    publicKey: String(entry?.publicKey || '').trim()
  })).filter((entry) => entry.id && entry.publicKey);
}

function verifyPluginSignature(root, manifest, trustedKeys) {
  const signature = manifest?.signature;
  if (!signature) return { status: 'unsigned', keyId: null, signer: null };
  if (signature.algorithm !== 'ed25519') throw new Error('Only Ed25519 plugin signatures are supported.');
  const key = normalizeTrustedKeys(trustedKeys).find((entry) => entry.id === String(signature.keyId || ''));
  if (!key) throw new Error(`Plugin signature key “${String(signature.keyId || '')}” is not trusted by this SHAM instance.`);
  let publicKey;
  try { publicKey = crypto.createPublicKey(key.publicKey); }
  catch { throw new Error(`Trusted plugin key “${key.id}” is not a valid public key.`); }
  const value = Buffer.from(String(signature.value || ''), 'base64url');
  if (!value.length || !crypto.verify(null, pluginDigest(root, manifest), publicKey, value)) {
    throw new Error('Plugin signature verification failed. The archive may be modified or signed by a different key.');
  }
  return { status: 'verified', keyId: key.id, signer: key.name || key.id };
}

module.exports = { canonical, pluginDigest, normalizeTrustedKeys, verifyPluginSignature };

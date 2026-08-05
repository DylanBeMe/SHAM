const fs = require('node:fs');
const path = require('node:path');
const { safeRelativePath } = require('./validation');

const MAX_PLUGIN_FILES = 500;
const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;


async function validatePluginArchiveFile(source, originalName = '') {
  if (!source) throw new Error('Choose a plugin ZIP archive.');
  if (!/\.zip$/i.test(String(originalName || ''))) {
    throw new Error('Plugin archives must use the .zip file extension.');
  }
  const handle = await fs.promises.open(source, 'r');
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const isZip = bytesRead >= 4
      && signature[0] === 0x50
      && signature[1] === 0x4b
      && ((signature[2] === 0x03 && signature[3] === 0x04)
        || (signature[2] === 0x05 && signature[3] === 0x06)
        || (signature[2] === 0x07 && signature[3] === 0x08));
    if (!isZip) throw new Error('The selected file is not a valid ZIP archive.');
  } finally {
    await handle.close();
  }
}

function stripTopDirectory(names) {
  const parts = names.map((name) => name.replaceAll('\\', '/').split('/'));
  if (!parts.length || parts.some((item) => item.length < 2)) return '';
  const first = parts[0][0];
  return parts.every((item) => item[0] === first) ? `${first}/` : '';
}

function extractPlugin(source, destination) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(source);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (!entries.length) throw new Error('The plugin archive is empty.');
  if (entries.length > MAX_PLUGIN_FILES) throw new Error(`Plugins may contain at most ${MAX_PLUGIN_FILES} files.`);
  const strip = stripTopDirectory(entries.map((entry) => entry.entryName));
  const seen = new Set();
  let total = 0;

  for (const entry of entries) {
    const declaredSize = Number(entry.header?.size || 0);
    const compressedSize = Number(entry.header?.compressedSize || 0);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) throw new Error('Plugin ZIP entry has an invalid size.');
    if (compressedSize > 0 && declaredSize > 1024 * 1024 && declaredSize / compressedSize > 1000) {
      throw new Error('Plugin ZIP entry has an unsafe compression ratio.');
    }
    total += declaredSize;
    if (total > MAX_PLUGIN_BYTES) throw new Error('The uncompressed plugin exceeds 20 MB.');

    const original = entry.entryName.replaceAll('\\', '/');
    const relative = safeRelativePath(strip && original.startsWith(strip) ? original.slice(strip.length) : original, 'Plugin file path');
    if (seen.has(relative)) throw new Error(`The plugin contains a duplicate path: ${relative}`);
    seen.add(relative);

    const output = path.resolve(destination, ...relative.split('/'));
    if (!output.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new Error('Plugin contains an unsafe path.');
    const data = entry.getData();
    if (data.length !== declaredSize) throw new Error(`Could not validate plugin ZIP entry: ${relative}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, data, { mode: 0o644 });
  }
}

module.exports = { extractPlugin, stripTopDirectory, validatePluginArchiveFile, MAX_PLUGIN_FILES, MAX_PLUGIN_BYTES };

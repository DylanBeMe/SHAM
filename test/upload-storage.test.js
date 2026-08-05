const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { CappedDiskStorage } = require('../src/upload-storage');

function store(storage, req, content) {
  return new Promise((resolve, reject) => {
    storage._handleFile(req, { stream: Readable.from([Buffer.from(content)]) }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

test('disk upload storage streams files and enforces the aggregate request limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-storage-'));
  const storage = new CappedDiskStorage(root, 6);
  const request = {};
  try {
    const first = await store(storage, request, '1234');
    assert.equal(fs.readFileSync(first.path, 'utf8'), '1234');
    await assert.rejects(() => store(storage, request, '5678'), /size limit/);
    assert.equal(request.shamUploadBytes, 8);
    assert.deepEqual(fs.readdirSync(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

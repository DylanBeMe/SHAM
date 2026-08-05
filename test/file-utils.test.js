const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'sham-files-'));
process.env.SHAM_DATA_PATH = temporaryData;

const {
  listSiteFiles,
  readTextFile,
  writeTextFile,
  replaceSingleFile,
  deleteSingleFile,
  stageSingleFileDeletion,
  listSiteFilesAsync,
  readTextFileAsync,
  writeTextFileAsync,
  replaceSingleFileFromPathAsync,
  deleteSingleFileAsync,
  siteRoot
} = require('../src/file-utils');

const site = { directory_name: 'site-test' };

test.after(() => fs.rmSync(temporaryData, { recursive: true, force: true }));

test('file browser writes, reads, replaces, lists, and deletes one file', () => {
  fs.mkdirSync(siteRoot(site), { recursive: true });
  writeTextFile(site, 'docs/readme.txt', 'hello');
  assert.equal(readTextFile(site, 'docs/readme.txt').content, 'hello');

  replaceSingleFile(site, 'docs/readme.txt', Buffer.from('updated'));
  assert.equal(readTextFile(site, 'docs/readme.txt').content, 'updated');
  assert.deepEqual(listSiteFiles(site).map((file) => file.path), ['docs/readme.txt']);

  deleteSingleFile(site, 'docs/readme.txt');
  assert.deepEqual(listSiteFiles(site), []);
});

test('file editor rejects traversal, reserved folders, and non-text documents', () => {
  assert.throws(() => writeTextFile(site, '../escape.txt', 'no'));
  assert.throws(() => writeTextFile(site, 'node_modules/package/index.js', 'no'), /not editable/);
  assert.throws(() => writeTextFile(site, '.sham/dependency-state.json', '{}'), /not editable/);
  assert.throws(() => writeTextFile(site, 'vendor/node_modules/package/index.js', 'no'), /not editable/);
  assert.throws(() => writeTextFile(site, 'Vendor/NODE_MODULES/package/index.js', 'no'), /not editable/);

  replaceSingleFile(site, 'binary.bin', Buffer.from([1, 0, 2]));
  assert.throws(() => readTextFile(site, 'binary.bin'), /binary/);
  replaceSingleFile(site, 'invalid-utf8.txt', Buffer.from([0xc3, 0x28]));
  assert.throws(() => readTextFile(site, 'invalid-utf8.txt'), /UTF-8/);
});


test('staged deletion can roll back a critical file before commit', () => {
  writeTextFile(site, 'server.js', 'console.log(1)');
  const deletion = stageSingleFileDeletion(site, 'server.js');
  assert.throws(() => readTextFile(site, 'server.js'), /not found/i);
  deletion.rollback();
  assert.equal(readTextFile(site, 'server.js').content, 'console.log(1)');

  const committed = stageSingleFileDeletion(site, 'server.js');
  committed.commit();
  assert.throws(() => readTextFile(site, 'server.js'), /not found/i);
});

test('async file operations preserve editor behavior without synchronous route I/O', async () => {
  const source = path.join(temporaryData, 'replacement.txt');
  fs.writeFileSync(source, 'replacement');
  await writeTextFileAsync(site, 'async/document.txt', 'hello async');
  assert.equal((await readTextFileAsync(site, 'async/document.txt')).content, 'hello async');
  await replaceSingleFileFromPathAsync(site, 'async/document.txt', source, fs.statSync(source).size);
  assert.equal((await readTextFileAsync(site, 'async/document.txt')).content, 'replacement');
  assert.deepEqual((await listSiteFilesAsync(site)).map((file) => file.path).filter((item) => item.startsWith('async/')), ['async/document.txt']);
  await deleteSingleFileAsync(site, 'async/document.txt');
  await assert.rejects(() => readTextFileAsync(site, 'async/document.txt'), /not found/i);
});

test('async file listing tolerates files disappearing during a scan', async () => {
  await writeTextFileAsync(site, 'volatile/keep.txt', 'keep');
  await writeTextFileAsync(site, 'volatile/disappear.txt', 'gone');
  const disappearing = path.join(siteRoot(site), 'volatile', 'disappear.txt');
  const originalLstat = fs.promises.lstat;
  fs.promises.lstat = async function patchedLstat(target, ...args) {
    if (path.resolve(target) === path.resolve(disappearing)) {
      const error = new Error('removed during scan');
      error.code = 'ENOENT';
      throw error;
    }
    return originalLstat.call(this, target, ...args);
  };
  try {
    const files = await listSiteFilesAsync(site);
    assert.ok(files.some((file) => file.path === 'volatile/keep.txt'));
    assert.ok(!files.some((file) => file.path === 'volatile/disappear.txt'));
  } finally {
    fs.promises.lstat = originalLstat;
    await fs.promises.rm(path.join(siteRoot(site), 'volatile'), { recursive: true, force: true });
  }
});

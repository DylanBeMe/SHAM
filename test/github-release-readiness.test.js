const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('public release metadata is coherent for SHAM 1.0.0', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.0.0');
  assert.equal(pkg.license, 'GPL-3.0-or-later');
  assert.equal(pkg.private, true);
  assert.match(read('README.md'), /Current release: 1\.0\.0/);
  assert.match(read('CHANGELOG.md'), /## \[1\.0\.0\] — 2026-08-05/);
  assert.doesNotMatch(read('README.md'), /3\.1\.1|3\.1\.0/);
  assert.doesNotMatch(read('public/index.html'), /3\.1\.1|3\.1\.0/);
});

test('GitHub CI and GHCR release workflows enforce validation and narrow permissions', () => {
  const ci = read('.github/workflows/ci.yml');
  const docker = read('.github/workflows/docker-publish.yml');
  const release = read('.github/workflows/release.yml');
  assert.match(ci, /permissions:\n  contents: read/);
  assert.match(ci, /npm run release:check/);
  assert.match(ci, /npm audit --omit=dev --audit-level=high/);
  assert.match(ci, /Docker smoke build/);
  assert.match(docker, /REGISTRY: ghcr\.io/);
  assert.match(docker, /packages: write/);
  assert.match(docker, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(docker, /sbom: true/);
  assert.match(docker, /provenance: mode=max/);
  assert.match(release, /Tag \$GITHUB_REF_NAME does not match package\.json version/);
  assert.match(release, /gh release create/);
  assert.match(release, /sha256sum/);
  assert.match(release, /--exclude 'data\/'/);
  assert.match(release, /data\/sites\/\.gitkeep/);
  assert.match(release, /data\/plugins\/\.gitkeep/);
});

test('release documentation and repository policy files are present', () => {
  for (const filename of [
    'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'RELEASING.md', 'CHANGELOG.md',
    '.github/dependabot.yml', '.github/pull_request_template.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml'
  ]) assert.equal(fs.existsSync(path.join(root, filename)), true, filename);
  assert.match(read('RELEASING.md'), /ghcr\.io\/<owner>\/<repository>:1\.0\.0/);
  assert.match(read('SECURITY.md'), /private vulnerability reporting/);
});

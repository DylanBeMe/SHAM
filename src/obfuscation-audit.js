const fs = require('node:fs');
const { listSiteFilesAsync, resolveSitePathAsync } = require('./file-utils');

const MAX_SCAN_FILES = 750;
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_WARNINGS = 200;

const CHECKS = [
  {
    id: 'eval',
    severity: 'high',
    pattern: /\beval\s*\(/g,
    message: 'Uses eval(), which can depend on identifier names or dynamically generated source.'
  },
  {
    id: 'function-constructor',
    severity: 'high',
    pattern: /\b(?:new\s+)?Function\s*\(/g,
    message: 'Uses the Function constructor, which can depend on dynamically generated source.'
  },
  {
    id: 'string-timer',
    severity: 'high',
    pattern: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/g,
    message: 'Uses a string timer. Renamed identifiers inside the string cannot be updated safely.'
  },
  {
    id: 'function-source',
    severity: 'medium',
    pattern: /(?:\.toString\s*\(\s*\)|Function\.prototype\.toString)/g,
    message: 'Reads function source text. Transformation changes that text and can affect reflection-based code.'
  },
  {
    id: 'name-reflection',
    severity: 'medium',
    pattern: /\.(?:name|displayName)\b/g,
    message: 'Reads function or class names. SHAM preserves names where possible, but generated/minified code can still differ.'
  },
  {
    id: 'dynamic-global',
    severity: 'medium',
    pattern: /\b(?:window|globalThis|self)\s*\[[^\]]+\]/g,
    message: 'Looks up globals dynamically. String-based global references cannot be proven compatible.'
  },
  {
    id: 'inline-handler',
    severity: 'medium',
    pattern: /\bon(?:click|change|input|submit|load|error|focus|blur|keydown|keyup)\s*=\s*['"]/gi,
    message: 'Contains an inline HTML event handler. Functions called by name must remain globally accessible.'
  },
  {
    id: 'with-statement',
    severity: 'medium',
    pattern: /\bwith\s*\(/g,
    message: 'Uses a with statement, which makes identifier resolution difficult to transform safely.'
  },
  {
    id: 'source-map',
    severity: 'low',
    pattern: /[#@]\s*sourceMappingURL\s*=/g,
    message: 'References a source map. The served transformed output will not match the original source map.'
  }
];

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineNumber(starts, index) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= index) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function summarizeRisk(warnings, skippedFiles) {
  if (warnings.some((item) => item.severity === 'high')) return 'high';
  if (warnings.some((item) => item.severity === 'medium') || skippedFiles.length) return 'medium';
  if (warnings.length) return 'low';
  return 'low';
}

async function auditObfuscationCompatibility(site) {
  const files = await listSiteFilesAsync(site, 5000);
  const allCandidates = files.filter((file) => /\.(?:js|mjs|cjs|html?)$/i.test(file.path));
  const candidates = allCandidates.slice(0, MAX_SCAN_FILES);
  const warnings = [];
  const skippedFiles = allCandidates.slice(MAX_SCAN_FILES).map((file) => ({ path: file.path, reason: `more than ${MAX_SCAN_FILES} candidate files` }));
  let scannedBytes = 0;
  let scannedFiles = 0;

  for (const file of candidates) {
    if (warnings.length >= MAX_WARNINGS) break;
    if (file.size > MAX_SCAN_FILE_BYTES) {
      skippedFiles.push({ path: file.path, reason: `larger than ${Math.round(MAX_SCAN_FILE_BYTES / 1024 / 1024)} MB` });
      continue;
    }
    if (scannedBytes + file.size > MAX_SCAN_TOTAL_BYTES) {
      skippedFiles.push({ path: file.path, reason: 'project scan byte limit reached' });
      continue;
    }

    let absolute;
    let source;
    try {
      ({ absolute } = await resolveSitePathAsync(site, file.path));
      const stat = await fs.promises.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('not a regular file'), { code: 'EINVAL' });
      source = await fs.promises.readFile(absolute, 'utf8');
    }
    catch (error) {
      skippedFiles.push({ path: file.path, reason: error.code === 'ENOENT' ? 'file changed during scan' : 'could not be read' });
      continue;
    }
    scannedBytes += Buffer.byteLength(source, 'utf8');
    scannedFiles += 1;
    const starts = lineStarts(source);

    for (const check of CHECKS) {
      check.pattern.lastIndex = 0;
      let match;
      while ((match = check.pattern.exec(source)) && warnings.length < MAX_WARNINGS) {
        warnings.push({
          id: check.id,
          severity: check.severity,
          path: file.path,
          line: lineNumber(starts, match.index),
          message: check.message
        });
        if (match[0].length === 0) check.pattern.lastIndex += 1;
      }
    }
  }

  return {
    risk: summarizeRisk(warnings, skippedFiles),
    compatible: warnings.every((item) => item.severity === 'low') && skippedFiles.length === 0,
    scannedFiles,
    scannedBytes,
    candidateFiles: allCandidates.length,
    warningCount: warnings.length,
    truncated: warnings.length >= MAX_WARNINGS,
    warnings,
    skippedFiles: skippedFiles.slice(0, 50),
    note: 'Static analysis cannot prove runtime compatibility. SHAM uses compatibility-oriented Terser settings and falls back to the original asset when transformation itself fails.'
  };
}

module.exports = {
  auditObfuscationCompatibility,
  MAX_SCAN_FILES,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_TOTAL_BYTES,
  MAX_WARNINGS
};

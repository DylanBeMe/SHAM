'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const virtualGroups = {
  'src/server.js': [
    'src/server.js',
    'src/routes/sites.js',
    'src/routes/admin.js',
    'src/routes/operations.js'
  ],
  'src/site-manager.js': [
    'src/site-manager.js',
    'src/sites/shared.js',
    'src/sites/core.js',
    'src/sites/delivery.js',
    'src/sites/runtime.js'
  ],
  'src/operations-manager.js': [
    'src/operations-manager.js',
    'src/operations/shared.js',
    'src/operations/configuration.js',
    'src/operations/deployments.js',
    'src/operations/observability.js'
  ],
  'public/app.js': [
    'public/app.js',
    'public/js/core.js',
    'public/js/dashboard.js',
    'public/js/sites.js',
    'public/js/site-workspace.js',
    'public/js/file-manager.js',
    'public/js/activity.js',
    'public/js/plugins.js',
    'public/js/admin.js',
    'public/js/operations.js',
    'public/js/appearance.js',
    'public/js/performance.js',
    'public/js/security.js'
  ]
};

function source(file) {
  const files = virtualGroups[file] || [file];
  return files.map((item) => fs.readFileSync(path.join(root, item), 'utf8')).join('\n');
}

module.exports = { root, source };

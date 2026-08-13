'use strict';

const { SiteManager } = require('./sites/runtime');
const { hydrateSite, realFileInside } = require('./sites/shared');

module.exports = { SiteManager, hydrateSite, realFileInside };

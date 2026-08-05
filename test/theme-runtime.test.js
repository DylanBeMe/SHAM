const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme-init.js'), 'utf8');

function bootTheme({ stored = null, failWrites = false } = {}) {
  const properties = new Map();
  const root = {
    dataset: {},
    style: {
      colorScheme: '',
      setProperty(name, value) { properties.set(name, value); },
      removeProperty(name) { properties.delete(name); }
    }
  };
  const meta = { content: '' };
  const storage = {
    value: stored,
    getItem() { return this.value; },
    setItem(_key, value) {
      if (failWrites) throw new Error('storage unavailable');
      this.value = value;
    },
    removeItem() {
      if (failWrites) throw new Error('storage unavailable');
      this.value = null;
    }
  };
  const context = {
    window: {},
    document: {
      documentElement: root,
      querySelector(selector) { return selector === 'meta[name="theme-color"]' ? meta : null; }
    },
    localStorage: storage,
    JSON,
    Math,
    Number,
    Object,
    String
  };
  vm.runInNewContext(source, context, { filename: 'theme-init.js' });
  return { theme: context.window.SHAM_THEME, root, meta, properties, storage };
}

test('invalid stored custom themes fail closed to the purple default', () => {
  const stored = JSON.stringify({
    name: 'custom',
    custom: { accent: '#ffffff', accentSecondary: '#ffffff', background: '#ffffff', panel: '#ffffff', text: '#ffffff', radius: 18 }
  });
  const runtime = bootTheme({ stored });
  assert.equal(runtime.theme.get().name, 'purple');
  assert.equal(runtime.root.dataset.theme, 'purple');
  assert.equal(runtime.meta.content, '#0c0717');
});

test('theme state remains coherent when browser storage is unavailable', () => {
  const runtime = bootTheme({ failWrites: true });
  const saved = runtime.theme.save({
    name: 'custom',
    custom: { accent: '#a970ff', accentSecondary: '#d7a7ff', background: '#0c0717', panel: '#1d1230', text: '#f7f2ff', radius: 20 }
  });
  assert.equal(saved, false);
  assert.equal(runtime.theme.get().name, 'custom');
  assert.equal(runtime.root.dataset.theme, 'custom');
  assert.equal(runtime.root.style.colorScheme, 'dark');
  assert.equal(runtime.properties.get('--radius'), '20px');

  const reset = runtime.theme.reset();
  assert.equal(reset, false);
  assert.equal(runtime.theme.get().name, 'purple');
  assert.equal(runtime.root.dataset.theme, 'purple');
});

test('custom themes reject an unreadable secondary accent', () => {
  const runtime = bootTheme();
  const custom = { ...runtime.theme.defaults.custom, accentSecondary: runtime.theme.defaults.custom.background };
  const result = runtime.theme.validateCustom(custom);
  assert.equal(result.valid, false);
  assert.match(result.message, /secondary accent/i);
});

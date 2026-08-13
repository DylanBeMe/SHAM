'use strict';

(() => {
  const STORAGE_KEY = 'sham-theme-v1';
  const MODES = new Set(['system', 'light', 'dark']);
  const THEMES = new Set(['purple', 'midnight', 'emerald', 'custom']);
  const defaults = {
    name: 'purple',
    mode: 'system',
    custom: {
      accent: '#a970ff',
      accentSecondary: '#d7a7ff',
      background: '#0c0717',
      panel: '#1d1230',
      text: '#f7f2ff',
      radius: 18
    }
  };
  const palettes = {
    dark: {
      purple: { background: '#0c0717', panel: '#1d1230', text: '#f7f2ff', accent: '#a970ff', accentSecondary: '#d7a7ff' },
      midnight: { background: '#06101d', panel: '#0e1f33', text: '#eef7ff', accent: '#6aaeff', accentSecondary: '#8bd7ff' },
      emerald: { background: '#061510', panel: '#0d261d', text: '#effff8', accent: '#62e5ad', accentSecondary: '#9ff0d0' }
    },
    light: {
      purple: { background: '#f5f1fb', panel: '#ffffff', text: '#241733', accent: '#7c3ed0', accentSecondary: '#a35ee8' },
      midnight: { background: '#f1f6fc', panel: '#ffffff', text: '#142237', accent: '#2f6fb8', accentSecondary: '#4b91cb' },
      emerald: { background: '#f0faf5', panel: '#ffffff', text: '#142b22', accent: '#16835d', accentSecondary: '#2a9a70' }
    }
  };
  const media = window.matchMedia?.('(prefers-color-scheme: light)');

  const copyDefaults = () => ({ name: defaults.name, mode: defaults.mode, custom: { ...defaults.custom } });

  function validColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
  }

  function channels(hex) {
    const normalized = validColor(hex, '#000000').slice(1);
    return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
  }

  function mix(first, second, weight = 0.5) {
    const a = channels(first);
    const b = channels(second);
    const value = a.map((channel, index) => Math.round(channel * (1 - weight) + b[index] * weight));
    return `#${value.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  function alpha(hex, opacity) {
    const [red, green, blue] = channels(hex);
    return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
  }

  function luminance(hex) {
    const values = channels(hex).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  }

  function contrastRatio(first, second) {
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  }

  function readableInk(background) {
    return contrastRatio('#ffffff', background) >= contrastRatio('#17101f', background) ? '#ffffff' : '#17101f';
  }

  function validateCustom(custom) {
    const background = validColor(custom?.background, defaults.custom.background);
    const panel = validColor(custom?.panel, defaults.custom.panel);
    const text = validColor(custom?.text, defaults.custom.text);
    const accent = validColor(custom?.accent, defaults.custom.accent);
    const accentSecondary = validColor(custom?.accentSecondary, defaults.custom.accentSecondary);
    const textOnBackground = contrastRatio(text, background);
    const textOnPanel = contrastRatio(text, panel);
    const minimum = Math.min(textOnBackground, textOnPanel);
    if (minimum < 4.5) return { valid: false, minimum, message: `Text needs at least 4.5:1 contrast against both the background and panels. Current minimum: ${minimum.toFixed(1)}:1.` };
    if (Math.min(contrastRatio(accent, background), contrastRatio(accent, panel)) < 3) return { valid: false, minimum, message: 'The accent needs at least 3:1 contrast against both the background and panels.' };
    if (Math.min(contrastRatio(accentSecondary, background), contrastRatio(accentSecondary, panel)) < 3) return { valid: false, minimum, message: 'The secondary accent needs at least 3:1 contrast against both the background and panels.' };
    return { valid: true, minimum };
  }

  function normalizeTheme(input) {
    const parsed = input && typeof input === 'object' ? input : {};
    const legacyLight = parsed.name === 'light';
    const name = THEMES.has(parsed.name) ? parsed.name : legacyLight ? 'purple' : defaults.name;
    const mode = legacyLight ? 'light' : MODES.has(parsed.mode) ? parsed.mode : defaults.mode;
    const candidate = { ...defaults.custom, ...(parsed.custom || {}) };
    const custom = {
      accent: validColor(candidate.accent, defaults.custom.accent),
      accentSecondary: validColor(candidate.accentSecondary, defaults.custom.accentSecondary),
      background: validColor(candidate.background, defaults.custom.background),
      panel: validColor(candidate.panel, defaults.custom.panel),
      text: validColor(candidate.text, defaults.custom.text),
      radius: Math.max(8, Math.min(28, Number(candidate.radius) || defaults.custom.radius))
    };
    return { name, mode, custom };
  }

  function safeTheme() {
    try {
      const theme = normalizeTheme(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
      return theme.name === 'custom' && !validateCustom(theme.custom).valid ? { ...copyDefaults(), mode: theme.mode } : theme;
    } catch { return copyDefaults(); }
  }

  function resolvedMode(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return media?.matches ? 'light' : 'dark';
  }

  function apply(theme) {
    const candidate = normalizeTheme(theme);
    const normalized = candidate.name === 'custom' && !validateCustom(candidate.custom).valid ? { ...copyDefaults(), mode: candidate.mode } : candidate;
    const root = document.documentElement;
    const mode = resolvedMode(normalized.mode);
    root.dataset.theme = normalized.name;
    root.dataset.themeMode = normalized.mode;
    root.dataset.mode = mode;
    root.style.colorScheme = mode;

    const custom = normalized.custom;
    const palette = normalized.name === 'custom'
      ? { background: custom.background, panel: custom.panel, text: custom.text, accent: custom.accent, accentSecondary: custom.accentSecondary }
      : palettes[mode][normalized.name];
    const { background, panel, text, accent, accentSecondary } = palette;
    const light = mode === 'light' && normalized.name !== 'custom'
      ? true
      : contrastRatio('#17101f', background) > contrastRatio('#ffffff', background);
    const values = {
      '--primary': accent,
      '--primary-strong': mix(accent, light ? '#000000' : '#ffffff', light ? 0.18 : 0.12),
      '--primary-soft': alpha(accent, light ? 0.12 : 0.16),
      '--accent-secondary': accentSecondary,
      '--primary-ink': readableInk(accent),
      '--bg': background,
      '--bg-soft': mix(background, light ? '#000000' : '#ffffff', light ? 0.05 : 0.06),
      '--panel': alpha(panel, normalized.name === 'custom' ? 0.94 : mode === 'light' ? 0.97 : 0.94),
      '--panel-solid': panel,
      '--panel-strong': mix(panel, light ? '#000000' : '#ffffff', light ? 0.06 : 0.08),
      '--panel-hover': mix(panel, accent, light ? 0.10 : 0.16),
      '--input': mix(background, panel, light ? 0.70 : 0.42),
      '--sidebar-bg': mix(background, panel, light ? 0.32 : 0.24),
      '--line': alpha(text, light ? 0.13 : 0.15),
      '--line-strong': alpha(text, light ? 0.24 : 0.29),
      '--text': text,
      '--muted': mix(text, background, light ? 0.48 : 0.38),
      '--danger-text': light ? '#9d2447' : '#ffb3c3',
      '--warning-text': light ? '#755000' : '#ffe0a5',
      '--success-text': light ? '#12613f' : '#a5f0d0',
      '--neutral-text': light ? '#3f3260' : '#d9c8ef',
      '--overlay-backdrop': light ? alpha(text, 0.46) : 'rgba(0, 0, 0, 0.72)',
      '--card-shadow': `0 14px 38px ${light ? alpha(text, 0.12) : 'rgba(0, 0, 0, 0.22)'}`,
      '--shadow': `0 24px 70px ${alpha(background, light ? 0.16 : 0.52)}`,
      '--radius': `${normalized.name === 'custom' ? custom.radius : defaults.custom.radius}px`
    };
    for (const [property, value] of Object.entries(values)) root.style.setProperty(property, value);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = background;
  }

  let current = safeTheme();
  apply(current);
  media?.addEventListener?.('change', () => { if (current.mode === 'system') apply(current); });

  window.SHAM_THEME = {
    STORAGE_KEY,
    defaults,
    get: () => ({ name: current.name, mode: current.mode, custom: { ...current.custom } }),
    apply,
    validateCustom,
    contrastRatio,
    save(theme) {
      const candidate = normalizeTheme(theme);
      if (candidate.name === 'custom' && !validateCustom(candidate.custom).valid) return false;
      current = candidate;
      let persisted = true;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); }
      catch { persisted = false; }
      apply(current);
      return persisted;
    },
    reset() {
      current = copyDefaults();
      let persisted = true;
      try { localStorage.removeItem(STORAGE_KEY); }
      catch { persisted = false; }
      apply(current);
      return persisted;
    }
  };
})();

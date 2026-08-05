'use strict';

(() => {
  const STORAGE_KEY = 'sham-theme-v1';
  const presetBackgrounds = {
    purple: '#0c0717',
    midnight: '#06101d',
    emerald: '#061510',
    light: '#f5f1fb'
  };
  const defaults = {
    name: 'purple',
    custom: {
      accent: '#a970ff',
      accentSecondary: '#d7a7ff',
      background: '#0c0717',
      panel: '#1d1230',
      text: '#f7f2ff',
      radius: 18
    }
  };

  const copyDefaults = () => ({ name: defaults.name, custom: { ...defaults.custom } });

  function safeTheme() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return copyDefaults();
      const name = ['purple', 'midnight', 'emerald', 'light', 'custom'].includes(parsed.name) ? parsed.name : 'purple';
      const candidate = { ...defaults.custom, ...(parsed.custom || {}) };
      const theme = {
        name,
        custom: {
          accent: validColor(candidate.accent, defaults.custom.accent),
          accentSecondary: validColor(candidate.accentSecondary, defaults.custom.accentSecondary),
          background: validColor(candidate.background, defaults.custom.background),
          panel: validColor(candidate.panel, defaults.custom.panel),
          text: validColor(candidate.text, defaults.custom.text),
          radius: Math.max(8, Math.min(28, Number(candidate.radius) || defaults.custom.radius))
        }
      };
      return theme.name === 'custom' && !validateCustom(theme.custom).valid ? copyDefaults() : theme;
    } catch {
      return copyDefaults();
    }
  }

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
    const accentOnBackground = contrastRatio(accent, background);
    const accentOnPanel = contrastRatio(accent, panel);
    const secondaryOnBackground = contrastRatio(accentSecondary, background);
    const secondaryOnPanel = contrastRatio(accentSecondary, panel);
    const minimum = Math.min(textOnBackground, textOnPanel);
    if (minimum < 4.5) {
      return { valid: false, minimum, message: `Text needs at least 4.5:1 contrast against both the background and panels. Current minimum: ${minimum.toFixed(1)}:1.` };
    }
    if (Math.min(accentOnBackground, accentOnPanel) < 3) {
      return { valid: false, minimum, message: 'The accent needs at least 3:1 contrast against both the background and panels.' };
    }
    if (Math.min(secondaryOnBackground, secondaryOnPanel) < 3) {
      return { valid: false, minimum, message: 'The secondary accent needs at least 3:1 contrast against both the background and panels.' };
    }
    return { valid: true, minimum };
  }

  function apply(theme) {
    const root = document.documentElement;
    root.dataset.theme = theme.name;
    const custom = theme.custom || defaults.custom;
    const accent = validColor(custom.accent, defaults.custom.accent);
    const accentSecondary = validColor(custom.accentSecondary, defaults.custom.accentSecondary);
    const background = validColor(custom.background, defaults.custom.background);
    const panel = validColor(custom.panel, defaults.custom.panel);
    const text = validColor(custom.text, defaults.custom.text);
    const lightCustom = contrastRatio('#17101f', background) > contrastRatio('#ffffff', background);
    const values = {
      '--primary': accent,
      '--primary-strong': mix(accent, lightCustom ? '#000000' : '#ffffff', lightCustom ? 0.18 : 0.12),
      '--primary-soft': alpha(accent, lightCustom ? 0.12 : 0.16),
      '--accent-secondary': accentSecondary,
      '--primary-ink': readableInk(accent),
      '--bg': background,
      '--bg-soft': mix(background, lightCustom ? '#000000' : '#ffffff', lightCustom ? 0.05 : 0.06),
      '--panel': alpha(panel, 0.94),
      '--panel-solid': panel,
      '--panel-strong': mix(panel, lightCustom ? '#000000' : '#ffffff', lightCustom ? 0.06 : 0.08),
      '--panel-hover': mix(panel, accent, 0.16),
      '--input': mix(background, panel, 0.42),
      '--sidebar-bg': mix(background, panel, 0.24),
      '--line': alpha(text, lightCustom ? 0.13 : 0.15),
      '--line-strong': alpha(text, lightCustom ? 0.24 : 0.29),
      '--text': text,
      '--muted': mix(text, background, lightCustom ? 0.48 : 0.38),
      '--danger-text': lightCustom ? '#9d2447' : '#ffb3c3',
      '--warning-text': lightCustom ? '#755000' : '#ffe0a5',
      '--success-text': lightCustom ? '#12613f' : '#a5f0d0',
      '--neutral-text': lightCustom ? '#3f3260' : '#d9c8ef',
      '--overlay-backdrop': lightCustom ? alpha(text, 0.46) : 'rgba(0, 0, 0, 0.72)',
      '--card-shadow': `0 14px 38px ${lightCustom ? alpha(text, 0.12) : 'rgba(0, 0, 0, 0.22)'}`,
      '--shadow': `0 24px 70px ${alpha(background, lightCustom ? 0.16 : 0.52)}`,
      '--radius': `${Math.max(8, Math.min(28, Number(custom.radius) || 18))}px`
    };
    for (const [property, value] of Object.entries(values)) {
      if (theme.name === 'custom') root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    }
    root.style.colorScheme = theme.name === 'light' || (theme.name === 'custom' && lightCustom) ? 'light' : 'dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme.name === 'custom' ? background : (presetBackgrounds[theme.name] || defaults.custom.background);
  }

  let current = safeTheme();
  apply(current);
  window.SHAM_THEME = {
    STORAGE_KEY,
    defaults,
    get: () => ({ name: current.name, custom: { ...current.custom } }),
    apply,
    validateCustom,
    contrastRatio,
    save(theme) {
      const candidate = {
        name: ['purple', 'midnight', 'emerald', 'light', 'custom'].includes(theme?.name) ? theme.name : 'purple',
        custom: { ...defaults.custom, ...(theme?.custom || {}) }
      };
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

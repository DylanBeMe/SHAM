'use strict';

let overviewRequest = null;
let overviewController = null;
let overviewRequestId = 0;
async function loadOverview({ force = false } = {}) {
  if (!state.user) return null;
  if (overviewRequest && !force) return overviewRequest;
  if (force) overviewController?.abort();

  const requestId = ++overviewRequestId;
  const controller = new AbortController();
  overviewController = controller;
  const button = $('#refresh-overview');
  if (button) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
    button.textContent = 'Refreshing…';
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-loading');
    // Keep this control clickable so the user can retry/cancel a stale request.
    button.disabled = false;
  }

  const request = (async () => {
    try {
      const statistics = await api('/api/statistics', { signal: controller.signal });
      if (requestId !== overviewRequestId) return null;
      state.statistics = statistics;
      const { totals } = statistics;
      $('#overview-requests').textContent = formatNumber(totals.requests);
      $('#overview-sites').textContent = `${formatNumber(totals.sites)} configured site${Number(totals.sites) === 1 ? '' : 's'}`;
      $('#overview-bytes').textContent = formatBytes(totals.bytes);
      $('#overview-running').textContent = formatNumber(totals.running);
      $('#overview-errors').textContent = formatNumber(totals.errors);
      $('#overview-visitors').textContent = formatNumber(totals.visitors);
      renderTrafficChart(statistics.daily || []);
      renderTopSites(statistics.sites || []);
      renderTrafficOrigins(statistics.countries || []);
      renderVisitors(statistics.visitors || []);
      renderAttention(statistics.attention || {}, statistics.clientTypes || []);
      return statistics;
    } catch (error) {
      if (error.name !== 'AbortError' && requestId === overviewRequestId) toast(error.message, 'error');
      return null;
    } finally {
      if (requestId === overviewRequestId) {
        overviewRequest = null;
        overviewController = null;
        if (button) {
          button.textContent = button.dataset.originalLabel || 'Refresh';
          delete button.dataset.originalLabel;
          button.removeAttribute('aria-busy');
          button.classList.remove('is-loading');
          button.disabled = false;
        }
      }
    }
  })();
  overviewRequest = request;
  return request;
}

function renderTrafficChart(daily) {
  const map = new Map(daily.map((row) => [row.day, row]));
  const points = [];
  const now = new Date();
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCDate(now.getUTCDate() - offset);
    const day = date.toISOString().slice(0, 10);
    points.push(map.get(day) || { day, requests: 0, bytes: 0, errors: 0 });
  }
  const maximum = Math.max(1, ...points.map((point) => Number(point.requests)));
  $('#traffic-chart').innerHTML = points.map((point) => {
    const date = new Date(`${point.day}T00:00:00Z`);
    const requests = Number(point.requests) || 0;
    const heightStep = requests <= 0 ? 0 : Math.max(1, Math.min(20, Math.ceil((requests / maximum) * 20)));
    return `<div class="bar-item" title="${escapeHtml(formatNumber(point.requests))} requests · ${escapeHtml(formatBytes(point.bytes))}"><div class="bar h-${heightStep}"></div><strong>${escapeHtml(formatNumber(point.requests))}</strong><span>${escapeHtml(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date))}</span></div>`;
  }).join('');
}

function renderTopSites(sites) {
  const target = $('#top-sites');
  if (!sites.length) {
    target.innerHTML = '<div class="empty-state"><p>No traffic has been recorded yet.</p></div>';
    return;
  }
  target.innerHTML = sites.slice(0, 8).map((site, index) => {
    const average = Number(site.requests) ? Math.round(Number(site.response_ms) / Number(site.requests)) : 0;
    return `<div class="rank-item"><span class="rank-number">${index + 1}</span><div><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.runtime_type)} · ${formatBytes(site.bytes)} · ${average} ms avg</small></div><strong>${formatNumber(site.requests)}</strong></div>`;
  }).join('');
}

let regionDisplayNames = null;
const countryNameCache = new Map();
function countryName(code) {
  const normalized = String(code || 'ZZ').toUpperCase();
  if (normalized === 'ZZ' || normalized === 'XX') return 'Unknown';
  if (normalized === 'T1') return 'Tor network';
  if (normalized === 'XK') return 'Kosovo';
  if (countryNameCache.has(normalized)) return countryNameCache.get(normalized);
  try {
    regionDisplayNames ||= new Intl.DisplayNames(undefined, { type: 'region' });
    const value = regionDisplayNames.of(normalized) || normalized;
    countryNameCache.set(normalized, value);
    return value;
  } catch { return normalized; }
}

function siteDisplayUrl(site) {
  if (site.domain) return site.url;
  try {
    const parsed = new URL(site.url);
    if (['localhost', '127.0.0.1', '0.0.0.0', '[::]', '::'].includes(parsed.hostname)) parsed.hostname = location.hostname;
    return parsed.toString().replace(/\/$/, '');
  } catch { return site.url; }
}

function trafficLevel(value, maximum) {
  if (value <= 0 || maximum <= 0) return 0;
  // Logarithmic scaling keeps lower-volume countries visible without letting one hotspot flatten the map.
  const ratio = Math.log1p(value) / Math.log1p(maximum);
  if (ratio <= .2) return 1;
  if (ratio <= .4) return 2;
  if (ratio <= .6) return 3;
  if (ratio <= .8) return 4;
  return 5;
}

function renderTrafficOrigins(countries) {
  const rows = countries
    .map((row) => ({
      ...row,
      country: String(row.country || 'ZZ').toUpperCase(),
      requests: Number(row.requests || 0),
      visitors: Number(row.visitors || 0),
      bytes: Number(row.bytes || 0)
    }))
    .sort((a, b) => b.requests - a.requests || a.country.localeCompare(b.country));
  const byCountry = new Map(rows.map((row) => [row.country, row]));
  const knownRows = rows.filter((row) => row.country !== 'ZZ' && row.country !== 'XX' && row.country !== 'T1');
  const maximum = Math.max(1, ...knownRows.map((row) => row.requests));
  const geometry = window.SHAM_WORLD_MAP?.countries || [];
  const geometryCodes = new Set(geometry.map((country) => country.code));
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const knownRequests = knownRows.reduce((sum, row) => sum + row.requests, 0);
  const unknownRequests = Math.max(0, totalRequests - knownRequests);
  const coverage = totalRequests > 0 ? (knownRequests / totalRequests) * 100 : 0;
  const mappedRequests = knownRows.filter((row) => geometryCodes.has(row.country)).reduce((sum, row) => sum + row.requests, 0);
  const map = $('#traffic-map');

  if (!geometry.length) {
    map.innerHTML = '<div class="map-empty"><strong>Map data unavailable</strong><span>Country totals are still listed below.</span></div>';
  } else {
    const paths = geometry.map((country) => {
      const row = byCountry.get(country.code);
      const level = trafficLevel(Number(row?.requests || 0), maximum);
      const share = totalRequests > 0 && row ? (row.requests / totalRequests) * 100 : 0;
      const label = row
        ? `${countryName(country.code)}: ${formatNumber(row.requests)} requests, ${formatNumber(row.visitors)} unique IPs, ${share.toFixed(1)} percent of recorded traffic`
        : `${countryName(country.code)}: no recorded traffic`;
      return `<path class="map-country level-${level}" data-country="${escapeHtml(country.code)}" d="${country.path}" tabindex="0" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></path>`;
    }).join('');
    map.innerHTML = `<div class="map-stage"><svg viewBox="${escapeHtml(window.SHAM_WORLD_MAP.viewBox || '0 0 1000 500')}" role="img" aria-label="Equal Earth map of request origins by country" preserveAspectRatio="xMidYMid meet"><g class="map-countries">${paths}</g></svg><div class="map-tooltip" role="status" hidden></div></div>`;

    const tooltip = $('.map-tooltip', map);
    const showTooltip = (path, clientX, clientY) => {
      const code = path?.dataset.country;
      if (!code || !tooltip) return;
      const row = byCountry.get(code);
      const share = totalRequests > 0 && row ? (row.requests / totalRequests) * 100 : 0;
      tooltip.innerHTML = `<strong>${escapeHtml(countryName(code))}</strong><span>${formatNumber(row?.requests || 0)} requests · ${formatNumber(row?.visitors || 0)} unique IPs</span><span>${formatBytes(row?.bytes || 0)} transferred${row ? ` · ${share.toFixed(1)}% of traffic` : ''}</span>`;
      const bounds = map.getBoundingClientRect();
      const x = Number.isFinite(clientX) ? clientX - bounds.left : bounds.width / 2;
      const y = Number.isFinite(clientY) ? clientY - bounds.top : bounds.height / 2;
      tooltip.hidden = false;
      const halfWidth = Math.min(bounds.width / 2, tooltip.offsetWidth / 2 + 10);
      const tooltipHeight = tooltip.offsetHeight;
      tooltip.style.left = `${Math.max(halfWidth, Math.min(bounds.width - halfWidth, x))}px`;
      tooltip.style.top = `${Math.max(10, Math.min(bounds.height - 10, y))}px`;
      tooltip.classList.toggle('below', y - tooltipHeight - 18 < 0);
      $$('.map-country.is-active', map).forEach((item) => item.classList.remove('is-active'));
      $$(`.map-country[data-country="${CSS.escape(code)}"]`, map).forEach((item) => item.classList.add('is-active'));
    };
    const hideTooltip = () => {
      if (tooltip) tooltip.hidden = true;
      $$('.map-country.is-active', map).forEach((item) => item.classList.remove('is-active'));
    };
    map.onpointermove = (event) => {
      const path = event.target.closest?.('.map-country');
      if (path) showTooltip(path, event.clientX, event.clientY);
      else hideTooltip();
    };
    map.onpointerleave = hideTooltip;
    map.onfocusin = (event) => {
      const path = event.target.closest?.('.map-country');
      if (!path) return;
      const box = path.getBoundingClientRect();
      showTooltip(path, box.left + box.width / 2, box.top + box.height / 2);
    };
    map.onfocusout = (event) => {
      if (!map.contains(event.relatedTarget)) hideTooltip();
    };
  }

  $('#traffic-map-legend').innerHTML = '<span>Fewer requests</span><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><i class="level-4"></i><i class="level-5"></i><span>More requests</span>';
  const mapStatus = $('#traffic-map-status');
  if (!totalRequests) mapStatus.textContent = 'No traffic has been recorded yet.';
  else {
    const unmappedRequests = Math.max(0, knownRequests - mappedRequests);
    mapStatus.textContent = `${coverage.toFixed(1)}% of requests include trusted country data. ${formatNumber(unknownRequests)} request${unknownRequests === 1 ? '' : 's'} are unknown${unmappedRequests ? `; ${formatNumber(unmappedRequests)} geolocated requests use territories not present in the bundled map` : ''}.`;
  }

  const ranking = $('#country-ranking');
  ranking.innerHTML = rows.length
    ? rows.slice(0, 10).map((row) => {
      const contents = `<span title="${escapeHtml(countryName(row.country))}">${escapeHtml(countryName(row.country))}</span><strong>${formatNumber(row.requests)} <small>req</small></strong><em>${formatNumber(row.visitors)} IPs</em>`;
      return geometryCodes.has(row.country)
        ? `<button class="country-chip" data-map-country="${escapeHtml(row.country)}" type="button">${contents}</button>`
        : `<div class="country-chip noninteractive">${contents}</div>`;
    }).join('')
    : '<p class="muted">Country traffic will appear after requests are recorded through a trusted Cloudflare edge.</p>';
  ranking.onclick = (event) => {
    const button = event.target.closest('[data-map-country]');
    if (!button) return;
    const path = $(`.map-country[data-country="${CSS.escape(button.dataset.mapCountry)}"]`, map);
    if (path) path.focus();
    else toast(`${countryName(button.dataset.mapCountry)} is not represented in the bundled map geometry.`, 'warning');
  };
}

function clientTypeLabel(type) {
  return ({ llm: 'LLM / AI', search: 'Search crawler', crawler: 'Crawler / scraper', browser: 'Browser', unknown: 'Unknown' })[type] || type || 'Unknown';
}

function renderAttention(attention, clientTypes) {
  const unhealthy = Number(attention.unhealthySites || 0);
  const failed = Number(attention.failedDeployments || 0);
  const alerts = Number(attention.activeAlerts || 0);
  const automated = clientTypes.filter((row) => ['llm', 'search', 'crawler'].includes(row.type)).reduce((sum, row) => sum + Number(row.requests || 0), 0);
  $('#attention-health').textContent = unhealthy ? `${unhealthy} need attention` : 'All healthy';
  $('#attention-deployments').textContent = failed ? `${failed} failed` : 'No failures';
  $('#attention-alerts').textContent = alerts ? `${alerts} active` : 'None';
  $('#attention-automation').textContent = `${formatNumber(automated)} requests`;
  $('#client-intelligence').innerHTML = clientTypes.filter((row) => Number(row.requests || 0) > 0).map((row) => `<span class="client-badge ${escapeHtml(row.type)}">${escapeHtml(clientTypeLabel(row.type))} · ${formatNumber(row.requests)}</span>`).join('');
}

function renderVisitors(visitors) {
  const target = $('#visitor-table');
  if (!visitors.length) {
    target.innerHTML = '<tr><td colspan="8" class="muted">No visitor activity has been recorded yet.</td></tr>';
    return;
  }
  target.innerHTML = visitors.map((visitor) => {
    const ip = String(visitor.ip || '');
    const actionable = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.includes(':');
    return `<tr data-visitor-site-id="${visitor.site_id}" data-visitor-ip="${escapeHtml(ip)}">
      <td><code>${escapeHtml(ip)}</code></td>
      <td><span class="client-badge ${escapeHtml(visitor.client_type || 'unknown')}">${escapeHtml(clientTypeLabel(visitor.client_type))}</span></td>
      <td class="user-agent-cell" title="${escapeHtml(visitor.user_agent || '')}">${escapeHtml(visitor.user_agent || 'Not recorded')}</td>
      <td>${escapeHtml(countryName(visitor.country))}</td>
      <td>${escapeHtml(visitor.site_name)}</td>
      <td>${formatNumber(visitor.requests)}</td>
      <td>${escapeHtml(formatDate(visitor.last_request_at))}</td>
      <td class="table-action">${actionable ? '<button class="button danger compact" data-ban-visitor type="button">Ban IP</button>' : '<small class="muted">Privacy-masked</small>'}</td>
    </tr>`;
  }).join('');
}

$('#visitor-table').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-ban-visitor]');
  if (!button) return;
  const row = button.closest('[data-visitor-site-id]');
  const site = state.sites.find((item) => item.id === Number(row.dataset.visitorSiteId));
  const ip = row.dataset.visitorIp;
  if (!site || !ip) return;
  const ok = await requestAction({ title: `Ban ${ip}?`, message: `Add this address to ${site.name}'s local firewall block list. You can remove it later in Site → Security.`, confirmLabel: 'Ban IP', danger: true });
  if (!ok) return;
  setBusy(button, true, 'Banning…');
  try {
    await api(`/api/sites/${site.id}/firewall/ban-ip`, { method: 'POST', body: { ip } });
    toast(`${ip} is now blocked on ${site.name}.`);
    await Promise.all([loadSites(), loadOverview({ force: true })]);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

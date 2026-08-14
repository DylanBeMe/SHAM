'use strict';

const net = require('node:net');

const LLM_CLIENT_PATTERNS = [
  /GPTBot/i,
  /ChatGPT-User/i,
  /OAI-SearchBot/i,
  /ClaudeBot/i,
  /Claude-Web/i,
  /PerplexityBot/i,
  /Perplexity-User/i,
  /Google-Extended/i,
  /Bytespider/i,
  /CCBot/i,
  /cohere-ai/i,
  /Amazonbot/i,
  /Applebot-Extended/i
];

const SEARCH_CLIENT_PATTERNS = [
  /Googlebot/i,
  /bingbot/i,
  /DuckDuckBot/i,
  /Baiduspider/i,
  /YandexBot/i,
  /Applebot/i
];

const AUTOMATION_PATTERNS = [
  /bot/i,
  /crawler/i,
  /spider/i,
  /scraper/i,
  /headless/i,
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /Go-http-client/i,
  /libwww-perl/i,
  /httpx/i,
  /axios\//i
];

function classifyClient(userAgent = '') {
  const ua = String(userAgent || '').slice(0, 1024);
  if (!ua) return { type: 'unknown', label: 'Unknown client', automated: false, userAgent: '' };
  if (LLM_CLIENT_PATTERNS.some((pattern) => pattern.test(ua))) return { type: 'llm', label: 'LLM / AI crawler', automated: true, userAgent: ua };
  if (SEARCH_CLIENT_PATTERNS.some((pattern) => pattern.test(ua))) return { type: 'search', label: 'Search crawler', automated: true, userAgent: ua };
  if (AUTOMATION_PATTERNS.some((pattern) => pattern.test(ua))) return { type: 'crawler', label: 'Automated crawler', automated: true, userAgent: ua };
  return { type: 'browser', label: 'Browser / app', automated: false, userAgent: ua };
}

function actionableIp(value) {
  return net.isIP(String(value || '').trim()) > 0;
}

function expandIpv6(value) {
  let address = String(value || '').trim().toLowerCase().split('%')[0];
  if (net.isIP(address) !== 6) return null;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const octets = address.slice(lastColon + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function formatIpv6(parts) {
  const values = parts.map((part) => Number(part) & 0xffff);
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < values.length;) {
    if (values[start] !== 0) { start += 1; continue; }
    let end = start;
    while (end < values.length && values[end] === 0) end += 1;
    if (end - start > bestLength && end - start >= 2) { bestStart = start; bestLength = end - start; }
    start = end;
  }
  if (bestStart < 0) return values.map((part) => part.toString(16)).join(':');
  const left = values.slice(0, bestStart).map((part) => part.toString(16)).join(':');
  const right = values.slice(bestStart + bestLength).map((part) => part.toString(16)).join(':');
  return `${left}::${right}`;
}

function maskIp(value) {
  const ip = String(value || '').trim();
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  const expanded = expandIpv6(ip);
  if (expanded) return `${formatIpv6([...expanded.slice(0, 3), 0, 0, 0, 0, 0])}/48`;
  return ip;
}

module.exports = { classifyClient, actionableIp, maskIp };

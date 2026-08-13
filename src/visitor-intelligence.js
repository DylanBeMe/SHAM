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

module.exports = { classifyClient, actionableIp };

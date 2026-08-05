const crypto = require('node:crypto');
const { promisify } = require('node:util');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, AUTH_RATE_LIMIT_BUCKETS } = require('./config');
const { db } = require('./db');

const COOKIE_NAME = 'sham_token';
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const MFA_TOKEN_TTL_SECONDS = 5 * 60;
const scrypt = promisify(crypto.scrypt);

function normalizeUsername(value) {
  const username = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,39}$/.test(username)) {
    throw new Error('Username must be 3–40 characters and use letters, numbers, dot, underscore, or hyphen.');
  }
  return username;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    throw new Error('Password must be between 12 and 200 characters.');
  }
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  validatePassword(password);
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: Buffer.from(derived).toString('hex') };
}

async function verifyPassword(password, salt, expectedHex) {
  if (typeof password !== 'string' || password.length > 200) return false;
  try {
    const actual = Buffer.from(await scrypt(password, salt, 64));
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) return cookies;
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    return cookies;
  }, {});
}

function issueMfaToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, purpose: 'mfa' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: MFA_TOKEN_TTL_SECONDS, issuer: 'sham', audience: 'sham-mfa' }
  );
}

function verifyMfaToken(token) {
  try {
    const payload = jwt.verify(String(token || ''), JWT_SECRET, { algorithms: ['HS256'], issuer: 'sham', audience: 'sham-mfa' });
    if (payload.purpose !== 'mfa') return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(payload.sub));
    return user?.active ? user : null;
  } catch { return null; }
}

function issueToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS, issuer: 'sham', audience: 'sham-dashboard' }
  );
}

function setAuthCookie(req, res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${TOKEN_TTL_SECONDS}`
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(req, res) {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function resolveUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'sham',
      audience: 'sham-dashboard'
    });
    const user = db.prepare('SELECT id, username, role, active, totp_enabled, created_at FROM users WHERE id = ?').get(Number(payload.sub));
    return user?.active ? user : null;
  } catch {
    return null;
  }
}

function optionalAuth(req, _res, next) {
  req.user = resolveUser(req);
  next();
}

function requireAuth(req, res, next) {
  req.user = resolveUser(req);
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}

function sameOriginGuard(req, res, next) {
  if (req.path.startsWith('/api/hooks/deploy/')) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }

  const origin = req.get('origin');
  if (origin) {
    try {
      const supplied = new URL(origin).origin;
      const expected = new URL(`${req.protocol}://${req.get('host')}`).origin;
      if (supplied !== expected) return res.status(403).json({ error: 'Origin validation failed.' });
    } catch {
      return res.status(403).json({ error: 'Origin validation failed.' });
    }
  }
  next();
}

function createRateLimiter({ windowMs, max, maxBuckets = AUTH_RATE_LIMIT_BUCKETS }) {
  const buckets = new Map();
  let lastSweep = 0;
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (now - lastSweep >= Math.min(windowMs, 60_000)) {
      for (const [bucketKey, bucket] of buckets) {
        if (now >= bucket.resetAt) buckets.delete(bucketKey);
      }
      lastSweep = now;
    }
    if (!buckets.has(key) && buckets.size >= maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    const current = buckets.get(key);
    if (!current || now >= current.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.set('RateLimit-Limit', String(max));
      res.set('RateLimit-Remaining', String(Math.max(0, max - 1)));
      res.set('RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));
      return next();
    }
    current.count += 1;
    buckets.delete(key);
    buckets.set(key, current);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - current.count)));
    res.set('RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));
    if (current.count > max) {
      res.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    next();
  };
}

module.exports = {
  normalizeUsername,
  validatePassword,
  hashPassword,
  verifyPassword,
  issueToken,
  issueMfaToken,
  verifyMfaToken,
  setAuthCookie,
  clearAuthCookie,
  optionalAuth,
  requireAuth,
  requireAdmin,
  sameOriginGuard,
  createRateLimiter
};

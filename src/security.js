'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;

const runtimeSecrets = {
  session: null,
  webhook: null
};

/**
 * Constant-time string equality check.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Load or lazily generate a stable runtime secret persisted next to DB_PATH (when file-backed).
 * @param {'session'|'webhook'} kind
 * @returns {string}
 */
function getRuntimeSecret(kind) {
  const envVar = kind === 'webhook'
    ? (process.env.SOLIS_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET)
    : (process.env.SOLIS_SESSION_SECRET || process.env.SESSION_SECRET);
  if (envVar && envVar.length >= 16) {
    return envVar;
  }
  if (runtimeSecrets[kind]) {
    return runtimeSecrets[kind];
  }

  const dbPath = process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'solis.db');
  if (dbPath && dbPath !== ':memory:') {
    const keyFile = path.join(path.dirname(dbPath), `.solis-${kind}.key`);
    try {
      if (fs.existsSync(keyFile)) {
        const existing = fs.readFileSync(keyFile, 'utf8').trim();
        if (existing.length >= 32) {
          runtimeSecrets[kind] = existing;
          return existing;
        }
      }
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      const generated = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyFile, generated, { encoding: 'utf8', mode: 0o600 });
      runtimeSecrets[kind] = generated;
      return generated;
    } catch {
      // Fall through to ephemeral in-memory secret if key file cannot be written.
    }
  }

  runtimeSecrets[kind] = crypto.randomBytes(32).toString('hex');
  return runtimeSecrets[kind];
}

function getSessionSecret() {
  return getRuntimeSecret('session');
}

function getWebhookSecret() {
  return getRuntimeSecret('webhook');
}

/**
 * Hash a plaintext password with scrypt and a per-password random 16-byte salt.
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const derived = crypto.scryptSync(password, salt, keylen, { N, r, p }).toString('hex');
  return `scrypt$${N}$${r}$${p}$${salt}$${derived}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];

  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (!salt || !expectedHex || expectedHex.length % 2 !== 0) return false;

  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = crypto.scryptSync(password, salt, expectedBuf.length, { N, r, p });
    if (actualBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Sign an arbitrary string value using HMAC-SHA256.
 * @param {string} value
 * @param {string} [secret]
 * @returns {string}
 */
function signValue(value, secret = getSessionSecret()) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Cannot sign empty value');
  }
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

/**
 * Verify and unwrap an HMAC-signed value (`value.mac`). Returns null if invalid.
 * @param {string} signedValue
 * @param {string} [secret]
 * @returns {string|null}
 */
function verifySignedValue(signedValue, secret = getSessionSecret()) {
  if (typeof signedValue !== 'string') return null;
  const dotIdx = signedValue.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === signedValue.length - 1) return null;

  const value = signedValue.slice(0, dotIdx);
  const providedMac = signedValue.slice(dotIdx + 1);
  const expectedMac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return safeEqual(providedMac, expectedMac) ? value : null;
}

/**
 * Compute an HMAC-SHA256 signature header (`sha256=<hex>`) for webhook payloads.
 * @param {string|Buffer} payload
 * @param {string} [secret]
 * @returns {string}
 */
function signWebhookPayload(payload, secret = getWebhookSecret()) {
  const data = typeof payload === 'string' || Buffer.isBuffer(payload)
    ? payload
    : JSON.stringify(payload);
  const digest = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Verify a webhook signature header (`sha256=<hex>` or raw `<hex>`).
 * @param {string|Buffer} payload
 * @param {string} signatureHeader
 * @param {string} [secret]
 * @returns {boolean}
 */
function verifyWebhookSignature(payload, signatureHeader, secret = getWebhookSecret()) {
  if (typeof signatureHeader !== 'string' || signatureHeader.trim().length === 0) return false;
  const data = typeof payload === 'string' || Buffer.isBuffer(payload)
    ? payload
    : JSON.stringify(payload);
  const expectedHex = crypto.createHmac('sha256', secret).update(data).digest('hex');
  const trimmed = signatureHeader.trim();
  const providedHex = trimmed.startsWith('sha256=') ? trimmed.slice(7) : trimmed;
  return safeEqual(providedHex.toLowerCase(), expectedHex.toLowerCase());
}

/**
 * Parse Cookie header from either an HTTP request or raw header string.
 * @param {import('http').IncomingMessage|string|undefined} reqOrHeader
 * @returns {Record<string, string>}
 */
function parseCookies(reqOrHeader) {
  const raw = typeof reqOrHeader === 'string'
    ? reqOrHeader
    : reqOrHeader?.headers?.cookie;
  const out = Object.create(null);
  if (!raw || typeof raw !== 'string') return out;

  const pairs = raw.split(';');
  for (const part of pairs) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Serialize a Set-Cookie header value with secure defaults (HttpOnly, SameSite=Lax).
 * @param {string} name
 * @param {string} value
 * @param {object} [options]
 * @returns {string}
 */
function serializeCookie(name, value, options = {}) {
  if (!name || /[\r\n;= ]/.test(name)) {
    throw new Error('Invalid cookie name');
  }
  const strVal = String(value ?? '');
  if (/[\r\n]/.test(strVal)) {
    throw new Error('Invalid cookie value');
  }

  const parts = [`${name}=${encodeURIComponent(strVal)}`];
  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) parts.push('HttpOnly');
  const sameSite = options.sameSite || 'Lax';
  parts.push(`SameSite=${sameSite}`);

  if (typeof options.maxAge === 'number' && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.expires instanceof Date) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.secure || process.env.COOKIE_SECURE === '1') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Append a Set-Cookie header without overwriting existing cookies on the response.
 * @param {import('http').ServerResponse} res
 * @param {string} cookieHeader
 */
function appendSetCookie(res, cookieHeader) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieHeader);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieHeader]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookieHeader]);
  }
}

function generateToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function generateCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Verify CSRF token from `X-CSRF-Token` header (or optional fallback string).
 * @param {import('http').IncomingMessage} req
 * @param {string} expectedToken
 * @param {string|null} [fallbackToken]
 * @returns {boolean}
 */
function verifyCsrfToken(req, expectedToken, fallbackToken = null) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false;
  const headerVal = req?.headers?.['x-csrf-token'];
  const provided = Array.isArray(headerVal) ? headerVal[0] : (headerVal || fallbackToken);
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return safeEqual(provided.trim(), expectedToken);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  if (/[\r\n\0\s<>]/.test(trimmed)) return false;
  if (!EMAIL_RE.test(trimmed)) return false;
  const [local, domain] = trimmed.split('@');
  if (!local || !domain || local.length > 64 || domain.length > 253) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  return true;
}

/**
 * Strictly parse and range-check an integer value.
 * Explicitly rejects null, undefined, booleans, arrays, objects, floats, NaN, and empty/non-digit strings.
 * @param {unknown} value
 * @param {{ min?: number, max?: number, coerceString?: boolean }} [opts]
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function parseStrictInt(value, opts = {}) {
  const min = opts.min ?? Number.MIN_SAFE_INTEGER;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  const coerceString = Boolean(opts.coerceString);

  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    typeof value === 'object'
  ) {
    return { ok: false, error: 'Value must be an integer' };
  }

  let num;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      return { ok: false, error: 'Value must be a safe integer' };
    }
    num = value === 0 ? 0 : value;
  } else if (coerceString && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) {
      return { ok: false, error: 'Value must be an integer' };
    }
    num = Number(trimmed);
    if (!Number.isSafeInteger(num)) {
      return { ok: false, error: 'Integer out of safe range' };
    }
    num = num === 0 ? 0 : num;
  } else {
    return { ok: false, error: 'Value must be an integer' };
  }

  if (num < min || num > max) {
    return { ok: false, error: `Integer must be between ${min} and ${max}` };
  }
  return { ok: true, value: num };
}

function isStrictInt(value, opts = {}) {
  return parseStrictInt(value, opts).ok;
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password is required' };
  }
  if (password.length < 8 || password.length > 128) {
    return { ok: false, error: 'Password must be between 8 and 128 characters' };
  }
  return { ok: true, value: password };
}

function sanitizeText(value, maxLen = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

function validateNonEmptyString(value, { minLen = 1, maxLen = 500, field = 'Field' } = {}) {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` };
  }
  const cleaned = value.replace(/[\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (cleaned.length < minLen || cleaned.length > maxLen) {
    return { ok: false, error: `${field} must be between ${minLen} and ${maxLen} characters` };
  }
  return { ok: true, value: cleaned };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeCsvCell(value) {
  const str = String(value ?? '');
  const neutralized = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

/**
 * Create an in-memory sliding-window rate limiter keyed by IP / route / user.
 * @param {{ windowMs?: number, max?: number, maxKeys?: number }} [opts]
 */
function createRateLimiter(opts = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 60;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map();

  function pruneOldestIfFull() {
    if (buckets.size < maxKeys) return;
    const cutoff = Date.now() - windowMs;
    for (const [k, stamps] of buckets) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) {
        buckets.delete(k);
      }
      if (buckets.size < maxKeys) return;
    }
    const firstKey = buckets.keys().next().value;
    if (firstKey !== undefined) buckets.delete(firstKey);
  }

  function consume(key, now = Date.now()) {
    const bucketKey = String(key || 'anonymous');
    const cutoff = now - windowMs;
    let stamps = buckets.get(bucketKey);

    if (!stamps) {
      pruneOldestIfFull();
      stamps = [];
      buckets.set(bucketKey, stamps);
    } else {
      while (stamps.length > 0 && stamps[0] <= cutoff) {
        stamps.shift();
      }
    }

    if (stamps.length >= max) {
      const oldest = stamps[0];
      const resetAt = oldest + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return {
        allowed: false,
        limit: max,
        remaining: 0,
        resetAt,
        retryAfterSeconds
      };
    }

    stamps.push(now);
    return {
      allowed: true,
      limit: max,
      remaining: Math.max(0, max - stamps.length),
      resetAt: stamps[0] + windowMs,
      retryAfterSeconds: 0
    };
  }

  function reset(key) {
    if (key === undefined) buckets.clear();
    else buckets.delete(String(key));
  }

  return { consume, check: consume, reset };
}

const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');

/**
 * Apply baseline security headers to HTTP responses.
 * @param {import('http').ServerResponse} res
 * @param {{ includeCsp?: boolean }} [opts]
 */
function applySecurityHeaders(res, opts = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (opts.includeCsp !== false) {
    res.setHeader('Content-Security-Policy', DEFAULT_CSP);
  }
}

function getClientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req?.socket?.remoteAddress || '127.0.0.1';
}

module.exports = {
  safeEqual,
  getSessionSecret,
  getWebhookSecret,
  hashPassword,
  verifyPassword,
  signValue,
  verifySignedValue,
  signWebhookPayload,
  verifyWebhookSignature,
  parseCookies,
  serializeCookie,
  appendSetCookie,
  generateToken,
  generateCsrfToken,
  verifyCsrfToken,
  normalizeEmail,
  isValidEmail,
  parseStrictInt,
  isStrictInt,
  validatePassword,
  sanitizeText,
  validateNonEmptyString,
  escapeHtml,
  sanitizeCsvCell,
  createRateLimiter,
  applySecurityHeaders,
  getClientIp,
  DEFAULT_CSP
};

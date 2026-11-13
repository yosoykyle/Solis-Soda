'use strict';

const crypto = require('node:crypto');
const security = require('./security');

const ROLES = Object.freeze(['customer', 'admin', 'merchandiser', 'warehouse', 'csr', 'finance']);
const STAFF_ROLES = Object.freeze(['admin', 'merchandiser', 'warehouse', 'csr', 'finance']);
const SESSION_COOKIE_NAME = 'solis_session';
const GUEST_CART_COOKIE_NAME = 'solis_cart';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GUEST_CART_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sendAuthError(res, statusCode, error, code = 'AUTH_ERROR') {
  const payload = JSON.stringify({ ok: false, error, code });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function hashSessionToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

/**
 * Create a new database session with an opaque token and per-session CSRF token.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {{ ttlMs?: number }} [opts]
 */
function createSession(db, userId, opts = {}) {
  const ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();

  const sessionId = `ses_${crypto.randomBytes(12).toString('hex')}`;
  const rawToken = security.generateToken(32);
  const tokenHash = hashSessionToken(rawToken);
  const csrfToken = security.generateCsrfToken();

  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, userId, tokenHash, csrfToken, expiresAt, nowIso);

  return {
    id: sessionId,
    userId,
    rawToken,
    csrfToken,
    expiresAt
  };
}

function setSessionCookie(res, rawToken, opts = {}) {
  const signed = security.signValue(rawToken);
  const maxAge = opts.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000);
  const cookie = security.serializeCookie(SESSION_COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
    secure: opts.secure
  });
  security.appendSetCookie(res, cookie);
}

function clearSessionCookie(res) {
  const cookie = security.serializeCookie(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0
  });
  security.appendSetCookie(res, cookie);
}

function readGuestCartToken(req) {
  const cookies = security.parseCookies(req);
  const signed = cookies[GUEST_CART_COOKIE_NAME];
  if (!signed) return null;
  const token = security.verifySignedValue(signed);
  return token && /^[a-zA-Z0-9_-]{16,128}$/.test(token) ? token : null;
}

function setGuestCartCookie(res, guestToken, opts = {}) {
  const signed = security.signValue(guestToken);
  const cookie = security.serializeCookie(GUEST_CART_COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: opts.maxAgeSeconds ?? GUEST_CART_MAX_AGE_SEC,
    secure: opts.secure
  });
  security.appendSetCookie(res, cookie);
}

function clearGuestCartCookie(res) {
  const cookie = security.serializeCookie(GUEST_CART_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0
  });
  security.appendSetCookie(res, cookie);
}

function ensureGuestCartToken(req, res) {
  const existing = readGuestCartToken(req);
  if (existing) return existing;
  const fresh = `cart_${crypto.randomBytes(18).toString('base64url')}`;
  setGuestCartCookie(res, fresh);
  return fresh;
}

/**
 * Authenticate the current HTTP request from its signed session cookie.
 * Returns null if unauthenticated, invalid, or expired.
 * @param {import('http').IncomingMessage} req
 * @param {import('node:sqlite').DatabaseSync} db
 */
function authenticateRequest(req, db) {
  const cookies = security.parseCookies(req);
  const signed = cookies[SESSION_COOKIE_NAME];
  if (!signed) return null;

  const rawToken = security.verifySignedValue(signed);
  if (!rawToken) return null;

  const tokenHash = hashSessionToken(rawToken);
  const row = db.prepare(
    `SELECT
       s.id AS session_id,
       s.csrf_token AS csrf_token,
       s.expires_at AS expires_at,
       u.id AS user_id,
       u.name AS user_name,
       u.email AS user_email,
       u.role AS user_role,
       u.created_at AS user_created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(tokenHash);

  if (!row) return null;

  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }

  return {
    user: {
      id: Number(row.user_id),
      name: String(row.user_name),
      email: String(row.user_email),
      role: String(row.user_role),
      createdAt: String(row.user_created_at)
    },
    session: {
      id: String(row.session_id),
      csrfToken: String(row.csrf_token),
      expiresAt: String(row.expires_at)
    }
  };
}

function revokeSessionById(db, sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function revokeSessionFromRequest(req, db) {
  const auth = authenticateRequest(req, db);
  if (auth) {
    revokeSessionById(db, auth.session.id);
  }
  return auth;
}

function isMutatingMethod(method) {
  return MUTATING_METHODS.has(String(method || 'GET').toUpperCase());
}

/**
 * Verify CSRF token for an authenticated session on mutating requests.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ session: { csrfToken: string } }} auth
 * @param {object|null} [body]
 * @returns {boolean}
 */
function requireCsrf(req, res, auth, body = null) {
  if (!isMutatingMethod(req.method)) return true;
  const fallback = body && typeof body._csrf === 'string' ? body._csrf : null;
  if (security.verifyCsrfToken(req, auth?.session?.csrfToken, fallback)) {
    return true;
  }
  sendAuthError(res, 403, 'Invalid or missing CSRF token', 'CSRF_INVALID');
  return false;
}

/**
 * RBAC middleware factory.
 * Accepts `requireRole('admin', 'warehouse')`, `requireRole(['admin', 'warehouse'])`,
 * or `requireRole(['admin', 'warehouse'], { csrf: true })`.
 *
 * Returns a handler `(req, res, ctx = {}, next?)` that:
 * - Writes 401/403 JSON and returns `null` when rejected
 * - Attaches `req.auth` / `req.user` and calls `next(auth)` (or returns `auth`) when permitted.
 */
function requireRole(...args) {
  let allowedRoles = [];
  let options = { csrf: true };

  if (args.length > 0 && Array.isArray(args[0])) {
    allowedRoles = args[0].map(String);
    if (args[1] && typeof args[1] === 'object') {
      options = { ...options, ...args[1] };
    }
  } else {
    const last = args[args.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last)) {
      options = { ...options, ...last };
      allowedRoles = args.slice(0, -1).map(String);
    } else {
      allowedRoles = args.map(String);
    }
  }

  return function roleGuard(req, res, ctxOrNext = {}, maybeNext) {
    let ctx = {};
    let next = null;
    if (typeof ctxOrNext === 'function') {
      next = ctxOrNext;
    } else if (ctxOrNext && typeof ctxOrNext === 'object') {
      ctx = ctxOrNext;
      if (typeof maybeNext === 'function') next = maybeNext;
    }

    const db = ctx.db || require('./db').getDb();
    const auth = req.auth || authenticateRequest(req, db);
    if (!auth) {
      sendAuthError(res, 401, 'Authentication required', 'UNAUTHENTICATED');
      return null;
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(auth.user.role)) {
      sendAuthError(res, 403, 'Forbidden: insufficient role permissions', 'FORBIDDEN');
      return null;
    }

    if (options.csrf !== false && isMutatingMethod(req.method)) {
      if (!requireCsrf(req, res, auth, ctx.body || null)) {
        return null;
      }
    }

    req.auth = auth;
    req.user = auth.user;

    if (next) return next(auth);
    return auth;
  };
}

/**
 * Require any authenticated user (optionally enforcing CSRF on mutating requests).
 */
function requireAuth(req, res, ctx = {}, next) {
  return requireRole([], { csrf: ctx?.csrf !== false })(req, res, ctx, next);
}

module.exports = {
  ROLES,
  STAFF_ROLES,
  SESSION_COOKIE_NAME,
  GUEST_CART_COOKIE_NAME,
  SESSION_TTL_MS,
  hashSessionToken,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  readGuestCartToken,
  setGuestCartCookie,
  clearGuestCartCookie,
  ensureGuestCartToken,
  authenticateRequest,
  revokeSessionById,
  revokeSessionFromRequest,
  requireCsrf,
  requireRole,
  requireAuth,
  hashPassword: security.hashPassword,
  verifyPassword: security.verifyPassword
};

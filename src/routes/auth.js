'use strict';

const dbMod = require('../db');
const authMod = require('../auth');
const security = require('../security');
const utils = require('./utils');

// Precomputed dummy scrypt hash to equalize login timing when email is not found.
const DUMMY_PASSWORD_HASH = security.hashPassword('SolisTimingDummy2026!');

const authRateLimiter = security.createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.SOLIS_AUTH_RATE_LIMIT ?? 60)
});

function enforceAuthRateLimit(req, res) {
  const ip = security.getClientIp(req);
  const verdict = authRateLimiter.consume(`auth:${ip}`);
  if (!verdict.allowed) {
    res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    utils.sendError(res, 429, 'Too many authentication attempts. Please try again shortly.', 'RATE_LIMITED');
    return false;
  }
  return true;
}

async function handleAuthRoutes(req, res, method, pathname, db) {
  if (method === 'GET' && pathname === '/api/auth/me') {
    const auth = authMod.authenticateRequest(req, db);
    if (!auth) {
      utils.sendJson(res, 200, {
        ok: true,
        authenticated: false,
        user: null,
        csrfToken: null
      });
      return true;
    }
    utils.sendJson(res, 200, {
      ok: true,
      authenticated: true,
      user: auth.user,
      csrfToken: auth.session.csrfToken
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/auth/register') {
    if (!enforceAuthRateLimit(req, res)) return true;

    const { body } = await utils.readJsonBody(req);
    const nameCheck = security.validateNonEmptyString(body.name, { minLen: 1, maxLen: 120, field: 'Name' });
    if (!nameCheck.ok) {
      utils.sendError(res, 400, nameCheck.error, 'VALIDATION_ERROR');
      return true;
    }

    if (!security.isValidEmail(body.email)) {
      utils.sendError(res, 400, 'Please enter a valid email address', 'INVALID_EMAIL');
      return true;
    }
    const email = security.normalizeEmail(body.email);

    const pwCheck = security.validatePassword(body.password);
    if (!pwCheck.ok) {
      utils.sendError(res, 400, pwCheck.error, 'INVALID_PASSWORD');
      return true;
    }

    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email);
    if (existing) {
      utils.sendError(res, 409, 'An account with this email already exists', 'EMAIL_EXISTS');
      return true;
    }

    const guestToken = authMod.readGuestCartToken(req);
    const passwordHash = security.hashPassword(pwCheck.value);
    const nowIso = new Date().toISOString();

    const created = dbMod.withTransaction(db, () => {
      const insertRes = db.prepare(
        `INSERT INTO users (name, email, password_hash, role, created_at)
         VALUES (?, ?, ?, 'customer', ?)`
      ).run(nameCheck.value, email, passwordHash, nowIso);
      const userId = Number(insertRes.lastInsertRowid);

      const session = authMod.createSession(db, userId);
      if (guestToken) {
        dbMod.mergeGuestCartToUser(db, guestToken, userId);
      }

      dbMod.writeAuditLog(db, {
        actorId: userId,
        actorEmail: email,
        actorRole: 'customer',
        action: 'user.register',
        targetType: 'user',
        targetId: String(userId),
        details: { role: 'customer' }
      });

      dbMod.queueNotification(db, {
        toEmail: email,
        subject: 'Welcome to SOLIS Botanical Soda',
        body: `Hi ${nameCheck.value},\n\nYour SOLIS customer account is active. You can now save delivery addresses, manage recurring Build-a-Box subscriptions, and track cold-chain shipments.\n\n— SOLIS`,
        type: 'welcome',
        referenceId: String(userId)
      });

      const userRow = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(userId);
      return { user: utils.formatUser(dbMod.toPlain(userRow)), session };
    });

    authMod.setSessionCookie(res, created.session.rawToken);
    if (guestToken) {
      authMod.clearGuestCartCookie(res);
    }

    utils.sendJson(res, 201, {
      ok: true,
      user: created.user,
      csrfToken: created.session.csrfToken
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    if (!enforceAuthRateLimit(req, res)) return true;

    const { body } = await utils.readJsonBody(req);
    if (!security.isValidEmail(body.email)) {
      utils.sendError(res, 400, 'Please enter a valid email address', 'INVALID_EMAIL');
      return true;
    }
    if (typeof body.password !== 'string' || body.password.length === 0) {
      utils.sendError(res, 400, 'Password is required', 'VALIDATION_ERROR');
      return true;
    }

    const email = security.normalizeEmail(body.email);
    const userRow = dbMod.toPlain(db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email));
    if (!userRow) {
      security.verifyPassword(body.password, DUMMY_PASSWORD_HASH);
      utils.sendError(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');
      return true;
    }

    const passwordValid = security.verifyPassword(body.password, userRow.password_hash);
    if (!passwordValid) {
      utils.sendError(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');
      return true;
    }

    const guestToken = authMod.readGuestCartToken(req);

    const result = dbMod.withTransaction(db, () => {
      const session = authMod.createSession(db, Number(userRow.id));
      if (guestToken) {
        dbMod.mergeGuestCartToUser(db, guestToken, Number(userRow.id));
      }
      dbMod.writeAuditLog(db, {
        actorId: Number(userRow.id),
        actorEmail: userRow.email,
        actorRole: userRow.role,
        action: 'auth.login',
        targetType: 'session',
        targetId: session.id,
        details: { mergedGuestCart: Boolean(guestToken) }
      });
      return { session };
    });

    authMod.setSessionCookie(res, result.session.rawToken);
    if (guestToken) {
      authMod.clearGuestCartCookie(res);
    }

    utils.sendJson(res, 200, {
      ok: true,
      user: utils.formatUser(userRow),
      csrfToken: result.session.csrfToken
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const { body } = await utils.readJsonBody(req, { optional: true });
    const auth = authMod.authenticateRequest(req, db);
    if (auth) {
      if (!authMod.requireCsrf(req, res, auth, body)) {
        return true;
      }
      authMod.revokeSessionById(db, auth.session.id);
      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'auth.logout',
        targetType: 'session',
        targetId: auth.session.id
      });
    }
    authMod.clearSessionCookie(res);
    utils.sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleAuthRoutes };

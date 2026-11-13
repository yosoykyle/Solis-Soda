'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dbMod = require('./src/db');
const security = require('./src/security');
const utils = require('./src/routes/utils');
const { handleAuthRoutes } = require('./src/routes/auth');
const { handleAccountRoutes } = require('./src/routes/account');
const { handleStorefrontRoutes } = require('./src/routes/storefront');
const { handleOpsRoutes } = require('./src/routes/ops');

const ROOT_DIR = __dirname;

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
});

const PUBLIC_EXACT_FILES = new Set([
  'index.html',
  'styles.css',
  'app.js',
  'robots.txt',
  'favicon.ico',
  'favicon.svg'
]);

const PUBLIC_DIRS = ['css/', 'js/', 'assets/', 'images/', 'fonts/'];
const PUBLIC_ASSET_EXTS = new Set([
  '.css',
  '.js',
  '.mjs',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
  '.txt',
  '.woff2',
  '.map'
]);

const BLOCKED_EXACT = new Set([
  'server.js',
  'package.json',
  'package-lock.json',
  'src',
  'tests',
  'data',
  'node_modules'
]);

const BLOCKED_PREFIXES = ['src/', 'tests/', 'data/', 'node_modules/'];

const apiRateLimiter = security.createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.SOLIS_API_RATE_LIMIT ?? 400)
});

function isForbiddenStaticPath(rawPathname) {
  if (!rawPathname || rawPathname.includes('\0') || rawPathname.includes('\\')) return true;
  const segments = rawPathname.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg.startsWith('.')) return true;
  }
  const rel = segments.join('/');
  const lower = rel.toLowerCase();
  if (BLOCKED_EXACT.has(lower)) return true;
  if (BLOCKED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return false;
}

function isAllowedPublicFile(relPosix) {
  const lower = relPosix.toLowerCase();
  if (PUBLIC_EXACT_FILES.has(lower)) return true;
  const inAllowedDir = PUBLIC_DIRS.some((dir) => lower.startsWith(dir));
  if (!inAllowedDir) return false;
  const ext = path.posix.extname(lower);
  return PUBLIC_ASSET_EXTS.has(ext);
}

function serveStatic(req, res, method, pathname) {
  if (isForbiddenStaticPath(pathname)) {
    utils.sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const normalizedPosix = path.posix.normalize(relativePath).replace(/^\/+/, '');
  if (isForbiddenStaticPath('/' + normalizedPosix)) {
    utils.sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    return;
  }

  if (!isAllowedPublicFile(normalizedPosix)) {
    utils.sendError(res, 404, 'Not found', 'NOT_FOUND');
    return;
  }

  const resolved = path.resolve(ROOT_DIR, normalizedPosix);
  if (resolved !== ROOT_DIR && !resolved.startsWith(ROOT_DIR + path.sep)) {
    utils.sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    return;
  }

  fs.stat(resolved, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      utils.sendError(res, 404, 'Not found', 'NOT_FOUND');
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });

    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(resolved);
    stream.on('error', () => {
      if (!res.headersSent) {
        utils.sendError(res, 500, 'Failed to read static file', 'STATIC_READ_ERROR');
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

function createAppServer() {
  dbMod.initDb();

  return http.createServer(async (req, res) => {
    security.applySecurityHeaders(res, { includeCsp: true });

    let url;
    let pathname;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      utils.sendError(res, 400, 'Malformed request URL', 'INVALID_URL');
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();

    if (pathname.startsWith('/api/')) {
      const ip = security.getClientIp(req);
      const rate = apiRateLimiter.consume(`api:${ip}`);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        utils.sendError(res, 429, 'Too many API requests', 'RATE_LIMITED');
        return;
      }

      const db = dbMod.getDb();
      try {
        if (await handleAuthRoutes(req, res, method, pathname, db)) return;
        if (await handleAccountRoutes(req, res, method, pathname, db)) return;
        if (await handleStorefrontRoutes(req, res, method, pathname, url, db)) return;
        if (await handleOpsRoutes(req, res, method, pathname, url, db)) return;
        utils.sendError(res, 404, 'API endpoint not found', 'NOT_FOUND');
      } catch (err) {
        utils.handleRouteError(res, err);
      }
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      utils.sendError(res, 405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
      return;
    }

    serveStatic(req, res, method, pathname);
  });
}

function startServer() {
  const port = process.env.PORT !== undefined ? Number(process.env.PORT) : 4174;
  const server = createAppServer();

  server.listen(port, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`SOLIS server listening on http://localhost:${boundPort}`);
  });

  const shutdown = () => {
    server.close(() => {
      dbMod.closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createAppServer,
  startServer
};

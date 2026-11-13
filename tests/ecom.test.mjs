import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 4176;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess = null;
let tempDir = null;
let tempDbPath = null;

class CookieClient {
  constructor() {
    this.cookies = new Map();
    this.csrfToken = null;
  }

  updateFromResponse(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    for (const header of setCookies) {
      const [pair] = header.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (!val || /Max-Age=0/i.test(header)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, val);
      }
    }
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(urlPath, { method = 'GET', body, headers = {}, rawBody } = {}) {
    const reqHeaders = { Accept: 'application/json', ...headers };
    const cookie = this.cookieHeader();
    if (cookie) reqHeaders.Cookie = cookie;
    if (this.csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !reqHeaders['X-CSRF-Token']) {
      reqHeaders['X-CSRF-Token'] = this.csrfToken;
    }

    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers: reqHeaders,
      body: payload,
    });
    this.updateFromResponse(res);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON response (HTML, CSS, CSV)
    }
    if (json && typeof json.csrfToken === 'string') {
      this.csrfToken = json.csrfToken;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  async login(email, password = 'SolisDemo2026!') {
    const res = await this.request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${res.text}`);
    assert.equal(res.json.ok, true);
    assert.ok(this.csrfToken, 'Expected csrfToken after login');
    return res.json;
  }
}

async function waitForHealth(timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server failed health check: ${lastErr?.message ?? 'timeout'}`);
}

describe('SOLIS Full E-Commerce Foundation (Isolated Temp DB)', () => {
  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'solis-ecom-test-'));
    tempDbPath = path.join(tempDir, 'solis-test.db');
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: tempDbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth();
  });

  after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
      const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
      serverProcess.kill('SIGTERM');
      setTimeout(() => {
        if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
      }, 2000);
      await exited;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('Security headers, static allowlist blocks, and public storefront', async () => {
    const home = await fetch(`${BASE_URL}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.ok(home.headers.get('content-security-policy'));

    for (const blocked of ['/src/db.js', '/tests/ecom.test.mjs', '/data/solis.db', '/package.json', '/server.js', '/.env']) {
      const res = await fetch(`${BASE_URL}${blocked}`);
      assert.ok(res.status === 403 || res.status === 404, `Expected ${blocked} to be blocked, got ${res.status}`);
    }

    const policies = await (await fetch(`${BASE_URL}/api/policies`)).json();
    assert.equal(policies.ok, true);
    const shippingPolicy = await (await fetch(`${BASE_URL}/api/policies/shipping`)).json();
    assert.equal(shippingPolicy.ok, true);
  });

  test('Strict integer validation & duplicate-SKU cap enforcement', async () => {
    const guest = new CookieClient();
    for (const badQty of [null, true, false, 1.5, [], {}, '']) {
      const res = await guest.request('/api/cart', {
        method: 'POST',
        body: { sku: 'SOLIS-BO-12', quantity: badQty },
      });
      assert.equal(res.status, 400, `Expected 400 for quantity=${JSON.stringify(badQty)}, got ${res.status}`);
    }

    // Add 6, then 5 -> aggregated 11 > 10 cap -> 400
    const add6 = await guest.request('/api/cart', {
      method: 'POST',
      body: { sku: 'SOLIS-BO-12', quantity: 6 },
    });
    assert.equal(add6.status, 200);
    const add5 = await guest.request('/api/cart', {
      method: 'POST',
      body: { sku: 'SOLIS-BO-12', quantity: 5 },
    });
    assert.equal(add5.status, 400);

    // Warehouse adjust strict int check
    const wh = new CookieClient();
    await wh.login('warehouse@solis.drink');
    const badDelta = await wh.request('/api/ops/inventory/adjust', {
      method: 'POST',
      body: { sku: 'SOLIS-BO-12', delta: null, reason: 'recount' },
    });
    assert.equal(badDelta.status, 400);
  });

  test('Auth, CSRF enforcement, and RBAC isolation', async () => {
    const anon = new CookieClient();
    assert.equal((await anon.request('/api/ops/orders')).status, 401);
    assert.equal((await anon.request('/api/account/orders')).status, 401);

    const customer = new CookieClient();
    await customer.login('customer@solis.drink');

    // Customer cannot access staff ops
    assert.equal((await customer.request('/api/ops/orders')).status, 403);
    assert.equal((await customer.request('/api/ops/finance/ledger')).status, 403);

    // Authenticated mutation without CSRF token -> 403
    const savedCsrf = customer.csrfToken;
    customer.csrfToken = null;
    const noCsrf = await customer.request('/api/account/addresses', {
      method: 'POST',
      headers: { 'X-CSRF-Token': '' },
      body: { line1: '100 Ice Way', city: 'San Francisco', postal: '94107' },
    });
    assert.equal(noCsrf.status, 403);
    customer.csrfToken = savedCsrf;

    // Warehouse cannot access finance
    const wh = new CookieClient();
    await wh.login('warehouse@solis.drink');
    assert.equal((await wh.request('/api/ops/finance/ledger')).status, 403);
    assert.equal((await wh.request('/api/ops/orders')).status, 200);
  });

  test('Full commerce lifecycle: Cart merge, BOM Variety 12-Pack FEFO stock, Quote, Payment HMAC + Replay, Idempotent Order, OMS & Tracking', async () => {
    // Check initial stock of Blood Orange 12-Pack
    const beforeProd = await (await fetch(`${BASE_URL}/api/products`)).json();
    const boProduct = beforeProd.products.find((p) => p.slug === 'blood-orange');
    const bo12 = boProduct.variants.find((v) => v.sku === 'SOLIS-BO-12');
    const initialBo12Stock = bo12.available;

    // 1. Guest adds Variety 12-Pack BOM bundle to cart, then logs in -> cart merges
    const shopper = new CookieClient();
    const cartAdd = await shopper.request('/api/cart', {
      method: 'POST',
      body: { sku: 'SOLIS-VAR-12', quantity: 1 },
    });
    assert.equal(cartAdd.status, 200);
    assert.equal(cartAdd.json.cart.itemCount, 1);

    await shopper.login('customer@solis.drink');
    const mergedCart = await shopper.request('/api/cart');
    assert.equal(mergedCart.status, 200);
    assert.ok(mergedCart.json.cart.items.some((it) => it.sku === 'SOLIS-VAR-12' && it.quantity >= 1));

    // 2. Quote with SOLIS10 (subtotal $34 = 3400c, 10% = 340c, net 3060c < 3500c -> shipping 600c, tax 8.25% of 3060c = 252c)
    const quoteRes = await shopper.request('/api/checkout/quote', {
      method: 'POST',
      body: { items: [{ sku: 'SOLIS-VAR-12', quantity: 1 }], promoCode: 'SOLIS10' },
    });
    assert.equal(quoteRes.status, 200);
    assert.equal(quoteRes.json.subtotalCents, 3400);
    assert.equal(quoteRes.json.discountCents, 340);
    assert.equal(quoteRes.json.shippingCents, 600);
    assert.ok(Number.isInteger(quoteRes.json.taxCents) && quoteRes.json.taxCents > 0);
    assert.equal(
      quoteRes.json.totalCents,
      quoteRes.json.discountedSubtotalCents + quoteRes.json.shippingCents + quoteRes.json.taxCents
    );

    // 3. PaymentIntent idempotency + HMAC webhook + replay protection
    const piKey = `pi-test-${Date.now()}`;
    const piRes = await shopper.request('/api/payments/intent', {
      method: 'POST',
      headers: { 'Idempotency-Key': piKey },
      body: { items: [{ sku: 'SOLIS-VAR-12', quantity: 1 }], promoCode: 'SOLIS10' },
    });
    assert.equal(piRes.status, 201);
    const piReplay = await shopper.request('/api/payments/intent', {
      method: 'POST',
      headers: { 'Idempotency-Key': piKey },
      body: { items: [{ sku: 'SOLIS-VAR-12', quantity: 1 }], promoCode: 'SOLIS10' },
    });
    assert.equal(piReplay.status, 200);
    assert.equal(piReplay.json.idempotentReplay, true);

    const { signature, rawPayload } = piRes.json.webhookSimulation;
    const badSig = await shopper.request('/api/payments/webhook', {
      method: 'POST',
      headers: { 'X-Solis-Signature': 'bad-signature' },
      rawBody: rawPayload,
    });
    assert.equal(badSig.status, 401);

    const goodHook = await shopper.request('/api/payments/webhook', {
      method: 'POST',
      headers: { 'X-Solis-Signature': signature },
      rawBody: rawPayload,
    });
    assert.equal(goodHook.status, 200);
    assert.equal(goodHook.json.processed, true);
    assert.equal(goodHook.json.deduplicated, false);

    const replayHook = await shopper.request('/api/payments/webhook', {
      method: 'POST',
      headers: { 'X-Solis-Signature': signature },
      rawBody: rawPayload,
    });
    assert.equal(replayHook.status, 200);
    assert.equal(replayHook.json.deduplicated, true);

    // 4. Idempotent Order creation + BOM FEFO stock decrement
    const orderKey = `ord-test-${Date.now()}`;
    const orderBody = {
      customer: {
        name: 'Ada Lovelace',
        email: 'customer@solis.drink',
        address: '101 Porcelain Way',
        city: 'San Francisco',
        postal: '94107',
      },
      items: [{ sku: 'SOLIS-VAR-12', quantity: 1 }],
      promoCode: 'SOLIS10',
      paymentIntentId: piRes.json.paymentIntent.id,
    };
    const orderRes = await shopper.request('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': orderKey },
      body: orderBody,
    });
    assert.equal(orderRes.status, 201);
    const orderId = orderRes.json.id;
    assert.match(orderId, /^SOLIS-/);
    assert.equal(orderRes.json.orderStatus, 'confirmed');
    assert.equal(orderRes.json.paymentStatus, 'paid');
    assert.equal(orderRes.json.fulfillmentStatus, 'allocated');

    // Replay order with same Idempotency-Key -> 200, no double stock decrement
    const orderReplay = await shopper.request('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': orderKey },
      body: orderBody,
    });
    assert.equal(orderReplay.status, 200);
    assert.equal(orderReplay.json.id, orderId);

    const afterProd = await (await fetch(`${BASE_URL}/api/products`)).json();
    const afterBo12 = afterProd.products.find((p) => p.slug === 'blood-orange').variants.find((v) => v.sku === 'SOLIS-BO-12');
    assert.equal(afterBo12.available, initialBo12Stock - 1, 'BOM Variety 12-Pack should decrement component 12-Pack stock by 1');

    // 5. Guest Order Tracking verification
    const wrongTrack = await fetch(`${BASE_URL}/api/orders/track?id=${encodeURIComponent(orderId)}&email=wrong@solis.drink`);
    assert.ok(wrongTrack.status === 403 || wrongTrack.status === 404);
    const goodTrack = await fetch(`${BASE_URL}/api/orders/track?id=${encodeURIComponent(orderId)}&email=customer@solis.drink`);
    assert.equal(goodTrack.status, 200);

    // 6. Warehouse OMS transitions: invalid confirmed->delivered rejected, valid confirmed->packed->shipped->delivered
    const wh = new CookieClient();
    await wh.login('warehouse@solis.drink');
    const badTrans = await wh.request(`/api/ops/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { orderStatus: 'delivered' },
    });
    assert.equal(badTrans.status, 400);

    const packRes = await wh.request(`/api/ops/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { orderStatus: 'packed' },
    });
    assert.equal(packRes.status, 200);
    assert.equal(packRes.json.order.orderStatus, 'packed');

    const shipRes = await wh.request(`/api/ops/orders/${orderId}/ship`, {
      method: 'POST',
      body: { carrier: 'ColdExpress', trackingNumber: 'CE-998877', coldChainPack: true },
    });
    assert.equal(shipRes.status, 200);
    assert.equal(shipRes.json.order.orderStatus, 'shipped');
    assert.equal(shipRes.json.order.fulfillmentStatus, 'shipped');

    const delivRes = await wh.request(`/api/ops/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { orderStatus: 'delivered' },
    });
    assert.equal(delivRes.status, 200);
    assert.equal(delivRes.json.order.orderStatus, 'delivered');

    // 7. Customer RMA damaged-can workflow + CSR approval/refund
    const rmaRes = await shopper.request(`/api/account/orders/${orderId}/return`, {
      method: 'POST',
      body: { reason: 'Damaged cans in transit', items: [{ sku: 'SOLIS-VAR-12', quantity: 1 }] },
    });
    assert.equal(rmaRes.status, 201);
    const rmaId = rmaRes.json.rma.id;

    const csr = new CookieClient();
    await csr.login('csr@solis.drink');
    const csrPatch = await csr.request(`/api/ops/returns/${rmaId}`, {
      method: 'PATCH',
      body: { status: 'refunded', resolution: 'Full refund issued' },
    });
    assert.equal(csrPatch.status, 200);
    assert.equal(csrPatch.json.rma.status, 'refunded');
  });

  test('Order Cancel + Stock Restore + Subscriptions + Finance CSV + Outbox/Audit', async () => {
    const shopper = new CookieClient();
    await shopper.login('customer@solis.drink');

    // Place a 6-pack order & cancel it
    const piRes = await shopper.request('/api/payments/intent', {
      method: 'POST',
      headers: { 'Idempotency-Key': `pi-cancel-${Date.now()}` },
      body: { items: [{ sku: 'SOLIS-BO-06', quantity: 2 }] },
    });
    assert.equal(piRes.status, 201);
    await shopper.request('/api/payments/webhook', {
      method: 'POST',
      headers: { 'X-Solis-Signature': piRes.json.webhookSimulation.signature },
      rawBody: piRes.json.webhookSimulation.rawPayload,
    });

    const beforeStock = (await (await fetch(`${BASE_URL}/api/products`)).json())
      .products.find((p) => p.slug === 'blood-orange')
      .variants.find((v) => v.sku === 'SOLIS-BO-06').available;

    const ordRes = await shopper.request('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': `ord-cancel-${Date.now()}` },
      body: {
        customer: { name: 'Ada', email: 'customer@solis.drink', address: '101 Porcelain Way', city: 'SF', postal: '94107' },
        items: [{ sku: 'SOLIS-BO-06', quantity: 2 }],
        paymentIntentId: piRes.json.paymentIntent.id,
      },
    });
    assert.equal(ordRes.status, 201);

    const cancelRes = await shopper.request(`/api/account/orders/${ordRes.json.id}/cancel`, {
      method: 'POST',
      body: { reason: 'Changed my mind' },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json.order.orderStatus, 'cancelled');
    assert.equal(cancelRes.json.order.paymentStatus, 'refunded');

    const afterStock = (await (await fetch(`${BASE_URL}/api/products`)).json())
      .products.find((p) => p.slug === 'blood-orange')
      .variants.find((v) => v.sku === 'SOLIS-BO-06').available;
    assert.equal(afterStock, beforeStock, 'Cancelling order should restore FEFO stock');

    // Subscriptions
    const subCreate = await shopper.request('/api/account/subscriptions', {
      method: 'POST',
      body: { cadence: '2-week', items: [{ sku: 'SOLIS-YL-12', quantity: 1 }] },
    });
    assert.equal(subCreate.status, 201);
    const subId = subCreate.json.subscription.id;
    const subPause = await shopper.request(`/api/account/subscriptions/${subId}`, {
      method: 'PATCH',
      body: { action: 'pause' },
    });
    assert.equal(subPause.status, 200);
    assert.equal(subPause.json.subscription.status, 'paused');

    // Admin outbox & audit logs
    const admin = new CookieClient();
    await admin.login('admin@solis.drink');
    const outbox = await admin.request('/api/ops/outbox');
    assert.equal(outbox.status, 200);
    assert.ok(outbox.json.outbox.length >= 1);
    const audits = await admin.request('/api/ops/audit-logs');
    assert.equal(audits.status, 200);
    assert.ok(audits.json.logs.length >= 1);

    // Finance ledger & CSV export
    const finance = new CookieClient();
    await finance.login('finance@solis.drink');
    const ledger = await finance.request('/api/ops/finance/ledger');
    assert.equal(ledger.status, 200);
    assert.equal(typeof ledger.json.summary.grossRevenueCents, 'number');
    const csv = await finance.request('/api/ops/finance/export.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/i);
    assert.match(csv.text, /^Date,Entry Type,Reference ID,Order ID,/);
    assert.match(csv.text, /'-4114/);
  });
});

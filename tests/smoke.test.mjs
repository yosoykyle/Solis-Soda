import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 4175;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RESERVATIONS_PATH = path.join(PROJECT_ROOT, 'data', 'reservations.json');
const ORDERS_PATH = path.join(PROJECT_ROOT, 'data', 'orders.json');

async function waitForHealth(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }, 2000);
  await exited;
  clearTimeout(timer);
}

async function run() {
  let stderr = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const initialStockById = new Map();

  try {
    await waitForHealth(5000);
    console.log(`[PASS] Server started on ${BASE_URL}`);

    // 1. Static files
    {
      const res = await fetch(`${BASE_URL}/`);
      assert.equal(res.status, 200, 'GET / status');
      assert.match(res.headers.get('content-type') || '', /text\/html/i);
      const html = await res.text();
      assert.match(html, /id="bag-drawer"/);
      assert.match(html, /id="ops-drawer"/);
      assert.match(html, /id="track-form"/);
      console.log('[PASS] GET / (200 text/html, bag drawer, ops drawer, track form present)');
    }
    {
      const res = await fetch(`${BASE_URL}/styles.css`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/css/i);
      console.log('[PASS] GET /styles.css (200 text/css)');
    }
    {
      const res = await fetch(`${BASE_URL}/app.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /javascript/i);
      console.log('[PASS] GET /app.js (200 javascript)');
    }

    // 2. GET /api/health
    {
      const res = await fetch(`${BASE_URL}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, service: 'solis-api' });
      console.log('[PASS] GET /api/health -> { ok: true, service: "solis-api" }');
    }

    // 3. GET /api/flavors
    let flavors;
    {
      const res = await fetch(`${BASE_URL}/api/flavors`);
      assert.equal(res.status, 200);
      flavors = await res.json();
      assert.ok(Array.isArray(flavors) && flavors.length === 4);
      for (const f of flavors) {
        assert.equal(typeof f.id, 'string');
        assert.equal(typeof f.name, 'string');
        assert.equal(typeof f.calories, 'number');
        assert.equal(typeof f.price, 'number');
        assert.equal(typeof f.tag, 'string');
        assert.equal(typeof f.stock, 'number');
        assert.equal(typeof f.inStock, 'boolean');
        initialStockById.set(f.id, f.stock);
      }
      console.log('[PASS] GET /api/flavors (4 flavors with stock & inStock)');
    }

    // 4. POST /api/orders (valid + SOLIS10 promo + stock decrement)
    let createdOrderId = null;
    {
      // blood-orange is $34 * 1 = $34; with SOLIS10 (10% = $3.40), net = $30.60 (< $35 => $6 shipping => $36.60)
      const res = await fetch(`${BASE_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: {
            name: 'Ada Lovelace',
            email: 'ada@solis.test',
            address: '101 Porcelain Way',
            city: 'San Francisco',
            postal: '94107',
          },
          items: [{ id: 'blood-orange', quantity: 1 }],
          promoCode: 'SOLIS10',
        }),
      });
      assert.equal(res.status, 201, 'POST /api/orders valid status');
      const order = await res.json();
      assert.equal(order.ok, true);
      assert.match(order.id, /^SOLIS-/);
      assert.equal(order.status, 'confirmed');
      assert.equal(order.subtotal, 34);
      assert.equal(order.discount, 3.4);
      assert.equal(order.shipping, 6);
      assert.equal(order.total, 36.6);
      createdOrderId = order.id;

      // Verify stock decremented
      const flavorsAfter = await (await fetch(`${BASE_URL}/api/flavors`)).json();
      const bloodOrange = flavorsAfter.find((f) => f.id === 'blood-orange');
      assert.equal(bloodOrange.stock, initialStockById.get('blood-orange') - 1);
      console.log(`[PASS] POST /api/orders valid + SOLIS10 -> 201 (${createdOrderId}, total=$${order.total}, stock decremented)`);
    }

    // 5. POST /api/orders (400 invalid input)
    {
      const res = await fetch(`${BASE_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: { name: '', email: 'bad-email', address: '', city: '', postal: '' },
          items: [{ id: 'blood-orange', quantity: 0 }],
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
      console.log('[PASS] POST /api/orders invalid input -> 400');
    }

    // 6. PATCH /api/flavors/:id (set stock=0 -> inStock=false, then 409 out-of-stock order, then restore)
    {
      const patchZero = await fetch(`${BASE_URL}/api/flavors/yuzu-lime`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: 0 }),
      });
      assert.equal(patchZero.status, 200);
      const patched = await patchZero.json();
      assert.equal(patched.ok, true);
      assert.equal(patched.flavor.stock, 0);
      assert.equal(patched.flavor.inStock, false);

      // Attempt order for out-of-stock SKU -> 409
      const oosRes = await fetch(`${BASE_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: {
            name: 'Ada Lovelace',
            email: 'ada@solis.test',
            address: '101 Porcelain Way',
            city: 'San Francisco',
            postal: '94107',
          },
          items: [{ id: 'yuzu-lime', quantity: 1 }],
        }),
      });
      assert.equal(oosRes.status, 409, 'POST /api/orders out-of-stock -> 409');
      const oosBody = await oosRes.json();
      assert.equal(oosBody.ok, false);
      assert.equal(oosBody.itemId, 'yuzu-lime');
      assert.equal(oosBody.available, 0);
      console.log('[PASS] PATCH /api/flavors/:id (stock=0, inStock=false) + POST /api/orders out-of-stock -> 409');
    }

    // 7. GET /api/orders/:id, GET /api/orders, PATCH /api/orders/:id
    {
      const getOne = await fetch(`${BASE_URL}/api/orders/${createdOrderId}`);
      assert.equal(getOne.status, 200);
      const oneBody = await getOne.json();
      assert.equal(oneBody.ok, true);
      assert.equal(oneBody.order.id, createdOrderId);

      const getMissing = await fetch(`${BASE_URL}/api/orders/SOLIS-DOES-NOT-EXIST`);
      assert.equal(getMissing.status, 404);

      const getAll = await fetch(`${BASE_URL}/api/orders`);
      assert.equal(getAll.status, 200);
      const allBody = await getAll.json();
      assert.equal(allBody.ok, true);
      assert.ok(allBody.orders.some((o) => o.id === createdOrderId));

      const patchStatus = await fetch(`${BASE_URL}/api/orders/${createdOrderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'packed' }),
      });
      assert.equal(patchStatus.status, 200);
      const patchBody = await patchStatus.json();
      assert.equal(patchBody.order.status, 'packed');

      const badStatus = await fetch(`${BASE_URL}/api/orders/${createdOrderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(badStatus.status, 400);

      // Verify persisted in data/orders.json
      const rawOrders = JSON.parse(await fs.readFile(ORDERS_PATH, 'utf8'));
      const orderList = Array.isArray(rawOrders) ? rawOrders : rawOrders.orders;
      const persistedOrder = orderList.find((o) => o.id === createdOrderId);
      assert.ok(persistedOrder, 'data/orders.json persisted order');
      assert.equal(persistedOrder.status, 'packed');

      console.log(`[PASS] GET /api/orders, GET /api/orders/:id (200 & 404), PATCH /api/orders/:id (packed & 400), data/orders.json persisted`);
    }

    // 8. Backwards compatibility: POST /api/reservations
    {
      const res = await fetch(`${BASE_URL}/api/reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'qa-smoke@solis.test',
          pack: 'Variety 12-Pack (All 4 Flavors)',
          quantity: 2,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.match(body.id, /^SOLIS-/);
      const raw = JSON.parse(await fs.readFile(RESERVATIONS_PATH, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.reservations;
      assert.ok(list.some((r) => r.id === body.id));
      console.log(`[PASS] POST /api/reservations backwards compatibility -> 201 (${body.id})`);
    }

    // 9. Restore test stock cleanly
    for (const [id, stock] of initialStockById.entries()) {
      const res = await fetch(`${BASE_URL}/api/flavors/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.flavor.stock, stock);
      assert.equal(body.flavor.inStock, stock > 0);
    }
    console.log('[PASS] Restored initial flavor stock cleanly');
  } finally {
    await stopServer(server);
    if (stderr.trim()) {
      console.error('[SERVER STDERR]', stderr.trim());
    }
  }
  console.log('[PASS] Test server stopped cleanly');
}

run().catch((err) => {
  console.error('[FAIL]', err);
  process.exitCode = 1;
});

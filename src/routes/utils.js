'use strict';

const dbMod = require('../db');
const authMod = require('../auth');
const security = require('../security');

const MAX_BODY_BYTES = 128 * 1024;

function sendJson(res, statusCode, payload, extraHeaders = null) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders ?? {})
  };
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendError(res, statusCode, error, code = 'ERROR', extra = null) {
  const payload = {
    ok: false,
    error: String(error ?? 'Request failed'),
    code,
    ...(extra && typeof extra === 'object' ? extra : {})
  };
  sendJson(res, statusCode, payload);
}

function sendCsv(res, filename, headers, rows) {
  const lines = [];
  lines.push(headers.map((h) => security.sanitizeCsvCell(h)).join(','));
  for (const row of rows) {
    lines.push(row.map((cell) => security.sanitizeCsvCell(cell)).join(','));
  }
  const csvBody = lines.join('\r\n') + '\r\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(csvBody),
    'Cache-Control': 'no-store'
  });
  res.end(csvBody);
}

function readJsonBody(req, { optional = false } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const trimmed = rawBody.trim();
      if (!trimmed) {
        if (optional) {
          resolve({ body: {}, rawBody });
          return;
        }
        reject(Object.assign(new Error('Request body is required'), { statusCode: 400, code: 'EMPTY_BODY' }));
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('JSON body must be an object'), { statusCode: 400, code: 'INVALID_JSON' }));
          return;
        }
        resolve({ body: parsed, rawBody });
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400, code: 'INVALID_JSON' }));
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function httpError(statusCode, message, code = 'BAD_REQUEST', extra = null) {
  return Object.assign(new Error(message), { statusCode, code, extra });
}

function handleRouteError(res, err) {
  const statusCode = Number(err?.statusCode ?? 500);
  const code = err?.code ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  const message = statusCode >= 500 ? 'Internal server error' : String(err?.message ?? 'Request failed');
  const extra = err?.extra ?? (err?.sku || err?.available !== undefined ? {
    ...(err.variantId !== undefined ? { variantId: err.variantId } : {}),
    ...(err.sku !== undefined ? { sku: err.sku } : {}),
    ...(err.available !== undefined ? { available: err.available } : {}),
    ...(err.requested !== undefined ? { requested: err.requested } : {})
  } : null);
  if (statusCode >= 500) {
    console.error('[solis-api] route error:', err);
  }
  sendError(res, statusCode, message, code, extra);
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function formatUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role),
    createdAt: String(row.created_at ?? row.createdAt ?? '')
  };
}

function formatAddress(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    label: String(row.label),
    recipientName: String(row.recipient_name),
    line1: String(row.line1),
    line2: String(row.line2 ?? ''),
    city: String(row.city),
    state: String(row.state ?? ''),
    postal: String(row.postal),
    country: String(row.country ?? 'US'),
    isDefault: Boolean(row.is_default),
    createdAt: String(row.created_at)
  };
}

function formatPromotion(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    code: String(row.code),
    type: String(row.type),
    value: Number(row.value),
    minSubtotalCents: Number(row.min_subtotal_cents ?? 0),
    active: Boolean(row.active),
    maxUses: row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses),
    usesCount: Number(row.uses_count ?? 0),
    createdAt: String(row.created_at)
  };
}

function formatRma(row) {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    status: String(row.status),
    reason: String(row.reason),
    items: safeJsonParse(row.items_json, []),
    resolution: String(row.resolution ?? ''),
    refundCents: Number(row.refund_cents ?? 0),
    notes: String(row.notes ?? ''),
    handledBy: row.handled_by === null || row.handled_by === undefined ? null : Number(row.handled_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function formatPaymentIntent(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    orderId: row.order_id ? String(row.order_id) : null,
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    status: String(row.status),
    clientSecret: String(row.client_secret),
    webhookEventId: row.webhook_event_id ? String(row.webhook_event_id) : null,
    webhookProcessed: Boolean(row.webhook_processed),
    metadata: safeJsonParse(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function formatSubscription(db, row) {
  const rawItems = safeJsonParse(row.items_json, []);
  const variantStmt = db.prepare(
    `SELECT v.*, p.name AS product_name, p.slug AS product_slug
     FROM variants v JOIN products p ON p.id = v.product_id
     WHERE v.id = ?`
  );
  let totalCents = 0;
  const items = rawItems.map((item) => {
    const v = variantStmt.get(Number(item.variantId));
    const unitPriceCents = v ? Number(v.price_cents) : Number(item.unitPriceCents ?? 0);
    const quantity = Number(item.quantity ?? 1);
    totalCents += unitPriceCents * quantity;
    return {
      variantId: Number(item.variantId),
      sku: v ? String(v.sku) : String(item.sku ?? ''),
      productName: v ? String(v.product_name) : String(item.productName ?? ''),
      productSlug: v ? String(v.product_slug) : String(item.productSlug ?? ''),
      label: v ? String(v.label) : String(item.label ?? ''),
      quantity,
      unitPriceCents,
      lineTotalCents: unitPriceCents * quantity
    };
  });

  return {
    id: String(row.id),
    userId: Number(row.user_id),
    cadence: String(row.cadence),
    status: String(row.status),
    items,
    estimatedSubtotalCents: totalCents,
    nextRunAt: String(row.next_run_at),
    skipCount: Number(row.skip_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function resolveVariantByInput(db, entry, { requireActive = true } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw httpError(400, 'Item entry must be an object', 'INVALID_ITEM');
  }

  let row = null;
  if (entry.variantId !== undefined && entry.variantId !== null && entry.variantId !== '') {
    const parsed = security.parseStrictInt(entry.variantId, { min: 1, coerceString: true });
    if (!parsed.ok) {
      throw httpError(400, 'variantId must be a positive integer', 'INVALID_VARIANT_ID');
    }
    row = db.prepare(
      `SELECT v.*, p.slug AS product_slug, p.name AS product_name, p.active AS product_active
       FROM variants v
       JOIN products p ON p.id = v.product_id
       WHERE v.id = ?`
    ).get(parsed.value);
  } else if (typeof entry.sku === 'string' && entry.sku.trim()) {
    const sku = entry.sku.trim().toUpperCase();
    row = db.prepare(
      `SELECT v.*, p.slug AS product_slug, p.name AS product_name, p.active AS product_active
       FROM variants v
       JOIN products p ON p.id = v.product_id
       WHERE UPPER(v.sku) = ?`
    ).get(sku);
  } else {
    throw httpError(400, 'Each item must specify variantId or sku', 'MISSING_VARIANT_IDENTIFIER');
  }

  if (!row) {
    throw httpError(404, 'Variant not found', 'VARIANT_NOT_FOUND');
  }
  if (requireActive && (!row.active || !row.product_active)) {
    throw httpError(400, `Variant ${row.sku} is currently unavailable`, 'VARIANT_UNAVAILABLE');
  }

  return dbMod.toPlain(row);
}

/**
 * Validate raw order/quote item list, resolve authoritative DB prices,
 * and enforce aggregated per-SKU cap of 1..MAX_ITEM_QTY (10).
 */
function resolveAndAggregateItems(db, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw httpError(400, 'At least one item is required', 'EMPTY_ITEMS');
  }
  if (rawItems.length > 50) {
    throw httpError(400, 'Too many line items', 'TOO_MANY_ITEMS');
  }

  const aggregatedMap = new Map();

  for (const entry of rawItems) {
    const variant = resolveVariantByInput(db, entry, { requireActive: true });
    const qtyRes = security.parseStrictInt(entry.quantity, { min: 1, max: dbMod.MAX_ITEM_QTY });
    if (!qtyRes.ok) {
      throw httpError(
        400,
        `Quantity for ${variant.sku} must be an integer between 1 and ${dbMod.MAX_ITEM_QTY}`,
        'INVALID_QUANTITY'
      );
    }

    const vid = Number(variant.id);
    const existing = aggregatedMap.get(vid);
    const nextQty = (existing ? existing.quantity : 0) + qtyRes.value;
    if (nextQty > dbMod.MAX_ITEM_QTY) {
      throw httpError(
        400,
        `Aggregated quantity for ${variant.sku} cannot exceed ${dbMod.MAX_ITEM_QTY}`,
        'MAX_QTY_EXCEEDED',
        { variantId: vid, sku: variant.sku, maxQuantity: dbMod.MAX_ITEM_QTY }
      );
    }

    aggregatedMap.set(vid, {
      variant,
      variantId: vid,
      productId: Number(variant.product_id),
      sku: String(variant.sku),
      productName: String(variant.product_name),
      productSlug: String(variant.product_slug),
      variantLabel: String(variant.label),
      packSize: Number(variant.pack_size),
      unitPriceCents: Number(variant.price_cents),
      quantity: nextQty,
      lineTotalCents: Number(variant.price_cents) * nextQty,
      isBundle: Boolean(variant.is_bundle)
    });
  }

  const lineItems = Array.from(aggregatedMap.values());
  const aggregated = lineItems.map((item) => ({
    variantId: item.variantId,
    quantity: item.quantity
  }));

  const stockChecks = lineItems.map((item) => {
    const available = dbMod.getVariantAvailableStock(db, item.variantId);
    return {
      variantId: item.variantId,
      sku: item.sku,
      requested: item.quantity,
      available,
      sufficient: available >= item.quantity
    };
  });

  return { lineItems, aggregated, stockChecks };
}

function lookupPromoStrict(db, rawPromoCode) {
  const code = security.sanitizeText(rawPromoCode ?? '', 40).toUpperCase();
  if (!code) return null;

  const promo = db.prepare('SELECT * FROM promotions WHERE UPPER(code) = ?').get(code);
  if (!promo || !promo.active) {
    throw httpError(400, `Promo code '${code}' is invalid or inactive`, 'INVALID_PROMO');
  }
  if (promo.max_uses !== null && promo.max_uses !== undefined && Number(promo.uses_count) >= Number(promo.max_uses)) {
    throw httpError(400, `Promo code '${code}' has reached its maximum uses`, 'PROMO_EXHAUSTED');
  }
  return dbMod.toPlain(promo);
}

function getCartRowForActor(db, auth, guestToken) {
  if (auth?.user?.id) {
    return dbMod.toPlain(db.prepare('SELECT * FROM carts WHERE user_id = ?').get(auth.user.id));
  }
  if (guestToken) {
    return dbMod.toPlain(db.prepare('SELECT * FROM carts WHERE guest_token = ?').get(guestToken));
  }
  return null;
}

function getOrCreateCartRowForActor(db, req, res, auth) {
  const nowIso = new Date().toISOString();
  if (auth?.user?.id) {
    let cart = db.prepare('SELECT * FROM carts WHERE user_id = ?').get(auth.user.id);
    if (!cart) {
      const insertRes = db.prepare(
        `INSERT INTO carts (guest_token, user_id, promo_code, created_at, updated_at)
         VALUES (NULL, ?, '', ?, ?)`
      ).run(auth.user.id, nowIso, nowIso);
      cart = db.prepare('SELECT * FROM carts WHERE id = ?').get(Number(insertRes.lastInsertRowid));
    }
    return dbMod.toPlain(cart);
  }

  const guestToken = authMod.ensureGuestCartToken(req, res);
  let cart = db.prepare('SELECT * FROM carts WHERE guest_token = ?').get(guestToken);
  if (!cart) {
    const insertRes = db.prepare(
      `INSERT INTO carts (guest_token, user_id, promo_code, created_at, updated_at)
       VALUES (?, NULL, '', ?, ?)`
    ).run(guestToken, nowIso, nowIso);
    cart = db.prepare('SELECT * FROM carts WHERE id = ?').get(Number(insertRes.lastInsertRowid));
  }
  return dbMod.toPlain(cart);
}

function hydrateCart(db, cartRow) {
  if (!cartRow) {
    const emptyQuote = dbMod.calculateQuoteTotals({ items: [], promo: null });
    return {
      id: null,
      promoCode: '',
      itemCount: 0,
      items: [],
      quote: emptyQuote
    };
  }

  const rows = dbMod.toPlainRows(
    db.prepare(
      `SELECT ci.id, ci.variant_id, ci.quantity,
              v.sku, v.label, v.pack_size, v.price_cents, v.is_bundle, v.active AS variant_active,
              p.id AS product_id, p.slug, p.name AS product_name, p.active AS product_active
       FROM cart_items ci
       JOIN variants v ON v.id = ci.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE ci.cart_id = ?
       ORDER BY ci.id ASC`
    ).all(cartRow.id)
  );

  const items = [];
  let itemCount = 0;

  for (const r of rows) {
    if (!r.variant_active || !r.product_active) continue;
    const available = dbMod.getVariantAvailableStock(db, r.variant_id);
    const quantity = Number(r.quantity);
    const unitPriceCents = Number(r.price_cents);
    itemCount += quantity;
    items.push({
      id: Number(r.id),
      variantId: Number(r.variant_id),
      productId: Number(r.product_id),
      slug: String(r.slug),
      productName: String(r.product_name),
      sku: String(r.sku),
      label: String(r.label),
      packSize: Number(r.pack_size),
      unitPriceCents,
      quantity,
      lineTotalCents: unitPriceCents * quantity,
      available,
      inStock: available > 0,
      isBundle: Boolean(r.is_bundle)
    });
  }

  let promo = null;
  if (cartRow.promo_code) {
    const p = db.prepare('SELECT * FROM promotions WHERE UPPER(code) = ?').get(String(cartRow.promo_code).toUpperCase());
    if (p && p.active) promo = dbMod.toPlain(p);
  }

  const quote = dbMod.calculateQuoteTotals({ items, promo });

  return {
    id: Number(cartRow.id),
    promoCode: quote.promoCode ?? String(cartRow.promo_code ?? ''),
    itemCount,
    items,
    quote
  };
}

function hydrateOrders(db, orderRows, { maskPii = false } = {}) {
  if (!Array.isArray(orderRows) || orderRows.length === 0) return [];
  const orders = orderRows.map((o) => dbMod.toPlain(o));
  const ids = orders.map((o) => o.id);
  const placeholders = ids.map(() => '?').join(',');

  const itemRows = dbMod.toPlainRows(
    db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`).all(...ids)
  );
  const eventRows = dbMod.toPlainRows(
    db.prepare(`SELECT * FROM order_events WHERE order_id IN (${placeholders}) ORDER BY id ASC`).all(...ids)
  );
  const shipmentRows = dbMod.toPlainRows(
    db.prepare(`SELECT * FROM shipments WHERE order_id IN (${placeholders}) ORDER BY id DESC`).all(...ids)
  );
  const refundRows = dbMod.toPlainRows(
    db.prepare(`SELECT * FROM refunds WHERE order_id IN (${placeholders}) ORDER BY created_at DESC`).all(...ids)
  );
  const returnRows = dbMod.toPlainRows(
    db.prepare(`SELECT * FROM returns WHERE order_id IN (${placeholders}) ORDER BY created_at DESC`).all(...ids)
  );

  const group = (list, mapper) => {
    const map = new Map();
    for (const row of list) {
      const key = String(row.order_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(mapper(row));
    }
    return map;
  };

  const itemsByOrder = group(itemRows, (r) => ({
    id: Number(r.id),
    variantId: Number(r.variant_id),
    productId: Number(r.product_id),
    sku: String(r.sku),
    productName: String(r.product_name),
    variantLabel: String(r.variant_label),
    quantity: Number(r.quantity),
    unitPriceCents: Number(r.unit_price_cents),
    lineTotalCents: Number(r.line_total_cents),
    isBundle: Boolean(r.is_bundle),
    lotNumber: String(r.lot_number ?? ''),
    expiresAt: String(r.expires_at ?? ''),
    lotAllocations: safeJsonParse(r.lot_allocations_json, [])
  }));

  const eventsByOrder = group(eventRows, (r) => ({
    id: Number(r.id),
    axis: String(r.axis ?? 'order'),
    fromStatus: r.from_status ? String(r.from_status) : null,
    toStatus: String(r.to_status),
    note: String(r.note ?? ''),
    actorId: r.actor_id === null || r.actor_id === undefined ? null : Number(r.actor_id),
    createdAt: String(r.created_at)
  }));

  const shipmentsByOrder = group(shipmentRows, (r) => ({
    id: Number(r.id),
    carrier: String(r.carrier),
    trackingNumber: String(r.tracking_number),
    status: String(r.status),
    lotNumbers: safeJsonParse(r.lot_numbers_json, []),
    earliestExpiresAt: String(r.earliest_expires_at ?? ''),
    coldChainPack: Boolean(r.cold_chain_pack),
    storageInstructions: String(r.storage_instructions ?? ''),
    shippedAt: String(r.shipped_at),
    createdAt: String(r.created_at)
  }));

  const refundsByOrder = group(refundRows, (r) => ({
    id: String(r.id),
    orderId: String(r.order_id),
    paymentIntentId: r.payment_intent_id ? String(r.payment_intent_id) : null,
    returnId: String(r.return_id ?? ''),
    amountCents: Number(r.amount_cents),
    reason: String(r.reason ?? ''),
    status: String(r.status),
    createdAt: String(r.created_at)
  }));

  const returnsByOrder = group(returnRows, formatRma);

  return orders.map((o) => {
    const orderStatus = String(o.order_status);
    const base = {
      id: String(o.id),
      userId: o.user_id === null || o.user_id === undefined ? null : Number(o.user_id),
      status: orderStatus,
      orderStatus,
      paymentStatus: String(o.payment_status),
      fulfillmentStatus: String(o.fulfillment_status),
      coldChainMode: String(o.cold_chain_mode ?? 'insulated_chilled'),
      insulatedPackIncluded: Boolean(o.insulated_pack_included),
      storageNotice: String(o.storage_notice ?? dbMod.COLD_CHAIN_STORAGE_NOTICE),
      promoCode: String(o.promo_code ?? ''),
      subtotalCents: Number(o.subtotal_cents),
      discountCents: Number(o.discount_cents),
      shippingCents: Number(o.shipping_cents),
      taxCents: Number(o.tax_cents),
      totalCents: Number(o.total_cents),
      createdAt: String(o.created_at),
      updatedAt: String(o.updated_at),
      shippingCity: String(o.shipping_city),
      items: itemsByOrder.get(o.id) ?? [],
      events: eventsByOrder.get(o.id) ?? [],
      shipments: shipmentsByOrder.get(o.id) ?? []
    };

    if (!maskPii) {
      base.customerName = String(o.customer_name);
      base.customerEmail = String(o.customer_email);
      base.shippingLine1 = String(o.shipping_line1);
      base.shippingCity = String(o.shipping_city);
      base.shippingPostal = String(o.shipping_postal);
      base.customer = {
        name: String(o.customer_name),
        email: String(o.customer_email),
        address: String(o.shipping_line1),
        line1: String(o.shipping_line1),
        city: String(o.shipping_city),
        postal: String(o.shipping_postal)
      };
      base.refunds = refundsByOrder.get(o.id) ?? [];
      base.returns = returnsByOrder.get(o.id) ?? [];
    }

    return base;
  });
}

function hydrateOrder(db, orderRow, opts = {}) {
  if (!orderRow) return null;
  return hydrateOrders(db, [orderRow], opts)[0] ?? null;
}

module.exports = {
  MAX_BODY_BYTES,
  sendJson,
  sendError,
  sendCsv,
  readJsonBody,
  httpError,
  handleRouteError,
  safeJsonParse,
  formatUser,
  formatAddress,
  formatPromotion,
  formatRma,
  formatPaymentIntent,
  formatSubscription,
  resolveVariantByInput,
  resolveAndAggregateItems,
  lookupPromoStrict,
  getCartRowForActor,
  getOrCreateCartRowForActor,
  hydrateCart,
  hydrateOrders,
  hydrateOrder
};

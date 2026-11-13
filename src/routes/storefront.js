'use strict';

const crypto = require('node:crypto');
const dbMod = require('../db');
const authMod = require('../auth');
const security = require('../security');
const utils = require('./utils');

const COLD_CHAIN_MODES = new Set(['standard_ambient', 'insulated_chilled', 'warm_weather_gel']);

const POLICIES = Object.freeze({
  privacy: {
    slug: 'privacy',
    title: 'Privacy Policy',
    updatedAt: '2026-11-01',
    summary: 'SOLIS collects only the contact, shipping, and order details needed to fulfill cold-chain deliveries and manage your account. Payment tokens are sandbox-tokenized and raw card numbers are never stored.'
  },
  terms: {
    slug: 'terms',
    title: 'Terms of Sale',
    updatedAt: '2026-11-01',
    summary: 'All prices are authoritative in USD cents. Orders are limited to 10 packs per SKU per transaction. Promo codes apply to eligible subtotals prior to tax (8.25%) and shipping calculation.'
  },
  shipping: {
    slug: 'shipping',
    title: 'Shipping & Cold-Chain Policy',
    updatedAt: '2026-11-01',
    summary: 'Orders of $35.00 or more after discounts ship free; orders under $35.00 carry a flat $6.00 cold-chain shipping fee. Every pack ships chilled with insulated liner protection and FEFO lot tracking; refrigerate at 35-42F (2-6C) upon arrival.'
  },
  returns: {
    slug: 'returns',
    title: 'Returns & Refunds Policy',
    updatedAt: '2026-11-01',
    summary: 'Confirmed orders may be cancelled with instant stock restoration and full refund prior to warehouse packing. Damaged or warm-in-transit cans qualify for fast RMA refund or replacement via your Account portal.'
  },
  nutrition: {
    slug: 'nutrition',
    title: 'Nutrition & Allergens',
    updatedAt: '2026-11-01',
    summary: 'SOLIS botanical sparkling sodas contain 30-40 kcal, 3g organic agave inulin prebiotic fiber, and 3-5g organic blue agave nectar per 12 fl oz can. All flavors are gluten-free, vegan, non-GMO, and free from top 9 major allergens.'
  }
});

function buildWebhookSimulation(paymentIntentId, amountCents, eventId, createdAt) {
  const payload = {
    id: eventId,
    type: 'payment_intent.succeeded',
    paymentIntentId,
    amountCents,
    currency: 'usd',
    createdAt
  };
  const rawPayload = JSON.stringify(payload);
  const signature = security.signWebhookPayload(rawPayload);
  return {
    endpoint: '/api/payments/webhook',
    signatureHeader: 'X-Solis-Signature',
    signature,
    rawPayload,
    payload
  };
}

function generateUniqueOrderId(db) {
  const checkStmt = db.prepare('SELECT 1 FROM orders WHERE id = ?');
  for (let i = 0; i < 8; i += 1) {
    const candidate = `SOLIS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    if (!checkStmt.get(candidate)) return candidate;
  }
  return `SOLIS-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function clearActorCarts(db, auth, guestToken) {
  const nowIso = new Date().toISOString();
  if (auth?.user?.id) {
    const userCart = db.prepare('SELECT id FROM carts WHERE user_id = ?').get(auth.user.id);
    if (userCart) {
      db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(userCart.id);
      db.prepare('UPDATE carts SET promo_code = ?, updated_at = ? WHERE id = ?').run('', nowIso, userCart.id);
    }
  }
  if (guestToken) {
    const guestCart = db.prepare('SELECT id FROM carts WHERE guest_token = ?').get(guestToken);
    if (guestCart) {
      db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(guestCart.id);
      db.prepare('UPDATE carts SET promo_code = ?, updated_at = ? WHERE id = ?').run('', nowIso, guestCart.id);
    }
  }
}

function validateCustomerInput(rawCustomer) {
  if (!rawCustomer || typeof rawCustomer !== 'object' || Array.isArray(rawCustomer)) {
    throw utils.httpError(400, 'Customer details object is required', 'VALIDATION_ERROR');
  }
  const nameCheck = security.validateNonEmptyString(rawCustomer.name, { minLen: 1, maxLen: 120, field: 'Customer name' });
  if (!nameCheck.ok) throw utils.httpError(400, nameCheck.error, 'VALIDATION_ERROR');

  if (!security.isValidEmail(rawCustomer.email)) {
    throw utils.httpError(400, 'Valid customer email is required', 'INVALID_EMAIL');
  }
  const email = security.normalizeEmail(rawCustomer.email);

  const rawAddress = rawCustomer.line1 !== undefined ? rawCustomer.line1 : rawCustomer.address;
  const line1Check = security.validateNonEmptyString(rawAddress, { minLen: 2, maxLen: 200, field: 'Shipping address' });
  if (!line1Check.ok) throw utils.httpError(400, line1Check.error, 'VALIDATION_ERROR');

  const cityCheck = security.validateNonEmptyString(rawCustomer.city, { minLen: 1, maxLen: 100, field: 'City' });
  if (!cityCheck.ok) throw utils.httpError(400, cityCheck.error, 'VALIDATION_ERROR');

  const postalCheck = security.validateNonEmptyString(rawCustomer.postal, { minLen: 2, maxLen: 24, field: 'Postal code' });
  if (!postalCheck.ok) throw utils.httpError(400, postalCheck.error, 'VALIDATION_ERROR');

  return {
    name: nameCheck.value,
    email,
    line1: line1Check.value,
    city: cityCheck.value,
    postal: postalCheck.value
  };
}

async function handleStorefrontRoutes(req, res, method, pathname, url, db) {
  // --- Health ---
  if (method === 'GET' && pathname === '/api/health') {
    try {
      const ping = db.prepare('SELECT 1 AS ok').get();
      if (!ping || Number(ping.ok) !== 1) throw new Error('Ping failed');
      utils.sendJson(res, 200, {
        ok: true,
        service: 'solis-api',
        db: 'ok',
        timestamp: new Date().toISOString()
      });
    } catch {
      utils.sendJson(res, 503, {
        ok: false,
        service: 'solis-api',
        db: 'error'
      });
    }
    return true;
  }

  // --- Legal & Cold-Chain Policies ---
  if (method === 'GET' && pathname === '/api/policies') {
    utils.sendJson(res, 200, {
      ok: true,
      policies: Object.values(POLICIES)
    });
    return true;
  }

  const policyMatch = pathname.match(/^\/api\/policies\/([^/]+)$/);
  if (method === 'GET' && policyMatch) {
    const slug = policyMatch[1].trim().toLowerCase();
    const policy = POLICIES[slug];
    if (!policy) {
      utils.sendError(res, 404, 'Policy not found', 'POLICY_NOT_FOUND');
      return true;
    }
    utils.sendJson(res, 200, { ok: true, policy });
    return true;
  }

  // --- Catalog ---
  if (method === 'GET' && pathname === '/api/products') {
    const q = url.searchParams.get('q') ?? '';
    const tag = url.searchParams.get('tag') ?? '';
    const sort = url.searchParams.get('sort') ?? 'featured';
    const products = dbMod.getCatalog(db, { q, tag, sort, includeInactive: false });
    utils.sendJson(res, 200, {
      ok: true,
      products,
      freeShippingThresholdCents: dbMod.FREE_SHIPPING_THRESHOLD_CENTS,
      standardShippingCents: dbMod.STANDARD_SHIPPING_CENTS,
      taxRateBps: dbMod.TAX_RATE_BPS,
      maxItemQty: dbMod.MAX_ITEM_QTY,
      coldChainNotice: dbMod.COLD_CHAIN_STORAGE_NOTICE
    });
    return true;
  }

  // --- Shopping Cart ---
  if (pathname === '/api/cart' || pathname.startsWith('/api/cart/')) {
    const auth = authMod.authenticateRequest(req, db);
    const guestToken = authMod.readGuestCartToken(req);

    if (method === 'GET' && pathname === '/api/cart') {
      const cartRow = utils.getCartRowForActor(db, auth, guestToken);
      utils.sendJson(res, 200, {
        ok: true,
        cart: utils.hydrateCart(db, cartRow)
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/cart') {
      const { body } = await utils.readJsonBody(req);
      if (auth && !authMod.requireCsrf(req, res, auth, body)) return true;

      const rawQty = Object.prototype.hasOwnProperty.call(body, 'quantity') ? body.quantity : 1;
      const qtyRes = security.parseStrictInt(rawQty, { min: 1, max: dbMod.MAX_ITEM_QTY });
      if (!qtyRes.ok) {
        utils.sendError(res, 400, `Quantity must be an integer between 1 and ${dbMod.MAX_ITEM_QTY}`, 'INVALID_QUANTITY');
        return true;
      }

      const variant = utils.resolveVariantByInput(db, body, { requireActive: true });
      const promo = body.promoCode !== undefined ? utils.lookupPromoStrict(db, body.promoCode) : null;

      const updatedCart = dbMod.withTransaction(db, () => {
        const cartRow = utils.getOrCreateCartRowForActor(db, req, res, auth);
        const existingItem = db.prepare(
          'SELECT id, quantity FROM cart_items WHERE cart_id = ? AND variant_id = ?'
        ).get(cartRow.id, variant.id);

        const nextQty = (existingItem ? Number(existingItem.quantity) : 0) + qtyRes.value;
        if (nextQty > dbMod.MAX_ITEM_QTY) {
          throw utils.httpError(
            400,
            `Cart quantity for ${variant.sku} cannot exceed ${dbMod.MAX_ITEM_QTY}`,
            'MAX_QTY_EXCEEDED',
            { variantId: variant.id, sku: variant.sku, maxQuantity: dbMod.MAX_ITEM_QTY }
          );
        }

        const available = dbMod.getVariantAvailableStock(db, variant.id);
        if (available < nextQty) {
          throw utils.httpError(
            409,
            `Insufficient stock for ${variant.sku} (requested ${nextQty}, available ${available})`,
            'INSUFFICIENT_STOCK',
            { variantId: variant.id, sku: variant.sku, available, requested: nextQty }
          );
        }

        const nowIso = new Date().toISOString();
        if (existingItem) {
          db.prepare('UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?')
            .run(nextQty, nowIso, existingItem.id);
        } else {
          db.prepare(
            `INSERT INTO cart_items (cart_id, variant_id, quantity, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(cartRow.id, variant.id, nextQty, nowIso, nowIso);
        }

        if (body.promoCode !== undefined) {
          db.prepare('UPDATE carts SET promo_code = ?, updated_at = ? WHERE id = ?')
            .run(promo ? promo.code : '', nowIso, cartRow.id);
        } else {
          db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(nowIso, cartRow.id);
        }

        const freshCartRow = db.prepare('SELECT * FROM carts WHERE id = ?').get(cartRow.id);
        return utils.hydrateCart(db, dbMod.toPlain(freshCartRow));
      });

      utils.sendJson(res, 200, { ok: true, cart: updatedCart });
      return true;
    }

    if (method === 'PATCH' && pathname === '/api/cart') {
      const { body } = await utils.readJsonBody(req);
      if (auth && !authMod.requireCsrf(req, res, auth, body)) return true;

      const hasItemTarget =
        body.variantId !== undefined ||
        (typeof body.sku === 'string' && body.sku.trim().length > 0) ||
        Object.prototype.hasOwnProperty.call(body, 'quantity');

      let variant = null;
      let targetQty = null;
      if (hasItemTarget) {
        variant = utils.resolveVariantByInput(db, body, { requireActive: false });
        if (!Object.prototype.hasOwnProperty.call(body, 'quantity')) {
          utils.sendError(res, 400, 'quantity is required when updating a cart item', 'VALIDATION_ERROR');
          return true;
        }
        const qtyRes = security.parseStrictInt(body.quantity, { min: 0, max: dbMod.MAX_ITEM_QTY });
        if (!qtyRes.ok) {
          utils.sendError(res, 400, `Quantity must be an integer between 0 and ${dbMod.MAX_ITEM_QTY}`, 'INVALID_QUANTITY');
          return true;
        }
        targetQty = qtyRes.value;
        if (targetQty > 0 && (!variant.active || !variant.product_active)) {
          utils.sendError(res, 400, `Variant ${variant.sku} is currently unavailable`, 'VARIANT_UNAVAILABLE');
          return true;
        }
      }

      let nextPromo = undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'promoCode')) {
        nextPromo = utils.lookupPromoStrict(db, body.promoCode);
      }

      if (!hasItemTarget && nextPromo === undefined) {
        utils.sendError(res, 400, 'Specify variantId/sku + quantity or promoCode to update', 'VALIDATION_ERROR');
        return true;
      }

      const updatedCart = dbMod.withTransaction(db, () => {
        const cartRow = utils.getOrCreateCartRowForActor(db, req, res, auth);
        const nowIso = new Date().toISOString();

        if (variant && targetQty !== null) {
          if (targetQty === 0) {
            db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND variant_id = ?').run(cartRow.id, variant.id);
          } else {
            const available = dbMod.getVariantAvailableStock(db, variant.id);
            if (available < targetQty) {
              throw utils.httpError(
                409,
                `Insufficient stock for ${variant.sku} (requested ${targetQty}, available ${available})`,
                'INSUFFICIENT_STOCK',
                { variantId: variant.id, sku: variant.sku, available, requested: targetQty }
              );
            }
            const existingItem = db.prepare(
              'SELECT id FROM cart_items WHERE cart_id = ? AND variant_id = ?'
            ).get(cartRow.id, variant.id);
            if (existingItem) {
              db.prepare('UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?')
                .run(targetQty, nowIso, existingItem.id);
            } else {
              db.prepare(
                `INSERT INTO cart_items (cart_id, variant_id, quantity, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)`
              ).run(cartRow.id, variant.id, targetQty, nowIso, nowIso);
            }
          }
        }

        if (nextPromo !== undefined) {
          db.prepare('UPDATE carts SET promo_code = ?, updated_at = ? WHERE id = ?')
            .run(nextPromo ? nextPromo.code : '', nowIso, cartRow.id);
        } else {
          db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(nowIso, cartRow.id);
        }

        const freshCartRow = db.prepare('SELECT * FROM carts WHERE id = ?').get(cartRow.id);
        return utils.hydrateCart(db, dbMod.toPlain(freshCartRow));
      });

      utils.sendJson(res, 200, { ok: true, cart: updatedCart });
      return true;
    }

    const cartDeleteMatch = pathname.match(/^\/api\/cart\/([^/]+)$/);
    if (method === 'DELETE' && (pathname === '/api/cart' || cartDeleteMatch)) {
      const { body } = await utils.readJsonBody(req, { optional: true });
      if (auth && !authMod.requireCsrf(req, res, auth, body)) return true;

      const paramVariantId = cartDeleteMatch ? cartDeleteMatch[1] : url.searchParams.get('variantId');
      const paramSku = url.searchParams.get('sku');
      const hasSingleTarget = Boolean(
        (paramVariantId !== null && paramVariantId !== undefined && paramVariantId !== '') ||
        (paramSku !== null && paramSku !== undefined && paramSku !== '') ||
        body.variantId !== undefined ||
        (typeof body.sku === 'string' && body.sku.trim())
      );

      let targetVariant = null;
      if (hasSingleTarget) {
        targetVariant = utils.resolveVariantByInput(
          db,
          {
            variantId: paramVariantId ?? body.variantId,
            sku: paramSku ?? body.sku
          },
          { requireActive: false }
        );
      }

      const updatedCart = dbMod.withTransaction(db, () => {
        const cartRow = utils.getCartRowForActor(db, auth, guestToken);
        if (!cartRow) return utils.hydrateCart(db, null);

        const nowIso = new Date().toISOString();
        if (targetVariant) {
          db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND variant_id = ?').run(cartRow.id, targetVariant.id);
          db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(nowIso, cartRow.id);
        } else {
          db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartRow.id);
          db.prepare('UPDATE carts SET promo_code = ?, updated_at = ? WHERE id = ?').run('', nowIso, cartRow.id);
        }
        const freshCartRow = db.prepare('SELECT * FROM carts WHERE id = ?').get(cartRow.id);
        return utils.hydrateCart(db, dbMod.toPlain(freshCartRow));
      });

      utils.sendJson(res, 200, { ok: true, cart: updatedCart });
      return true;
    }
  }

  // --- Checkout Quote ---
  if (method === 'POST' && pathname === '/api/checkout/quote') {
    const { body } = await utils.readJsonBody(req, { optional: true });
    const auth = authMod.authenticateRequest(req, db);
    const guestToken = authMod.readGuestCartToken(req);

    let lineItems;
    let stockChecks;

    if (Object.prototype.hasOwnProperty.call(body, 'items')) {
      ({ lineItems, stockChecks } = utils.resolveAndAggregateItems(db, body.items));
    } else {
      const cartRow = utils.getCartRowForActor(db, auth, guestToken);
      const hydrated = utils.hydrateCart(db, cartRow);
      if (hydrated.items.length === 0) {
        utils.sendError(res, 400, 'Items are required for checkout quote', 'EMPTY_ITEMS');
        return true;
      }
      lineItems = hydrated.items;
      stockChecks = hydrated.items.map((item) => ({
        variantId: item.variantId,
        sku: item.sku,
        requested: item.quantity,
        available: item.available,
        sufficient: item.available >= item.quantity
      }));
    }

    const promo = Object.prototype.hasOwnProperty.call(body, 'promoCode')
      ? utils.lookupPromoStrict(db, body.promoCode)
      : null;

    const quote = dbMod.calculateQuoteTotals({ items: lineItems, promo });
    const stockOk = stockChecks.every((s) => s.sufficient);
    const enrichedQuote = {
      ...quote,
      items: lineItems.map((i) => ({
        variantId: i.variantId,
        sku: i.sku,
        productName: i.productName,
        variantLabel: i.variantLabel ?? i.label,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        lineTotalCents: i.lineTotalCents
      })),
      stockChecks,
      stockOk
    };

    utils.sendJson(res, 200, {
      ok: true,
      ...enrichedQuote,
      quote: enrichedQuote
    });
    return true;
  }

  // --- Payment Intent (Tokenized Sandbox + Signed Webhook Simulation) ---
  if (method === 'POST' && pathname === '/api/payments/intent') {
    const { body } = await utils.readJsonBody(req);
    const auth = authMod.authenticateRequest(req, db);
    if (auth && !authMod.requireCsrf(req, res, auth, body)) return true;

    const rawIdemKey = req.headers['idempotency-key'] ?? body.idempotencyKey;
    const idemCheck = security.validateNonEmptyString(rawIdemKey, { minLen: 4, maxLen: 128, field: 'Idempotency-Key' });
    if (!idemCheck.ok) {
      utils.sendError(res, 400, 'Idempotency-Key header is required', 'MISSING_IDEMPOTENCY_KEY');
      return true;
    }
    const idempotencyKey = idemCheck.value;

    const guestToken = authMod.readGuestCartToken(req);
    let amountCents;
    let quoteSummary = null;

    if (Object.prototype.hasOwnProperty.call(body, 'items')) {
      const { lineItems, stockChecks } = utils.resolveAndAggregateItems(db, body.items);
      const short = stockChecks.find((s) => !s.sufficient);
      if (short) {
        utils.sendError(res, 409, `Insufficient stock for ${short.sku}`, 'INSUFFICIENT_STOCK', short);
        return true;
      }
      const promo = Object.prototype.hasOwnProperty.call(body, 'promoCode')
        ? utils.lookupPromoStrict(db, body.promoCode)
        : null;
      quoteSummary = dbMod.calculateQuoteTotals({ items: lineItems, promo });
      amountCents = quoteSummary.totalCents;
    } else {
      const cartRow = utils.getCartRowForActor(db, auth, guestToken);
      const hydrated = utils.hydrateCart(db, cartRow);
      if (hydrated.items.length > 0 && !Object.prototype.hasOwnProperty.call(body, 'amountCents')) {
        const short = hydrated.items.find((i) => i.available < i.quantity);
        if (short) {
          utils.sendError(res, 409, `Insufficient stock for ${short.sku}`, 'INSUFFICIENT_STOCK', {
            variantId: short.variantId,
            sku: short.sku,
            available: short.available,
            requested: short.quantity
          });
          return true;
        }
        const promo = Object.prototype.hasOwnProperty.call(body, 'promoCode')
          ? utils.lookupPromoStrict(db, body.promoCode)
          : (hydrated.promoCode ? utils.lookupPromoStrict(db, hydrated.promoCode) : null);
        quoteSummary = dbMod.calculateQuoteTotals({ items: hydrated.items, promo });
        amountCents = quoteSummary.totalCents;
      } else if (Object.prototype.hasOwnProperty.call(body, 'amountCents')) {
        const amtRes = security.parseStrictInt(body.amountCents, { min: 1, max: 10_000_000 });
        if (!amtRes.ok) {
          utils.sendError(res, 400, 'amountCents must be a positive integer', 'INVALID_AMOUNT');
          return true;
        }
        amountCents = amtRes.value;
      } else {
        utils.sendError(res, 400, 'Provide order items (or non-empty cart) to create a PaymentIntent', 'EMPTY_ITEMS');
        return true;
      }
    }

    const paymentMethodToken = security.sanitizeText(body.paymentMethodToken ?? 'tok_sandbox_visa', 80) || 'tok_sandbox_visa';

    const outcome = dbMod.withTransaction(db, () => {
      const existing = db.prepare('SELECT * FROM payment_intents WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (Number(existing.amount_cents) !== amountCents) {
          throw utils.httpError(
            409,
            'Idempotency-Key already used with a different payment amount',
            'IDEMPOTENCY_CONFLICT'
          );
        }
        const plain = dbMod.toPlain(existing);
        const meta = utils.safeJsonParse(plain.metadata_json, {});
        const evtId = meta.simulatedEventId ?? `evt_${crypto.randomBytes(12).toString('hex')}`;
        return {
          replay: true,
          paymentIntent: utils.formatPaymentIntent(plain),
          webhookSimulation: buildWebhookSimulation(plain.id, Number(plain.amount_cents), evtId, plain.created_at)
        };
      }

      const nowIso = new Date().toISOString();
      const piId = `pi_${crypto.randomBytes(12).toString('hex')}`;
      const clientSecret = `pi_secret_${crypto.randomBytes(16).toString('hex')}`;
      const simulatedEventId = `evt_${crypto.randomBytes(12).toString('hex')}`;
      const meta = {
        paymentMethodToken,
        simulatedEventId,
        ...(quoteSummary ? { quoteSubtotalCents: quoteSummary.subtotalCents, promoCode: quoteSummary.promoCode } : {})
      };

      db.prepare(
        `INSERT INTO payment_intents (
           id, idempotency_key, user_id, order_id, amount_cents, currency,
           status, client_secret, webhook_event_id, webhook_processed, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, 'usd', 'requires_confirmation', ?, NULL, 0, ?, ?, ?)`
      ).run(piId, idempotencyKey, auth?.user?.id ?? null, amountCents, clientSecret, JSON.stringify(meta), nowIso, nowIso);

      const createdRow = dbMod.toPlain(db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(piId));
      return {
        replay: false,
        paymentIntent: utils.formatPaymentIntent(createdRow),
        webhookSimulation: buildWebhookSimulation(piId, amountCents, simulatedEventId, nowIso)
      };
    });

    utils.sendJson(res, outcome.replay ? 200 : 201, {
      ok: true,
      idempotentReplay: outcome.replay,
      paymentIntent: outcome.paymentIntent,
      webhookSimulation: outcome.webhookSimulation
    });
    return true;
  }

  // --- Payment Webhook (HMAC-verified + processed_webhook_events replay guard) ---
  if (method === 'POST' && pathname === '/api/payments/webhook') {
    const { body, rawBody } = await utils.readJsonBody(req);
    const sigHeader = req.headers['x-solis-signature'] ?? req.headers['x-webhook-signature'];
    if (typeof sigHeader !== 'string' || !security.verifyWebhookSignature(rawBody, sigHeader)) {
      utils.sendError(res, 401, 'Invalid or missing webhook HMAC signature', 'INVALID_WEBHOOK_SIGNATURE');
      return true;
    }

    const eventId = security.sanitizeText(body.id ?? body.eventId ?? '', 120);
    const eventType = security.sanitizeText(body.type ?? '', 80);
    const paymentIntentId = security.sanitizeText(body.paymentIntentId ?? body.data?.paymentIntentId ?? '', 120);

    if (!eventId || !eventType || !paymentIntentId) {
      utils.sendError(res, 400, 'Webhook payload requires id, type, and paymentIntentId', 'INVALID_WEBHOOK_PAYLOAD');
      return true;
    }

    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

    const result = dbMod.withTransaction(db, () => {
      const rec = dbMod.recordWebhookEvent(db, {
        eventId,
        eventType,
        paymentIntentId,
        payloadHash
      });

      const piRow = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(paymentIntentId);
      if (rec.duplicate) {
        return {
          deduplicated: true,
          processed: false,
          eventId,
          processedAt: rec.processedAt,
          paymentIntent: piRow ? utils.formatPaymentIntent(dbMod.toPlain(piRow)) : null
        };
      }

      if (!piRow) {
        throw utils.httpError(404, `PaymentIntent '${paymentIntentId}' not found`, 'PAYMENT_INTENT_NOT_FOUND');
      }

      if (piRow.webhook_processed) {
        return {
          deduplicated: true,
          processed: false,
          eventId,
          paymentIntent: utils.formatPaymentIntent(dbMod.toPlain(piRow))
        };
      }

      const nowIso = new Date().toISOString();
      if (eventType === 'payment_intent.succeeded') {
        db.prepare(
          `UPDATE payment_intents
           SET status = 'succeeded', webhook_event_id = ?, webhook_processed = 1, updated_at = ?
           WHERE id = ?`
        ).run(eventId, nowIso, paymentIntentId);

        if (piRow.order_id) {
          const ord = db.prepare('SELECT * FROM orders WHERE id = ?').get(piRow.order_id);
          if (ord && ord.order_status === 'pending_payment') {
            dbMod.transitionOrderState(db, ord.id, {
              orderStatus: 'confirmed',
              paymentStatus: 'paid',
              fulfillmentStatus: ord.fulfillment_status === 'unfulfilled' ? 'allocated' : undefined,
              note: `Payment confirmed via webhook ${eventId}`
            });
            dbMod.queueNotification(db, {
              toEmail: ord.customer_email,
              subject: `Order ${ord.id} Payment Confirmed`,
              body: `Hi ${ord.customer_name},\n\nPayment for your SOLIS order ${ord.id} is confirmed ($${(Number(ord.total_cents) / 100).toFixed(2)}). ${ord.storage_notice}\n\n— SOLIS`,
              type: 'order_confirmation',
              referenceId: ord.id
            });
          }
        }
      } else if (eventType === 'payment_intent.payment_failed' || eventType === 'payment_intent.failed') {
        db.prepare(
          `UPDATE payment_intents
           SET status = 'failed', webhook_event_id = ?, webhook_processed = 1, updated_at = ?
           WHERE id = ?`
        ).run(eventId, nowIso, paymentIntentId);

        if (piRow.order_id) {
          const ord = db.prepare('SELECT * FROM orders WHERE id = ?').get(piRow.order_id);
          if (ord && dbMod.canTransitionPaymentStatus(ord.payment_status, 'failed')) {
            dbMod.transitionOrderState(db, ord.id, {
              paymentStatus: 'failed',
              note: `Payment failed via webhook ${eventId}`
            });
          }
        }
      } else {
        throw utils.httpError(400, `Unsupported webhook event type '${eventType}'`, 'UNSUPPORTED_WEBHOOK_TYPE');
      }

      dbMod.writeAuditLog(db, {
        actorId: piRow.user_id ?? null,
        actorRole: 'webhook',
        action: 'payment.webhook',
        targetType: 'payment_intent',
        targetId: paymentIntentId,
        details: { eventId, eventType }
      });

      const updatedPi = dbMod.toPlain(db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(paymentIntentId));
      return {
        deduplicated: false,
        processed: true,
        eventId,
        paymentIntent: utils.formatPaymentIntent(updatedPi)
      };
    });

    utils.sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // --- Place Order (Idempotent Atomic Transaction + FEFO + Cold-Chain + Outbox) ---
  if (method === 'POST' && pathname === '/api/orders') {
    const { body } = await utils.readJsonBody(req);
    const auth = authMod.authenticateRequest(req, db);
    if (auth && !authMod.requireCsrf(req, res, auth, body)) return true;

    const rawIdemKey = req.headers['idempotency-key'] ?? body.idempotencyKey;
    let idempotencyKey = null;
    if (rawIdemKey !== undefined && rawIdemKey !== null && String(rawIdemKey).trim() !== '') {
      const idemCheck = security.validateNonEmptyString(rawIdemKey, { minLen: 4, maxLen: 128, field: 'Idempotency-Key' });
      if (!idemCheck.ok) {
        utils.sendError(res, 400, idemCheck.error, 'INVALID_IDEMPOTENCY_KEY');
        return true;
      }
      idempotencyKey = idemCheck.value;
    }

    if (idempotencyKey) {
      const existingOrder = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
      if (existingOrder) {
        const hydrated = utils.hydrateOrder(db, existingOrder);
        utils.sendJson(res, 200, {
          ok: true,
          idempotentReplay: true,
          id: hydrated.id,
          order: hydrated,
          ...hydrated
        });
        return true;
      }
    }

    const customer = validateCustomerInput(body.customer);
    const { lineItems, aggregated } = utils.resolveAndAggregateItems(db, body.items);
    const promo = Object.prototype.hasOwnProperty.call(body, 'promoCode')
      ? utils.lookupPromoStrict(db, body.promoCode)
      : null;
    const quote = dbMod.calculateQuoteTotals({ items: lineItems, promo });

    const requestedColdChain = security.sanitizeText(body.coldChainMode ?? 'insulated_chilled', 40).toLowerCase();
    const coldChainMode = COLD_CHAIN_MODES.has(requestedColdChain) ? requestedColdChain : 'insulated_chilled';
    const insulatedPackIncluded = coldChainMode === 'standard_ambient' ? 0 : 1;
    const guestToken = authMod.readGuestCartToken(req);

    const created = dbMod.withTransaction(db, () => {
      if (idempotencyKey) {
        const dup = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
        if (dup) {
          return { replay: true, order: utils.hydrateOrder(db, dup) };
        }
      }

      const nowIso = new Date().toISOString();
      let paymentIntentId = body.paymentIntentId ? security.sanitizeText(body.paymentIntentId, 120) : '';
      let isPaid = true;

      if (paymentIntentId) {
        const pi = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(paymentIntentId);
        if (!pi) {
          throw utils.httpError(404, `PaymentIntent '${paymentIntentId}' not found`, 'PAYMENT_INTENT_NOT_FOUND');
        }
        if (pi.order_id) {
          throw utils.httpError(409, 'PaymentIntent has already been applied to an order', 'PAYMENT_INTENT_USED');
        }
        if (Number(pi.amount_cents) !== quote.totalCents) {
          throw utils.httpError(
            409,
            `PaymentIntent amount (${pi.amount_cents}) does not match authoritative total (${quote.totalCents})`,
            'PAYMENT_AMOUNT_MISMATCH'
          );
        }
        if (pi.status === 'failed' || pi.status === 'cancelled') {
          throw utils.httpError(409, `PaymentIntent is in non-payable status '${pi.status}'`, 'PAYMENT_FAILED');
        }
        isPaid = pi.status === 'succeeded';
      } else {
        paymentIntentId = `pi_${crypto.randomBytes(12).toString('hex')}`;
        const clientSecret = `pi_secret_${crypto.randomBytes(16).toString('hex')}`;
        const piIdemKey = idempotencyKey ? `order_${idempotencyKey}` : `auto_${crypto.randomBytes(12).toString('hex')}`;
        const token = security.sanitizeText(body.paymentMethodToken ?? 'tok_sandbox_visa', 80) || 'tok_sandbox_visa';
        db.prepare(
          `INSERT INTO payment_intents (
             id, idempotency_key, user_id, order_id, amount_cents, currency,
             status, client_secret, webhook_event_id, webhook_processed, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, NULL, ?, 'usd', 'succeeded', ?, NULL, 1, ?, ?, ?)`
        ).run(
          paymentIntentId,
          piIdemKey,
          auth?.user?.id ?? null,
          quote.totalCents,
          clientSecret,
          JSON.stringify({ paymentMethodToken: token, mode: 'direct_sandbox' }),
          nowIso,
          nowIso
        );
      }

      const orderId = generateUniqueOrderId(db);
      const stockResult = dbMod.decrementOrderStock(db, aggregated, {
        actorId: auth?.user?.id ?? null,
        referenceId: orderId
      });

      const orderStatus = isPaid ? 'confirmed' : 'pending_payment';
      const paymentStatus = isPaid ? 'paid' : 'pending';
      const fulfillmentStatus = 'allocated';

      db.prepare(
        `INSERT INTO orders (
           id, user_id, customer_name, customer_email,
           shipping_line1, shipping_city, shipping_postal,
           promo_code, subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
           order_status, payment_status, fulfillment_status,
           cold_chain_mode, insulated_pack_included, storage_notice,
           idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        orderId,
        auth?.user?.id ?? null,
        customer.name,
        customer.email,
        customer.line1,
        customer.city,
        customer.postal,
        quote.promoCode ?? '',
        quote.subtotalCents,
        quote.discountCents,
        quote.shippingCents,
        quote.taxCents,
        quote.totalCents,
        orderStatus,
        paymentStatus,
        fulfillmentStatus,
        coldChainMode,
        insulatedPackIncluded,
        dbMod.COLD_CHAIN_STORAGE_NOTICE,
        idempotencyKey,
        nowIso,
        nowIso
      );

      const insertOrderItem = db.prepare(
        `INSERT INTO order_items (
           order_id, variant_id, product_id, sku, product_name, variant_label,
           quantity, unit_price_cents, line_total_cents, is_bundle,
           lot_number, expires_at, lot_allocations_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const item of lineItems) {
        const allocs = stockResult.allocationsByOrderVariant.get(item.variantId) ?? [];
        const sortedByExpiry = [...allocs].sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
        const primaryLot = sortedByExpiry[0]?.lotNumber ?? '';
        const earliestExpiry = sortedByExpiry[0]?.expiresAt ?? '';
        insertOrderItem.run(
          orderId,
          item.variantId,
          item.productId,
          item.sku,
          item.productName,
          item.variantLabel,
          item.quantity,
          item.unitPriceCents,
          item.lineTotalCents,
          item.isBundle ? 1 : 0,
          primaryLot,
          earliestExpiry,
          JSON.stringify(allocs)
        );
      }

      db.prepare(
        `INSERT INTO order_events (order_id, axis, from_status, to_status, note, actor_id, created_at)
         VALUES (?, 'order', NULL, ?, ?, ?, ?)`
      ).run(orderId, orderStatus, 'Order created & FEFO inventory allocated', auth?.user?.id ?? null, nowIso);

      db.prepare('UPDATE payment_intents SET order_id = ?, updated_at = ? WHERE id = ?')
        .run(orderId, nowIso, paymentIntentId);

      if (quote.promoCode) {
        db.prepare('UPDATE promotions SET uses_count = uses_count + 1 WHERE UPPER(code) = UPPER(?)')
          .run(quote.promoCode);
      }

      clearActorCarts(db, auth, guestToken);

      const itemLines = lineItems
        .map((i) => `- ${i.quantity}x ${i.productName} (${i.variantLabel}, ${i.sku})`)
        .join('\n');

      dbMod.queueNotification(db, {
        toEmail: customer.email,
        subject: `Order ${orderId} ${isPaid ? 'Confirmed' : 'Pending Payment'} — SOLIS`,
        body: `Hi ${customer.name},\n\nThank you for your SOLIS order ${orderId}.\n\nItems:\n${itemLines}\n\nTotal: $${(quote.totalCents / 100).toFixed(2)}\nCold-Chain: ${dbMod.COLD_CHAIN_STORAGE_NOTICE}\n\n— SOLIS`,
        type: 'order_confirmation',
        referenceId: orderId
      });

      dbMod.writeAuditLog(db, {
        actorId: auth?.user?.id ?? null,
        actorEmail: auth?.user?.email ?? customer.email,
        actorRole: auth?.user?.role ?? 'guest',
        action: 'order.create',
        targetType: 'order',
        targetId: orderId,
        details: {
          totalCents: quote.totalCents,
          itemCount: lineItems.reduce((s, i) => s + i.quantity, 0),
          promoCode: quote.promoCode ?? null,
          coldChainMode
        }
      });

      const createdRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      return { replay: false, order: utils.hydrateOrder(db, createdRow) };
    });

    utils.sendJson(res, created.replay ? 200 : 201, {
      ok: true,
      idempotentReplay: created.replay,
      id: created.order.id,
      order: created.order,
      ...created.order
    });
    return true;
  }

  // --- Verification-Gated Guest Order Tracking ---
  if (method === 'GET' && pathname === '/api/orders/track') {
    const orderId = (url.searchParams.get('id') ?? '').trim();
    const rawEmail = (url.searchParams.get('email') ?? '').trim();

    if (!orderId || !security.isValidEmail(rawEmail)) {
      utils.sendError(res, 400, 'Both order ID and a valid email address are required to track an order', 'VALIDATION_ERROR');
      return true;
    }

    const normalizedEmail = security.normalizeEmail(rawEmail);
    const orderRow = db.prepare(
      'SELECT * FROM orders WHERE UPPER(id) = UPPER(?) AND LOWER(customer_email) = ?'
    ).get(orderId, normalizedEmail);

    if (!orderRow) {
      utils.sendError(res, 404, 'Order not found or email does not match', 'ORDER_NOT_FOUND');
      return true;
    }

    utils.sendJson(res, 200, {
      ok: true,
      order: utils.hydrateOrder(db, orderRow, { maskPii: true })
    });
    return true;
  }

  return false;
}

module.exports = { handleStorefrontRoutes };

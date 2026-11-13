'use strict';

const crypto = require('node:crypto');
const dbMod = require('../db');
const authMod = require('../auth');
const security = require('../security');
const utils = require('./utils');

const VALID_VARIANT_LABELS = new Set(['6-Pack', '12-Pack', '24-Pack']);
const VALID_PROMO_TYPES = new Set(['percent', 'fixed', 'free_shipping']);
const RMA_ACTION_TO_STATUS = Object.freeze({
  approve: 'approved',
  reject: 'rejected',
  refund: 'refunded',
  replace: 'replaced'
});

function buildFinanceLedger(db, { from = '', to = '' } = {}) {
  const orderParams = [];
  let orderWhere = "WHERE payment_status IN ('paid', 'partially_refunded', 'refunded')";
  if (from) {
    orderWhere += ' AND created_at >= ?';
    orderParams.push(from);
  }
  if (to) {
    orderWhere += ' AND created_at <= ?';
    orderParams.push(to);
  }

  const orderRows = dbMod.toPlainRows(
    db.prepare(`SELECT * FROM orders ${orderWhere} ORDER BY created_at DESC, id DESC`).all(...orderParams)
  );

  const refundParams = [];
  let refundWhere = "WHERE r.status = 'succeeded'";
  if (from) {
    refundWhere += ' AND r.created_at >= ?';
    refundParams.push(from);
  }
  if (to) {
    refundWhere += ' AND r.created_at <= ?';
    refundParams.push(to);
  }

  const refundRows = dbMod.toPlainRows(
    db.prepare(
      `SELECT r.*, o.customer_email, o.customer_name
       FROM refunds r
       JOIN orders o ON o.id = r.order_id
       ${refundWhere}
       ORDER BY r.created_at DESC, r.id DESC`
    ).all(...refundParams)
  );

  let subtotalCents = 0;
  let discountCents = 0;
  let shippingCents = 0;
  let taxCents = 0;
  let grossRevenueCents = 0;
  let refundsCents = 0;

  const entries = [];

  for (const o of orderRows) {
    const sub = Number(o.subtotal_cents);
    const disc = Number(o.discount_cents);
    const ship = Number(o.shipping_cents);
    const tax = Number(o.tax_cents);
    const total = Number(o.total_cents);

    subtotalCents += sub;
    discountCents += disc;
    shippingCents += ship;
    taxCents += tax;
    grossRevenueCents += total;

    entries.push({
      entryType: 'charge',
      referenceId: String(o.id),
      orderId: String(o.id),
      customerName: String(o.customer_name),
      customerEmail: String(o.customer_email),
      status: String(o.payment_status),
      orderStatus: String(o.order_status),
      subtotalCents: sub,
      discountCents: disc,
      shippingCents: ship,
      taxCents: tax,
      amountCents: total,
      signedAmountCents: total,
      currency: 'USD',
      note: o.promo_code ? `Promo ${o.promo_code}` : '',
      createdAt: String(o.created_at)
    });
  }

  for (const r of refundRows) {
    const amt = Number(r.amount_cents);
    refundsCents += amt;

    entries.push({
      entryType: 'refund',
      referenceId: String(r.id),
      orderId: String(r.order_id),
      customerName: String(r.customer_name),
      customerEmail: String(r.customer_email),
      status: String(r.status),
      orderStatus: 'refunded',
      subtotalCents: 0,
      discountCents: 0,
      shippingCents: 0,
      taxCents: 0,
      amountCents: amt,
      signedAmountCents: -amt,
      currency: 'USD',
      note: String(r.reason ?? ''),
      createdAt: String(r.created_at)
    });
  }

  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    summary: {
      orderCount: orderRows.length,
      refundCount: refundRows.length,
      subtotalCents,
      discountCents,
      shippingCents,
      taxCents,
      grossRevenueCents,
      refundsCents,
      netRevenueCents: grossRevenueCents - refundsCents
    },
    entries
  };
}

function authorizeOps(req, res, db, allowedRoles, body = null) {
  return authMod.requireRole(allowedRoles, { csrf: true })(req, res, { db, body });
}

async function handleOpsRoutes(req, res, method, pathname, url, db) {
  if (!pathname.startsWith('/api/ops')) return false;

  const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

  // Fail closed on unauthenticated requests before reading request bodies.
  const preAuth = authMod.authenticateRequest(req, db);
  if (!preAuth) {
    utils.sendError(res, 401, 'Authentication required', 'UNAUTHENTICATED');
    return true;
  }

  let body = {};
  if (isMutating) {
    ({ body } = await utils.readJsonBody(req));
  }

  // --- Admin / Merchandiser: Catalog & Promotions & Logs & Outbox ---
  if (method === 'GET' && pathname === '/api/ops/products') {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser', 'warehouse']);
    if (!auth) return true;
    const products = dbMod.getCatalog(db, { includeInactive: true });
    utils.sendJson(res, 200, { ok: true, products });
    return true;
  }

  if (method === 'POST' && pathname === '/api/ops/products') {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser'], body);
    if (!auth) return true;

    const slugCheck = security.validateNonEmptyString(body.slug, { minLen: 2, maxLen: 60, field: 'Slug' });
    const nameCheck = security.validateNonEmptyString(body.name, { minLen: 2, maxLen: 120, field: 'Product name' });
    if (!slugCheck.ok) {
      utils.sendError(res, 400, slugCheck.error, 'VALIDATION_ERROR');
      return true;
    }
    if (!nameCheck.ok) {
      utils.sendError(res, 400, nameCheck.error, 'VALIDATION_ERROR');
      return true;
    }

    const slug = slugCheck.value.toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      utils.sendError(res, 400, 'Slug must contain lowercase letters, numbers, and hyphens only', 'INVALID_SLUG');
      return true;
    }

    const rawCalories = Object.prototype.hasOwnProperty.call(body, 'calories') ? body.calories : 35;
    const calRes = security.parseStrictInt(rawCalories, { min: 0, max: 2000 });
    if (!calRes.ok) {
      utils.sendError(res, 400, 'Calories must be a non-negative integer', 'VALIDATION_ERROR');
      return true;
    }

    const rawShelf = Object.prototype.hasOwnProperty.call(body, 'shelfLifeDays') ? body.shelfLifeDays : 365;
    const shelfRes = security.parseStrictInt(rawShelf, { min: 1, max: 3650 });
    if (!shelfRes.ok) {
      utils.sendError(res, 400, 'shelfLifeDays must be a positive integer', 'VALIDATION_ERROR');
      return true;
    }

    const rawSort = Object.prototype.hasOwnProperty.call(body, 'sortOrder') ? body.sortOrder : 10;
    const sortRes = security.parseStrictInt(rawSort, { min: 0, max: 10000 });
    if (!sortRes.ok) {
      utils.sendError(res, 400, 'sortOrder must be a non-negative integer', 'VALIDATION_ERROR');
      return true;
    }

    const subtitle = security.sanitizeText(body.subtitle ?? '', 200);
    const tag = security.sanitizeText(body.tag ?? 'Seasonal', 40);
    const description = security.sanitizeText(body.description ?? '', 1000);
    const storageInstructions =
      security.sanitizeText(body.storageInstructions ?? dbMod.COLD_CHAIN_STORAGE_NOTICE, 300) ||
      dbMod.COLD_CHAIN_STORAGE_NOTICE;
    const coldChainRequired = body.coldChainRequired === false || body.coldChainRequired === 0 ? 0 : 1;
    const accentColor = security.sanitizeText(body.accentColor ?? '#0A5E9E', 20) || '#0A5E9E';
    const active = body.active === false || body.active === 0 ? 0 : 1;

    const variantsInput = Array.isArray(body.variants) ? body.variants : [];
    const parsedVariants = [];
    for (const v of variantsInput) {
      if (!v || typeof v !== 'object') {
        utils.sendError(res, 400, 'Each variant must be an object', 'VALIDATION_ERROR');
        return true;
      }
      const skuCheck = security.validateNonEmptyString(v.sku, { minLen: 3, maxLen: 40, field: 'SKU' });
      if (!skuCheck.ok) {
        utils.sendError(res, 400, skuCheck.error, 'VALIDATION_ERROR');
        return true;
      }
      const label = security.sanitizeText(v.label ?? '12-Pack', 20);
      if (!VALID_VARIANT_LABELS.has(label)) {
        utils.sendError(res, 400, "Variant label must be '6-Pack', '12-Pack', or '24-Pack'", 'VALIDATION_ERROR');
        return true;
      }
      const defaultPackSize = label === '6-Pack' ? 6 : label === '24-Pack' ? 24 : 12;
      const rawPackSize = Object.prototype.hasOwnProperty.call(v, 'packSize') ? v.packSize : defaultPackSize;
      const packRes = security.parseStrictInt(rawPackSize, { min: 1, max: 144 });
      const priceRes = security.parseStrictInt(v.priceCents, { min: 0, max: 1_000_000 });
      const rawOnHand = Object.prototype.hasOwnProperty.call(v, 'onHand') ? v.onHand : 0;
      const handRes = security.parseStrictInt(rawOnHand, { min: 0, max: 100_000 });
      if (!packRes.ok || !priceRes.ok || !handRes.ok) {
        utils.sendError(res, 400, 'Variant packSize, priceCents, and onHand must be valid non-negative integers', 'VALIDATION_ERROR');
        return true;
      }
      parsedVariants.push({
        sku: skuCheck.value.toUpperCase(),
        label,
        packSize: packRes.value,
        priceCents: priceRes.value,
        onHand: handRes.value,
        lotNumber: security.sanitizeText(v.lotNumber ?? 'LOT-2026-NEW', 40) || 'LOT-2026-NEW',
        expiresAt: security.sanitizeText(v.expiresAt ?? '2027-09-30', 20) || '2027-09-30',
        active: v.active === false || v.active === 0 ? 0 : 1
      });
    }

    const product = dbMod.withTransaction(db, () => {
      if (db.prepare('SELECT id FROM products WHERE LOWER(slug) = ?').get(slug)) {
        throw utils.httpError(409, `Product slug '${slug}' already exists`, 'SLUG_EXISTS');
      }
      for (const pv of parsedVariants) {
        if (db.prepare('SELECT id FROM variants WHERE UPPER(sku) = ?').get(pv.sku)) {
          throw utils.httpError(409, `SKU '${pv.sku}' already exists`, 'SKU_EXISTS');
        }
      }

      const nowIso = new Date().toISOString();
      const prodRes = db.prepare(
        `INSERT INTO products (
           slug, name, subtitle, calories, tag, description, nutrition_json,
           storage_instructions, cold_chain_required, shelf_life_days,
           accent_color, sort_order, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        slug,
        nameCheck.value,
        subtitle,
        calRes.value,
        tag,
        description,
        JSON.stringify(body.nutrition && typeof body.nutrition === 'object' ? body.nutrition : {}),
        storageInstructions,
        coldChainRequired,
        shelfRes.value,
        accentColor,
        sortRes.value,
        active,
        nowIso,
        nowIso
      );
      const productId = Number(prodRes.lastInsertRowid);

      for (const pv of parsedVariants) {
        const vRes = db.prepare(
          `INSERT INTO variants (product_id, sku, label, pack_size, price_cents, on_hand, reserved, is_bundle, active)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
        ).run(productId, pv.sku, pv.label, pv.packSize, pv.priceCents, pv.onHand, pv.active);
        const variantId = Number(vRes.lastInsertRowid);

        if (pv.onHand > 0) {
          db.prepare(
            `INSERT INTO inventory_lots (variant_id, lot_number, expires_at, on_hand, received_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(variantId, pv.lotNumber, pv.expiresAt, pv.onHand, nowIso);

          db.prepare(
            `INSERT INTO inventory_ledger (variant_id, delta, reason, lot_number, expires_at, actor_id, reference_id, created_at)
             VALUES (?, ?, 'initial_seed', ?, ?, ?, 'OPS-PROD', ?)`
          ).run(variantId, pv.onHand, pv.lotNumber, pv.expiresAt, auth.user.id, nowIso);
        }
      }

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'product.create',
        targetType: 'product',
        targetId: String(productId),
        details: { slug, variantCount: parsedVariants.length }
      });

      return dbMod.getCatalog(db, { includeInactive: true }).find((p) => p.id === productId);
    });

    utils.sendJson(res, 201, { ok: true, product });
    return true;
  }

  const prodPatchMatch = pathname.match(/^\/api\/ops\/products\/([^/]+)$/);
  if (method === 'PATCH' && (pathname === '/api/ops/products' || prodPatchMatch)) {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser'], body);
    if (!auth) return true;

    const pathTarget = prodPatchMatch ? prodPatchMatch[1].trim() : null;

    const product = dbMod.withTransaction(db, () => {
      let targetProduct = null;
      const lookupId = pathTarget ?? body.productId ?? body.id;

      if (lookupId !== undefined && lookupId !== null && lookupId !== '') {
        const idCheck = security.parseStrictInt(lookupId, { min: 1, coerceString: true });
        if (idCheck.ok) {
          targetProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(idCheck.value);
        } else {
          targetProduct = db.prepare('SELECT * FROM products WHERE LOWER(slug) = LOWER(?)').get(String(lookupId));
        }
      } else if (body.slug) {
        targetProduct = db.prepare('SELECT * FROM products WHERE LOWER(slug) = LOWER(?)').get(String(body.slug));
      } else if (body.variantId !== undefined || body.sku) {
        const vRow = utils.resolveVariantByInput(db, body, { requireActive: false });
        targetProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(vRow.product_id);
      }

      if (!targetProduct) {
        throw utils.httpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
      }

      const nowIso = new Date().toISOString();
      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        const nc = security.validateNonEmptyString(body.name, { minLen: 2, maxLen: 120, field: 'Product name' });
        if (!nc.ok) throw utils.httpError(400, nc.error, 'VALIDATION_ERROR');
        updates.push('name = ?');
        params.push(nc.value);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'subtitle')) {
        updates.push('subtitle = ?');
        params.push(security.sanitizeText(body.subtitle, 200));
      }
      if (Object.prototype.hasOwnProperty.call(body, 'tag')) {
        updates.push('tag = ?');
        params.push(security.sanitizeText(body.tag, 40));
      }
      if (Object.prototype.hasOwnProperty.call(body, 'description')) {
        updates.push('description = ?');
        params.push(security.sanitizeText(body.description, 1000));
      }
      if (Object.prototype.hasOwnProperty.call(body, 'storageInstructions')) {
        updates.push('storage_instructions = ?');
        params.push(security.sanitizeText(body.storageInstructions, 300));
      }
      if (Object.prototype.hasOwnProperty.call(body, 'calories')) {
        const calRes = security.parseStrictInt(body.calories, { min: 0, max: 2000 });
        if (!calRes.ok) throw utils.httpError(400, 'Calories must be a non-negative integer', 'VALIDATION_ERROR');
        updates.push('calories = ?');
        params.push(calRes.value);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'active')) {
        if (typeof body.active !== 'boolean' && body.active !== 0 && body.active !== 1) {
          throw utils.httpError(400, 'active must be boolean or 0/1', 'VALIDATION_ERROR');
        }
        updates.push('active = ?');
        params.push(body.active ? 1 : 0);
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        params.push(nowIso, targetProduct.id);
        db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      const variantPatches = [];
      if (Array.isArray(body.variants)) {
        variantPatches.push(...body.variants);
      } else if (
        body.variantId !== undefined ||
        body.sku !== undefined ||
        Object.prototype.hasOwnProperty.call(body, 'priceCents') ||
        Object.prototype.hasOwnProperty.call(body, 'variantActive')
      ) {
        variantPatches.push({
          variantId: body.variantId,
          sku: body.sku,
          priceCents: body.priceCents,
          active: Object.prototype.hasOwnProperty.call(body, 'variantActive') ? body.variantActive : undefined
        });
      }

      for (const vp of variantPatches) {
        if (!vp || typeof vp !== 'object') {
          throw utils.httpError(400, 'Each variant patch must be an object', 'VALIDATION_ERROR');
        }
        const vRow = utils.resolveVariantByInput(
          db,
          { variantId: vp.variantId ?? vp.id, sku: vp.sku },
          { requireActive: false }
        );
        if (Number(vRow.product_id) !== Number(targetProduct.id)) {
          throw utils.httpError(400, `Variant ${vRow.sku} does not belong to this product`, 'VARIANT_MISMATCH');
        }

        const vUpdates = [];
        const vParams = [];
        if (Object.prototype.hasOwnProperty.call(vp, 'priceCents') && vp.priceCents !== undefined) {
          const priceRes = security.parseStrictInt(vp.priceCents, { min: 0, max: 1_000_000 });
          if (!priceRes.ok) {
            throw utils.httpError(400, 'priceCents must be a non-negative integer', 'VALIDATION_ERROR');
          }
          vUpdates.push('price_cents = ?');
          vParams.push(priceRes.value);
        }
        if (Object.prototype.hasOwnProperty.call(vp, 'active') && vp.active !== undefined) {
          if (typeof vp.active !== 'boolean' && vp.active !== 0 && vp.active !== 1) {
            throw utils.httpError(400, 'variant active must be boolean or 0/1', 'VALIDATION_ERROR');
          }
          vUpdates.push('active = ?');
          vParams.push(vp.active ? 1 : 0);
        }
        if (vUpdates.length > 0) {
          vParams.push(vRow.id);
          db.prepare(`UPDATE variants SET ${vUpdates.join(', ')} WHERE id = ?`).run(...vParams);
          db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(nowIso, targetProduct.id);
        }
      }

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'product.update',
        targetType: 'product',
        targetId: String(targetProduct.id),
        details: { updatedFields: updates.length, variantUpdates: variantPatches.length }
      });

      return dbMod.getCatalog(db, { includeInactive: true }).find((p) => p.id === Number(targetProduct.id));
    });

    utils.sendJson(res, 200, { ok: true, product });
    return true;
  }

  // --- Promotions ---
  if (method === 'GET' && pathname === '/api/ops/promotions') {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser']);
    if (!auth) return true;
    const rows = dbMod.toPlainRows(db.prepare('SELECT * FROM promotions ORDER BY id DESC').all());
    utils.sendJson(res, 200, { ok: true, promotions: rows.map(utils.formatPromotion) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/ops/promotions') {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser'], body);
    if (!auth) return true;

    const codeCheck = security.validateNonEmptyString(body.code, { minLen: 2, maxLen: 32, field: 'Promo code' });
    if (!codeCheck.ok) {
      utils.sendError(res, 400, codeCheck.error, 'VALIDATION_ERROR');
      return true;
    }
    const code = codeCheck.value.toUpperCase();
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
      utils.sendError(res, 400, 'Promo code must be alphanumeric (A-Z, 0-9, _, -)', 'INVALID_PROMO_CODE');
      return true;
    }

    const type = security.sanitizeText(body.type ?? '', 20).toLowerCase();
    if (!VALID_PROMO_TYPES.has(type)) {
      utils.sendError(res, 400, "Promo type must be 'percent', 'fixed', or 'free_shipping'", 'VALIDATION_ERROR');
      return true;
    }

    const valMax = type === 'percent' ? 100 : 1_000_000;
    const valMin = type === 'free_shipping' ? 0 : 1;
    const rawValue = Object.prototype.hasOwnProperty.call(body, 'value')
      ? body.value
      : (type === 'free_shipping' ? 0 : undefined);
    const valRes = security.parseStrictInt(rawValue, { min: valMin, max: valMax });
    if (!valRes.ok) {
      utils.sendError(res, 400, `Promo value must be an integer between ${valMin} and ${valMax}`, 'VALIDATION_ERROR');
      return true;
    }

    const rawMinSub = Object.prototype.hasOwnProperty.call(body, 'minSubtotalCents') ? body.minSubtotalCents : 0;
    const minSubRes = security.parseStrictInt(rawMinSub, { min: 0, max: 10_000_000 });
    if (!minSubRes.ok) {
      utils.sendError(res, 400, 'minSubtotalCents must be a non-negative integer', 'VALIDATION_ERROR');
      return true;
    }

    let maxUses = null;
    if (Object.prototype.hasOwnProperty.call(body, 'maxUses') && body.maxUses !== null && body.maxUses !== '') {
      const maxRes = security.parseStrictInt(body.maxUses, { min: 1, max: 1_000_000 });
      if (!maxRes.ok) {
        utils.sendError(res, 400, 'maxUses must be null or a positive integer', 'VALIDATION_ERROR');
        return true;
      }
      maxUses = maxRes.value;
    }

    const active = body.active === false || body.active === 0 ? 0 : 1;

    const promotion = dbMod.withTransaction(db, () => {
      if (db.prepare('SELECT id FROM promotions WHERE UPPER(code) = ?').get(code)) {
        throw utils.httpError(409, `Promo code '${code}' already exists`, 'PROMO_EXISTS');
      }
      const nowIso = new Date().toISOString();
      const resInsert = db.prepare(
        `INSERT INTO promotions (code, type, value, min_subtotal_cents, active, max_uses, uses_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(code, type, valRes.value, minSubRes.value, active, maxUses, nowIso);
      const promoId = Number(resInsert.lastInsertRowid);

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'promotion.create',
        targetType: 'promotion',
        targetId: code,
        details: { type, value: valRes.value, minSubtotalCents: minSubRes.value, maxUses }
      });

      return utils.formatPromotion(dbMod.toPlain(db.prepare('SELECT * FROM promotions WHERE id = ?').get(promoId)));
    });

    utils.sendJson(res, 201, { ok: true, promotion });
    return true;
  }

  const promoPatchMatch = pathname.match(/^\/api\/ops\/promotions\/([^/]+)$/);
  if (method === 'PATCH' && (pathname === '/api/ops/promotions' || promoPatchMatch)) {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser'], body);
    if (!auth) return true;

    const pathTarget = promoPatchMatch ? promoPatchMatch[1].trim() : null;

    const promotion = dbMod.withTransaction(db, () => {
      const lookup = pathTarget ?? body.id ?? body.code;
      if (lookup === undefined || lookup === null || lookup === '') {
        throw utils.httpError(400, 'Promotion id or code is required', 'VALIDATION_ERROR');
      }

      const idCheck = security.parseStrictInt(lookup, { min: 1, coerceString: true });
      const existing = idCheck.ok
        ? db.prepare('SELECT * FROM promotions WHERE id = ?').get(idCheck.value)
        : db.prepare('SELECT * FROM promotions WHERE UPPER(code) = UPPER(?)').get(String(lookup));

      if (!existing) {
        throw utils.httpError(404, 'Promotion not found', 'PROMO_NOT_FOUND');
      }

      const updates = [];
      const params = [];
      const nextType = Object.prototype.hasOwnProperty.call(body, 'type')
        ? security.sanitizeText(body.type, 20).toLowerCase()
        : existing.type;
      if (!VALID_PROMO_TYPES.has(nextType)) {
        throw utils.httpError(400, "Promo type must be 'percent', 'fixed', or 'free_shipping'", 'VALIDATION_ERROR');
      }
      if (Object.prototype.hasOwnProperty.call(body, 'type')) {
        updates.push('type = ?');
        params.push(nextType);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'value')) {
        const valMax = nextType === 'percent' ? 100 : 1_000_000;
        const valMin = nextType === 'free_shipping' ? 0 : 1;
        const valRes = security.parseStrictInt(body.value, { min: valMin, max: valMax });
        if (!valRes.ok) {
          throw utils.httpError(400, `Promo value must be an integer between ${valMin} and ${valMax}`, 'VALIDATION_ERROR');
        }
        updates.push('value = ?');
        params.push(valRes.value);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'minSubtotalCents')) {
        const minRes = security.parseStrictInt(body.minSubtotalCents, { min: 0, max: 10_000_000 });
        if (!minRes.ok) throw utils.httpError(400, 'minSubtotalCents must be a non-negative integer', 'VALIDATION_ERROR');
        updates.push('min_subtotal_cents = ?');
        params.push(minRes.value);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'maxUses')) {
        if (body.maxUses === null) {
          updates.push('max_uses = NULL');
        } else {
          const maxRes = security.parseStrictInt(body.maxUses, { min: 1, max: 1_000_000 });
          if (!maxRes.ok) throw utils.httpError(400, 'maxUses must be null or a positive integer', 'VALIDATION_ERROR');
          updates.push('max_uses = ?');
          params.push(maxRes.value);
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'active')) {
        if (typeof body.active !== 'boolean' && body.active !== 0 && body.active !== 1) {
          throw utils.httpError(400, 'active must be boolean or 0/1', 'VALIDATION_ERROR');
        }
        updates.push('active = ?');
        params.push(body.active ? 1 : 0);
      }

      if (updates.length === 0) {
        throw utils.httpError(400, 'No valid promotion fields supplied to update', 'VALIDATION_ERROR');
      }

      params.push(existing.id);
      db.prepare(`UPDATE promotions SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'promotion.update',
        targetType: 'promotion',
        targetId: existing.code,
        details: { updatedCount: updates.length }
      });

      return utils.formatPromotion(dbMod.toPlain(db.prepare('SELECT * FROM promotions WHERE id = ?').get(existing.id)));
    });

    utils.sendJson(res, 200, { ok: true, promotion });
    return true;
  }

  // --- Audit Logs & Notification Outbox ---
  if (method === 'GET' && pathname === '/api/ops/audit-logs') {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser']);
    if (!auth) return true;

    const rawLimit = url.searchParams.get('limit');
    const limitRes = rawLimit !== null
      ? security.parseStrictInt(rawLimit, { min: 1, max: 500, coerceString: true })
      : { ok: true, value: 100 };
    if (!limitRes.ok) {
      utils.sendError(res, 400, 'limit must be between 1 and 500', 'VALIDATION_ERROR');
      return true;
    }

    const actionFilter = (url.searchParams.get('action') ?? '').trim();
    const targetTypeFilter = (url.searchParams.get('targetType') ?? '').trim();

    const clauses = [];
    const params = [];
    if (actionFilter) {
      clauses.push('action = ?');
      params.push(actionFilter);
    }
    if (targetTypeFilter) {
      clauses.push('target_type = ?');
      params.push(targetTypeFilter);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limitRes.value);

    const rows = dbMod.toPlainRows(
      db.prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ?`).all(...params)
    );
    const logs = rows.map((r) => ({
      id: Number(r.id),
      actorId: r.actor_id === null || r.actor_id === undefined ? null : Number(r.actor_id),
      actorEmail: String(r.actor_email ?? ''),
      actorRole: String(r.actor_role ?? ''),
      action: String(r.action),
      targetType: String(r.target_type),
      targetId: String(r.target_id),
      details: utils.safeJsonParse(r.details_json, {}),
      createdAt: String(r.created_at)
    }));

    utils.sendJson(res, 200, { ok: true, count: logs.length, logs });
    return true;
  }

  if (method === 'GET' && pathname === '/api/ops/outbox') {
    const auth = authorizeOps(req, res, db, ['admin', 'merchandiser']);
    if (!auth) return true;

    const rawLimit = url.searchParams.get('limit');
    const limitRes = rawLimit !== null
      ? security.parseStrictInt(rawLimit, { min: 1, max: 500, coerceString: true })
      : { ok: true, value: 100 };
    if (!limitRes.ok) {
      utils.sendError(res, 400, 'limit must be between 1 and 500', 'VALIDATION_ERROR');
      return true;
    }

    const typeFilter = (url.searchParams.get('type') ?? '').trim();
    const refFilter = (url.searchParams.get('referenceId') ?? '').trim();
    const clauses = [];
    const params = [];
    if (typeFilter) {
      clauses.push('type = ?');
      params.push(typeFilter);
    }
    if (refFilter) {
      clauses.push('UPPER(reference_id) = UPPER(?)');
      params.push(refFilter);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limitRes.value);

    const rows = dbMod.toPlainRows(
      db.prepare(`SELECT * FROM notification_outbox ${whereSql} ORDER BY id DESC LIMIT ?`).all(...params)
    );
    const outbox = rows.map((r) => ({
      id: Number(r.id),
      toEmail: String(r.to_email),
      subject: String(r.subject),
      body: String(r.body),
      type: String(r.type),
      status: String(r.status),
      referenceId: String(r.reference_id ?? ''),
      createdAt: String(r.created_at)
    }));

    utils.sendJson(res, 200, { ok: true, count: outbox.length, outbox });
    return true;
  }

  // --- Warehouse: Inventory Adjustment, Lots, Ship, OMS Transitions ---
  if (method === 'GET' && pathname === '/api/ops/inventory/ledger') {
    const auth = authorizeOps(req, res, db, ['admin', 'warehouse']);
    if (!auth) return true;

    const rawLimit = url.searchParams.get('limit');
    const limitRes = rawLimit !== null
      ? security.parseStrictInt(rawLimit, { min: 1, max: 500, coerceString: true })
      : { ok: true, value: 100 };
    if (!limitRes.ok) {
      utils.sendError(res, 400, 'limit must be between 1 and 500', 'VALIDATION_ERROR');
      return true;
    }

    const rows = dbMod.toPlainRows(
      db.prepare(
        `SELECT il.*, v.sku, v.label AS variant_label, p.name AS product_name
         FROM inventory_ledger il
         JOIN variants v ON v.id = il.variant_id
         JOIN products p ON p.id = v.product_id
         ORDER BY il.id DESC
         LIMIT ?`
      ).all(limitRes.value)
    );

    const ledger = rows.map((r) => ({
      id: Number(r.id),
      variantId: Number(r.variant_id),
      sku: String(r.sku),
      productName: String(r.product_name),
      variantLabel: String(r.variant_label),
      delta: Number(r.delta),
      reason: String(r.reason),
      lotNumber: String(r.lot_number ?? ''),
      expiresAt: String(r.expires_at ?? ''),
      actorId: r.actor_id === null || r.actor_id === undefined ? null : Number(r.actor_id),
      referenceId: String(r.reference_id ?? ''),
      createdAt: String(r.created_at)
    }));

    utils.sendJson(res, 200, { ok: true, count: ledger.length, ledger });
    return true;
  }

  if (method === 'POST' && pathname === '/api/ops/inventory/adjust') {
    const auth = authorizeOps(req, res, db, ['admin', 'warehouse'], body);
    if (!auth) return true;

    const variant = utils.resolveVariantByInput(db, body, { requireActive: false });
    const deltaRes = security.parseStrictInt(body.delta, { min: -100_000, max: 100_000 });
    if (!deltaRes.ok || deltaRes.value === 0) {
      utils.sendError(res, 400, 'delta must be a non-zero integer', 'INVALID_DELTA');
      return true;
    }

    const reasonCheck = security.validateNonEmptyString(body.reason, { minLen: 2, maxLen: 200, field: 'Reason' });
    if (!reasonCheck.ok) {
      utils.sendError(res, 400, reasonCheck.error, 'VALIDATION_ERROR');
      return true;
    }

    const lotNumber = security.sanitizeText(body.lotNumber ?? '', 60);
    const expiresAt = security.sanitizeText(body.expiresAt ?? '', 30);

    const updatedVariant = dbMod.withTransaction(db, () => {
      const adjusted = dbMod.adjustVariantStock(db, {
        variantId: variant.id,
        delta: deltaRes.value,
        reason: reasonCheck.value,
        lotNumber,
        expiresAt,
        actorId: auth.user.id,
        referenceId: 'OPS-ADJ'
      });

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'inventory.adjust',
        targetType: 'variant',
        targetId: String(variant.sku),
        details: {
          variantId: variant.id,
          delta: deltaRes.value,
          reason: reasonCheck.value,
          lotNumber,
          expiresAt,
          onHand: adjusted.on_hand,
          available: adjusted.available
        }
      });

      return adjusted;
    });

    utils.sendJson(res, 200, {
      ok: true,
      variant: {
        id: Number(updatedVariant.id),
        productId: Number(updatedVariant.product_id),
        sku: String(updatedVariant.sku),
        label: String(updatedVariant.label),
        onHand: Number(updatedVariant.on_hand),
        reserved: Number(updatedVariant.reserved),
        available: Number(updatedVariant.available),
        inStock: Number(updatedVariant.available) > 0,
        lots: updatedVariant.lots ?? []
      }
    });
    return true;
  }

  const shipMatch = pathname.match(/^\/api\/ops\/orders\/([^/]+)\/ship$/);
  if (method === 'POST' && shipMatch) {
    const auth = authorizeOps(req, res, db, ['admin', 'warehouse'], body);
    if (!auth) return true;

    const orderId = shipMatch[1].trim();
    const carrierCheck = security.validateNonEmptyString(body.carrier, { minLen: 2, maxLen: 80, field: 'Carrier' });
    const trackingCheck = security.validateNonEmptyString(body.trackingNumber, {
      minLen: 3,
      maxLen: 120,
      field: 'Tracking number'
    });
    if (!carrierCheck.ok) {
      utils.sendError(res, 400, carrierCheck.error, 'VALIDATION_ERROR');
      return true;
    }
    if (!trackingCheck.ok) {
      utils.sendError(res, 400, trackingCheck.error, 'VALIDATION_ERROR');
      return true;
    }

    const note = security.sanitizeText(
      body.note ?? `Shipped via ${carrierCheck.value} (${trackingCheck.value})`,
      300
    );

    const result = dbMod.withTransaction(db, () => {
      const orderRow = dbMod.toPlain(db.prepare('SELECT * FROM orders WHERE UPPER(id) = UPPER(?)').get(orderId));
      if (!orderRow) {
        throw utils.httpError(404, `Order '${orderId}' not found`, 'ORDER_NOT_FOUND');
      }
      if (
        !dbMod.canTransitionOrderStatus(orderRow.order_status, 'shipped') ||
        !dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'shipped')
      ) {
        throw utils.httpError(
          409,
          `Order must be packed before shipping (orderStatus='${orderRow.order_status}', fulfillmentStatus='${orderRow.fulfillment_status}')`,
          'INVALID_STATUS_TRANSITION'
        );
      }

      const itemRows = dbMod.toPlainRows(
        db.prepare('SELECT lot_number, expires_at, lot_allocations_json FROM order_items WHERE order_id = ?').all(orderRow.id)
      );
      const lotSet = new Set();
      const expiryCandidates = [];
      for (const item of itemRows) {
        if (item.lot_number) lotSet.add(item.lot_number);
        if (item.expires_at) expiryCandidates.push(item.expires_at);
        const allocs = utils.safeJsonParse(item.lot_allocations_json, []);
        for (const a of allocs) {
          if (a.lotNumber) lotSet.add(a.lotNumber);
          if (a.expiresAt) expiryCandidates.push(a.expiresAt);
        }
      }
      expiryCandidates.sort();
      const lotNumbers = Array.from(lotSet);
      const earliestExpiresAt = expiryCandidates[0] ?? '';
      const coldChainPack = body.coldChainPack !== undefined
        ? (body.coldChainPack ? 1 : 0)
        : Number(orderRow.insulated_pack_included ?? 1);
      const storageInstructions = String(orderRow.storage_notice ?? dbMod.COLD_CHAIN_STORAGE_NOTICE);
      const nowIso = new Date().toISOString();

      const shipInsert = db.prepare(
        `INSERT INTO shipments (
           order_id, carrier, tracking_number, status,
           lot_numbers_json, earliest_expires_at, cold_chain_pack, storage_instructions,
           shipped_at, actor_id, created_at
         ) VALUES (?, ?, ?, 'shipped', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        orderRow.id,
        carrierCheck.value,
        trackingCheck.value,
        JSON.stringify(lotNumbers),
        earliestExpiresAt,
        coldChainPack,
        storageInstructions,
        nowIso,
        auth.user.id,
        nowIso
      );

      const updatedOrderRow = dbMod.transitionOrderState(db, orderRow.id, {
        orderStatus: 'shipped',
        fulfillmentStatus: 'shipped',
        note,
        actorId: auth.user.id
      });

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'order.ship',
        targetType: 'order',
        targetId: orderRow.id,
        details: {
          carrier: carrierCheck.value,
          trackingNumber: trackingCheck.value,
          lotNumbers,
          earliestExpiresAt,
          coldChainPack: Boolean(coldChainPack)
        }
      });

      dbMod.queueNotification(db, {
        toEmail: orderRow.customer_email,
        subject: `Your SOLIS Order ${orderRow.id} Has Shipped`,
        body: `Hi ${orderRow.customer_name},\n\nYour SOLIS order ${orderRow.id} has shipped via ${carrierCheck.value}.\nTracking Number: ${trackingCheck.value}\nFEFO Lots: ${lotNumbers.join(', ') || 'Standard'}\nCold-Chain Care: ${storageInstructions}\n\n— SOLIS`,
        type: 'order_shipped',
        referenceId: orderRow.id
      });

      const shipmentRow = dbMod.toPlain(
        db.prepare('SELECT * FROM shipments WHERE id = ?').get(Number(shipInsert.lastInsertRowid))
      );

      return {
        order: utils.hydrateOrder(db, updatedOrderRow),
        shipment: {
          id: Number(shipmentRow.id),
          orderId: String(shipmentRow.order_id),
          carrier: String(shipmentRow.carrier),
          trackingNumber: String(shipmentRow.tracking_number),
          status: String(shipmentRow.status),
          lotNumbers,
          earliestExpiresAt,
          coldChainPack: Boolean(shipmentRow.cold_chain_pack),
          storageInstructions: String(shipmentRow.storage_instructions),
          shippedAt: String(shipmentRow.shipped_at),
          createdAt: String(shipmentRow.created_at)
        }
      };
    });

    utils.sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  const orderStatusMatch = pathname.match(/^\/api\/ops\/orders\/([^/]+)\/status$/);
  if (method === 'PATCH' && orderStatusMatch) {
    const auth = authorizeOps(req, res, db, ['admin', 'warehouse'], body);
    if (!auth) return true;

    const orderId = orderStatusMatch[1].trim();
    const rawOrderStatus = body.orderStatus !== undefined ? body.orderStatus : body.status;
    const requestedOrderStatus = rawOrderStatus !== undefined
      ? security.sanitizeText(String(rawOrderStatus), 30).toLowerCase()
      : undefined;
    const requestedFulfillment = body.fulfillmentStatus !== undefined
      ? security.sanitizeText(String(body.fulfillmentStatus), 30).toLowerCase()
      : undefined;
    const requestedPayment = body.paymentStatus !== undefined
      ? security.sanitizeText(String(body.paymentStatus), 30).toLowerCase()
      : undefined;

    if (requestedOrderStatus !== undefined && !dbMod.ORDER_STATUSES.includes(requestedOrderStatus)) {
      utils.sendError(res, 400, `orderStatus must be one of: ${dbMod.ORDER_STATUSES.join(', ')}`, 'INVALID_STATUS');
      return true;
    }
    if (requestedFulfillment !== undefined && !dbMod.FULFILLMENT_STATUSES.includes(requestedFulfillment)) {
      utils.sendError(res, 400, `fulfillmentStatus must be one of: ${dbMod.FULFILLMENT_STATUSES.join(', ')}`, 'INVALID_STATUS');
      return true;
    }
    if (requestedPayment !== undefined && !dbMod.PAYMENT_STATUSES.includes(requestedPayment)) {
      utils.sendError(res, 400, `paymentStatus must be one of: ${dbMod.PAYMENT_STATUSES.join(', ')}`, 'INVALID_STATUS');
      return true;
    }
    if (requestedOrderStatus === undefined && requestedFulfillment === undefined && requestedPayment === undefined) {
      utils.sendError(res, 400, 'Specify status/orderStatus, fulfillmentStatus, or paymentStatus', 'VALIDATION_ERROR');
      return true;
    }

    const note = security.sanitizeText(body.note ?? '', 300);

    const updatedOrder = dbMod.withTransaction(db, () => {
      const orderRow = dbMod.toPlain(db.prepare('SELECT * FROM orders WHERE UPPER(id) = UPPER(?)').get(orderId));
      if (!orderRow) {
        throw utils.httpError(404, `Order '${orderId}' not found`, 'ORDER_NOT_FOUND');
      }

      let nextFulfillment = requestedFulfillment;
      if (nextFulfillment === undefined && requestedOrderStatus !== undefined) {
        if (requestedOrderStatus === 'packed' && dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'packed')) {
          nextFulfillment = 'packed';
        } else if (requestedOrderStatus === 'shipped' && dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'shipped')) {
          nextFulfillment = 'shipped';
        } else if (requestedOrderStatus === 'delivered' && dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'delivered')) {
          nextFulfillment = 'delivered';
        } else if (requestedOrderStatus === 'cancelled' && dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'cancelled')) {
          nextFulfillment = 'cancelled';
        }
      }

      let nextPayment = requestedPayment;
      if (requestedOrderStatus === 'cancelled' && orderRow.order_status !== 'cancelled') {
        dbMod.restoreOrderStock(db, orderRow.id, { actorId: auth.user.id, reason: 'ops_cancel' });
        if (nextPayment === undefined) {
          if (orderRow.payment_status === 'paid' && Number(orderRow.total_cents) > 0) {
            const nowIso = new Date().toISOString();
            const pi = db.prepare('SELECT id FROM payment_intents WHERE order_id = ? LIMIT 1').get(orderRow.id);
            const refundId = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            db.prepare(
              `INSERT INTO refunds (id, order_id, payment_intent_id, return_id, amount_cents, reason, status, actor_id, created_at)
               VALUES (?, ?, ?, '', ?, ?, 'succeeded', ?, ?)`
            ).run(
              refundId,
              orderRow.id,
              pi ? pi.id : null,
              Number(orderRow.total_cents),
              note || 'Warehouse cancellation',
              auth.user.id,
              nowIso
            );
            nextPayment = 'refunded';
          } else if (dbMod.canTransitionPaymentStatus(orderRow.payment_status, 'voided')) {
            nextPayment = 'voided';
          }
        }
      }

      const transitioned = dbMod.transitionOrderState(db, orderRow.id, {
        orderStatus: requestedOrderStatus,
        paymentStatus: nextPayment,
        fulfillmentStatus: nextFulfillment,
        note: note || `Status updated by ${auth.user.role}`,
        actorId: auth.user.id
      });

      if (requestedOrderStatus === 'delivered') {
        db.prepare("UPDATE shipments SET status = 'delivered' WHERE order_id = ?").run(orderRow.id);
        dbMod.queueNotification(db, {
          toEmail: orderRow.customer_email,
          subject: `Order ${orderRow.id} Delivered — SOLIS`,
          body: `Hi ${orderRow.customer_name},\n\nYour SOLIS cold-chain delivery (${orderRow.id}) has arrived! ${orderRow.storage_notice}\n\n— SOLIS`,
          type: 'order_delivered',
          referenceId: orderRow.id
        });
      }

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'order.status_update',
        targetType: 'order',
        targetId: orderRow.id,
        details: {
          orderStatus: transitioned.order_status,
          paymentStatus: transitioned.payment_status,
          fulfillmentStatus: transitioned.fulfillment_status,
          note
        }
      });

      return utils.hydrateOrder(db, transitioned);
    });

    utils.sendJson(res, 200, { ok: true, order: updatedOrder });
    return true;
  }

  // --- CSR (and Warehouse Pick/Pack view): Searchable Orders & RMA Resolution ---
  if (method === 'GET' && pathname === '/api/ops/orders') {
    const auth = authorizeOps(req, res, db, ['admin', 'csr', 'warehouse']);
    if (!auth) return true;

    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const statusParam = (url.searchParams.get('status') ?? '').trim().toLowerCase();
    const rawLimit = url.searchParams.get('limit');
    const limitRes = rawLimit !== null
      ? security.parseStrictInt(rawLimit, { min: 1, max: 500, coerceString: true })
      : { ok: true, value: 100 };
    if (!limitRes.ok) {
      utils.sendError(res, 400, 'limit must be between 1 and 500', 'VALIDATION_ERROR');
      return true;
    }

    const clauses = [];
    const params = [];

    if (statusParam) {
      const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
      const valid = statuses.filter((s) => dbMod.ORDER_STATUSES.includes(s));
      if (valid.length > 0) {
        clauses.push(`order_status IN (${valid.map(() => '?').join(',')})`);
        params.push(...valid);
      }
    }

    if (q) {
      const like = `%${q}%`;
      clauses.push(
        `(LOWER(id) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(customer_email) LIKE ? OR LOWER(shipping_postal) LIKE ? OR LOWER(promo_code) LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = orders.id AND (LOWER(oi.sku) LIKE ? OR LOWER(oi.product_name) LIKE ?)))`
      );
      params.push(like, like, like, like, like, like, like);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limitRes.value);

    const rows = dbMod.toPlainRows(
      db.prepare(`SELECT * FROM orders ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params)
    );
    const orders = utils.hydrateOrders(db, rows, { maskPii: false });

    utils.sendJson(res, 200, { ok: true, count: orders.length, orders });
    return true;
  }

  if (method === 'GET' && pathname === '/api/ops/returns') {
    const auth = authorizeOps(req, res, db, ['admin', 'csr']);
    if (!auth) return true;

    const statusParam = (url.searchParams.get('status') ?? '').trim().toLowerCase();
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const clauses = [];
    const params = [];

    if (statusParam) {
      clauses.push('LOWER(r.status) = ?');
      params.push(statusParam);
    }
    if (q) {
      const like = `%${q}%`;
      clauses.push('(LOWER(r.id) LIKE ? OR LOWER(r.order_id) LIKE ? OR LOWER(o.customer_email) LIKE ? OR LOWER(r.reason) LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = dbMod.toPlainRows(
      db.prepare(
        `SELECT r.*, o.customer_name, o.customer_email, o.order_status, o.total_cents AS order_total_cents
         FROM returns r
         JOIN orders o ON o.id = r.order_id
         ${whereSql}
         ORDER BY r.created_at DESC`
      ).all(...params)
    );

    const returns = rows.map((r) => ({
      ...utils.formatRma(r),
      customerName: String(r.customer_name),
      customerEmail: String(r.customer_email),
      orderStatus: String(r.order_status),
      orderTotalCents: Number(r.order_total_cents)
    }));

    utils.sendJson(res, 200, { ok: true, count: returns.length, returns });
    return true;
  }

  const returnPatchMatch = pathname.match(/^\/api\/ops\/returns\/([^/]+)$/);
  if (method === 'PATCH' && returnPatchMatch) {
    const auth = authorizeOps(req, res, db, ['admin', 'csr'], body);
    if (!auth) return true;

    const rmaId = returnPatchMatch[1].trim();
    const rawAction = body.action ? security.sanitizeText(body.action, 20).toLowerCase() : '';
    const rawStatus = body.status ? security.sanitizeText(body.status, 20).toLowerCase() : '';
    const nextStatus = rawStatus || RMA_ACTION_TO_STATUS[rawAction] || '';

    if (!['approved', 'rejected', 'refunded', 'replaced'].includes(nextStatus)) {
      utils.sendError(
        res,
        400,
        "RMA status must be 'approved', 'rejected', 'refunded', or 'replaced'",
        'INVALID_RMA_STATUS'
      );
      return true;
    }

    const resolution = security.sanitizeText(body.resolution ?? nextStatus, 200);
    const notes = security.sanitizeText(body.notes ?? '', 500);
    const shouldRestock = body.restock === true;

    const result = dbMod.withTransaction(db, () => {
      const rmaRow = dbMod.toPlain(db.prepare('SELECT * FROM returns WHERE UPPER(id) = UPPER(?)').get(rmaId));
      if (!rmaRow) {
        throw utils.httpError(404, `RMA '${rmaId}' not found`, 'RMA_NOT_FOUND');
      }
      if (['rejected', 'refunded', 'replaced'].includes(rmaRow.status)) {
        throw utils.httpError(409, `RMA '${rmaRow.id}' is already resolved (${rmaRow.status})`, 'RMA_ALREADY_RESOLVED');
      }

      const orderRow = dbMod.toPlain(db.prepare('SELECT * FROM orders WHERE id = ?').get(rmaRow.order_id));
      if (!orderRow) {
        throw utils.httpError(404, 'Associated order not found', 'ORDER_NOT_FOUND');
      }

      let finalRefundCents = Number(rmaRow.refund_cents ?? 0);
      let refund = null;
      const nowIso = new Date().toISOString();

      if (nextStatus === 'refunded') {
        const refundedRow = db.prepare(
          "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE order_id = ? AND status = 'succeeded'"
        ).get(orderRow.id);
        const alreadyRefunded = Number(refundedRow.total ?? 0);
        const remainingRefundable = Math.max(0, Number(orderRow.total_cents) - alreadyRefunded);

        if (Object.prototype.hasOwnProperty.call(body, 'refundCents')) {
          const refRes = security.parseStrictInt(body.refundCents, { min: 1, max: 10_000_000 });
          if (!refRes.ok) {
            throw utils.httpError(400, 'refundCents must be a positive integer', 'INVALID_REFUND_AMOUNT');
          }
          finalRefundCents = refRes.value;
        } else {
          finalRefundCents = finalRefundCents > 0 ? Math.min(finalRefundCents, remainingRefundable) : remainingRefundable;
        }

        if (finalRefundCents <= 0 || finalRefundCents > remainingRefundable) {
          throw utils.httpError(
            409,
            `Refund amount (${finalRefundCents}) exceeds remaining refundable balance (${remainingRefundable})`,
            'REFUND_EXCEEDS_TOTAL'
          );
        }

        const pi = db.prepare('SELECT id FROM payment_intents WHERE order_id = ? LIMIT 1').get(orderRow.id);
        const refundId = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        db.prepare(
          `INSERT INTO refunds (id, order_id, payment_intent_id, return_id, amount_cents, reason, status, actor_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?)`
        ).run(refundId, orderRow.id, pi ? pi.id : null, rmaRow.id, finalRefundCents, rmaRow.reason, auth.user.id, nowIso);

        refund = {
          id: refundId,
          orderId: orderRow.id,
          returnId: rmaRow.id,
          amountCents: finalRefundCents,
          reason: rmaRow.reason,
          status: 'succeeded',
          createdAt: nowIso
        };

        const isFullRefund = alreadyRefunded + finalRefundCents >= Number(orderRow.total_cents);
        const targetPaymentStatus = isFullRefund ? 'refunded' : 'partially_refunded';
        const nextOrderStatus = isFullRefund && dbMod.canTransitionOrderStatus(orderRow.order_status, 'refunded')
          ? 'refunded'
          : undefined;
        const nextFulfillmentStatus = isFullRefund && dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'returned')
          ? 'returned'
          : undefined;

        dbMod.transitionOrderState(db, orderRow.id, {
          orderStatus: nextOrderStatus,
          paymentStatus: dbMod.canTransitionPaymentStatus(orderRow.payment_status, targetPaymentStatus)
            ? targetPaymentStatus
            : undefined,
          fulfillmentStatus: nextFulfillmentStatus,
          note: `RMA ${rmaRow.id} refunded ($${(finalRefundCents / 100).toFixed(2)})`,
          actorId: auth.user.id
        });

        if (shouldRestock) {
          dbMod.restoreOrderStock(db, orderRow.id, { actorId: auth.user.id, reason: 'rma_restock' });
        }
      } else if (nextStatus === 'replaced') {
        const nextFulfillmentStatus = dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'returned')
          ? 'returned'
          : undefined;
        dbMod.transitionOrderState(db, orderRow.id, {
          fulfillmentStatus: nextFulfillmentStatus,
          note: `RMA ${rmaRow.id} replacement approved`,
          actorId: auth.user.id
        });
      }

      db.prepare(
        `UPDATE returns
         SET status = ?, resolution = ?, refund_cents = ?, notes = ?, handled_by = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        nextStatus,
        resolution,
        finalRefundCents,
        notes || String(rmaRow.notes ?? ''),
        auth.user.id,
        nowIso,
        rmaRow.id
      );

      dbMod.writeAuditLog(db, {
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: `rma.${nextStatus}`,
        targetType: 'return',
        targetId: rmaRow.id,
        details: {
          orderId: orderRow.id,
          resolution,
          refundCents: finalRefundCents,
          refundId: refund?.id ?? null
        }
      });

      const refundMsg = refund
        ? `Refund ${refund.id} for $${(refund.amountCents / 100).toFixed(2)} has been processed.`
        : `Resolution: ${resolution}.`;

      dbMod.queueNotification(db, {
        toEmail: orderRow.customer_email,
        subject: `RMA ${rmaRow.id} Update: ${nextStatus.toUpperCase()}`,
        body: `Hi ${orderRow.customer_name},\n\nYour return request ${rmaRow.id} for order ${orderRow.id} is now '${nextStatus}'. ${refundMsg}\n\n— SOLIS`,
        type: `rma_${nextStatus}`,
        referenceId: rmaRow.id
      });

      const updatedRma = utils.formatRma(dbMod.toPlain(db.prepare('SELECT * FROM returns WHERE id = ?').get(rmaRow.id)));
      return { rma: updatedRma, refund };
    });

    utils.sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // --- Finance: Ledger & Sanitized CSV Export ---
  if (method === 'GET' && pathname === '/api/ops/finance/ledger') {
    const auth = authorizeOps(req, res, db, ['admin', 'finance']);
    if (!auth) return true;

    const from = (url.searchParams.get('from') ?? '').trim();
    const to = (url.searchParams.get('to') ?? '').trim();
    const ledger = buildFinanceLedger(db, { from, to });

    utils.sendJson(res, 200, { ok: true, ...ledger });
    return true;
  }

  if (method === 'GET' && pathname === '/api/ops/finance/export.csv') {
    const auth = authorizeOps(req, res, db, ['admin', 'finance']);
    if (!auth) return true;

    const from = (url.searchParams.get('from') ?? '').trim();
    const to = (url.searchParams.get('to') ?? '').trim();
    const ledger = buildFinanceLedger(db, { from, to });

    dbMod.writeAuditLog(db, {
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      actorRole: auth.user.role,
      action: 'finance.export_csv',
      targetType: 'finance_ledger',
      targetId: 'export',
      details: { entryCount: ledger.entries.length }
    });

    const headers = [
      'Date',
      'Entry Type',
      'Reference ID',
      'Order ID',
      'Customer Name',
      'Customer Email',
      'Status',
      'Subtotal Cents',
      'Discount Cents',
      'Shipping Cents',
      'Tax Cents',
      'Signed Amount Cents',
      'Currency',
      'Note'
    ];

    const rows = ledger.entries.map((e) => [
      e.createdAt,
      e.entryType,
      e.referenceId,
      e.orderId,
      e.customerName,
      e.customerEmail,
      e.status,
      e.subtotalCents,
      e.discountCents,
      e.shippingCents,
      e.taxCents,
      e.signedAmountCents,
      e.currency,
      e.note
    ]);

    utils.sendCsv(res, 'solis-finance-ledger.csv', headers, rows);
    return true;
  }

  return false;
}

module.exports = { handleOpsRoutes };

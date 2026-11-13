'use strict';

const crypto = require('node:crypto');
const dbMod = require('../db');
const authMod = require('../auth');
const security = require('../security');
const utils = require('./utils');

const VALID_CADENCES = new Set(['biweekly', 'monthly', '2-week', '4-week']);

function cadenceIntervalDays(cadence) {
  return cadence === '2-week' || cadence === 'biweekly' ? 14 : 28;
}

function addDaysIso(baseIso, days) {
  const baseMs = Number.isFinite(Date.parse(baseIso)) ? Math.max(Date.now(), Date.parse(baseIso)) : Date.now();
  return new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
}

async function handleAccountRoutes(req, res, method, pathname, db) {
  if (!pathname.startsWith('/api/account')) return false;

  const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const auth = authMod.authenticateRequest(req, db);
  if (!auth) {
    utils.sendError(res, 401, 'Authentication required', 'UNAUTHENTICATED');
    return true;
  }

  let body = {};
  if (isMutating) {
    const optionalBody = method === 'DELETE' || pathname.endsWith('/cancel');
    ({ body } = await utils.readJsonBody(req, { optional: optionalBody }));
    if (!authMod.requireCsrf(req, res, auth, body)) {
      return true;
    }
  }

  const user = auth.user;

  // --- Addresses ---
  if (method === 'GET' && pathname === '/api/account/addresses') {
    const rows = dbMod.toPlainRows(
      db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC').all(user.id)
    );
    utils.sendJson(res, 200, {
      ok: true,
      addresses: rows.map(utils.formatAddress)
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/account/addresses') {
    const labelCheck = body.label !== undefined
      ? security.validateNonEmptyString(body.label, { minLen: 1, maxLen: 40, field: 'Label' })
      : { ok: true, value: 'Home' };
    if (!labelCheck.ok) {
      utils.sendError(res, 400, labelCheck.error, 'VALIDATION_ERROR');
      return true;
    }

    const recipientCheck = security.validateNonEmptyString(body.recipientName ?? user.name, {
      minLen: 1,
      maxLen: 120,
      field: 'Recipient name'
    });
    const line1Check = security.validateNonEmptyString(body.line1, { minLen: 2, maxLen: 200, field: 'Address line 1' });
    const cityCheck = security.validateNonEmptyString(body.city, { minLen: 1, maxLen: 100, field: 'City' });
    const postalCheck = security.validateNonEmptyString(body.postal, { minLen: 2, maxLen: 24, field: 'Postal code' });

    for (const check of [recipientCheck, line1Check, cityCheck, postalCheck]) {
      if (!check.ok) {
        utils.sendError(res, 400, check.error, 'VALIDATION_ERROR');
        return true;
      }
    }

    const line2 = security.sanitizeText(body.line2 ?? '', 200);
    const state = security.sanitizeText(body.state ?? '', 60);
    const country = security.sanitizeText(body.country ?? 'US', 40) || 'US';
    const wantDefault = Boolean(body.isDefault);
    const nowIso = new Date().toISOString();

    const address = dbMod.withTransaction(db, () => {
      const existingCount = Number(
        db.prepare('SELECT COUNT(*) AS cnt FROM addresses WHERE user_id = ?').get(user.id).cnt
      );
      const isDefault = wantDefault || existingCount === 0 ? 1 : 0;
      if (isDefault) {
        db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(user.id);
      }
      const resInsert = db.prepare(
        `INSERT INTO addresses (user_id, label, recipient_name, line1, line2, city, state, postal, country, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.id,
        labelCheck.value,
        recipientCheck.value,
        line1Check.value,
        line2,
        cityCheck.value,
        state,
        postalCheck.value,
        country,
        isDefault,
        nowIso
      );
      const row = db.prepare('SELECT * FROM addresses WHERE id = ?').get(Number(resInsert.lastInsertRowid));
      return utils.formatAddress(dbMod.toPlain(row));
    });

    utils.sendJson(res, 201, { ok: true, address });
    return true;
  }

  const addrDeleteMatch = pathname.match(/^\/api\/account\/addresses\/([^/]+)$/);
  if (method === 'DELETE' && addrDeleteMatch) {
    const idRes = security.parseStrictInt(addrDeleteMatch[1], { min: 1, coerceString: true });
    if (!idRes.ok) {
      utils.sendError(res, 400, 'Invalid address ID', 'INVALID_ID');
      return true;
    }

    const deleted = dbMod.withTransaction(db, () => {
      const existing = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').get(idRes.value, user.id);
      if (!existing) return null;
      db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(idRes.value, user.id);
      if (existing.is_default) {
        const nextAddr = db.prepare('SELECT id FROM addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
        if (nextAddr) {
          db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ?').run(nextAddr.id);
        }
      }
      return idRes.value;
    });

    if (!deleted) {
      utils.sendError(res, 404, 'Address not found', 'NOT_FOUND');
      return true;
    }
    utils.sendJson(res, 200, { ok: true, deletedId: deleted });
    return true;
  }

  // --- Orders ---
  if (method === 'GET' && pathname === '/api/account/orders') {
    const rows = dbMod.toPlainRows(
      db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(user.id)
    );
    utils.sendJson(res, 200, {
      ok: true,
      orders: utils.hydrateOrders(db, rows, { maskPii: false })
    });
    return true;
  }

  const cancelMatch = pathname.match(/^\/api\/account\/orders\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    const orderId = cancelMatch[1].trim();
    const reason = security.sanitizeText(body.reason ?? 'Customer requested cancellation', 300) || 'Customer requested cancellation';

    const result = dbMod.withTransaction(db, () => {
      const orderRow = dbMod.toPlain(
        db.prepare('SELECT * FROM orders WHERE UPPER(id) = UPPER(?) AND user_id = ?').get(orderId, user.id)
      );
      if (!orderRow) {
        throw utils.httpError(404, 'Order not found', 'ORDER_NOT_FOUND');
      }
      if (orderRow.order_status !== 'confirmed' && orderRow.order_status !== 'pending_payment') {
        throw utils.httpError(
          409,
          `Order cannot be cancelled in status '${orderRow.order_status}'`,
          'ORDER_NOT_CANCELLABLE'
        );
      }

      dbMod.restoreOrderStock(db, orderRow.id, { actorId: user.id, reason: 'order_cancel' });

      const nowIso = new Date().toISOString();
      let refund = null;
      let nextPaymentStatus = undefined;

      if (orderRow.payment_status === 'paid' && Number(orderRow.total_cents) > 0) {
        const pi = db.prepare('SELECT id FROM payment_intents WHERE order_id = ? LIMIT 1').get(orderRow.id);
        const refundId = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        db.prepare(
          `INSERT INTO refunds (id, order_id, payment_intent_id, return_id, amount_cents, reason, status, actor_id, created_at)
           VALUES (?, ?, ?, '', ?, ?, 'succeeded', ?, ?)`
        ).run(refundId, orderRow.id, pi ? pi.id : null, Number(orderRow.total_cents), reason, user.id, nowIso);
        refund = {
          id: refundId,
          orderId: orderRow.id,
          amountCents: Number(orderRow.total_cents),
          reason,
          status: 'succeeded',
          createdAt: nowIso
        };
        if (dbMod.canTransitionPaymentStatus(orderRow.payment_status, 'refunded')) {
          nextPaymentStatus = 'refunded';
        }
      } else if (dbMod.canTransitionPaymentStatus(orderRow.payment_status, 'voided')) {
        nextPaymentStatus = 'voided';
      }

      const nextFulfillmentStatus = dbMod.canTransitionFulfillmentStatus(orderRow.fulfillment_status, 'cancelled')
        ? 'cancelled'
        : undefined;

      const updatedOrderRow = dbMod.transitionOrderState(db, orderRow.id, {
        orderStatus: 'cancelled',
        paymentStatus: nextPaymentStatus,
        fulfillmentStatus: nextFulfillmentStatus,
        note: reason,
        actorId: user.id
      });

      dbMod.writeAuditLog(db, {
        actorId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: 'order.cancel',
        targetType: 'order',
        targetId: orderRow.id,
        details: {
          reason,
          refundId: refund?.id ?? null,
          refundCents: refund?.amountCents ?? 0
        }
      });

      const refundMsg = refund
        ? `A refund of $${(refund.amountCents / 100).toFixed(2)} (${refund.id}) has been recorded.`
        : 'No payment capture needed to be refunded.';

      dbMod.queueNotification(db, {
        toEmail: orderRow.customer_email,
        subject: `Order ${orderRow.id} Cancelled`,
        body: `Hi ${orderRow.customer_name},\n\nYour SOLIS order ${orderRow.id} has been cancelled (${reason}). Inventory has been restored. ${refundMsg}\n\n— SOLIS`,
        type: 'order_cancelled',
        referenceId: orderRow.id
      });

      return {
        order: utils.hydrateOrder(db, updatedOrderRow),
        refund
      };
    });

    utils.sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  const returnMatch = pathname.match(/^\/api\/account\/orders\/([^/]+)\/return$/);
  if (method === 'POST' && returnMatch) {
    const orderId = returnMatch[1].trim();
    const reasonCheck = security.validateNonEmptyString(body.reason, { minLen: 3, maxLen: 500, field: 'Reason' });
    if (!reasonCheck.ok) {
      utils.sendError(res, 400, reasonCheck.error, 'VALIDATION_ERROR');
      return true;
    }
    const notes = security.sanitizeText(body.notes ?? '', 500);

    const rma = dbMod.withTransaction(db, () => {
      const orderRow = dbMod.toPlain(
        db.prepare('SELECT * FROM orders WHERE UPPER(id) = UPPER(?) AND user_id = ?').get(orderId, user.id)
      );
      if (!orderRow) {
        throw utils.httpError(404, 'Order not found', 'ORDER_NOT_FOUND');
      }
      if (['pending_payment', 'cancelled', 'refunded'].includes(orderRow.order_status)) {
        throw utils.httpError(
          409,
          `Cannot submit RMA for order in status '${orderRow.order_status}'`,
          'RMA_NOT_ELIGIBLE'
        );
      }

      const orderItems = dbMod.toPlainRows(
        db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderRow.id)
      );
      const itemByVariant = new Map(orderItems.map((i) => [Number(i.variant_id), i]));
      const itemBySku = new Map(orderItems.map((i) => [String(i.sku).toUpperCase(), i]));

      let rmaItems = [];
      let requestedRefundCents = 0;

      if (Array.isArray(body.items) && body.items.length > 0) {
        for (const entry of body.items) {
          if (!entry || typeof entry !== 'object') {
            throw utils.httpError(400, 'Each RMA item must be an object', 'VALIDATION_ERROR');
          }
          let matched = null;
          if (entry.variantId !== undefined && entry.variantId !== null) {
            const vidRes = security.parseStrictInt(entry.variantId, { min: 1, coerceString: true });
            if (vidRes.ok) matched = itemByVariant.get(vidRes.value) ?? null;
          } else if (typeof entry.sku === 'string' && entry.sku.trim()) {
            matched = itemBySku.get(entry.sku.trim().toUpperCase()) ?? null;
          }
          if (!matched) {
            throw utils.httpError(400, 'RMA item does not belong to this order', 'INVALID_RMA_ITEM');
          }
          const qtyRes = security.parseStrictInt(entry.quantity ?? 1, { min: 1, max: Number(matched.quantity) });
          if (!qtyRes.ok) {
            throw utils.httpError(
              400,
              `RMA quantity for ${matched.sku} must be between 1 and ${matched.quantity}`,
              'INVALID_RMA_QUANTITY'
            );
          }
          requestedRefundCents += Number(matched.unit_price_cents) * qtyRes.value;
          rmaItems.push({
            variantId: Number(matched.variant_id),
            sku: String(matched.sku),
            productName: String(matched.product_name),
            variantLabel: String(matched.variant_label),
            quantity: qtyRes.value,
            unitPriceCents: Number(matched.unit_price_cents)
          });
        }
      } else {
        rmaItems = orderItems.map((m) => ({
          variantId: Number(m.variant_id),
          sku: String(m.sku),
          productName: String(m.product_name),
          variantLabel: String(m.variant_label),
          quantity: Number(m.quantity),
          unitPriceCents: Number(m.unit_price_cents)
        }));
        requestedRefundCents = Number(orderRow.total_cents);
      }

      requestedRefundCents = Math.min(Number(orderRow.total_cents), requestedRefundCents);
      const nowIso = new Date().toISOString();
      const rmaId = `RMA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      db.prepare(
        `INSERT INTO returns (id, order_id, user_id, status, reason, items_json, resolution, refund_cents, notes, handled_by, created_at, updated_at)
         VALUES (?, ?, ?, 'requested', ?, ?, '', ?, ?, NULL, ?, ?)`
      ).run(rmaId, orderRow.id, user.id, reasonCheck.value, JSON.stringify(rmaItems), requestedRefundCents, notes, nowIso, nowIso);

      dbMod.writeAuditLog(db, {
        actorId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: 'rma.request',
        targetType: 'return',
        targetId: rmaId,
        details: { orderId: orderRow.id, reason: reasonCheck.value, requestedRefundCents }
      });

      dbMod.queueNotification(db, {
        toEmail: orderRow.customer_email,
        subject: `RMA Request ${rmaId} Received for Order ${orderRow.id}`,
        body: `Hi ${orderRow.customer_name},\n\nWe received your damaged-can / return request (${rmaId}) for order ${orderRow.id}.\nReason: ${reasonCheck.value}\nOur care team will review and issue a replacement or refund.\n\n— SOLIS`,
        type: 'rma_requested',
        referenceId: rmaId
      });

      return utils.formatRma(dbMod.toPlain(db.prepare('SELECT * FROM returns WHERE id = ?').get(rmaId)));
    });

    utils.sendJson(res, 201, { ok: true, rma });
    return true;
  }

  // --- Subscriptions (Build-a-Box) ---
  if (method === 'GET' && pathname === '/api/account/subscriptions') {
    const rows = dbMod.toPlainRows(
      db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(user.id)
    );
    utils.sendJson(res, 200, {
      ok: true,
      subscriptions: rows.map((r) => utils.formatSubscription(db, r))
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/account/subscriptions') {
    const cadence = security.sanitizeText(body.cadence ?? '4-week', 20).toLowerCase();
    if (!VALID_CADENCES.has(cadence)) {
      utils.sendError(res, 400, "Cadence must be '2-week', '4-week', 'biweekly', or 'monthly'", 'INVALID_CADENCE');
      return true;
    }

    const { lineItems } = utils.resolveAndAggregateItems(db, body.items);
    const subItems = lineItems.map((i) => ({
      variantId: i.variantId,
      sku: i.sku,
      productName: i.productName,
      label: i.variantLabel,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents
    }));

    const nowIso = new Date().toISOString();
    const nextRunAt = addDaysIso(nowIso, cadenceIntervalDays(cadence));
    const subId = `SUB-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const subscription = dbMod.withTransaction(db, () => {
      db.prepare(
        `INSERT INTO subscriptions (id, user_id, cadence, status, items_json, next_run_at, skip_count, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?)`
      ).run(subId, user.id, cadence, JSON.stringify(subItems), nextRunAt, nowIso, nowIso);

      dbMod.writeAuditLog(db, {
        actorId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: 'subscription.create',
        targetType: 'subscription',
        targetId: subId,
        details: { cadence, itemCount: subItems.length }
      });

      dbMod.queueNotification(db, {
        toEmail: user.email,
        subject: `SOLIS Subscription ${subId} Activated`,
        body: `Hi ${user.name},\n\nYour Build-a-Box (${cadence}) subscription ${subId} is active. Next scheduled cold-chain shipment: ${nextRunAt.slice(0, 10)}.\n\n— SOLIS`,
        type: 'subscription_created',
        referenceId: subId
      });

      const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId);
      return utils.formatSubscription(db, dbMod.toPlain(row));
    });

    utils.sendJson(res, 201, { ok: true, subscription });
    return true;
  }

  const subPatchMatch = pathname.match(/^\/api\/account\/subscriptions\/([^/]+)$/);
  if (method === 'PATCH' && subPatchMatch) {
    const subId = subPatchMatch[1].trim();
    const rawAction = body.action ? security.sanitizeText(body.action, 20).toLowerCase() : '';
    const rawStatus = body.status ? security.sanitizeText(body.status, 20).toLowerCase() : '';

    const subscription = dbMod.withTransaction(db, () => {
      const existing = dbMod.toPlain(
        db.prepare('SELECT * FROM subscriptions WHERE UPPER(id) = UPPER(?) AND user_id = ?').get(subId, user.id)
      );
      if (!existing) {
        throw utils.httpError(404, 'Subscription not found', 'SUBSCRIPTION_NOT_FOUND');
      }
      if (existing.status === 'cancelled') {
        throw utils.httpError(409, 'Cancelled subscriptions cannot be modified', 'SUBSCRIPTION_CANCELLED');
      }

      let nextStatus = existing.status;
      let nextCadence = existing.cadence;
      let nextItemsJson = existing.items_json;
      let nextRunAt = existing.next_run_at;
      let nextSkipCount = Number(existing.skip_count ?? 0);

      const action = rawAction || (rawStatus === 'paused' ? 'pause' : rawStatus === 'active' ? 'resume' : rawStatus === 'cancelled' ? 'cancel' : '');
      if (action && !['pause', 'resume', 'skip', 'swap', 'cancel'].includes(action)) {
        throw utils.httpError(400, "Action must be 'pause', 'resume', 'skip', 'swap', or 'cancel'", 'INVALID_ACTION');
      }

      if (action === 'pause') {
        nextStatus = 'paused';
      } else if (action === 'resume') {
        nextStatus = 'active';
      } else if (action === 'cancel') {
        nextStatus = 'cancelled';
      } else if (action === 'skip') {
        nextSkipCount += 1;
        nextRunAt = addDaysIso(existing.next_run_at, cadenceIntervalDays(existing.cadence));
      }

      if (body.cadence !== undefined) {
        const cand = security.sanitizeText(body.cadence, 20).toLowerCase();
        if (!VALID_CADENCES.has(cand)) {
          throw utils.httpError(400, "Cadence must be '2-week', '4-week', 'biweekly', or 'monthly'", 'INVALID_CADENCE');
        }
        nextCadence = cand;
      }

      if (body.items !== undefined) {
        const { lineItems } = utils.resolveAndAggregateItems(db, body.items);
        const subItems = lineItems.map((i) => ({
          variantId: i.variantId,
          sku: i.sku,
          productName: i.productName,
          label: i.variantLabel,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents
        }));
        nextItemsJson = JSON.stringify(subItems);
      }

      if (!action && body.cadence === undefined && body.items === undefined) {
        throw utils.httpError(400, 'Specify an action, cadence, or items to update', 'VALIDATION_ERROR');
      }

      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE subscriptions
         SET cadence = ?, status = ?, items_json = ?, next_run_at = ?, skip_count = ?, updated_at = ?
         WHERE id = ?`
      ).run(nextCadence, nextStatus, nextItemsJson, nextRunAt, nextSkipCount, nowIso, existing.id);

      dbMod.writeAuditLog(db, {
        actorId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: `subscription.${action || 'update'}`,
        targetType: 'subscription',
        targetId: existing.id,
        details: { nextStatus, nextCadence, nextSkipCount }
      });

      dbMod.queueNotification(db, {
        toEmail: user.email,
        subject: `SOLIS Subscription ${existing.id} Updated (${nextStatus})`,
        body: `Hi ${user.name},\n\nYour Build-a-Box subscription ${existing.id} was updated (${action || 'modified'}). Status: ${nextStatus}. Next delivery: ${nextRunAt.slice(0, 10)}.\n\n— SOLIS`,
        type: 'subscription_updated',
        referenceId: existing.id
      });

      const updated = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(existing.id);
      return utils.formatSubscription(db, dbMod.toPlain(updated));
    });

    utils.sendJson(res, 200, { ok: true, subscription });
    return true;
  }

  return false;
}

module.exports = { handleAccountRoutes };

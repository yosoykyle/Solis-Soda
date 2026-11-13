'use strict';

const fs = require('node:fs');
const path = require('node:path');
const security = require('./security');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'solis.db');

const FREE_SHIPPING_THRESHOLD_CENTS = 3500;
const STANDARD_SHIPPING_CENTS = 600;
const TAX_RATE_BPS = 825; // 8.25%
const MAX_ITEM_QTY = 10;

const COLD_CHAIN_STORAGE_NOTICE = 'Keep refrigerated at 35-42F (2-6C). Consume ice-cold.';

const ORDER_STATUSES = Object.freeze([
  'pending_payment',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'refunded'
]);

const PAYMENT_STATUSES = Object.freeze([
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'voided'
]);

const FULFILLMENT_STATUSES = Object.freeze([
  'unfulfilled',
  'allocated',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned'
]);

const ORDER_STATUS_TRANSITIONS = Object.freeze({
  pending_payment: Object.freeze(['confirmed', 'cancelled']),
  confirmed: Object.freeze(['packed', 'cancelled', 'refunded']),
  packed: Object.freeze(['shipped', 'cancelled', 'refunded']),
  shipped: Object.freeze(['delivered', 'refunded']),
  delivered: Object.freeze(['refunded']),
  cancelled: Object.freeze(['refunded']),
  refunded: Object.freeze([])
});

const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['authorized', 'paid', 'failed', 'voided']),
  authorized: Object.freeze(['paid', 'voided', 'failed']),
  paid: Object.freeze(['partially_refunded', 'refunded']),
  partially_refunded: Object.freeze(['partially_refunded', 'refunded']),
  refunded: Object.freeze([]),
  failed: Object.freeze(['pending', 'paid']),
  voided: Object.freeze([])
});

const FULFILLMENT_STATUS_TRANSITIONS = Object.freeze({
  unfulfilled: Object.freeze(['allocated', 'packed', 'cancelled']),
  allocated: Object.freeze(['packed', 'cancelled']),
  packed: Object.freeze(['shipped', 'cancelled']),
  shipped: Object.freeze(['delivered', 'returned']),
  delivered: Object.freeze(['returned']),
  cancelled: Object.freeze([]),
  returned: Object.freeze([])
});

const txDepthMap = new WeakMap();

let activeDb = null;
let activeDbPath = null;

function getDbPath() {
  return process.env.DB_PATH || DEFAULT_DB_PATH;
}

/**
 * Convert a null-prototype node:sqlite row to a regular plain object.
 * @param {object|undefined|null} row
 */
function toPlain(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  return { ...row };
}

function toPlainRows(rows) {
  return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
}

function canTransitionOrderStatus(fromStatus, toStatus) {
  const allowed = ORDER_STATUS_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

function canTransitionPaymentStatus(fromStatus, toStatus) {
  const allowed = PAYMENT_STATUS_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

function canTransitionFulfillmentStatus(fromStatus, toStatus) {
  const allowed = FULFILLMENT_STATUS_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

/**
 * Run `fn(db)` inside an atomic BEGIN IMMEDIATE transaction (or nested SAVEPOINT).
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(db: import('node:sqlite').DatabaseSync) => T} fn
 * @returns {T}
 */
function withTransaction(db, fn) {
  const depth = txDepthMap.get(db) ?? 0;
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE');
    txDepthMap.set(db, 1);
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure if connection already rolled back.
      }
      throw err;
    } finally {
      txDepthMap.set(db, 0);
    }
  }

  const sp = `sp_solis_${depth}`;
  db.exec(`SAVEPOINT ${sp}`);
  txDepthMap.set(db, depth + 1);
  try {
    const result = fn(db);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      db.exec(`RELEASE SAVEPOINT ${sp}`);
    } catch {
      // Ignore savepoint rollback errors.
    }
    throw err;
  } finally {
    txDepthMap.set(db, depth);
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer'
    CHECK(role IN ('customer', 'admin', 'merchandiser', 'warehouse', 'csr', 'finance')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Home',
  recipient_name TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '',
  postal TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  calories INTEGER NOT NULL DEFAULT 35 CHECK(calories >= 0),
  tag TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  nutrition_json TEXT NOT NULL DEFAULT '{}',
  storage_instructions TEXT NOT NULL DEFAULT 'Keep refrigerated at 35-42F (2-6C). Consume ice-cold.',
  cold_chain_required INTEGER NOT NULL DEFAULT 1 CHECK(cold_chain_required IN (0, 1)),
  shelf_life_days INTEGER NOT NULL DEFAULT 365 CHECK(shelf_life_days > 0),
  accent_color TEXT NOT NULL DEFAULT '#B83D1C',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL CHECK(label IN ('6-Pack', '12-Pack', '24-Pack')),
  pack_size INTEGER NOT NULL CHECK(pack_size > 0),
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  is_bundle INTEGER NOT NULL DEFAULT 0 CHECK(is_bundle IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_variants_product_id ON variants(product_id);

CREATE TABLE IF NOT EXISTS bundle_items (
  bundle_variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  component_variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  PRIMARY KEY (bundle_variant_id, component_variant_id),
  CHECK(bundle_variant_id != component_variant_id)
);

CREATE TABLE IF NOT EXISTS inventory_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  lot_number TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
  received_at TEXT NOT NULL,
  UNIQUE(variant_id, lot_number)
);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_fefo ON inventory_lots(variant_id, expires_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  lot_number TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reference_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_variant_id ON inventory_ledger(variant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_created_at ON inventory_ledger(created_at);

CREATE TABLE IF NOT EXISTS carts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_token TEXT UNIQUE,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  promo_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity >= 1 AND quantity <= 10),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(cart_id, variant_id)
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('percent', 'fixed', 'free_shipping')),
  value INTEGER NOT NULL CHECK(value >= 0),
  min_subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK(min_subtotal_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses >= 1),
  uses_count INTEGER NOT NULL DEFAULT 0 CHECK(uses_count >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  shipping_line1 TEXT NOT NULL,
  shipping_city TEXT NOT NULL,
  shipping_postal TEXT NOT NULL,
  promo_code TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
  shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK(shipping_cents >= 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK(tax_cents >= 0),
  total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
  order_status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK(order_status IN ('pending_payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded')),
  payment_status TEXT NOT NULL DEFAULT 'paid'
    CHECK(payment_status IN ('pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'failed', 'voided')),
  fulfillment_status TEXT NOT NULL DEFAULT 'allocated'
    CHECK(fulfillment_status IN ('unfulfilled', 'allocated', 'packed', 'shipped', 'delivered', 'cancelled', 'returned')),
  cold_chain_mode TEXT NOT NULL DEFAULT 'insulated_chilled'
    CHECK(cold_chain_mode IN ('standard_ambient', 'insulated_chilled', 'warm_weather_gel')),
  insulated_pack_included INTEGER NOT NULL DEFAULT 1 CHECK(insulated_pack_included IN (0, 1)),
  storage_notice TEXT NOT NULL DEFAULT 'Keep refrigerated at 35-42F (2-6C). Consume ice-cold.',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_order_status ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK(line_total_cents >= 0),
  is_bundle INTEGER NOT NULL DEFAULT 0 CHECK(is_bundle IN (0, 1)),
  lot_number TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  lot_allocations_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  axis TEXT NOT NULL DEFAULT 'order' CHECK(axis IN ('order', 'payment', 'fulfillment')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'requires_confirmation'
    CHECK(status IN ('requires_confirmation', 'succeeded', 'failed', 'cancelled')),
  client_secret TEXT NOT NULL,
  webhook_event_id TEXT UNIQUE,
  webhook_processed INTEGER NOT NULL DEFAULT 0 CHECK(webhook_processed IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payment_intent_id TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
  payload_hash TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_intent_id TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
  return_id TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'succeeded' CHECK(status IN ('pending', 'succeeded', 'failed')),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'shipped'
    CHECK(status IN ('label_created', 'shipped', 'in_transit', 'delivered')),
  lot_numbers_json TEXT NOT NULL DEFAULT '[]',
  earliest_expires_at TEXT NOT NULL DEFAULT '',
  cold_chain_pack INTEGER NOT NULL DEFAULT 1 CHECK(cold_chain_pack IN (0, 1)),
  storage_instructions TEXT NOT NULL DEFAULT 'Keep refrigerated at 35-42F (2-6C). Consume ice-cold.',
  shipped_at TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id);

CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested', 'approved', 'rejected', 'refunded', 'replaced')),
  reason TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  resolution TEXT NOT NULL DEFAULT '',
  refund_cents INTEGER NOT NULL DEFAULT 0 CHECK(refund_cents >= 0),
  notes TEXT NOT NULL DEFAULT '',
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_returns_order_id ON returns(order_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cadence TEXT NOT NULL CHECK(cadence IN ('biweekly', 'monthly', '2-week', '4-week')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'cancelled')),
  items_json TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  skip_count INTEGER NOT NULL DEFAULT 0 CHECK(skip_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'sent', 'failed')),
  reference_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON notification_outbox(created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
`;

const DEMO_USERS = [
  { name: 'Maya Lin', email: 'customer@solis.drink', role: 'customer' },
  { name: 'Elena Vance', email: 'admin@solis.drink', role: 'admin' },
  { name: 'Julian Park', email: 'merchandiser@solis.drink', role: 'merchandiser' },
  { name: 'Marcus Cole', email: 'warehouse@solis.drink', role: 'warehouse' },
  { name: 'Sora Tanaka', email: 'csr@solis.drink', role: 'csr' },
  { name: 'Claire Sterling', email: 'finance@solis.drink', role: 'finance' }
];

const SEED_PRODUCTS = [
  {
    slug: 'blood-orange',
    name: 'Blood Orange & Rosemary',
    subtitle: 'Cold-Pressed Citrus & Garden Herb',
    calories: 35,
    tag: 'Signature',
    accentColor: '#B83D1C',
    sortOrder: 1,
    description: 'Sicilian blood orange balanced by a subtle, aromatic sprig of garden rosemary.',
    storageInstructions: 'Keep refrigerated at 35-42F (2-6C). Ships with insulated cold-chain liner.',
    coldChainRequired: 1,
    shelfLifeDays: 365,
    nutrition: {
      servingSize: '12 fl oz (355 mL)',
      calories: 35,
      totalFatG: 0,
      sodiumMg: 15,
      totalCarbG: 8,
      dietaryFiberG: 3,
      totalSugarsG: 4,
      addedSugarsG: 4,
      proteinG: 0,
      allergens: 'None (gluten-free, vegan, non-GMO)',
      ingredients: [
        'Triple-filtered mountain spring water',
        'Cold-pressed Sicilian blood orange juice',
        'Organic agave inulin (prebiotic)',
        'Organic blue agave nectar',
        'Garden rosemary extract',
        'Organic lemon juice'
      ],
      botanicals: ['Blood Orange Peel', 'Garden Rosemary', 'Agave Inulin']
    },
    variants: [
      { sku: 'SOLIS-BO-06', label: '6-Pack', packSize: 6, priceCents: 1900, onHand: 36, isBundle: 0 },
      { sku: 'SOLIS-BO-12', label: '12-Pack', packSize: 12, priceCents: 3400, onHand: 24, isBundle: 0 },
      { sku: 'SOLIS-BO-24', label: '24-Pack', packSize: 24, priceCents: 6200, onHand: 12, isBundle: 0 }
    ]
  },
  {
    slug: 'yuzu-lime',
    name: 'Yuzu Lime & Sea Salt',
    subtitle: 'Japanese Citrus & Pacific Mineral',
    calories: 30,
    tag: 'Ultra Crisp',
    accentColor: '#3E732D',
    sortOrder: 2,
    description: 'Japanese yuzu zest, key lime juice, and a clean pinch of Pacific sea salt.',
    storageInstructions: 'Keep refrigerated at 35-42F (2-6C). Ships with insulated cold-chain liner.',
    coldChainRequired: 1,
    shelfLifeDays: 365,
    nutrition: {
      servingSize: '12 fl oz (355 mL)',
      calories: 30,
      totalFatG: 0,
      sodiumMg: 35,
      totalCarbG: 7,
      dietaryFiberG: 3,
      totalSugarsG: 3,
      addedSugarsG: 3,
      proteinG: 0,
      allergens: 'None (gluten-free, vegan, non-GMO)',
      ingredients: [
        'Triple-filtered mountain spring water',
        'Japanese yuzu juice',
        'Cold-pressed key lime juice',
        'Organic agave inulin (prebiotic)',
        'Pacific sea salt',
        'Organic blue agave nectar'
      ],
      botanicals: ['Yuzu Zest', 'Key Lime', 'Pacific Sea Salt']
    },
    variants: [
      { sku: 'SOLIS-YL-06', label: '6-Pack', packSize: 6, priceCents: 1900, onHand: 36, isBundle: 0 },
      { sku: 'SOLIS-YL-12', label: '12-Pack', packSize: 12, priceCents: 3400, onHand: 24, isBundle: 0 },
      { sku: 'SOLIS-YL-24', label: '24-Pack', packSize: 24, priceCents: 6200, onHand: 12, isBundle: 0 }
    ]
  },
  {
    slug: 'hibiscus-berry',
    name: 'Hibiscus & Wild Berry',
    subtitle: 'Steeped Petals & Botanical Tartness',
    calories: 35,
    tag: 'Floral',
    accentColor: '#A62952',
    sortOrder: 3,
    description: 'Steeped crimson hibiscus petals muddled with tart blackberry and ginger.',
    storageInstructions: 'Keep refrigerated at 35-42F (2-6C). Ships with insulated cold-chain liner.',
    coldChainRequired: 1,
    shelfLifeDays: 365,
    nutrition: {
      servingSize: '12 fl oz (355 mL)',
      calories: 35,
      totalFatG: 0,
      sodiumMg: 10,
      totalCarbG: 8,
      dietaryFiberG: 3,
      totalSugarsG: 4,
      addedSugarsG: 4,
      proteinG: 0,
      allergens: 'None (gluten-free, vegan, non-GMO)',
      ingredients: [
        'Triple-filtered mountain spring water',
        'Steeped crimson hibiscus tea',
        'Wild blackberry puree',
        'Organic agave inulin (prebiotic)',
        'Cold-pressed ginger extract',
        'Organic blue agave nectar'
      ],
      botanicals: ['Hibiscus Petals', 'Wild Blackberry', 'Ginger Root']
    },
    variants: [
      { sku: 'SOLIS-HB-06', label: '6-Pack', packSize: 6, priceCents: 1900, onHand: 36, isBundle: 0 },
      { sku: 'SOLIS-HB-12', label: '12-Pack', packSize: 12, priceCents: 3400, onHand: 24, isBundle: 0 },
      { sku: 'SOLIS-HB-24', label: '24-Pack', packSize: 24, priceCents: 6200, onHand: 12, isBundle: 0 }
    ]
  },
  {
    slug: 'ginger-peach',
    name: 'Golden Ginger & Peach',
    subtitle: 'Peruvian Root & Orchard Stone Fruit',
    calories: 40,
    tag: 'Limited',
    accentColor: '#8C5608',
    sortOrder: 4,
    description: 'Cold-pressed Peruvian ginger root softened with ripe white peach.',
    storageInstructions: 'Keep refrigerated at 35-42F (2-6C). Cold-pressed small-batch seasonal release.',
    coldChainRequired: 1,
    shelfLifeDays: 270,
    nutrition: {
      servingSize: '12 fl oz (355 mL)',
      calories: 40,
      totalFatG: 0,
      sodiumMg: 15,
      totalCarbG: 9,
      dietaryFiberG: 3,
      totalSugarsG: 5,
      addedSugarsG: 5,
      proteinG: 0,
      allergens: 'None (gluten-free, vegan, non-GMO)',
      ingredients: [
        'Triple-filtered mountain spring water',
        'White peach puree',
        'Cold-pressed Peruvian ginger juice',
        'Organic agave inulin (prebiotic)',
        'Organic blue agave nectar',
        'Organic lemon juice'
      ],
      botanicals: ['Peruvian Ginger', 'White Peach', 'Agave Inulin']
    },
    variants: [
      { sku: 'SOLIS-GP-06', label: '6-Pack', packSize: 6, priceCents: 2000, onHand: 36, isBundle: 0 },
      { sku: 'SOLIS-GP-12', label: '12-Pack', packSize: 12, priceCents: 3600, onHand: 24, isBundle: 0 },
      { sku: 'SOLIS-GP-24', label: '24-Pack', packSize: 24, priceCents: 6600, onHand: 12, isBundle: 0 }
    ]
  },
  {
    slug: 'variety',
    name: 'Variety 12-Pack',
    subtitle: 'All 4 Signature Botanicals',
    calories: 35,
    tag: 'Bundle',
    accentColor: '#0A5E9E',
    sortOrder: 5,
    description: 'Curated discovery pack spanning Blood Orange & Rosemary, Yuzu Lime & Sea Salt, Hibiscus & Wild Berry, and Golden Ginger & Peach.',
    storageInstructions: 'Keep refrigerated at 35-42F (2-6C). Ships in insulated cold-chain pack.',
    coldChainRequired: 1,
    shelfLifeDays: 270,
    nutrition: {
      servingSize: '12 fl oz (355 mL)',
      calories: 35,
      totalFatG: 0,
      sodiumMg: 19,
      totalCarbG: 8,
      dietaryFiberG: 3,
      totalSugarsG: 4,
      addedSugarsG: 4,
      proteinG: 0,
      allergens: 'None (gluten-free, vegan, non-GMO)',
      ingredients: [
        'BOM Bundle composed of Blood Orange & Rosemary (12-Pack), Yuzu Lime & Sea Salt (12-Pack), Hibiscus & Wild Berry (12-Pack), and Golden Ginger & Peach (12-Pack)'
      ],
      botanicals: ['All 4 Signature Blends']
    },
    variants: [
      { sku: 'SOLIS-VAR-12', label: '12-Pack', packSize: 12, priceCents: 3400, onHand: 0, isBundle: 1 }
    ]
  }
];

const VARIETY_COMPONENT_SKUS = [
  'SOLIS-BO-12',
  'SOLIS-YL-12',
  'SOLIS-HB-12',
  'SOLIS-GP-12'
];

function seedDatabase(db) {
  const nowIso = new Date().toISOString();

  withTransaction(db, () => {
    const userCount = Number(db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt);
    if (userCount === 0) {
      const insertUser = db.prepare(
        `INSERT INTO users (name, email, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      let customerId = null;
      for (const u of DEMO_USERS) {
        const res = insertUser.run(
          u.name,
          u.email.toLowerCase(),
          security.hashPassword('SolisDemo2026!'),
          u.role,
          nowIso
        );
        if (u.role === 'customer') {
          customerId = Number(res.lastInsertRowid);
        }
      }
      if (customerId) {
        db.prepare(
          `INSERT INTO addresses (user_id, label, recipient_name, line1, line2, city, state, postal, country, is_default, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          customerId,
          'Home',
          'Maya Lin',
          '420 Valencia St',
          'Apt 4B',
          'San Francisco',
          'CA',
          '94103',
          'US',
          1,
          nowIso
        );
      }
    }

    const productCount = Number(db.prepare('SELECT COUNT(*) AS cnt FROM products').get().cnt);
    if (productCount === 0) {
      const insertProduct = db.prepare(
        `INSERT INTO products (
           slug, name, subtitle, calories, tag, description, nutrition_json,
           storage_instructions, cold_chain_required, shelf_life_days,
           accent_color, sort_order, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      );
      const insertVariant = db.prepare(
        `INSERT INTO variants (product_id, sku, label, pack_size, price_cents, on_hand, reserved, is_bundle, active)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)`
      );
      const insertLot = db.prepare(
        `INSERT INTO inventory_lots (variant_id, lot_number, expires_at, on_hand, received_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      const insertLedger = db.prepare(
        `INSERT INTO inventory_ledger (variant_id, delta, reason, lot_number, expires_at, actor_id, reference_id, created_at)
         VALUES (?, ?, 'initial_seed', ?, ?, NULL, 'SEED-INIT', ?)`
      );

      const variantIdBySku = new Map();

      for (const p of SEED_PRODUCTS) {
        const prodRes = insertProduct.run(
          p.slug,
          p.name,
          p.subtitle,
          p.calories,
          p.tag,
          p.description,
          JSON.stringify(p.nutrition),
          p.storageInstructions,
          p.coldChainRequired,
          p.shelfLifeDays,
          p.accentColor,
          p.sortOrder,
          nowIso,
          nowIso
        );
        const productId = Number(prodRes.lastInsertRowid);

        for (const v of p.variants) {
          const varRes = insertVariant.run(
            productId,
            v.sku,
            v.label,
            v.packSize,
            v.priceCents,
            v.onHand,
            v.isBundle
          );
          const variantId = Number(varRes.lastInsertRowid);
          variantIdBySku.set(v.sku, variantId);

          if (!v.isBundle && v.onHand > 0) {
            // Split initial stock across two FEFO lots (earlier-expiring batch first).
            const firstLotQty = Math.floor(v.onHand / 2);
            const secondLotQty = v.onHand - firstLotQty;
            if (firstLotQty > 0) {
              insertLot.run(variantId, 'LOT-2026-A', '2027-03-31', firstLotQty, nowIso);
              insertLedger.run(variantId, firstLotQty, 'LOT-2026-A', '2027-03-31', nowIso);
            }
            if (secondLotQty > 0) {
              insertLot.run(variantId, 'LOT-2026-B', '2027-09-30', secondLotQty, nowIso);
              insertLedger.run(variantId, secondLotQty, 'LOT-2026-B', '2027-09-30', nowIso);
            }
          }
        }
      }

      const bundleVariantId = variantIdBySku.get('SOLIS-VAR-12');
      if (bundleVariantId) {
        const insertBundleItem = db.prepare(
          `INSERT INTO bundle_items (bundle_variant_id, component_variant_id, quantity)
           VALUES (?, ?, ?)`
        );
        for (const compSku of VARIETY_COMPONENT_SKUS) {
          const compId = variantIdBySku.get(compSku);
          if (compId) {
            insertBundleItem.run(bundleVariantId, compId, 1);
          }
        }
      }
    }

    const promoCount = Number(db.prepare('SELECT COUNT(*) AS cnt FROM promotions').get().cnt);
    if (promoCount === 0) {
      const insertPromo = db.prepare(
        `INSERT INTO promotions (code, type, value, min_subtotal_cents, active, max_uses, uses_count, created_at)
         VALUES (?, ?, ?, ?, 1, NULL, 0, ?)`
      );
      insertPromo.run('SOLIS10', 'percent', 10, 0, nowIso);
      insertPromo.run('SOLIS5', 'fixed', 500, 0, nowIso);
    }
  });
}

/**
 * Open/initialize a SQLite database at `customPath` (or DB_PATH / data/solis.db),
 * enable WAL + busy_timeout + foreign_keys, apply schema, and seed baseline data.
 * @param {string} [customPath]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function initDb(customPath) {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = customPath || getDbPath();

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  if (activeDb && activeDbPath === dbPath) {
    return activeDb;
  }
  if (activeDb) {
    try {
      activeDb.close();
    } catch {
      // Ignore close error on stale handle.
    }
    activeDb = null;
    activeDbPath = null;
  }

  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA_SQL);

  seedDatabase(db);

  activeDb = db;
  activeDbPath = dbPath;
  return db;
}

/**
 * Get the active DatabaseSync connection, initializing (or reopening if DB_PATH changed).
 * @returns {import('node:sqlite').DatabaseSync}
 */
function getDb() {
  const currentPath = getDbPath();
  if (!activeDb || activeDbPath !== currentPath) {
    return initDb(currentPath);
  }
  return activeDb;
}

function closeDb() {
  if (activeDb) {
    try {
      activeDb.close();
    } finally {
      activeDb = null;
      activeDbPath = null;
    }
  }
}

/**
 * Return active inventory lots for a variant in FEFO order (earliest expiry first).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} variantId
 */
function getVariantLots(db, variantId) {
  const rows = toPlainRows(
    db.prepare(
      `SELECT id, variant_id, lot_number, expires_at, on_hand, received_at
       FROM inventory_lots
       WHERE variant_id = ? AND on_hand > 0
       ORDER BY expires_at ASC, id ASC`
    ).all(variantId)
  );
  return rows.map((r) => ({
    id: Number(r.id),
    variantId: Number(r.variant_id),
    lotNumber: String(r.lot_number),
    expiresAt: String(r.expires_at),
    onHand: Number(r.on_hand),
    receivedAt: String(r.received_at)
  }));
}

/**
 * Compute live available stock for a variant, expanding BOM components when is_bundle = 1.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} variantId
 * @returns {number}
 */
function getVariantAvailableStock(db, variantId) {
  const variant = db.prepare(
    'SELECT id, on_hand, reserved, is_bundle, active FROM variants WHERE id = ?'
  ).get(variantId);
  if (!variant || !variant.active) return 0;

  if (!variant.is_bundle) {
    return Math.max(0, Number(variant.on_hand) - Number(variant.reserved));
  }

  const components = db.prepare(
    `SELECT bi.quantity, v.on_hand, v.reserved, v.active
     FROM bundle_items bi
     JOIN variants v ON v.id = bi.component_variant_id
     WHERE bi.bundle_variant_id = ?`
  ).all(variantId);

  if (components.length === 0) return 0;
  let minBundles = Infinity;
  for (const c of components) {
    if (!c.active) return 0;
    const compAvail = Math.max(0, Number(c.on_hand) - Number(c.reserved));
    const possible = Math.floor(compAvail / Number(c.quantity));
    if (possible < minBundles) minBundles = possible;
  }
  return Number.isFinite(minBundles) ? Math.max(0, minBundles) : 0;
}

function safeParseJson(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Fetch products with their variants, FEFO lots, bundle definitions, and live available stock.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ q?: string, tag?: string, sort?: string, includeInactive?: boolean }} [filters]
 */
function getCatalog(db, filters = {}) {
  const includeInactive = Boolean(filters.includeInactive);
  const prodSql = includeInactive
    ? 'SELECT * FROM products ORDER BY sort_order ASC, id ASC'
    : 'SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, id ASC';

  const productRows = toPlainRows(db.prepare(prodSql).all());
  const variantRows = toPlainRows(
    db.prepare(
      includeInactive
        ? 'SELECT * FROM variants ORDER BY pack_size ASC, id ASC'
        : 'SELECT * FROM variants WHERE active = 1 ORDER BY pack_size ASC, id ASC'
    ).all()
  );
  const bundleRows = toPlainRows(
    db.prepare(
      `SELECT bi.bundle_variant_id, bi.component_variant_id, bi.quantity,
              v.sku AS component_sku, v.label AS component_label, p.slug AS component_slug, p.name AS component_name
       FROM bundle_items bi
       JOIN variants v ON v.id = bi.component_variant_id
       JOIN products p ON p.id = v.product_id`
    ).all()
  );
  const lotRows = toPlainRows(
    db.prepare(
      `SELECT variant_id, lot_number, expires_at, on_hand
       FROM inventory_lots
       WHERE on_hand > 0
       ORDER BY expires_at ASC, id ASC`
    ).all()
  );

  const lotsByVariant = new Map();
  for (const lot of lotRows) {
    if (!lotsByVariant.has(lot.variant_id)) lotsByVariant.set(lot.variant_id, []);
    lotsByVariant.get(lot.variant_id).push({
      lotNumber: lot.lot_number,
      expiresAt: lot.expires_at,
      onHand: Number(lot.on_hand)
    });
  }

  const bundleMap = new Map();
  for (const b of bundleRows) {
    if (!bundleMap.has(b.bundle_variant_id)) bundleMap.set(b.bundle_variant_id, []);
    bundleMap.get(b.bundle_variant_id).push({
      componentVariantId: Number(b.component_variant_id),
      sku: b.component_sku,
      label: b.component_label,
      productSlug: b.component_slug,
      productName: b.component_name,
      quantity: Number(b.quantity)
    });
  }

  const variantsByProduct = new Map();
  for (const v of variantRows) {
    const available = getVariantAvailableStock(db, v.id);
    const lots = lotsByVariant.get(v.id) ?? [];
    const formatted = {
      id: Number(v.id),
      productId: Number(v.product_id),
      sku: v.sku,
      label: v.label,
      packSize: Number(v.pack_size),
      priceCents: Number(v.price_cents),
      onHand: Number(v.on_hand),
      reserved: Number(v.reserved),
      available,
      inStock: Boolean(v.active) && available > 0,
      isBundle: Boolean(v.is_bundle),
      active: Boolean(v.active),
      nextLot: lots[0] ?? null,
      lots,
      bundleItems: v.is_bundle ? (bundleMap.get(v.id) ?? []) : []
    };
    if (!variantsByProduct.has(v.product_id)) variantsByProduct.set(v.product_id, []);
    variantsByProduct.get(v.product_id).push(formatted);
  }

  let catalog = productRows.map((p) => {
    const variants = variantsByProduct.get(p.id) ?? [];
    const prices = variants.map((v) => v.priceCents);
    const minPriceCents = prices.length ? Math.min(...prices) : 0;
    const inStock = Boolean(p.active) && variants.some((v) => v.inStock);
    return {
      id: Number(p.id),
      slug: p.slug,
      name: p.name,
      subtitle: p.subtitle,
      calories: Number(p.calories),
      tag: p.tag,
      description: p.description,
      storageInstructions: p.storage_instructions,
      coldChainRequired: Boolean(p.cold_chain_required),
      shelfLifeDays: Number(p.shelf_life_days),
      accentColor: p.accent_color,
      sortOrder: Number(p.sort_order),
      active: Boolean(p.active),
      nutrition: safeParseJson(p.nutrition_json, {}),
      minPriceCents,
      inStock,
      variants
    };
  });

  if (filters.tag && String(filters.tag).trim().toLowerCase() !== 'all') {
    const targetTag = String(filters.tag).trim().toLowerCase();
    catalog = catalog.filter((p) => p.tag.toLowerCase() === targetTag || p.slug.toLowerCase() === targetTag);
  }

  if (filters.q && String(filters.q).trim()) {
    const needle = String(filters.q).trim().toLowerCase();
    catalog = catalog.filter((p) => {
      const hay = [
        p.name,
        p.subtitle,
        p.description,
        p.tag,
        p.slug,
        ...p.variants.map((v) => v.sku)
      ].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }

  const sort = String(filters.sort ?? 'featured').trim().toLowerCase();
  if (sort === 'price-asc') {
    catalog.sort((a, b) => a.minPriceCents - b.minPriceCents || a.sortOrder - b.sortOrder);
  } else if (sort === 'price-desc') {
    catalog.sort((a, b) => b.minPriceCents - a.minPriceCents || a.sortOrder - b.sortOrder);
  } else if (sort === 'calories-asc') {
    catalog.sort((a, b) => a.calories - b.calories || a.sortOrder - b.sortOrder);
  } else if (sort === 'name-asc') {
    catalog.sort((a, b) => a.name.localeCompare(b.name));
  }

  return catalog;
}

function defaultExpiryIso(daysAhead = 365) {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Allocate `quantity` units from `inventory_lots` in FEFO order (earliest `expires_at` first).
 * Updates `inventory_lots.on_hand` and returns allocated slices.
 */
function allocateFromLotsFefo(db, variantId, quantity, fallbackLotLabel = 'LOT-2026-A') {
  const lots = toPlainRows(
    db.prepare(
      `SELECT id, lot_number, expires_at, on_hand
       FROM inventory_lots
       WHERE variant_id = ? AND on_hand > 0
       ORDER BY expires_at ASC, id ASC`
    ).all(variantId)
  );

  const allocations = [];
  let remaining = quantity;
  const decLotStmt = db.prepare('UPDATE inventory_lots SET on_hand = on_hand - ? WHERE id = ?');

  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(lot.on_hand));
    if (take <= 0) continue;
    decLotStmt.run(take, lot.id);
    allocations.push({
      variantId: Number(variantId),
      lotNumber: lot.lot_number,
      expiresAt: lot.expires_at,
      quantity: take
    });
    remaining -= take;
  }

  if (remaining > 0) {
    // Fallback if variant.on_hand exceeded lot rows (e.g., manual DB edits without lot rows).
    allocations.push({
      variantId: Number(variantId),
      lotNumber: fallbackLotLabel,
      expiresAt: defaultExpiryIso(),
      quantity: remaining
    });
  }

  return allocations;
}

/**
 * Upsert stock into a specific lot (used for restock, returns, and order cancellation restores).
 */
function addStockToLot(db, variantId, quantity, lotNumber, expiresAt, nowIso) {
  const cleanLot = lotNumber && String(lotNumber).trim() ? String(lotNumber).trim() : `LOT-${nowIso.slice(0, 10)}`;
  const cleanExpiry = expiresAt && String(expiresAt).trim() ? String(expiresAt).trim() : defaultExpiryIso();

  const existing = db.prepare(
    'SELECT id, expires_at FROM inventory_lots WHERE variant_id = ? AND lot_number = ?'
  ).get(variantId, cleanLot);

  if (existing) {
    db.prepare('UPDATE inventory_lots SET on_hand = on_hand + ? WHERE id = ?').run(quantity, existing.id);
    return { lotNumber: cleanLot, expiresAt: existing.expires_at || cleanExpiry };
  }

  db.prepare(
    `INSERT INTO inventory_lots (variant_id, lot_number, expires_at, on_hand, received_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(variantId, cleanLot, cleanExpiry, quantity, nowIso);
  return { lotNumber: cleanLot, expiresAt: cleanExpiry };
}

/**
 * Adjust physical inventory for a non-bundle variant and append FEFO lot + inventory_ledger entries.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ variantId: number, delta: number, reason: string, lotNumber?: string, expiresAt?: string, actorId?: number|null, referenceId?: string }} params
 */
function adjustVariantStock(db, params) {
  const {
    variantId,
    delta,
    reason,
    lotNumber = '',
    expiresAt = '',
    actorId = null,
    referenceId = ''
  } = params;

  return withTransaction(db, () => {
    const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(variantId);
    if (!variant) {
      throw Object.assign(new Error('Variant not found'), { statusCode: 404, code: 'VARIANT_NOT_FOUND' });
    }
    if (variant.is_bundle) {
      throw Object.assign(new Error('Cannot adjust stock directly on a BOM bundle SKU; adjust component SKUs instead'), {
        statusCode: 400,
        code: 'BUNDLE_DIRECT_ADJUST_FORBIDDEN'
      });
    }

    const nextOnHand = Number(variant.on_hand) + delta;
    if (nextOnHand < Number(variant.reserved)) {
      throw Object.assign(new Error('Adjustment would reduce on-hand stock below reserved quantity'), {
        statusCode: 409,
        code: 'INSUFFICIENT_STOCK'
      });
    }

    const nowIso = new Date().toISOString();
    db.prepare('UPDATE variants SET on_hand = ? WHERE id = ?').run(nextOnHand, variantId);

    const insertLedger = db.prepare(
      `INSERT INTO inventory_ledger (variant_id, delta, reason, lot_number, expires_at, actor_id, reference_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    if (delta > 0) {
      const lotInfo = addStockToLot(db, variantId, delta, lotNumber, expiresAt, nowIso);
      insertLedger.run(variantId, delta, reason, lotInfo.lotNumber, lotInfo.expiresAt, actorId, referenceId, nowIso);
    } else if (delta < 0) {
      const absDelta = Math.abs(delta);
      const cleanLot = String(lotNumber ?? '').trim();
      if (cleanLot) {
        const targetLot = db.prepare(
          'SELECT id, lot_number, expires_at, on_hand FROM inventory_lots WHERE variant_id = ? AND lot_number = ?'
        ).get(variantId, cleanLot);
        if (!targetLot || Number(targetLot.on_hand) < absDelta) {
          throw Object.assign(new Error(`Insufficient stock in lot ${cleanLot}`), {
            statusCode: 409,
            code: 'INSUFFICIENT_LOT_STOCK'
          });
        }
        db.prepare('UPDATE inventory_lots SET on_hand = on_hand - ? WHERE id = ?').run(absDelta, targetLot.id);
        insertLedger.run(variantId, delta, reason, targetLot.lot_number, targetLot.expires_at, actorId, referenceId, nowIso);
      } else {
        const slices = allocateFromLotsFefo(db, variantId, absDelta);
        for (const s of slices) {
          insertLedger.run(variantId, -s.quantity, reason, s.lotNumber, s.expiresAt, actorId, referenceId, nowIso);
        }
      }
    } else {
      insertLedger.run(variantId, 0, reason, String(lotNumber ?? ''), String(expiresAt ?? ''), actorId, referenceId, nowIso);
    }

    const updated = toPlain(db.prepare('SELECT * FROM variants WHERE id = ?').get(variantId));
    return {
      ...updated,
      available: Math.max(0, Number(updated.on_hand) - Number(updated.reserved)),
      lots: getVariantLots(db, variantId)
    };
  });
}

/**
 * Atomically validate and decrement stock for order items using FEFO lot allocation
 * (expanding BOM bundles). Aggregates total component demand across regular and bundle items
 * before mutating.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ variantId: number, quantity: number }>} items
 * @param {{ actorId?: number|null, referenceId?: string }} [opts]
 */
function decrementOrderStock(db, items, opts = {}) {
  const actorId = opts.actorId ?? null;
  const referenceId = opts.referenceId ?? '';

  return withTransaction(db, () => {
    const demandByVariant = new Map();
    const expandedNeeds = [];

    const getVariantStmt = db.prepare(
      `SELECT v.*, p.name AS product_name, p.active AS product_active
       FROM variants v
       JOIN products p ON p.id = v.product_id
       WHERE v.id = ?`
    );
    const getBundleStmt = db.prepare(
      'SELECT component_variant_id, quantity FROM bundle_items WHERE bundle_variant_id = ?'
    );

    for (const item of items) {
      const variant = getVariantStmt.get(item.variantId);
      if (!variant || !variant.active || !variant.product_active) {
        throw Object.assign(new Error(`Unavailable variant ${item.variantId}`), {
          statusCode: 400,
          code: 'VARIANT_UNAVAILABLE'
        });
      }

      if (!variant.is_bundle) {
        const vid = Number(variant.id);
        demandByVariant.set(vid, (demandByVariant.get(vid) ?? 0) + item.quantity);
        expandedNeeds.push({
          orderVariantId: vid,
          physicalVariantId: vid,
          sku: variant.sku,
          quantity: item.quantity,
          reason: 'sale'
        });
      } else {
        const comps = getBundleStmt.all(variant.id);
        if (comps.length === 0) {
          throw Object.assign(new Error(`Bundle ${variant.sku} has no components`), {
            statusCode: 409,
            code: 'INSUFFICIENT_STOCK'
          });
        }
        for (const comp of comps) {
          const need = Number(comp.quantity) * item.quantity;
          const compId = Number(comp.component_variant_id);
          demandByVariant.set(compId, (demandByVariant.get(compId) ?? 0) + need);
          expandedNeeds.push({
            orderVariantId: Number(variant.id),
            physicalVariantId: compId,
            sku: variant.sku,
            quantity: need,
            reason: 'bundle_sale'
          });
        }
      }
    }

    for (const [compId, needed] of demandByVariant.entries()) {
      const row = getVariantStmt.get(compId);
      if (!row || !row.active || !row.product_active) {
        throw Object.assign(new Error(`Component variant ${compId} unavailable`), {
          statusCode: 409,
          code: 'INSUFFICIENT_STOCK',
          variantId: compId
        });
      }
      const available = Math.max(0, Number(row.on_hand) - Number(row.reserved));
      if (available < needed) {
        throw Object.assign(new Error(`Insufficient stock for ${row.sku}`), {
          statusCode: 409,
          code: 'INSUFFICIENT_STOCK',
          variantId: compId,
          sku: row.sku,
          available,
          requested: needed
        });
      }
    }

    const nowIso = new Date().toISOString();
    const updateStockStmt = db.prepare('UPDATE variants SET on_hand = on_hand - ? WHERE id = ?');
    const insertLedgerStmt = db.prepare(
      `INSERT INTO inventory_ledger (variant_id, delta, reason, lot_number, expires_at, actor_id, reference_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const allocationsByOrderVariant = new Map();
    const allLotAllocations = [];

    for (const need of expandedNeeds) {
      updateStockStmt.run(need.quantity, need.physicalVariantId);
      const slices = allocateFromLotsFefo(db, need.physicalVariantId, need.quantity);
      const list = allocationsByOrderVariant.get(need.orderVariantId) ?? [];

      for (const s of slices) {
        insertLedgerStmt.run(
          need.physicalVariantId,
          -s.quantity,
          need.reason,
          s.lotNumber,
          s.expiresAt,
          actorId,
          referenceId,
          nowIso
        );
        const entry = {
          variantId: need.physicalVariantId,
          lotNumber: s.lotNumber,
          expiresAt: s.expiresAt,
          quantity: s.quantity
        };
        list.push(entry);
        allLotAllocations.push(entry);
      }
      allocationsByOrderVariant.set(need.orderVariantId, list);
    }

    return {
      demandByVariant,
      allocationsByOrderVariant,
      allLotAllocations
    };
  });
}

/**
 * Atomically restore physical stock & original FEFO lots for all items in a cancelled/refunded order.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} orderId
 * @param {{ actorId?: number|null, reason?: string }} [opts]
 */
function restoreOrderStock(db, orderId, opts = {}) {
  const actorId = opts.actorId ?? null;
  const reason = opts.reason ?? 'order_cancel';

  return withTransaction(db, () => {
    const orderItems = db.prepare(
      'SELECT variant_id, quantity, is_bundle, lot_allocations_json FROM order_items WHERE order_id = ?'
    ).all(orderId);
    const getBundleStmt = db.prepare(
      'SELECT component_variant_id, quantity FROM bundle_items WHERE bundle_variant_id = ?'
    );

    const nowIso = new Date().toISOString();
    const updateStmt = db.prepare('UPDATE variants SET on_hand = on_hand + ? WHERE id = ?');
    const ledgerStmt = db.prepare(
      `INSERT INTO inventory_ledger (variant_id, delta, reason, lot_number, expires_at, actor_id, reference_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const restoreByVariant = new Map();

    for (const item of orderItems) {
      const allocs = safeParseJson(item.lot_allocations_json, []);
      if (Array.isArray(allocs) && allocs.length > 0) {
        for (const a of allocs) {
          const vid = Number(a.variantId ?? item.variant_id);
          const qty = Number(a.quantity ?? 0);
          if (qty <= 0) continue;
          updateStmt.run(qty, vid);
          const restoredLot = addStockToLot(db, vid, qty, a.lotNumber, a.expiresAt, nowIso);
          ledgerStmt.run(vid, qty, reason, restoredLot.lotNumber, restoredLot.expiresAt, actorId, orderId, nowIso);
          restoreByVariant.set(vid, (restoreByVariant.get(vid) ?? 0) + qty);
        }
      } else if (!item.is_bundle) {
        const vid = Number(item.variant_id);
        const qty = Number(item.quantity);
        updateStmt.run(qty, vid);
        const restoredLot = addStockToLot(db, vid, qty, 'LOT-RESTORE', defaultExpiryIso(), nowIso);
        ledgerStmt.run(vid, qty, reason, restoredLot.lotNumber, restoredLot.expiresAt, actorId, orderId, nowIso);
        restoreByVariant.set(vid, (restoreByVariant.get(vid) ?? 0) + qty);
      } else {
        const comps = getBundleStmt.all(item.variant_id);
        for (const comp of comps) {
          const cid = Number(comp.component_variant_id);
          const qty = Number(comp.quantity) * Number(item.quantity);
          updateStmt.run(qty, cid);
          const restoredLot = addStockToLot(db, cid, qty, 'LOT-RESTORE', defaultExpiryIso(), nowIso);
          ledgerStmt.run(cid, qty, reason, restoredLot.lotNumber, restoredLot.expiresAt, actorId, orderId, nowIso);
          restoreByVariant.set(cid, (restoreByVariant.get(cid) ?? 0) + qty);
        }
      }
    }

    return restoreByVariant;
  });
}

/**
 * Validate and apply a 3-axis OMS state transition on `orders` + append `order_events`.
 */
function transitionOrderState(db, orderId, { orderStatus, paymentStatus, fulfillmentStatus, note = '', actorId = null } = {}) {
  return withTransaction(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      throw Object.assign(new Error('Order not found'), { statusCode: 404, code: 'ORDER_NOT_FOUND' });
    }

    const nowIso = new Date().toISOString();
    const eventsToInsert = [];

    let nextOrderStatus = order.order_status;
    let nextPaymentStatus = order.payment_status;
    let nextFulfillmentStatus = order.fulfillment_status;

    if (orderStatus !== undefined && orderStatus !== order.order_status) {
      if (!canTransitionOrderStatus(order.order_status, orderStatus)) {
        throw Object.assign(
          new Error(`Invalid order status transition from ${order.order_status} to ${orderStatus}`),
          { statusCode: 400, code: 'INVALID_STATUS_TRANSITION' }
        );
      }
      nextOrderStatus = orderStatus;
      eventsToInsert.push({ axis: 'order', from: order.order_status, to: orderStatus });
    }

    if (paymentStatus !== undefined && paymentStatus !== order.payment_status) {
      if (!canTransitionPaymentStatus(order.payment_status, paymentStatus)) {
        throw Object.assign(
          new Error(`Invalid payment status transition from ${order.payment_status} to ${paymentStatus}`),
          { statusCode: 400, code: 'INVALID_PAYMENT_TRANSITION' }
        );
      }
      nextPaymentStatus = paymentStatus;
      eventsToInsert.push({ axis: 'payment', from: order.payment_status, to: paymentStatus });
    }

    if (fulfillmentStatus !== undefined && fulfillmentStatus !== order.fulfillment_status) {
      if (!canTransitionFulfillmentStatus(order.fulfillment_status, fulfillmentStatus)) {
        throw Object.assign(
          new Error(`Invalid fulfillment status transition from ${order.fulfillment_status} to ${fulfillmentStatus}`),
          { statusCode: 400, code: 'INVALID_FULFILLMENT_TRANSITION' }
        );
      }
      nextFulfillmentStatus = fulfillmentStatus;
      eventsToInsert.push({ axis: 'fulfillment', from: order.fulfillment_status, to: fulfillmentStatus });
    }

    db.prepare(
      `UPDATE orders
       SET order_status = ?, payment_status = ?, fulfillment_status = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextOrderStatus, nextPaymentStatus, nextFulfillmentStatus, nowIso, orderId);

    const insertEvent = db.prepare(
      `INSERT INTO order_events (order_id, axis, from_status, to_status, note, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const ev of eventsToInsert) {
      insertEvent.run(orderId, ev.axis, ev.from, ev.to, String(note ?? ''), actorId, nowIso);
    }

    return toPlain(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  });
}

/**
 * Record an incoming webhook event idempotently in `processed_webhook_events` for replay protection.
 */
function recordWebhookEvent(db, { eventId, eventType, paymentIntentId = null, payloadHash }) {
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT event_id, processed_at FROM processed_webhook_events WHERE event_id = ?').get(eventId);
    if (existing) {
      return { duplicate: true, eventId, processedAt: existing.processed_at };
    }
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO processed_webhook_events (event_id, event_type, payment_intent_id, payload_hash, processed_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(eventId, eventType, paymentIntentId, payloadHash, nowIso);
    return { duplicate: false, eventId, processedAt: nowIso };
  });
}

/**
 * Merge a guest cart into an authenticated user's cart on login/register.
 * Caps per-SKU quantities at MAX_ITEM_QTY (10).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} guestToken
 * @param {number} userId
 */
function mergeGuestCartToUser(db, guestToken, userId) {
  if (!guestToken || !userId) return null;

  return withTransaction(db, () => {
    const guestCart = db.prepare('SELECT * FROM carts WHERE guest_token = ?').get(guestToken);
    if (!guestCart) return null;

    const guestItems = db.prepare('SELECT variant_id, quantity FROM cart_items WHERE cart_id = ?').all(guestCart.id);
    const nowIso = new Date().toISOString();

    let userCart = db.prepare('SELECT * FROM carts WHERE user_id = ?').get(userId);
    if (!userCart) {
      const res = db.prepare(
        `INSERT INTO carts (guest_token, user_id, promo_code, created_at, updated_at)
         VALUES (NULL, ?, ?, ?, ?)`
      ).run(userId, guestCart.promo_code ?? '', nowIso, nowIso);
      userCart = db.prepare('SELECT * FROM carts WHERE id = ?').get(Number(res.lastInsertRowid));
    } else if (!userCart.promo_code && guestCart.promo_code) {
      db.prepare('UPDATE carts SET promo_code = ?, updated_at = ? WHERE id = ?')
        .run(guestCart.promo_code, nowIso, userCart.id);
    }

    const getExistingStmt = db.prepare(
      'SELECT id, quantity FROM cart_items WHERE cart_id = ? AND variant_id = ?'
    );
    const updateItemStmt = db.prepare(
      'UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?'
    );
    const insertItemStmt = db.prepare(
      `INSERT INTO cart_items (cart_id, variant_id, quantity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const gi of guestItems) {
      const existing = getExistingStmt.get(userCart.id, gi.variant_id);
      if (existing) {
        const mergedQty = Math.min(MAX_ITEM_QTY, Number(existing.quantity) + Number(gi.quantity));
        updateItemStmt.run(mergedQty, nowIso, existing.id);
      } else {
        insertItemStmt.run(
          userCart.id,
          gi.variant_id,
          Math.min(MAX_ITEM_QTY, Math.max(1, Number(gi.quantity))),
          nowIso,
          nowIso
        );
      }
    }

    db.prepare('DELETE FROM carts WHERE id = ?').run(guestCart.id);
    return Number(userCart.id);
  });
}

/**
 * Pure server-authoritative integer-cents order/quote calculation using nullish coalescing.
 * @param {{ items: Array<{ unitPriceCents: number, quantity: number }>, promo?: object|null }} params
 */
function calculateQuoteTotals({ items, promo = null }) {
  let subtotalCents = 0;
  for (const item of items) {
    subtotalCents += Number(item.unitPriceCents) * Number(item.quantity);
  }

  let discountCents = 0;
  let promoApplied = null;
  let promoFreeShipping = false;

  if (promo && promo.active) {
    const withinMaxUses = promo.max_uses == null || Number(promo.uses_count) < Number(promo.max_uses);
    const meetsMin = subtotalCents >= Number(promo.min_subtotal_cents ?? 0);
    if (withinMaxUses && meetsMin && subtotalCents > 0) {
      if (promo.type === 'percent') {
        discountCents = Math.min(subtotalCents, Math.round((subtotalCents * Number(promo.value)) / 100));
        promoApplied = promo.code;
      } else if (promo.type === 'fixed') {
        discountCents = Math.min(subtotalCents, Number(promo.value));
        promoApplied = promo.code;
      } else if (promo.type === 'free_shipping') {
        promoFreeShipping = true;
        promoApplied = promo.code;
      }
    }
  }

  const discountedSubtotalCents = Math.max(0, subtotalCents - discountCents);
  const qualifiesFreeShipping =
    subtotalCents === 0 || promoFreeShipping || discountedSubtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS;
  const shippingCents = qualifiesFreeShipping ? 0 : STANDARD_SHIPPING_CENTS;
  const taxCents = Math.round((discountedSubtotalCents * TAX_RATE_BPS) / 10000);
  const totalCents = discountedSubtotalCents + shippingCents + taxCents;

  return {
    subtotalCents,
    discountCents,
    discountedSubtotalCents,
    shippingCents,
    taxCents,
    totalCents,
    freeShipping: subtotalCents > 0 && shippingCents === 0,
    freeShippingThresholdCents: FREE_SHIPPING_THRESHOLD_CENTS,
    amountToFreeShippingCents:
      subtotalCents > 0 && shippingCents > 0
        ? Math.max(0, FREE_SHIPPING_THRESHOLD_CENTS - discountedSubtotalCents)
        : 0,
    promoCode: promoApplied
  };
}

function writeAuditLog(db, { actorId = null, actorEmail = '', actorRole = '', action, targetType, targetId, details = {} }) {
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actorId,
    String(actorEmail ?? ''),
    String(actorRole ?? ''),
    String(action),
    String(targetType),
    String(targetId),
    JSON.stringify(details ?? {}),
    nowIso
  );
}

function queueNotification(db, { toEmail, subject, body, type, referenceId = '', status = 'queued' }) {
  const nowIso = new Date().toISOString();
  const res = db.prepare(
    `INSERT INTO notification_outbox (to_email, subject, body, type, status, reference_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    String(toEmail).toLowerCase(),
    String(subject),
    String(body),
    String(type),
    status,
    String(referenceId),
    nowIso
  );
  return Number(res.lastInsertRowid);
}

module.exports = {
  ROOT_DIR,
  DEFAULT_DB_PATH,
  FREE_SHIPPING_THRESHOLD_CENTS,
  STANDARD_SHIPPING_CENTS,
  TAX_RATE_BPS,
  MAX_ITEM_QTY,
  COLD_CHAIN_STORAGE_NOTICE,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  FULFILLMENT_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  PAYMENT_STATUS_TRANSITIONS,
  FULFILLMENT_STATUS_TRANSITIONS,
  getDbPath,
  initDb,
  getDb,
  closeDb,
  withTransaction,
  toPlain,
  toPlainRows,
  canTransitionOrderStatus,
  canTransitionPaymentStatus,
  canTransitionFulfillmentStatus,
  getVariantLots,
  getVariantAvailableStock,
  getCatalog,
  adjustVariantStock,
  decrementOrderStock,
  restoreOrderStock,
  transitionOrderState,
  recordWebhookEvent,
  mergeGuestCartToUser,
  calculateQuoteTotals,
  writeAuditLog,
  queueNotification
};

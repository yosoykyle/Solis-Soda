'use strict';

(() => {
  const STAFF_ROLES = new Set(['admin', 'merchandiser', 'warehouse', 'csr', 'finance']);

  const DEMO_ACCOUNTS = Object.freeze([
    { role: 'customer', label: 'Shopper', email: 'customer@solis.drink', desc: 'Orders, addresses, Build-a-Box' },
    { role: 'admin', label: 'Admin', email: 'admin@solis.drink', desc: 'All staff ops workspaces' },
    { role: 'merchandiser', label: 'Merchandiser', email: 'merchandiser@solis.drink', desc: 'SKUs, promos, logs, outbox' },
    { role: 'warehouse', label: 'Warehouse', email: 'warehouse@solis.drink', desc: 'Pick/pack, ship, FEFO lots' },
    { role: 'csr', label: 'CSR', email: 'csr@solis.drink', desc: 'Order search & RMA refunds' },
    { role: 'finance', label: 'Finance', email: 'finance@solis.drink', desc: 'Revenue ledger & CSV export' }
  ]);

  const ORDER_TRANSITIONS = Object.freeze({
    pending_payment: ['confirmed', 'cancelled'],
    confirmed: ['packed', 'cancelled'],
    packed: ['shipped', 'cancelled'],
    shipped: ['delivered'],
    delivered: [],
    cancelled: [],
    refunded: []
  });

  const INVENTORY_REASONS = Object.freeze([
    { value: 'restock_received', label: 'Restock received' },
    { value: 'damaged_cans', label: 'Damaged cans write-off' },
    { value: 'cycle_count', label: 'Cycle count adjustment' },
    { value: 'quality_hold', label: 'Quality hold / release' },
    { value: 'expired_writeoff', label: 'Expired batch write-off' }
  ]);

  const RMA_REASONS = Object.freeze([
    'Damaged or dented cans',
    'Warm arrival / cold-chain issue',
    'Missing pack from shipment',
    'Wrong flavor delivered',
    'Other quality concern'
  ]);

  /* ========================================================================
     1. Utilities & Bridge Helpers
     ======================================================================== */
  function getApp() {
    return window.SOLIS_APP || null;
  }

  function escapeHtml(value) {
    const app = getApp();
    if (app && typeof app.escapeHtml === 'function') {
      return app.escapeHtml(value);
    }
    return String(value ?? '').replace(/[&<>"'/]/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        case '/':
          return '&#47;';
        default:
          return ch;
      }
    });
  }

  function formatCents(cents) {
    const app = getApp();
    if (app && typeof app.formatCents === 'function') {
      return app.formatCents(cents);
    }
    const n = Number(cents);
    if (!Number.isFinite(n)) return '$0.00';
    const sign = n < 0 ? '-' : '';
    return `${sign}$${(Math.abs(Math.round(n)) / 100).toFixed(2)}`;
  }

  function formatDate(iso, includeTime = false) {
    if (!iso) return '—';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return String(iso);
    try {
      const opts = includeTime
        ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { year: 'numeric', month: 'short', day: 'numeric' };
      return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms));
    } catch {
      return String(iso).slice(0, 10);
    }
  }

  function formatStatusLabel(status) {
    return String(status || 'unknown')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function pluralize(count, singular, plural) {
    return count === 1 ? `1 ${singular}` : `${count} ${plural || `${singular}s`}`;
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
  }

  function parseDollarsToCents(raw) {
    const str = String(raw ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(str)) return null;
    const cents = Math.round(Number(str) * 100);
    return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
  }

  function parseStrictIntegerInput(raw) {
    const str = String(raw ?? '').trim();
    if (!/^-?\d+$/.test(str)) return null;
    const val = Number(str);
    return Number.isSafeInteger(val) ? val : null;
  }

  async function portalFetch(url, options = {}) {
    const app = getApp();
    if (app && typeof app.apiFetch === 'function') {
      return app.apiFetch(url, options);
    }
    const res = await fetch(url, { ...options, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function isStaffRole(role) {
    return STAFF_ROLES.has(String(role || '').toLowerCase());
  }

  function getAuthState() {
    const app = getApp();
    if (app && typeof app.getAuth === 'function') {
      return app.getAuth();
    }
    return { authenticated: false, user: null, csrfToken: null };
  }

  function getStatusTone(status) {
    const s = String(status || '').toLowerCase();
    if (['delivered', 'paid', 'succeeded', 'active', 'approved', 'refunded', 'replaced'].includes(s)) {
      return s === 'refunded' ? 'warning' : 'success';
    }
    if (['shipped', 'packed', 'confirmed', 'allocated', 'queued', 'recorded'].includes(s)) {
      return 'info';
    }
    if (['cancelled', 'failed', 'voided', 'rejected'].includes(s)) {
      return 'danger';
    }
    if (['paused', 'pending_payment', 'pending', 'requested', 'partially_refunded'].includes(s)) {
      return 'warning';
    }
    return 'neutral';
  }

  function renderBadge(label, tone = 'neutral') {
    const icons = {
      success: '✓',
      info: '•',
      warning: '◐',
      danger: '✕',
      neutral: '·'
    };
    const icon = icons[tone] || '·';
    return `<span class="portal-badge portal-badge--${escapeHtml(tone)}"><span aria-hidden="true">${icon}</span> ${escapeHtml(label)}</span>`;
  }

  function getFocusableElements(container) {
    if (!container) return [];
    const selector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([type="hidden"]):not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'summary',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');
    return Array.from(container.querySelectorAll(selector)).filter((el) => {
      if (el.hidden || el.closest('[hidden]')) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  /* ========================================================================
     2. Portal State
     ======================================================================== */
  const state = {
    activePortal: null, // 'account' | 'ops' | null
    lastFocused: null,
    authTab: 'login', // 'login' | 'register'
    accountTab: 'orders', // 'orders' | 'addresses' | 'subscriptions'
    opsTab: 'warehouse', // 'warehouse' | 'merchandiser' | 'csr' | 'finance'
    merchSubTab: 'catalog', // 'catalog' | 'promos' | 'audit' | 'outbox'

    accountLive: { type: 'info', text: '' },
    opsLive: { type: 'info', text: '' },

    // Customer data
    orders: [],
    ordersLoaded: false,
    addresses: [],
    addressesLoaded: false,
    subscriptions: [],
    subscriptionsLoaded: false,
    expandedReceipts: new Set(),
    openRmaOrderId: null,
    editingSubId: null,
    subBoxDraft: new Map(), // variantId -> qty
    subSwapDraft: new Map(), // variantId -> qty
    pendingConfirm: null, // { scope, key }

    // Ops data
    opsProducts: [],
    opsOrders: [],
    opsOrderStatusFilter: 'all',
    opsOrderSearch: '',
    opsInventoryLedger: [],
    opsPromotions: [],
    opsAuditLogs: [],
    opsAuditActionFilter: '',
    opsOutbox: [],
    opsOutboxTypeFilter: '',
    opsOutboxRefFilter: '',
    opsReturns: [],
    opsReturnStatusFilter: 'all',
    opsReturnSearch: '',
    opsFinance: { summary: null, entries: [] },
    opsFinanceFrom: '',
    opsFinanceTo: '',
    openShipOrderId: null,
    opsCsrOrders: [],
    opsCsrOrderQuery: '',
    opsCsrOrderStatus: ''
  };

  /* ========================================================================
     3. Mount Root Shell
     ======================================================================== */
  const root = document.getElementById('portals-root');
  if (!root) return;

  root.innerHTML = `
    <div class="portal-backdrop" id="portal-backdrop" hidden></div>

    <aside
      class="portal-drawer"
      id="account-portal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-portal-title"
      hidden
    >
      <header class="portal-header">
        <div class="portal-title-wrap">
          <span class="portal-kicker">SOLIS Member Portal</span>
          <h2 class="portal-title" id="account-portal-title" tabindex="-1">Customer Account</h2>
        </div>
        <div class="portal-header-actions" id="account-header-actions">
          <button type="button" class="portal-close" id="account-portal-close" aria-label="Close account portal">✕</button>
        </div>
      </header>
      <div class="portal-body" id="account-portal-body">
        <div class="portal-live" id="account-live-region" role="status" aria-live="polite" tabindex="-1"></div>
        <div id="account-portal-content"></div>
      </div>
    </aside>

    <aside
      class="portal-drawer portal-drawer--wide"
      id="ops-portal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ops-portal-title"
      hidden
    >
      <header class="portal-header">
        <div class="portal-title-wrap">
          <span class="portal-kicker">SOLIS Operations</span>
          <h2 class="portal-title" id="ops-portal-title" tabindex="-1">Staff Operations Workspace</h2>
        </div>
        <div class="portal-header-actions" id="ops-header-actions">
          <button type="button" class="portal-btn portal-btn--sm" id="ops-switch-account">My Account</button>
          <button type="button" class="portal-close" id="ops-portal-close" aria-label="Close staff operations workspace">✕</button>
        </div>
      </header>
      <div class="portal-body" id="ops-portal-body">
        <div class="portal-live" id="ops-live-region" role="status" aria-live="polite" tabindex="-1"></div>
        <div id="ops-portal-content"></div>
      </div>
    </aside>
  `;

  const dom = {
    backdrop: document.getElementById('portal-backdrop'),
    accountDrawer: document.getElementById('account-portal'),
    accountTitle: document.getElementById('account-portal-title'),
    accountHeaderActions: document.getElementById('account-header-actions'),
    accountClose: document.getElementById('account-portal-close'),
    accountLive: document.getElementById('account-live-region'),
    accountContent: document.getElementById('account-portal-content'),

    opsDrawer: document.getElementById('ops-portal'),
    opsTitle: document.getElementById('ops-portal-title'),
    opsHeaderActions: document.getElementById('ops-header-actions'),
    opsSwitchAccount: document.getElementById('ops-switch-account'),
    opsClose: document.getElementById('ops-portal-close'),
    opsLive: document.getElementById('ops-live-region'),
    opsContent: document.getElementById('ops-portal-content')
  };

  function setLiveMessage(portal, type, text) {
    const msg = String(text || '').trim();
    const safeType = type === 'error' || type === 'success' ? type : 'info';
    if (portal === 'account') {
      state.accountLive = { type: safeType, text: msg };
      if (!dom.accountLive) return;
      dom.accountLive.className = msg ? `portal-live is-${safeType}` : 'portal-live';
      dom.accountLive.setAttribute('role', safeType === 'error' && msg ? 'alert' : 'status');
      dom.accountLive.setAttribute('aria-live', safeType === 'error' && msg ? 'assertive' : 'polite');
      dom.accountLive.textContent = msg;
    } else {
      state.opsLive = { type: safeType, text: msg };
      if (!dom.opsLive) return;
      dom.opsLive.className = msg ? `portal-live is-${safeType}` : 'portal-live';
      dom.opsLive.setAttribute('role', safeType === 'error' && msg ? 'alert' : 'status');
      dom.opsLive.setAttribute('aria-live', safeType === 'error' && msg ? 'assertive' : 'polite');
      dom.opsLive.textContent = msg;
    }
  }

  function syncTriggerAriaExpanded() {
    const acctBtn = document.getElementById('account-toggle');
    const opsBtn = document.getElementById('ops-toggle');
    if (acctBtn) acctBtn.setAttribute('aria-expanded', state.activePortal === 'account' ? 'true' : 'false');
    if (opsBtn) opsBtn.setAttribute('aria-expanded', state.activePortal === 'ops' ? 'true' : 'false');
  }

  function getActiveDrawerEl() {
    if (state.activePortal === 'account') return dom.accountDrawer;
    if (state.activePortal === 'ops') return dom.opsDrawer;
    return null;
  }

  function closePortals({ restoreFocus = true } = {}) {
    if (!state.activePortal) return;
    state.activePortal = null;
    state.pendingConfirm = null;

    setLiveMessage('account', 'info', '');
    setLiveMessage('ops', 'info', '');

    dom.accountDrawer.hidden = true;
    dom.opsDrawer.hidden = true;
    dom.backdrop.hidden = true;

    const app = getApp();
    if (app && typeof app.setBackgroundInert === 'function') {
      app.setBackgroundInert(false);
    }
    syncTriggerAriaExpanded();

    if (restoreFocus) {
      let target = state.lastFocused;
      const isHiddenOrInert =
        !target ||
        !target.isConnected ||
        target.hidden ||
        target.closest('[hidden]') ||
        target.closest('[inert]');
      if (isHiddenOrInert) {
        const acctBtn = document.getElementById('account-toggle');
        const mainEl = document.getElementById('main');
        target = acctBtn && !acctBtn.closest('[hidden]') ? acctBtn : mainEl;
      }
      if (target && typeof target.focus === 'function') {
        try {
          target.focus();
        } catch {
          // Ignore unfocusable fallback
        }
      }
    }
    state.lastFocused = null;
  }

  function getAllowedOpsTabs(role) {
    const r = String(role || '').toLowerCase();
    const tabs = [];
    if (r === 'admin' || r === 'warehouse') {
      tabs.push({ id: 'warehouse', label: 'Warehouse' });
    }
    if (r === 'admin' || r === 'merchandiser') {
      tabs.push({ id: 'merchandiser', label: 'Admin / Merchandiser' });
    }
    if (r === 'admin' || r === 'csr') {
      tabs.push({ id: 'csr', label: 'CSR' });
    }
    if (r === 'admin' || r === 'finance') {
      tabs.push({ id: 'finance', label: 'Finance' });
    }
    return tabs;
  }

  async function openAccountPortal({ triggerEl = null, initialTab = null } = {}) {
    const app = getApp();
    if (app && typeof app.closeStoreDrawers === 'function') {
      app.closeStoreDrawers({ restoreFocus: false });
    }

    if (!state.activePortal) {
      const candidate = triggerEl instanceof HTMLElement ? triggerEl : document.activeElement;
      state.lastFocused = candidate instanceof HTMLElement ? candidate : document.getElementById('account-toggle');
    }

    if (initialTab) {
      state.accountTab = initialTab;
    }

    if (state.activePortal === 'ops') {
      setLiveMessage('ops', 'info', '');
    }

    state.activePortal = 'account';
    dom.opsDrawer.hidden = true;
    dom.accountDrawer.hidden = false;
    dom.backdrop.hidden = false;
    if (app && typeof app.setBackgroundInert === 'function') {
      app.setBackgroundInert(true, dom.accountDrawer);
    }
    syncTriggerAriaExpanded();

    renderAccountPortal();
    dom.accountTitle?.focus();

    const auth = getAuthState();
    if (auth.authenticated) {
      await loadAccountTabData(state.accountTab);
    }
  }

  async function openOpsPortal({ triggerEl = null, initialTab = null } = {}) {
    const auth = getAuthState();
    if (!auth.authenticated || !auth.user || !isStaffRole(auth.user.role)) {
      setLiveMessage(
        'account',
        'info',
        'Staff Operations requires signing in with an Admin, Merchandiser, Warehouse, CSR, or Finance account.'
      );
      await openAccountPortal({ triggerEl });
      return;
    }

    const allowedTabs = getAllowedOpsTabs(auth.user.role);
    if (allowedTabs.length === 0) {
      setLiveMessage('account', 'error', 'Your account does not have Staff Operations permissions.');
      await openAccountPortal({ triggerEl });
      return;
    }

    if (initialTab && allowedTabs.some((t) => t.id === initialTab)) {
      state.opsTab = initialTab;
    } else if (!allowedTabs.some((t) => t.id === state.opsTab)) {
      state.opsTab = allowedTabs[0].id;
    }

    const app = getApp();
    if (app && typeof app.closeStoreDrawers === 'function') {
      app.closeStoreDrawers({ restoreFocus: false });
    }

    if (!state.activePortal) {
      const candidate = triggerEl instanceof HTMLElement ? triggerEl : document.activeElement;
      state.lastFocused = candidate instanceof HTMLElement ? candidate : document.getElementById('ops-toggle');
    }

    if (state.activePortal === 'account') {
      setLiveMessage('account', 'info', '');
    }

    state.activePortal = 'ops';
    dom.accountDrawer.hidden = true;
    dom.opsDrawer.hidden = false;
    dom.backdrop.hidden = false;
    if (app && typeof app.setBackgroundInert === 'function') {
      app.setBackgroundInert(true, dom.opsDrawer);
    }
    syncTriggerAriaExpanded();

    renderOpsPortal();
    dom.opsTitle?.focus();

    await loadOpsTabData(state.opsTab);
  }

  /* ========================================================================
     4. Keyboard, Focus Trap, and Tablist Helper
     ======================================================================== */
  function getConfirmCancelFallbackSelector(pending) {
    if (!pending || !pending.key) return null;
    const key = CSS.escape(String(pending.key));
    if (pending.scope === 'cancel-order') return `[data-ask-cancel-order="${key}"]`;
    if (pending.scope === 'delete-address') return `[data-ask-delete-address="${key}"]`;
    if (pending.scope === 'cancel-sub') return `[data-ask-cancel-sub="${key}"]`;
    if (pending.scope === 'wh-cancel') return `[data-wh-ask-cancel="${key}"]`;
    if (pending.scope === 'csr-reject-rma') return `[data-ask-reject-rma="${key}"]`;
    return null;
  }

  function captureFocusTarget(container) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !container || !container.contains(active)) {
      return null;
    }
    if (active.id) {
      return { selector: `#${CSS.escape(active.id)}` };
    }
    if (active.dataset.acctTab) return { selector: `[data-acct-tab="${CSS.escape(active.dataset.acctTab)}"]` };
    if (active.dataset.authTab) return { selector: `[data-auth-tab="${CSS.escape(active.dataset.authTab)}"]` };
    if (active.dataset.opsTab) return { selector: `[data-ops-tab="${CSS.escape(active.dataset.opsTab)}"]` };
    if (active.dataset.merchSubtab) return { selector: `[data-merch-subtab="${CSS.escape(active.dataset.merchSubtab)}"]` };
    if (active.dataset.toggleReceipt) return { selector: `[data-toggle-receipt="${CSS.escape(active.dataset.toggleReceipt)}"]` };
    if (active.dataset.toggleRma) return { selector: `[data-toggle-rma="${CSS.escape(active.dataset.toggleRma)}"]` };
    if (active.dataset.askCancelOrder) return { selector: `[data-ask-cancel-order="${CSS.escape(active.dataset.askCancelOrder)}"]` };
    if (active.dataset.confirmCancelOrder) {
      return {
        selector: `[data-confirm-cancel-order="${CSS.escape(active.dataset.confirmCancelOrder)}"]`,
        fallback: `[data-toggle-receipt="${CSS.escape(active.dataset.confirmCancelOrder)}"]`
      };
    }
    if (active.dataset.askDeleteAddress) return { selector: `[data-ask-delete-address="${CSS.escape(active.dataset.askDeleteAddress)}"]` };
    if (active.dataset.askCancelSub) return { selector: `[data-ask-cancel-sub="${CSS.escape(active.dataset.askCancelSub)}"]` };
    if (active.dataset.confirmCancelSub) {
      return {
        selector: `[data-confirm-cancel-sub="${CSS.escape(active.dataset.confirmCancelSub)}"]`,
        fallback: `[data-toggle-sub-edit="${CSS.escape(active.dataset.confirmCancelSub)}"]`
      };
    }
    if (active.dataset.toggleSubEdit) return { selector: `[data-toggle-sub-edit="${CSS.escape(active.dataset.toggleSubEdit)}"]` };
    if (active.dataset.subAction && active.dataset.subId) {
      return {
        selector: `[data-sub-action="${CSS.escape(active.dataset.subAction)}"][data-sub-id="${CSS.escape(active.dataset.subId)}"]`,
        fallback: `[data-toggle-sub-edit="${CSS.escape(active.dataset.subId)}"]`
      };
    }
    if (active.dataset.subDraftDelta && active.dataset.variantId) {
      return {
        selector: `[data-sub-draft-delta="${CSS.escape(active.dataset.subDraftDelta)}"][data-variant-id="${CSS.escape(active.dataset.variantId)}"]`
      };
    }
    if (active.dataset.swapQtyDelta && active.dataset.variantId) {
      return {
        selector: `[data-swap-qty-delta="${CSS.escape(active.dataset.swapQtyDelta)}"][data-variant-id="${CSS.escape(active.dataset.variantId)}"]`
      };
    }
    if (active.dataset.whStatus && active.dataset.nextStatus) {
      return {
        selector: `[data-wh-status="${CSS.escape(active.dataset.whStatus)}"][data-next-status="${CSS.escape(active.dataset.nextStatus)}"]`,
        fallback: `[data-wh-toggle-ship="${CSS.escape(active.dataset.whStatus)}"]`
      };
    }
    if (active.dataset.whToggleShip) {
      return { selector: `[data-wh-toggle-ship="${CSS.escape(active.dataset.whToggleShip)}"]` };
    }
    if (active.dataset.whAskCancel) {
      return { selector: `[data-wh-ask-cancel="${CSS.escape(active.dataset.whAskCancel)}"]` };
    }
    if (active.dataset.toggleProductActive) {
      return { selector: `[data-toggle-product-active="${CSS.escape(active.dataset.toggleProductActive)}"]` };
    }
    if (active.dataset.togglePromo) {
      return { selector: `[data-toggle-promo="${CSS.escape(active.dataset.togglePromo)}"]` };
    }
    if (active.dataset.askRejectRma) {
      return { selector: `[data-ask-reject-rma="${CSS.escape(active.dataset.askRejectRma)}"]` };
    }
    if (active.dataset.rmaAction && active.dataset.rmaId) {
      return {
        selector: `[data-rma-action="${CSS.escape(active.dataset.rmaAction)}"][data-rma-id="${CSS.escape(active.dataset.rmaId)}"]`
      };
    }
    const form = active.closest('form');
    if (form?.dataset.variantEditForm && form?.dataset.variantId) {
      const part = active.name ? `[name="${CSS.escape(active.name)}"]` : 'button[type="submit"]';
      return {
        selector: `form[data-variant-edit-form="${CSS.escape(form.dataset.variantEditForm)}"][data-variant-id="${CSS.escape(form.dataset.variantId)}"] ${part}`
      };
    }
    if (form?.id && active.tagName === 'BUTTON') {
      return { selector: `#${CSS.escape(form.id)} button[type="${CSS.escape(active.type || 'submit')}"]` };
    }
    return { selector: null };
  }

  function restorePortalFocus(portal, captured, explicitSelector = null) {
    const isAccount = portal === 'account';
    const container = isAccount ? dom.accountContent : dom.opsContent;
    const titleEl = isAccount ? dom.accountTitle : dom.opsTitle;
    if (!container) return;

    const candidates = [
      explicitSelector,
      captured?.selector,
      captured?.fallback,
      (captured || explicitSelector) ? '[role="tab"][aria-selected="true"]' : null
    ].filter(Boolean);

    for (const sel of candidates) {
      const target = container.querySelector(sel);
      if (target instanceof HTMLElement && !target.closest('[hidden]')) {
        target.focus();
        return;
      }
    }

    if (captured || explicitSelector) {
      titleEl?.focus();
    }
  }

  function wireRovingTablist(tablistEl, onSelect) {
    if (!tablistEl) return;
    const tabs = Array.from(tablistEl.querySelectorAll('[role="tab"]'));
    tabs.forEach((tab, idx) => {
      tab.addEventListener('keydown', (e) => {
        const isRtl = document.documentElement.getAttribute('dir') === 'rtl';
        const forwardKey = isRtl ? 'ArrowLeft' : 'ArrowRight';
        const backwardKey = isRtl ? 'ArrowRight' : 'ArrowLeft';
        let nextIdx = null;
        if (e.key === forwardKey) nextIdx = (idx + 1) % tabs.length;
        else if (e.key === backwardKey) nextIdx = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = tabs.length - 1;
        if (nextIdx === null) return;
        e.preventDefault();
        const nextTab = tabs[nextIdx];
        onSelect(nextTab);
        const refreshed = (nextTab.id ? document.getElementById(nextTab.id) : null) || nextTab;
        if (typeof refreshed.focus === 'function') refreshed.focus();
      });
    });
  }

  document.addEventListener('keydown', (e) => {
    const activeDrawer = getActiveDrawerEl();
    if (!activeDrawer) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.pendingConfirm) {
        const abortFallback = getConfirmCancelFallbackSelector(state.pendingConfirm);
        state.pendingConfirm = null;
        if (state.activePortal === 'account') renderAccountPortal(abortFallback);
        else renderOpsPortal(abortFallback);
        return;
      }
      closePortals({ restoreFocus: true });
      return;
    }

    if (e.key === 'Tab') {
      const focusables = getFocusableElements(activeDrawer);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  dom.backdrop.addEventListener('click', () => closePortals({ restoreFocus: true }));
  dom.accountClose.addEventListener('click', () => closePortals({ restoreFocus: true }));
  dom.opsClose.addEventListener('click', () => closePortals({ restoreFocus: true }));
  dom.opsSwitchAccount.addEventListener('click', () => openAccountPortal({ triggerEl: dom.opsSwitchAccount }));

  /* ========================================================================
     5. Form Validation & Busy Helpers
     ======================================================================== */
  function setFieldError(inputEl, errorEl, message) {
    if (!inputEl || !errorEl) return;
    if (message) {
      inputEl.setAttribute('aria-invalid', 'true');
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      inputEl.removeAttribute('aria-invalid');
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
  }

  function setButtonBusy(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent.trim();
      btn.setAttribute('aria-disabled', 'true');
      if (busyLabel) btn.textContent = busyLabel;
    } else {
      btn.removeAttribute('aria-disabled');
      if (btn.dataset.idleLabel) btn.textContent = btn.dataset.idleLabel;
    }
  }

  function isBusy(btn) {
    return !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true';
  }

  /* ========================================================================
     6. Customer Account Portal (Auth + Orders + Addresses + Subscriptions)
     ======================================================================== */
  function updateAccountHeaderChrome(auth) {
    const isAuth = Boolean(auth.authenticated && auth.user);
    dom.accountTitle.textContent = isAuth ? auth.user.name : 'Sign In or Register';

    const existingStaffBtn = document.getElementById('account-open-ops-btn');
    const existingSignOutBtn = document.getElementById('account-signout-btn');
    existingStaffBtn?.remove();
    existingSignOutBtn?.remove();

    if (isAuth) {
      if (isStaffRole(auth.user.role)) {
        const opsBtn = document.createElement('button');
        opsBtn.type = 'button';
        opsBtn.id = 'account-open-ops-btn';
        opsBtn.className = 'portal-btn portal-btn--accent portal-btn--sm';
        opsBtn.textContent = 'Staff Ops';
        opsBtn.addEventListener('click', () => openOpsPortal({ triggerEl: opsBtn }));
        dom.accountHeaderActions.insertBefore(opsBtn, dom.accountClose);
      }
      const signOutBtn = document.createElement('button');
      signOutBtn.type = 'button';
      signOutBtn.id = 'account-signout-btn';
      signOutBtn.className = 'portal-btn portal-btn--sm';
      signOutBtn.textContent = 'Sign Out';
      signOutBtn.addEventListener('click', handleLogout);
      dom.accountHeaderActions.insertBefore(signOutBtn, dom.accountClose);
    }
  }

  async function handleLogout() {
    const app = getApp();
    try {
      await portalFetch('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      // Clear local auth state even if session already expired
    }
    state.orders = [];
    state.ordersLoaded = false;
    state.addresses = [];
    state.addressesLoaded = false;
    state.subscriptions = [];
    state.subscriptionsLoaded = false;
    state.pendingConfirm = null;

    if (app && typeof app.setAuth === 'function') {
      app.setAuth({ authenticated: false, user: null, csrfToken: null });
    }
    if (app && typeof app.refreshCart === 'function') {
      await app.refreshCart();
    }

    setLiveMessage('account', 'info', 'You have signed out of your SOLIS account.');
    if (state.activePortal === 'ops') {
      await openAccountPortal();
    } else {
      renderAccountPortal();
      dom.accountTitle?.focus();
    }
  }

  function renderAuthView() {
    const isLogin = state.authTab === 'login';
    return `
      <div class="portal-tablist" role="tablist" aria-label="Account authentication">
        <button
          type="button"
          id="auth-tab-login"
          class="portal-tab"
          role="tab"
          aria-selected="${isLogin ? 'true' : 'false'}"
          aria-controls="auth-panel-login"
          tabindex="${isLogin ? '0' : '-1'}"
          data-auth-tab="login"
        >Sign In</button>
        <button
          type="button"
          id="auth-tab-register"
          class="portal-tab"
          role="tab"
          aria-selected="${!isLogin ? 'true' : 'false'}"
          aria-controls="auth-panel-register"
          tabindex="${!isLogin ? '0' : '-1'}"
          data-auth-tab="register"
        >Create Account</button>
      </div>

      <section
        id="auth-panel-login"
        class="portal-tabpanel"
        role="tabpanel"
        aria-labelledby="auth-tab-login"
        ${isLogin ? '' : 'hidden'}
      >
        <form class="portal-card portal-form" id="portal-login-form" novalidate>
          <h3 class="portal-section-title">Sign in to SOLIS</h3>
          <p class="portal-hint">* Required fields</p>

          <div class="portal-field">
            <label for="login-email" class="portal-label">Email address <span aria-hidden="true">*</span></label>
            <input
              type="email"
              id="login-email"
              name="email"
              class="portal-input"
              placeholder="name@example.com"
              autocomplete="email"
              spellcheck="false"
              required
              aria-describedby="login-email-error"
            />
            <p class="portal-field-error" id="login-email-error" hidden></p>
          </div>

          <div class="portal-field">
            <label for="login-password" class="portal-label">Password <span aria-hidden="true">*</span></label>
            <input
              type="password"
              id="login-password"
              name="password"
              class="portal-input"
              placeholder="Enter your password"
              autocomplete="current-password"
              required
              aria-describedby="login-password-error"
            />
            <p class="portal-field-error" id="login-password-error" hidden></p>
          </div>

          <button type="submit" class="portal-btn portal-btn--primary portal-btn--full" id="portal-login-submit">
            Sign In
          </button>
        </form>
      </section>

      <section
        id="auth-panel-register"
        class="portal-tabpanel"
        role="tabpanel"
        aria-labelledby="auth-tab-register"
        ${!isLogin ? '' : 'hidden'}
      >
        <form class="portal-card portal-form" id="portal-register-form" novalidate>
          <h3 class="portal-section-title">Create customer account</h3>
          <p class="portal-hint">* Required fields. Guest bag items transfer automatically.</p>

          <div class="portal-field">
            <label for="reg-name" class="portal-label">Full name <span aria-hidden="true">*</span></label>
            <input
              type="text"
              id="reg-name"
              name="name"
              class="portal-input"
              placeholder="Alex Rivera"
              autocomplete="name"
              required
              aria-describedby="reg-name-error"
            />
            <p class="portal-field-error" id="reg-name-error" hidden></p>
          </div>

          <div class="portal-field">
            <label for="reg-email" class="portal-label">Email address <span aria-hidden="true">*</span></label>
            <input
              type="email"
              id="reg-email"
              name="email"
              class="portal-input"
              placeholder="name@example.com"
              autocomplete="email"
              spellcheck="false"
              required
              aria-describedby="reg-email-error"
            />
            <p class="portal-field-error" id="reg-email-error" hidden></p>
          </div>

          <div class="portal-field">
            <label for="reg-password" class="portal-label">Password <span aria-hidden="true">*</span></label>
            <input
              type="password"
              id="reg-password"
              name="password"
              class="portal-input"
              placeholder="Create a password"
              autocomplete="new-password"
              required
              aria-describedby="reg-password-hint reg-password-error"
            />
            <p class="portal-hint" id="reg-password-hint">Use at least 8 characters.</p>
            <p class="portal-field-error" id="reg-password-error" hidden></p>
          </div>

          <button type="submit" class="portal-btn portal-btn--primary portal-btn--full" id="portal-register-submit">
            Create Account
          </button>
        </form>
      </section>

      <section class="portal-card portal-card--subtle" aria-labelledby="demo-roles-heading">
        <div>
          <h3 class="portal-card-title" id="demo-roles-heading">Evaluation Sandbox · Demo Role Quick-Fill</h3>
          <p class="portal-card-sub">
            Select any demo role to fill evaluation credentials and open a built-in sandbox sign-in session.
          </p>
        </div>
        <div class="portal-demo-grid">
          ${DEMO_ACCOUNTS.map(
            (demo) => `
              <button
                type="button"
                class="portal-demo-btn"
                data-demo-email="${escapeHtml(demo.email)}"
                data-demo-role="${escapeHtml(demo.role)}"
              >
                <span class="portal-demo-role">${escapeHtml(demo.label)}</span>
                <span class="portal-demo-email">${escapeHtml(demo.email)}</span>
                <span class="portal-hint">${escapeHtml(demo.desc)}</span>
              </button>
            `
          ).join('')}
        </div>
      </section>
    `;
  }

  function renderOrderCard(order) {
    const expanded = state.expandedReceipts.has(order.id);
    const rmaOpen = state.openRmaOrderId === order.id;
    const isCancelConfirm =
      state.pendingConfirm?.scope === 'cancel-order' && state.pendingConfirm.key === order.id;

    const canCancel = order.orderStatus === 'confirmed' || order.orderStatus === 'pending_payment';
    const canRma = !['pending_payment', 'cancelled', 'refunded'].includes(order.orderStatus);

    const itemsHtml = (order.items || [])
      .map((item) => {
        const lotPart = item.lotNumber
          ? ` · Lot ${escapeHtml(item.lotNumber)}${item.expiresAt ? ` (Exp ${escapeHtml(item.expiresAt)})` : ''}`
          : '';
        return `
          <li class="portal-item-row">
            <div class="portal-item-main">
              <strong>${escapeHtml(item.productName)}</strong> — ${escapeHtml(item.variantLabel)}
              <div class="portal-card-sub portal-mono">SKU ${escapeHtml(item.sku)} · Qty ${escapeHtml(item.quantity)}${lotPart}</div>
            </div>
            <strong class="portal-num">${escapeHtml(formatCents(item.lineTotalCents))}</strong>
          </li>
        `;
      })
      .join('');

    const shipmentsHtml = (order.shipments || [])
      .map(
        (s) => `
          <div class="portal-cold-notice">
            <strong>Shipment:</strong> ${escapeHtml(s.carrier)} · Tracking <span class="portal-mono">${escapeHtml(s.trackingNumber)}</span>
            (${escapeHtml(formatStatusLabel(s.status))}) · Shipped ${escapeHtml(formatDate(s.shippedAt, true))}
            ${s.lotNumbers?.length ? `<br />FEFO Lots: <span class="portal-mono">${escapeHtml(s.lotNumbers.join(', '))}</span>` : ''}
          </div>
        `
      )
      .join('');

    const refundsHtml = (order.refunds || [])
      .map(
        (r) => `
          <p class="portal-hint portal-num">
            Refund ${escapeHtml(r.id)}: ${escapeHtml(formatCents(r.amountCents))} (${escapeHtml(r.reason)}) — ${escapeHtml(formatDate(r.createdAt))}
          </p>
        `
      )
      .join('');

    const rmasHtml = (order.returns || [])
      .map(
        (rma) => `
          <div class="portal-item-row">
            <div class="portal-item-main">
              <strong>${escapeHtml(rma.id)}</strong> — ${escapeHtml(rma.reason)}
              <div class="portal-card-sub">
                ${rma.resolution ? `Resolution: ${escapeHtml(rma.resolution)} · ` : ''}
                Requested ${escapeHtml(formatDate(rma.createdAt))}
              </div>
            </div>
            ${renderBadge(formatStatusLabel(rma.status), getStatusTone(rma.status))}
          </div>
        `
      )
      .join('');

    return `
      <article class="portal-card" data-order-card="${escapeHtml(order.id)}">
        <div class="portal-card-head">
          <div>
            <h4 class="portal-card-title portal-mono">${escapeHtml(order.id)}</h4>
            <p class="portal-card-sub">
              Placed ${escapeHtml(formatDate(order.createdAt, true))} · Total <strong class="portal-num">${escapeHtml(formatCents(order.totalCents))}</strong>
            </p>
          </div>
          <div class="portal-badges">
            ${renderBadge(`Order: ${formatStatusLabel(order.orderStatus)}`, getStatusTone(order.orderStatus))}
            ${renderBadge(`Payment: ${formatStatusLabel(order.paymentStatus)}`, getStatusTone(order.paymentStatus))}
            ${renderBadge(`Fulfillment: ${formatStatusLabel(order.fulfillmentStatus)}`, getStatusTone(order.fulfillmentStatus))}
          </div>
        </div>

        <p class="portal-cold-notice">
          <strong>Cold-Chain Care:</strong> ${escapeHtml(order.storageNotice || 'Keep refrigerated at 35-42F (2-6C).')}
          ${order.insulatedPackIncluded ? ' · Insulated liner included.' : ''}
        </p>

        <div class="portal-btn-row">
          <button
            type="button"
            class="portal-btn portal-btn--sm"
            data-toggle-receipt="${escapeHtml(order.id)}"
            aria-expanded="${expanded ? 'true' : 'false'}"
            aria-controls="acct-receipt-${escapeHtml(order.id)}"
          >
            ${expanded ? 'Hide Receipt' : 'View Itemized Receipt'}
          </button>
          ${
            canCancel
              ? `<button type="button" class="portal-btn portal-btn--danger-outline portal-btn--sm" data-ask-cancel-order="${escapeHtml(order.id)}">Cancel Order</button>`
              : ''
          }
          ${
            canRma
              ? `<button type="button" class="portal-btn portal-btn--sm" data-toggle-rma="${escapeHtml(order.id)}" aria-expanded="${rmaOpen ? 'true' : 'false'}">Report Damaged Cans / RMA</button>`
              : ''
          }
        </div>

        ${
          isCancelConfirm
            ? `
              <div class="portal-confirm-box" role="region" aria-label="Confirm order cancellation">
                <p class="portal-confirm-text">
                  Cancel order <span class="portal-mono">${escapeHtml(order.id)}</span>? Inventory will be restored to FEFO lots and any captured payment will be refunded.
                </p>
                <div class="portal-btn-row">
                  <button type="button" class="portal-btn portal-btn--danger portal-btn--sm" data-confirm-cancel-order="${escapeHtml(order.id)}">Confirm Cancel Order</button>
                  <button type="button" class="portal-btn portal-btn--sm" data-abort-confirm>Keep Order</button>
                </div>
              </div>
            `
            : ''
        }

        <div id="acct-receipt-${escapeHtml(order.id)}" class="portal-receipt-panel" ${expanded ? '' : 'hidden'}>
          <div class="portal-card-sub">
            Ship to: ${escapeHtml(order.customerName)} · ${escapeHtml(order.shippingLine1)}, ${escapeHtml(order.shippingCity)} ${escapeHtml(order.shippingPostal)}
          </div>
          <ul class="portal-item-list">${itemsHtml}</ul>
          <div class="portal-summary-lines">
            <div class="portal-summary-row"><span>Subtotal</span><span>${escapeHtml(formatCents(order.subtotalCents))}</span></div>
            ${order.discountCents > 0 ? `<div class="portal-summary-row"><span>Discount (${escapeHtml(order.promoCode || 'Promo')})</span><span>-${escapeHtml(formatCents(order.discountCents))}</span></div>` : ''}
            <div class="portal-summary-row"><span>Chilled Shipping</span><span>${order.shippingCents === 0 ? 'Free' : escapeHtml(formatCents(order.shippingCents))}</span></div>
            <div class="portal-summary-row"><span>Tax (8.25%)</span><span>${escapeHtml(formatCents(order.taxCents))}</span></div>
            <div class="portal-summary-row portal-summary-row--total"><span>Total</span><span>${escapeHtml(formatCents(order.totalCents))}</span></div>
          </div>
          ${shipmentsHtml}
          ${refundsHtml}
          ${rmasHtml ? `<div><strong>Returns &amp; RMAs</strong><div class="portal-item-list">${rmasHtml}</div></div>` : ''}
        </div>

        ${
          rmaOpen
            ? `
              <form class="portal-card portal-card--subtle portal-form" data-rma-form="${escapeHtml(order.id)}" novalidate>
                <h5 class="portal-card-title">Report Damaged Cans / Request RMA</h5>
                <div class="portal-grid-2">
                  <div class="portal-field">
                    <label for="rma-reason-${escapeHtml(order.id)}" class="portal-label">Issue reason</label>
                    <select id="rma-reason-${escapeHtml(order.id)}" name="reason" class="portal-select">
                      ${RMA_REASONS.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="portal-field">
                    <label for="rma-item-${escapeHtml(order.id)}" class="portal-label">Affected pack</label>
                    <select id="rma-item-${escapeHtml(order.id)}" name="sku" class="portal-select">
                      <option value="">All items in order</option>
                      ${(order.items || [])
                        .map(
                          (it) =>
                            `<option value="${escapeHtml(it.sku)}">${escapeHtml(it.productName)} (${escapeHtml(it.variantLabel)} · max ${escapeHtml(it.quantity)})</option>`
                        )
                        .join('')}
                    </select>
                  </div>
                </div>
                <div class="portal-grid-2">
                  <div class="portal-field">
                    <label for="rma-qty-${escapeHtml(order.id)}" class="portal-label">Affected pack quantity</label>
                    <input
                      type="number"
                      id="rma-qty-${escapeHtml(order.id)}"
                      name="quantity"
                      class="portal-input"
                      min="1"
                      max="10"
                      step="1"
                      value="1"
                      aria-describedby="rma-qty-error-${escapeHtml(order.id)}"
                    />
                    <p class="portal-field-error" id="rma-qty-error-${escapeHtml(order.id)}" hidden></p>
                  </div>
                  <div class="portal-field">
                    <label for="rma-notes-${escapeHtml(order.id)}" class="portal-label">Details (optional)</label>
                    <input type="text" id="rma-notes-${escapeHtml(order.id)}" name="notes" class="portal-input" placeholder="e.g., 2 dented cans in top layer" />
                  </div>
                </div>
                <div class="portal-btn-row">
                  <button type="submit" class="portal-btn portal-btn--primary portal-btn--sm">Submit Return Request</button>
                  <button type="button" class="portal-btn portal-btn--sm" data-toggle-rma="${escapeHtml(order.id)}">Cancel</button>
                </div>
              </form>
            `
            : ''
        }
      </article>
    `;
  }

  function renderAccountOrdersTab() {
    if (!state.ordersLoaded) {
      return '<p class="portal-muted">Loading your order history…</p>';
    }
    if (state.orders.length === 0) {
      return `
        <div class="portal-empty">
          <p class="portal-empty-title">No orders placed yet</p>
          <p class="portal-muted">Add chilled botanical packs from the collection to place your first order.</p>
          <a href="#flavors" class="portal-btn portal-btn--primary portal-btn--sm" id="acct-empty-browse">Browse Flavors</a>
        </div>
      `;
    }
    return `
      <div class="portal-card-head">
        <h3 class="portal-section-title">Orders &amp; Invoices (${escapeHtml(state.orders.length)})</h3>
        <button type="button" class="portal-btn portal-btn--sm" id="acct-refresh-orders">Refresh</button>
      </div>
      ${state.orders.map(renderOrderCard).join('')}
    `;
  }

  function renderAccountAddressesTab(user) {
    const listHtml =
      state.addresses.length === 0
        ? `<div class="portal-empty"><p class="portal-empty-title">No saved delivery addresses</p><p class="portal-muted">Save an address below to autofill checkout.</p></div>`
        : state.addresses
            .map((addr) => {
              const confirmDel =
                state.pendingConfirm?.scope === 'delete-address' && state.pendingConfirm.key === String(addr.id);
              return `
                <article class="portal-card">
                  <div class="portal-card-head">
                    <div>
                      <h4 class="portal-card-title">${escapeHtml(addr.label)} ${addr.isDefault ? renderBadge('Default', 'success') : ''}</h4>
                      <p class="portal-card-sub">
                        ${escapeHtml(addr.recipientName)}<br />
                        ${escapeHtml(addr.line1)}${addr.line2 ? `, ${escapeHtml(addr.line2)}` : ''}<br />
                        ${escapeHtml(addr.city)}${addr.state ? `, ${escapeHtml(addr.state)}` : ''} ${escapeHtml(addr.postal)} · ${escapeHtml(addr.country)}
                      </p>
                    </div>
                    <button
                      type="button"
                      class="portal-btn portal-btn--danger-outline portal-btn--sm"
                      data-ask-delete-address="${escapeHtml(addr.id)}"
                    >Delete Address</button>
                  </div>
                  ${
                    confirmDel
                      ? `
                        <div class="portal-confirm-box" role="region" aria-label="Confirm address removal">
                          <p class="portal-confirm-text">Delete saved address "${escapeHtml(addr.label)}"?</p>
                          <div class="portal-btn-row">
                            <button type="button" class="portal-btn portal-btn--danger portal-btn--sm" data-confirm-delete-address="${escapeHtml(addr.id)}">Confirm Delete Address</button>
                            <button type="button" class="portal-btn portal-btn--sm" data-abort-confirm>Keep Address</button>
                          </div>
                        </div>
                      `
                      : ''
                  }
                </article>
              `;
            })
            .join('');

    return `
      <div class="portal-card-head">
        <h3 class="portal-section-title">Saved Delivery Addresses</h3>
        <button type="button" class="portal-btn portal-btn--sm" id="acct-refresh-addresses">Refresh</button>
      </div>
      ${state.addressesLoaded ? listHtml : '<p class="portal-muted">Loading addresses…</p>'}

      <form class="portal-card portal-form" id="portal-address-form" novalidate>
        <h4 class="portal-card-title">Add Delivery Address</h4>
        <p class="portal-hint">* Required fields</p>
        <div class="portal-grid-2">
          <div class="portal-field">
            <label for="addr-label" class="portal-label">Label</label>
            <input type="text" id="addr-label" name="label" class="portal-input" value="Home" placeholder="Home or Studio" />
          </div>
          <div class="portal-field">
            <label for="addr-recipient" class="portal-label">Recipient name <span aria-hidden="true">*</span></label>
            <input
              type="text"
              id="addr-recipient"
              name="recipientName"
              class="portal-input"
              value="${escapeHtml(user.name)}"
              autocomplete="shipping name"
              required
              aria-describedby="addr-recipient-error"
            />
            <p class="portal-field-error" id="addr-recipient-error" hidden></p>
          </div>
        </div>
        <div class="portal-field">
          <label for="addr-line1" class="portal-label">Street address <span aria-hidden="true">*</span></label>
          <input
            type="text"
            id="addr-line1"
            name="line1"
            class="portal-input"
            placeholder="742 Valencia St"
            autocomplete="shipping address-line1"
            required
            aria-describedby="addr-line1-error"
          />
          <p class="portal-field-error" id="addr-line1-error" hidden></p>
        </div>
        <div class="portal-grid-3">
          <div class="portal-field">
            <label for="addr-city" class="portal-label">City <span aria-hidden="true">*</span></label>
            <input
              type="text"
              id="addr-city"
              name="city"
              class="portal-input"
              placeholder="San Francisco"
              autocomplete="shipping address-level2"
              required
              aria-describedby="addr-city-error"
            />
            <p class="portal-field-error" id="addr-city-error" hidden></p>
          </div>
          <div class="portal-field">
            <label for="addr-state" class="portal-label">State</label>
            <input type="text" id="addr-state" name="state" class="portal-input" placeholder="CA" autocomplete="shipping address-level1" />
          </div>
          <div class="portal-field">
            <label for="addr-postal" class="portal-label">Postal code <span aria-hidden="true">*</span></label>
            <input
              type="text"
              id="addr-postal"
              name="postal"
              class="portal-input"
              placeholder="94110"
              autocomplete="shipping postal-code"
              required
              aria-describedby="addr-postal-error"
            />
            <p class="portal-field-error" id="addr-postal-error" hidden></p>
          </div>
        </div>
        <label class="portal-check-label">
          <input type="checkbox" id="addr-default" name="isDefault" checked />
          <span>Set as default delivery address</span>
        </label>
        <button type="submit" class="portal-btn portal-btn--primary">Save Address</button>
      </form>
    `;
  }

  function getSubBuilderVariants() {
    const app = getApp();
    const catalog = app && typeof app.getCatalog === 'function' ? app.getCatalog() : [];
    const products = catalog.length > 0 ? catalog : state.opsProducts;
    const variants = [];
    for (const p of products) {
      if (p.active === false) continue;
      for (const v of p.variants || []) {
        if (v.active === false) continue;
        variants.push({
          variantId: Number(v.id),
          sku: String(v.sku),
          productName: String(p.name),
          label: String(v.label),
          priceCents: Number(v.priceCents)
        });
      }
    }
    return variants;
  }

  function renderSubscriptionCard(sub) {
    const isCancelled = sub.status === 'cancelled';
    const isPaused = sub.status === 'paused';
    const isConfirmCancel =
      state.pendingConfirm?.scope === 'cancel-sub' && state.pendingConfirm.key === sub.id;
    const isEditing = state.editingSubId === sub.id;
    const variants = getSubBuilderVariants();

    return `
      <article class="portal-card">
        <div class="portal-card-head">
          <div>
            <h4 class="portal-card-title portal-mono">${escapeHtml(sub.id)}</h4>
            <p class="portal-card-sub">
              Cadence: <strong>${escapeHtml(sub.cadence)}</strong> · Next box: <strong>${escapeHtml(formatDate(sub.nextRunAt))}</strong>
              ${sub.skipCount > 0 ? ` · Skipped ${escapeHtml(pluralize(sub.skipCount, 'time'))}` : ''}
            </p>
          </div>
          <div class="portal-badges">
            ${renderBadge(formatStatusLabel(sub.status), getStatusTone(sub.status))}
            <span class="portal-badge portal-badge--neutral portal-num">${escapeHtml(formatCents(sub.estimatedSubtotalCents))}/box</span>
          </div>
        </div>

        <ul class="portal-item-list">
          ${(sub.items || [])
            .map(
              (item) => `
                <li class="portal-item-row">
                  <span><strong>${escapeHtml(item.productName)}</strong> (${escapeHtml(item.label)}) × ${escapeHtml(item.quantity)}</span>
                  <strong class="portal-num">${escapeHtml(formatCents(item.lineTotalCents))}</strong>
                </li>
              `
            )
            .join('')}
        </ul>

        ${
          !isCancelled
            ? `
              <div class="portal-btn-row">
                ${
                  isPaused
                    ? `<button type="button" class="portal-btn portal-btn--primary portal-btn--sm" data-sub-action="resume" data-sub-id="${escapeHtml(sub.id)}">Resume Subscription</button>`
                    : `<button type="button" class="portal-btn portal-btn--sm" data-sub-action="pause" data-sub-id="${escapeHtml(sub.id)}">Pause Subscription</button>`
                }
                <button type="button" class="portal-btn portal-btn--sm" data-sub-action="skip" data-sub-id="${escapeHtml(sub.id)}">Skip Next Box</button>
                <button type="button" class="portal-btn portal-btn--sm" data-toggle-sub-edit="${escapeHtml(sub.id)}" aria-expanded="${isEditing ? 'true' : 'false'}">
                  ${isEditing ? 'Close Editor' : 'Swap Flavors / Cadence'}
                </button>
                <button type="button" class="portal-btn portal-btn--danger-outline portal-btn--sm" data-ask-cancel-sub="${escapeHtml(sub.id)}">Cancel Subscription</button>
              </div>
            `
            : ''
        }

        ${
          isConfirmCancel
            ? `
              <div class="portal-confirm-box" role="region" aria-label="Confirm subscription cancellation">
                <p class="portal-confirm-text">Cancel Build-a-Box subscription <span class="portal-mono">${escapeHtml(sub.id)}</span>? Future scheduled cold-chain boxes will stop.</p>
                <div class="portal-btn-row">
                  <button type="button" class="portal-btn portal-btn--danger portal-btn--sm" data-confirm-cancel-sub="${escapeHtml(sub.id)}">Confirm Cancel Subscription</button>
                  <button type="button" class="portal-btn portal-btn--sm" data-abort-confirm>Keep Subscription</button>
                </div>
              </div>
            `
            : ''
        }

        ${
          isEditing
            ? `
              <form class="portal-card portal-card--subtle portal-form" data-sub-swap-form="${escapeHtml(sub.id)}" novalidate>
                <h5 class="portal-card-title">Update Cadence or Flavors</h5>
                <div class="portal-field">
                  <label for="sub-swap-cadence-${escapeHtml(sub.id)}" class="portal-label">Delivery cadence</label>
                  <select id="sub-swap-cadence-${escapeHtml(sub.id)}" name="cadence" class="portal-select">
                    <option value="2-week" ${sub.cadence === '2-week' || sub.cadence === 'biweekly' ? 'selected' : ''}>Every 2 weeks (Biweekly)</option>
                    <option value="4-week" ${sub.cadence === '4-week' || sub.cadence === 'monthly' ? 'selected' : ''}>Every 4 weeks (Monthly)</option>
                  </select>
                </div>
                ${variants
                  .filter((v) => v.label === '12-Pack' || state.subSwapDraft.get(v.variantId) > 0)
                  .map((v) => {
                    const qty = state.subSwapDraft.get(v.variantId) ?? 0;
                    return `
                      <div class="portal-box-row">
                        <div class="portal-item-main">
                          <strong>${escapeHtml(v.productName)}</strong> · ${escapeHtml(v.label)}
                          <span class="portal-card-sub portal-num">${escapeHtml(formatCents(v.priceCents))}</span>
                        </div>
                        <div class="portal-qty-group">
                          <button type="button" class="portal-qty-btn" data-swap-qty-delta="-1" data-variant-id="${escapeHtml(v.variantId)}" aria-label="Decrease ${escapeHtml(v.productName)} ${escapeHtml(v.label)} quantity">−</button>
                          <span class="portal-qty-val">${escapeHtml(qty)}</span>
                          <button type="button" class="portal-qty-btn" data-swap-qty-delta="1" data-variant-id="${escapeHtml(v.variantId)}" aria-label="Increase ${escapeHtml(v.productName)} ${escapeHtml(v.label)} quantity">+</button>
                        </div>
                      </div>
                    `;
                  })
                  .join('')}
                <div class="portal-btn-row">
                  <button type="submit" class="portal-btn portal-btn--primary portal-btn--sm">Save Box Changes</button>
                </div>
              </form>
            `
            : ''
        }
      </article>
    `;
  }

  function renderAccountSubscriptionsTab() {
    const variants = getSubBuilderVariants();
    // Default pick 12-Packs in builder for clean selection (plus Variety 12-Pack)
    const builderVariants = variants.filter((v) => v.label === '12-Pack');
    let draftSubtotal = 0;
    let draftCount = 0;
    for (const v of builderVariants) {
      const q = state.subBoxDraft.get(v.variantId) ?? 0;
      draftSubtotal += q * v.priceCents;
      draftCount += q;
    }

    const listHtml =
      state.subscriptions.length === 0
        ? `<div class="portal-empty"><p class="portal-empty-title">No recurring boxes yet</p><p class="portal-muted">Build your chilled 2-week or 4-week botanical box below.</p></div>`
        : state.subscriptions.map(renderSubscriptionCard).join('');

    return `
      <div class="portal-card-head">
        <h3 class="portal-section-title">Build-a-Box Subscriptions</h3>
        <button type="button" class="portal-btn portal-btn--sm" id="acct-refresh-subs">Refresh</button>
      </div>
      ${state.subscriptionsLoaded ? listHtml : '<p class="portal-muted">Loading subscriptions…</p>'}

      <form class="portal-card portal-form" id="portal-sub-create-form" novalidate>
        <h4 class="portal-card-title">Create New Recurring Box</h4>
        <div class="portal-field">
          <label for="sub-create-cadence" class="portal-label">Delivery cadence</label>
          <select id="sub-create-cadence" name="cadence" class="portal-select">
            <option value="2-week">Every 2 weeks (Biweekly)</option>
            <option value="4-week" selected>Every 4 weeks (Monthly)</option>
          </select>
        </div>

        <div class="portal-item-list">
          ${
            builderVariants.length === 0
              ? '<p class="portal-muted">Loading flavor packs…</p>'
              : builderVariants
                  .map((v) => {
                    const qty = state.subBoxDraft.get(v.variantId) ?? 0;
                    return `
                      <div class="portal-box-row">
                        <div class="portal-item-main">
                          <strong>${escapeHtml(v.productName)}</strong> · ${escapeHtml(v.label)}
                          <div class="portal-card-sub portal-num">${escapeHtml(formatCents(v.priceCents))} · ${escapeHtml(v.sku)}</div>
                        </div>
                        <div class="portal-qty-group">
                          <button type="button" class="portal-qty-btn" data-sub-draft-delta="-1" data-variant-id="${escapeHtml(v.variantId)}" aria-label="Decrease ${escapeHtml(v.productName)} 12-Pack quantity">−</button>
                          <span class="portal-qty-val">${escapeHtml(qty)}</span>
                          <button type="button" class="portal-qty-btn" data-sub-draft-delta="1" data-variant-id="${escapeHtml(v.variantId)}" aria-label="Increase ${escapeHtml(v.productName)} 12-Pack quantity">+</button>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>

        <div class="portal-summary-lines">
          <div class="portal-summary-row">
            <span>Selected packs (${escapeHtml(pluralize(draftCount, 'pack'))})</span>
            <strong class="portal-num">${escapeHtml(formatCents(draftSubtotal))}</strong>
          </div>
          <p class="portal-hint">
            ${draftSubtotal >= 3500 ? 'Qualifies for free cold-chain shipping ($35+ threshold).' : `Add ${formatCents(Math.max(0, 3500 - draftSubtotal))} more for free cold-chain shipping ($6.00 otherwise).`}
          </p>
        </div>

        <button type="submit" class="portal-btn portal-btn--primary" id="portal-sub-create-btn">Create Subscription</button>
      </form>
    `;
  }

  function renderAccountPortal(explicitFocusSelector = null) {
    const auth = getAuthState();
    updateAccountHeaderChrome(auth);
    const captured = dom.accountContent.contains(document.activeElement)
      ? captureFocusTarget(dom.accountContent)
      : null;

    if (!auth.authenticated || !auth.user) {
      dom.accountContent.innerHTML = renderAuthView();
      wireAuthViewEvents();
      restorePortalFocus('account', captured, explicitFocusSelector);
      return;
    }

    const user = auth.user;
    const isStaff = isStaffRole(user.role);
    const tabs = [
      { id: 'orders', label: 'Orders & Invoices' },
      { id: 'addresses', label: 'Addresses' },
      { id: 'subscriptions', label: 'Subscriptions' }
    ];

    let panelHtml = '';
    if (state.accountTab === 'orders') panelHtml = renderAccountOrdersTab();
    else if (state.accountTab === 'addresses') panelHtml = renderAccountAddressesTab(user);
    else panelHtml = renderAccountSubscriptionsTab();

    dom.accountContent.innerHTML = `
      <div class="portal-user-banner">
        <div class="portal-user-meta">
          <p class="portal-user-name">${escapeHtml(user.name)} ${renderBadge(formatStatusLabel(user.role), 'neutral')}</p>
          <p class="portal-user-email">${escapeHtml(user.email)}</p>
        </div>
      </div>

      <div class="portal-tablist" role="tablist" aria-label="Customer account sections" id="acct-tablist">
        ${tabs
          .map((t) => {
            const active = state.accountTab === t.id;
            return `
              <button
                type="button"
                id="acct-tab-${t.id}"
                class="portal-tab"
                role="tab"
                aria-selected="${active ? 'true' : 'false'}"
                aria-controls="acct-panel-${t.id}"
                tabindex="${active ? '0' : '-1'}"
                data-acct-tab="${t.id}"
              >${escapeHtml(t.label)}</button>
            `;
          })
          .join('')}
      </div>

      <section
        id="acct-panel-${escapeHtml(state.accountTab)}"
        class="portal-tabpanel"
        role="tabpanel"
        aria-labelledby="acct-tab-${escapeHtml(state.accountTab)}"
      >
        ${panelHtml}
      </section>
    `;

    wireSignedInAccountEvents();
    restorePortalFocus('account', captured, explicitFocusSelector);
  }

  async function loadAccountTabData(tab) {
    const auth = getAuthState();
    if (!auth.authenticated) return;
    try {
      if (tab === 'orders') {
        const res = await portalFetch('/api/account/orders');
        state.orders = Array.isArray(res.orders) ? res.orders : [];
        state.ordersLoaded = true;
      } else if (tab === 'addresses') {
        const res = await portalFetch('/api/account/addresses');
        state.addresses = Array.isArray(res.addresses) ? res.addresses : [];
        state.addressesLoaded = true;
      } else if (tab === 'subscriptions') {
        const app = getApp();
        if (app && typeof app.getCatalog === 'function' && app.getCatalog().length === 0) {
          await app.refreshCatalog();
        }
        const res = await portalFetch('/api/account/subscriptions');
        state.subscriptions = Array.isArray(res.subscriptions) ? res.subscriptions : [];
        state.subscriptionsLoaded = true;
      }
      if (state.activePortal === 'account' && state.accountTab === tab) renderAccountPortal();
    } catch (err) {
      if (err.status === 401) {
        const app = getApp();
        if (app) await app.refreshAuth();
      }
      setLiveMessage('account', 'error', err.message || 'Unable to load account details. Refresh and try again.');
    }
  }

  function wireAuthViewEvents() {
    const tablist = dom.accountContent.querySelector('[role="tablist"]');
    const switchAuthTab = (tabBtn) => {
      const next = tabBtn.dataset.authTab === 'register' ? 'register' : 'login';
      state.authTab = next;
      setLiveMessage('account', 'info', '');
      renderAccountPortal(`#auth-tab-${CSS.escape(next)}`);
    };
    tablist?.querySelectorAll('[role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => switchAuthTab(btn));
    });
    wireRovingTablist(tablist, switchAuthTab);

    const loginForm = document.getElementById('portal-login-form');
    loginForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailEl = document.getElementById('login-email');
      const passEl = document.getElementById('login-password');
      const emailErr = document.getElementById('login-email-error');
      const passErr = document.getElementById('login-password-error');
      const submitBtn = document.getElementById('portal-login-submit');
      if (isBusy(submitBtn)) return;

      const email = emailEl.value.trim();
      const password = passEl.value;
      let firstInvalid = null;

      if (!isValidEmail(email)) {
        setFieldError(emailEl, emailErr, 'Enter a valid email address (for example, name@example.com).');
        firstInvalid = emailEl;
      } else {
        setFieldError(emailEl, emailErr, '');
      }

      if (!password) {
        setFieldError(passEl, passErr, 'Enter your account password.');
        if (!firstInvalid) firstInvalid = passEl;
      } else {
        setFieldError(passEl, passErr, '');
      }

      if (firstInvalid) {
        firstInvalid.focus();
        setLiveMessage('account', 'error', 'Check the highlighted login fields and submit again.');
        return;
      }

      setButtonBusy(submitBtn, true, 'Signing in…');
      try {
        await performLogin(email, password);
      } catch (err) {
        setButtonBusy(submitBtn, false);
        setLiveMessage('account', 'error', err.message || 'Unable to sign in. Check your credentials and try again.');
      }
    });

    const regForm = document.getElementById('portal-register-form');
    regForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameEl = document.getElementById('reg-name');
      const emailEl = document.getElementById('reg-email');
      const passEl = document.getElementById('reg-password');
      const nameErr = document.getElementById('reg-name-error');
      const emailErr = document.getElementById('reg-email-error');
      const passErr = document.getElementById('reg-password-error');
      const submitBtn = document.getElementById('portal-register-submit');
      if (isBusy(submitBtn)) return;

      const name = nameEl.value.trim();
      const email = emailEl.value.trim();
      const password = passEl.value;
      let firstInvalid = null;

      if (!name) {
        setFieldError(nameEl, nameErr, 'Enter your full name.');
        firstInvalid = nameEl;
      } else {
        setFieldError(nameEl, nameErr, '');
      }

      if (!isValidEmail(email)) {
        setFieldError(emailEl, emailErr, 'Enter a valid email address (for example, name@example.com).');
        if (!firstInvalid) firstInvalid = emailEl;
      } else {
        setFieldError(emailEl, emailErr, '');
      }

      if (password.length < 8) {
        setFieldError(passEl, passErr, 'Choose a password with at least 8 characters.');
        if (!firstInvalid) firstInvalid = passEl;
      } else {
        setFieldError(passEl, passErr, '');
      }

      if (firstInvalid) {
        firstInvalid.focus();
        setLiveMessage('account', 'error', 'Fix the highlighted registration fields and submit again.');
        return;
      }

      setButtonBusy(submitBtn, true, 'Creating account…');
      try {
        const res = await portalFetch('/api/auth/register', {
          method: 'POST',
          body: { name, email, password }
        });
        await finalizeSignIn(res);
      } catch (err) {
        setButtonBusy(submitBtn, false);
        setLiveMessage('account', 'error', err.message || 'Unable to create account. Try another email or try again.');
      }
    });

    dom.accountContent.querySelectorAll('[data-demo-email]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const demoEmail = btn.dataset.demoEmail;
        if (!demoEmail) return;
        if (state.authTab !== 'login') {
          state.authTab = 'login';
          renderAccountPortal();
        }
        const emailEl = document.getElementById('login-email');
        const passEl = document.getElementById('login-password');
        if (emailEl) emailEl.value = demoEmail;
        if (passEl) passEl.value = 'SolisDemo2026!';
        setButtonBusy(btn, true);
        setLiveMessage('account', 'info', `Signing in as ${demoEmail}…`);
        try {
          await performLogin(demoEmail, 'SolisDemo2026!');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('account', 'error', err.message || 'Demo sign-in failed. Try again.');
        }
      });
    });
  }

  async function performLogin(email, password) {
    const res = await portalFetch('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    await finalizeSignIn(res);
  }

  async function finalizeSignIn(authRes) {
    const app = getApp();
    if (app && typeof app.setAuth === 'function') {
      app.setAuth({
        authenticated: true,
        user: authRes.user,
        csrfToken: authRes.csrfToken
      });
    }
    if (app && typeof app.refreshCart === 'function') {
      await app.refreshCart();
    }
    state.ordersLoaded = false;
    state.addressesLoaded = false;
    state.subscriptionsLoaded = false;
    state.accountTab = 'orders';

    const roleLabel = formatStatusLabel(authRes.user?.role || 'customer');
    setLiveMessage('account', 'success', `Signed in as ${authRes.user?.name || 'Member'} (${roleLabel}).`);
    renderAccountPortal();
    await loadAccountTabData('orders');
    dom.accountTitle?.focus();
  }

  function wireSignedInAccountEvents() {
    const tablist = document.getElementById('acct-tablist');
    const selectAccountTab = async (tabBtn) => {
      const next = tabBtn.dataset.acctTab;
      if (!next) return;
      state.accountTab = next;
      state.pendingConfirm = null;
      setLiveMessage('account', 'info', '');
      renderAccountPortal(`#acct-tab-${CSS.escape(next)}`);
      await loadAccountTabData(next);
    };
    tablist?.querySelectorAll('[role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => selectAccountTab(btn));
    });
    wireRovingTablist(tablist, selectAccountTab);

    document.getElementById('acct-empty-browse')?.addEventListener('click', () => {
      closePortals({ restoreFocus: false });
    });

    document.getElementById('acct-refresh-orders')?.addEventListener('click', () => loadAccountTabData('orders'));
    document.getElementById('acct-refresh-addresses')?.addEventListener('click', () => loadAccountTabData('addresses'));
    document.getElementById('acct-refresh-subs')?.addEventListener('click', () => loadAccountTabData('subscriptions'));

    // Receipt toggles
    dom.accountContent.querySelectorAll('[data-toggle-receipt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.toggleReceipt;
        if (state.expandedReceipts.has(id)) state.expandedReceipts.delete(id);
        else state.expandedReceipts.add(id);
        renderAccountPortal();
        dom.accountContent.querySelector(`[data-toggle-receipt="${CSS.escape(id)}"]`)?.focus();
      });
    });

    // Order cancel flow
    dom.accountContent.querySelectorAll('[data-ask-cancel-order]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingConfirm = { scope: 'cancel-order', key: btn.dataset.askCancelOrder };
        renderAccountPortal('[data-confirm-cancel-order]');
      });
    });

    dom.accountContent.querySelectorAll('[data-confirm-cancel-order]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const orderId = btn.dataset.confirmCancelOrder;
        setButtonBusy(btn, true, 'Cancelling…');
        try {
          await portalFetch(`/api/account/orders/${encodeURIComponent(orderId)}/cancel`, {
            method: 'POST',
            body: { reason: 'Customer requested cancellation' }
          });
          state.pendingConfirm = null;
          const app = getApp();
          if (app && typeof app.refreshCatalog === 'function') await app.refreshCatalog();
          setLiveMessage('account', 'success', `Order ${orderId} cancelled. Stock restored and refund recorded in Outbox.`);
          await loadAccountTabData('orders');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('account', 'error', err.message || 'Unable to cancel order.');
        }
      });
    });

    // RMA toggle + submit
    dom.accountContent.querySelectorAll('[data-toggle-rma]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.toggleRma;
        state.openRmaOrderId = state.openRmaOrderId === id ? null : id;
        renderAccountPortal();
      });
    });

    dom.accountContent.querySelectorAll('[data-rma-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const orderId = form.dataset.rmaForm;
        const submitBtn = form.querySelector('button[type="submit"]');
        if (isBusy(submitBtn)) return;

        const reason = form.elements.reason.value;
        const sku = form.elements.sku.value;
        const qtyEl = form.elements.quantity;
        const qtyErr = document.getElementById(`rma-qty-error-${orderId}`);
        const qtyVal = parseStrictIntegerInput(qtyEl.value);
        const notes = form.elements.notes.value.trim();

        const payload = { reason, notes };
        if (sku) {
          const order = state.orders.find((o) => o.id === orderId);
          const matchedItem = order?.items?.find((i) => i.sku === sku);
          const maxQty = matchedItem ? matchedItem.quantity : 10;
          if (!qtyVal || qtyVal < 1 || qtyVal > maxQty) {
            setFieldError(qtyEl, qtyErr, `Enter a quantity between 1 and ${maxQty} for ${sku}.`);
            qtyEl.focus();
            setLiveMessage('account', 'error', `Enter a quantity between 1 and ${maxQty} for ${sku}.`);
            return;
          }
          setFieldError(qtyEl, qtyErr, '');
          payload.items = [{ sku, quantity: qtyVal }];
        } else {
          setFieldError(qtyEl, qtyErr, '');
        }

        setButtonBusy(submitBtn, true, 'Submitting…');
        try {
          const res = await portalFetch(`/api/account/orders/${encodeURIComponent(orderId)}/return`, {
            method: 'POST',
            body: payload
          });
          state.openRmaOrderId = null;
          state.expandedReceipts.add(orderId);
          setLiveMessage('account', 'success', `Return request ${res.rma?.id || ''} logged for order ${orderId}.`);
          await loadAccountTabData('orders');
        } catch (err) {
          setButtonBusy(submitBtn, false);
          setLiveMessage('account', 'error', err.message || 'Unable to submit return request.');
        }
      });
    });

    // Address delete + create
    dom.accountContent.querySelectorAll('[data-ask-delete-address]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingConfirm = { scope: 'delete-address', key: btn.dataset.askDeleteAddress };
        renderAccountPortal('[data-confirm-delete-address]');
      });
    });

    dom.accountContent.querySelectorAll('[data-confirm-delete-address]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const id = btn.dataset.confirmDeleteAddress;
        setButtonBusy(btn, true, 'Deleting…');
        try {
          await portalFetch(`/api/account/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
          state.pendingConfirm = null;
          const app = getApp();
          if (app && typeof app.refreshAddresses === 'function') await app.refreshAddresses();
          setLiveMessage('account', 'success', 'Saved address deleted.');
          await loadAccountTabData('addresses');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('account', 'error', err.message || 'Unable to delete address.');
        }
      });
    });

    const addrForm = document.getElementById('portal-address-form');
    addrForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const recEl = document.getElementById('addr-recipient');
      const line1El = document.getElementById('addr-line1');
      const cityEl = document.getElementById('addr-city');
      const postalEl = document.getElementById('addr-postal');
      const recErr = document.getElementById('addr-recipient-error');
      const line1Err = document.getElementById('addr-line1-error');
      const cityErr = document.getElementById('addr-city-error');
      const postalErr = document.getElementById('addr-postal-error');
      const submitBtn = addrForm.querySelector('button[type="submit"]');
      if (isBusy(submitBtn)) return;

      let firstInvalid = null;
      const checks = [
        [recEl, recErr, recEl.value.trim().length > 0, 'Enter the recipient name.'],
        [line1El, line1Err, line1El.value.trim().length >= 2, 'Enter a street address.'],
        [cityEl, cityErr, cityEl.value.trim().length > 0, 'Enter a city.'],
        [postalEl, postalErr, postalEl.value.trim().length >= 2, 'Enter a postal code.']
      ];
      for (const [inputEl, errEl, ok, msg] of checks) {
        if (!ok) {
          setFieldError(inputEl, errEl, msg);
          if (!firstInvalid) firstInvalid = inputEl;
        } else {
          setFieldError(inputEl, errEl, '');
        }
      }
      if (firstInvalid) {
        firstInvalid.focus();
        setLiveMessage('account', 'error', 'Complete the required address fields and submit again.');
        return;
      }

      setButtonBusy(submitBtn, true, 'Saving…');
      try {
        await portalFetch('/api/account/addresses', {
          method: 'POST',
          body: {
            label: document.getElementById('addr-label').value.trim() || 'Home',
            recipientName: recEl.value.trim(),
            line1: line1El.value.trim(),
            city: cityEl.value.trim(),
            state: document.getElementById('addr-state').value.trim(),
            postal: postalEl.value.trim(),
            isDefault: document.getElementById('addr-default').checked
          }
        });
        const app = getApp();
        if (app && typeof app.refreshAddresses === 'function') await app.refreshAddresses();
        setLiveMessage('account', 'success', 'Delivery address saved to your account.');
        await loadAccountTabData('addresses');
      } catch (err) {
        setButtonBusy(submitBtn, false);
        setLiveMessage('account', 'error', err.message || 'Unable to save address.');
      }
    });

    // Subscriptions builder & controls
    dom.accountContent.querySelectorAll('[data-sub-draft-delta]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const vid = Number(btn.dataset.variantId);
        const delta = Number(btn.dataset.subDraftDelta);
        const curr = state.subBoxDraft.get(vid) ?? 0;
        const next = Math.min(10, Math.max(0, curr + delta));
        if (next === 0) state.subBoxDraft.delete(vid);
        else state.subBoxDraft.set(vid, next);
        renderAccountPortal();
        const selector = `[data-sub-draft-delta="${delta}"][data-variant-id="${vid}"]`;
        dom.accountContent.querySelector(selector)?.focus();
      });
    });

    document.getElementById('portal-sub-create-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('portal-sub-create-btn');
      if (isBusy(btn)) return;

      const items = [];
      for (const [variantId, quantity] of state.subBoxDraft.entries()) {
        if (quantity > 0) items.push({ variantId, quantity });
      }
      if (items.length === 0) {
        setLiveMessage('account', 'error', 'Select at least one 12-Pack for your Build-a-Box subscription.');
        return;
      }
      const cadence = document.getElementById('sub-create-cadence').value;

      setButtonBusy(btn, true, 'Creating…');
      try {
        const res = await portalFetch('/api/account/subscriptions', {
          method: 'POST',
          body: { cadence, items }
        });
        state.subBoxDraft.clear();
        setLiveMessage('account', 'success', `Subscription ${res.subscription?.id || ''} activated.`);
        await loadAccountTabData('subscriptions');
      } catch (err) {
        setButtonBusy(btn, false);
        setLiveMessage('account', 'error', err.message || 'Unable to create subscription.');
      }
    });

    dom.accountContent.querySelectorAll('[data-sub-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const subId = btn.dataset.subId;
        const action = btn.dataset.subAction;
        setButtonBusy(btn, true, 'Updating…');
        try {
          await portalFetch(`/api/account/subscriptions/${encodeURIComponent(subId)}`, {
            method: 'PATCH',
            body: { action }
          });
          setLiveMessage('account', 'success', `Subscription ${subId} updated (${action}).`);
          await loadAccountTabData('subscriptions');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('account', 'error', err.message || 'Unable to update subscription.');
        }
      });
    });

    dom.accountContent.querySelectorAll('[data-ask-cancel-sub]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingConfirm = { scope: 'cancel-sub', key: btn.dataset.askCancelSub };
        renderAccountPortal('[data-confirm-cancel-sub]');
      });
    });

    dom.accountContent.querySelectorAll('[data-confirm-cancel-sub]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const subId = btn.dataset.confirmCancelSub;
        setButtonBusy(btn, true, 'Cancelling…');
        try {
          await portalFetch(`/api/account/subscriptions/${encodeURIComponent(subId)}`, {
            method: 'PATCH',
            body: { action: 'cancel' }
          });
          state.pendingConfirm = null;
          setLiveMessage('account', 'success', `Subscription ${subId} cancelled.`);
          await loadAccountTabData('subscriptions');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('account', 'error', err.message || 'Unable to cancel subscription.');
        }
      });
    });

    dom.accountContent.querySelectorAll('[data-toggle-sub-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const subId = btn.dataset.toggleSubEdit;
        if (state.editingSubId === subId) {
          state.editingSubId = null;
          state.subSwapDraft.clear();
        } else {
          state.editingSubId = subId;
          state.subSwapDraft.clear();
          const sub = state.subscriptions.find((s) => s.id === subId);
          for (const it of sub?.items || []) {
            state.subSwapDraft.set(Number(it.variantId), Number(it.quantity));
          }
        }
        renderAccountPortal();
      });
    });

    dom.accountContent.querySelectorAll('[data-swap-qty-delta]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const vid = Number(btn.dataset.variantId);
        const delta = Number(btn.dataset.swapQtyDelta);
        const curr = state.subSwapDraft.get(vid) ?? 0;
        const next = Math.min(10, Math.max(0, curr + delta));
        if (next === 0) state.subSwapDraft.delete(vid);
        else state.subSwapDraft.set(vid, next);
        renderAccountPortal();
        const selector = `[data-swap-qty-delta="${delta}"][data-variant-id="${vid}"]`;
        dom.accountContent.querySelector(selector)?.focus();
      });
    });

    dom.accountContent.querySelectorAll('[data-sub-swap-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const subId = form.dataset.subSwapForm;
        const btn = form.querySelector('button[type="submit"]');
        if (isBusy(btn)) return;
        const items = [];
        for (const [variantId, quantity] of state.subSwapDraft.entries()) {
          if (quantity > 0) items.push({ variantId, quantity });
        }
        if (items.length === 0) {
          setLiveMessage('account', 'error', 'Keep at least one pack in your subscription box.');
          return;
        }
        const cadence = form.elements.cadence.value;
        setButtonBusy(btn, true, 'Saving…');
        try {
          await portalFetch(`/api/account/subscriptions/${encodeURIComponent(subId)}`, {
            method: 'PATCH',
            body: { action: 'swap', cadence, items }
          });
          state.editingSubId = null;
          state.subSwapDraft.clear();
          setLiveMessage('account', 'success', `Subscription ${subId} updated.`);
          await loadAccountTabData('subscriptions');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('account', 'error', err.message || 'Unable to save subscription changes.');
        }
      });
    });

    dom.accountContent.querySelectorAll('[data-abort-confirm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const abortFallback = getConfirmCancelFallbackSelector(state.pendingConfirm);
        state.pendingConfirm = null;
        renderAccountPortal(abortFallback);
      });
    });
  }

  /* ========================================================================
     7. Staff Operations Portal (Warehouse, Admin/Merchandiser, CSR, Finance)
     ======================================================================== */
  function renderWarehouseTab() {
    const physicalVariants = [];
    for (const p of state.opsProducts) {
      for (const v of p.variants || []) {
        if (!v.isBundle) {
          physicalVariants.push({ ...v, productName: p.name });
        }
      }
    }

    const filterStatus = state.opsOrderStatusFilter;
    const visibleOrders = state.opsOrders.filter((o) =>
      filterStatus === 'all' ? true : o.orderStatus === filterStatus
    );

    const queueHtml =
      visibleOrders.length === 0
        ? `<div class="portal-empty"><p class="portal-empty-title">No matching orders</p><p class="portal-muted">Try another status filter or refresh the queue.</p></div>`
        : visibleOrders
            .map((order) => {
              const isPacked = order.orderStatus === 'packed';
              const isShipOpen = state.openShipOrderId === order.id;
              const isConfirmed = order.orderStatus === 'confirmed';
              const isShipped = order.orderStatus === 'shipped';
              const isPending = order.orderStatus === 'pending_payment';
              const allowedNext = ORDER_TRANSITIONS[order.orderStatus] || [];

              return `
                <article class="portal-card">
                  <div class="portal-card-head">
                    <div>
                      <h4 class="portal-card-title portal-mono">${escapeHtml(order.id)}</h4>
                      <p class="portal-card-sub">
                        ${escapeHtml(order.customerName)} · ${escapeHtml(order.shippingCity)} ${escapeHtml(order.shippingPostal)} · ${escapeHtml(formatDate(order.createdAt, true))}
                      </p>
                    </div>
                    <div class="portal-badges">
                      ${renderBadge(`Order: ${formatStatusLabel(order.orderStatus)}`, getStatusTone(order.orderStatus))}
                      ${renderBadge(`Fulfill: ${formatStatusLabel(order.fulfillmentStatus)}`, getStatusTone(order.fulfillmentStatus))}
                      ${renderBadge(order.insulatedPackIncluded ? 'Insulated Cold Pack' : 'Standard Pack', 'neutral')}
                    </div>
                  </div>

                  <ul class="portal-item-list">
                    ${(order.items || [])
                      .map((it) => {
                        const lotTxt = it.lotNumber
                          ? `FEFO Lot ${escapeHtml(it.lotNumber)} (Exp ${escapeHtml(it.expiresAt)})`
                          : 'FEFO allocated';
                        return `
                          <li class="portal-item-row">
                            <div class="portal-item-main">
                              <strong>${escapeHtml(it.productName)}</strong> · ${escapeHtml(it.variantLabel)} (<span class="portal-mono">${escapeHtml(it.sku)}</span>) × ${escapeHtml(it.quantity)}
                              <div class="portal-card-sub portal-mono">${lotTxt}</div>
                            </div>
                            <strong class="portal-num">${escapeHtml(formatCents(it.lineTotalCents))}</strong>
                          </li>
                        `;
                      })
                      .join('')}
                  </ul>

                  <div class="portal-btn-row">
                    ${isPending ? `<button type="button" class="portal-btn portal-btn--primary portal-btn--sm" data-wh-status="${escapeHtml(order.id)}" data-next-status="confirmed">Confirm Payment</button>` : ''}
                    ${isConfirmed ? `<button type="button" class="portal-btn portal-btn--primary portal-btn--sm" data-wh-status="${escapeHtml(order.id)}" data-next-status="packed">Mark Packed</button>` : ''}
                    ${isPacked ? `<button type="button" class="portal-btn portal-btn--accent portal-btn--sm" data-wh-toggle-ship="${escapeHtml(order.id)}" aria-expanded="${isShipOpen ? 'true' : 'false'}">Ship Order &amp; Add Tracking</button>` : ''}
                    ${isShipped ? `<button type="button" class="portal-btn portal-btn--primary portal-btn--sm" data-wh-status="${escapeHtml(order.id)}" data-next-status="delivered">Mark Delivered</button>` : ''}
                    ${
                      allowedNext.includes('cancelled')
                        ? `<button type="button" class="portal-btn portal-btn--danger-outline portal-btn--sm" data-wh-ask-cancel="${escapeHtml(order.id)}">Cancel Order</button>`
                        : ''
                    }
                  </div>

                  ${
                    state.pendingConfirm?.scope === 'wh-cancel' && state.pendingConfirm.key === order.id
                      ? `
                        <div class="portal-confirm-box" role="region" aria-label="Confirm warehouse order cancellation">
                          <p class="portal-confirm-text">Cancel order <span class="portal-mono">${escapeHtml(order.id)}</span> and restore FEFO lots?</p>
                          <div class="portal-btn-row">
                            <button type="button" class="portal-btn portal-btn--danger portal-btn--sm" data-wh-confirm-cancel="${escapeHtml(order.id)}">Confirm Cancel Order</button>
                            <button type="button" class="portal-btn portal-btn--sm" data-ops-abort-confirm>Keep Order</button>
                          </div>
                        </div>
                      `
                      : ''
                  }

                  ${
                    isShipOpen
                      ? `
                        <form class="portal-card portal-card--subtle portal-form" data-wh-ship-form="${escapeHtml(order.id)}" novalidate>
                          <h5 class="portal-card-title">Dispatch Shipment — ${escapeHtml(order.id)}</h5>
                          <div class="portal-grid-2">
                            <div class="portal-field">
                              <label for="ship-carrier-${escapeHtml(order.id)}" class="portal-label">Carrier <span aria-hidden="true">*</span></label>
                              <input
                                type="text"
                                id="ship-carrier-${escapeHtml(order.id)}"
                                name="carrier"
                                class="portal-input"
                                value="SOLIS Cold Courier"
                                required
                                aria-describedby="ship-carrier-error-${escapeHtml(order.id)}"
                              />
                              <p class="portal-field-error" id="ship-carrier-error-${escapeHtml(order.id)}" hidden></p>
                            </div>
                            <div class="portal-field">
                              <label for="ship-tracking-${escapeHtml(order.id)}" class="portal-label">Tracking number <span aria-hidden="true">*</span></label>
                              <input
                                type="text"
                                id="ship-tracking-${escapeHtml(order.id)}"
                                name="trackingNumber"
                                class="portal-input"
                                placeholder="TRK-SOLIS-9001"
                                required
                                aria-describedby="ship-tracking-error-${escapeHtml(order.id)}"
                              />
                              <p class="portal-field-error" id="ship-tracking-error-${escapeHtml(order.id)}" hidden></p>
                            </div>
                          </div>
                          <label class="portal-check-label">
                            <input type="checkbox" name="coldChainPack" ${order.insulatedPackIncluded ? 'checked' : ''} />
                            <span>Include insulated cold-chain gel pack</span>
                          </label>
                          <div class="portal-btn-row">
                            <button type="submit" class="portal-btn portal-btn--primary portal-btn--sm">Confirm Shipment</button>
                            <button type="button" class="portal-btn portal-btn--sm" data-wh-toggle-ship="${escapeHtml(order.id)}">Cancel</button>
                          </div>
                        </form>
                      `
                      : ''
                  }
                </article>
              `;
            })
            .join('');

    return `
      <section class="portal-card" aria-labelledby="wh-queue-heading">
        <div class="portal-card-head">
          <div>
            <h3 class="portal-section-title" id="wh-queue-heading">Pick, Pack &amp; Ship Queue</h3>
            <p class="portal-card-sub">OMS transitions: confirmed → packed → shipped (with tracking) → delivered.</p>
          </div>
          <div class="portal-btn-row">
            <label for="wh-status-filter" class="sr-only">Filter orders by status</label>
            <select id="wh-status-filter" class="portal-select portal-select--compact">
              <option value="all" ${filterStatus === 'all' ? 'selected' : ''}>All statuses (${escapeHtml(state.opsOrders.length)})</option>
              <option value="confirmed" ${filterStatus === 'confirmed' ? 'selected' : ''}>To Pack (Confirmed)</option>
              <option value="packed" ${filterStatus === 'packed' ? 'selected' : ''}>Ready to Ship (Packed)</option>
              <option value="shipped" ${filterStatus === 'shipped' ? 'selected' : ''}>Shipped</option>
              <option value="delivered" ${filterStatus === 'delivered' ? 'selected' : ''}>Delivered</option>
            </select>
            <button type="button" class="portal-btn portal-btn--sm" id="wh-refresh-orders">Refresh</button>
          </div>
        </div>
        ${queueHtml}
      </section>

      <section class="portal-card" aria-labelledby="wh-adjust-heading">
        <h3 class="portal-section-title" id="wh-adjust-heading">FEFO Lot &amp; Inventory Adjustment</h3>
        ${
          physicalVariants.length === 0
            ? '<p class="portal-muted">Loading physical SKUs and FEFO lots…</p>'
            : `
              <form class="portal-form" id="wh-adjust-form" novalidate>
                <div class="portal-grid-2">
                  <div class="portal-field">
                    <label for="adj-variant" class="portal-label">Physical SKU <span aria-hidden="true">*</span></label>
                    <select id="adj-variant" name="variantId" class="portal-select">
                      ${physicalVariants
                        .map((v) => {
                          const shortFlavor = String(v.productName || '').replace(/\s*&.*$/, '').trim();
                          return `<option value="${escapeHtml(v.id)}">${escapeHtml(v.sku)} · ${escapeHtml(shortFlavor)} ${escapeHtml(v.label)} (${escapeHtml(v.available)} avail)</option>`;
                        })
                        .join('')}
                    </select>
                  </div>
                  <div class="portal-field">
                    <label for="adj-reason" class="portal-label">Reason code <span aria-hidden="true">*</span></label>
                    <select id="adj-reason" name="reason" class="portal-select">
                      ${INVENTORY_REASONS.map((r) => `<option value="${escapeHtml(r.value)}">${escapeHtml(r.label)}</option>`).join('')}
                    </select>
                  </div>
                </div>

                <div class="portal-grid-3">
                  <div class="portal-field">
                    <label for="adj-delta" class="portal-label">Delta units (non-zero) <span aria-hidden="true">*</span></label>
                    <input type="number" id="adj-delta" name="delta" class="portal-input" step="1" placeholder="e.g. 12 or -2" required aria-describedby="adj-delta-error" />
                    <p class="portal-field-error" id="adj-delta-error" hidden></p>
                  </div>
                  <div class="portal-field">
                    <label for="adj-lot" class="portal-label">Batch / Lot number</label>
                    <input type="text" id="adj-lot" name="lotNumber" class="portal-input" value="LOT-2026-C" placeholder="LOT-2026-C" />
                  </div>
                  <div class="portal-field">
                    <label for="adj-expiry" class="portal-label">Expiry date</label>
                    <input type="date" id="adj-expiry" name="expiresAt" class="portal-input" value="2027-12-31" />
                  </div>
                </div>

                <button type="submit" class="portal-btn portal-btn--primary" id="wh-adjust-submit">Apply Inventory Adjustment</button>
              </form>
            `
        }

        <h4 class="portal-card-title">Active SKU Lots (FEFO Order)</h4>
        <ul class="portal-item-list">
          ${physicalVariants
            .map((v) => {
              const lotsStr = (v.lots || [])
                .map((l) => `${l.lotNumber}: ${l.onHand} (Exp ${l.expiresAt})`)
                .join(' · ');
              return `
                <li class="portal-item-row">
                  <div class="portal-item-main">
                    <strong class="portal-mono">${escapeHtml(v.sku)}</strong> — ${escapeHtml(v.productName)} ${escapeHtml(v.label)}
                    <div class="portal-card-sub portal-mono">${lotsStr ? escapeHtml(lotsStr) : 'No active lots'}</div>
                  </div>
                  <strong class="portal-num">Avail ${escapeHtml(v.available)} / On hand ${escapeHtml(v.onHand)}</strong>
                </li>
              `;
            })
            .join('')}
        </ul>

        ${
          state.opsInventoryLedger.length > 0
            ? `
              <details class="portal-disclosure">
                <summary>Recent Inventory Ledger (${escapeHtml(state.opsInventoryLedger.length)} entries)</summary>
                <ul class="portal-item-list portal-item-list--spaced">
                  ${state.opsInventoryLedger
                    .slice(0, 15)
                    .map(
                      (entry) => `
                        <li class="portal-item-row">
                          <div class="portal-item-main">
                            <strong class="portal-mono">${escapeHtml(entry.sku)}</strong> (${escapeHtml(entry.reason)})
                            <div class="portal-card-sub portal-mono">
                              Lot ${escapeHtml(entry.lotNumber || '—')} · Exp ${escapeHtml(entry.expiresAt || '—')} · ${escapeHtml(formatDate(entry.createdAt, true))}
                            </div>
                          </div>
                          <strong class="portal-num">${entry.delta > 0 ? `+${entry.delta}` : escapeHtml(entry.delta)}</strong>
                        </li>
                      `
                    )
                    .join('')}
                </ul>
              </details>
            `
            : ''
        }
      </section>
    `;
  }

  function renderMerchandiserTab() {
    const subTabs = [
      { id: 'catalog', label: 'Catalog & SKUs' },
      { id: 'promos', label: 'Promo Codes' },
      { id: 'audit', label: 'Audit Logs' },
      { id: 'outbox', label: 'Notification Log' }
    ];

    let bodyHtml = '';
    if (state.merchSubTab === 'catalog') {
      bodyHtml = `
        <div class="portal-card-head">
          <h3 class="portal-section-title">SKU Pricing &amp; Active Catalog</h3>
          <button type="button" class="portal-btn portal-btn--sm" id="merch-refresh-catalog">Refresh</button>
        </div>
        ${state.opsProducts
          .map(
            (prod) => `
              <article class="portal-card">
                <div class="portal-card-head">
                  <div>
                    <h4 class="portal-card-title">${escapeHtml(prod.name)}</h4>
                    <p class="portal-card-sub">
                      ID <span class="portal-mono">${escapeHtml(prod.slug)}</span> · ${escapeHtml(prod.calories)} cal · ${escapeHtml(prod.tag)}
                    </p>
                  </div>
                  <div class="portal-btn-row">
                    ${renderBadge(prod.active ? 'Active' : 'Inactive', prod.active ? 'success' : 'danger')}
                    <button
                      type="button"
                      class="portal-btn portal-btn--sm"
                      data-toggle-product-active="${escapeHtml(prod.id)}"
                      data-next-active="${prod.active ? '0' : '1'}"
                    >${prod.active ? 'Deactivate Product' : 'Activate Product'}</button>
                  </div>
                </div>
                <div class="portal-item-list">
                  ${(prod.variants || [])
                    .map(
                      (v) => `
                        <form class="portal-item-row" data-variant-edit-form="${escapeHtml(prod.id)}" data-variant-id="${escapeHtml(v.id)}" novalidate>
                          <div class="portal-item-main">
                            <strong class="portal-mono">${escapeHtml(v.sku)}</strong> · ${escapeHtml(v.label)}
                            <div class="portal-card-sub portal-num">Available stock: ${escapeHtml(v.available)}</div>
                          </div>
                          <div class="portal-btn-row">
                            <label for="var-price-${escapeHtml(v.id)}" class="sr-only">Price in USD for ${escapeHtml(v.sku)}</label>
                            <input
                              type="text"
                              id="var-price-${escapeHtml(v.id)}"
                              name="priceUsd"
                              class="portal-input portal-input--price"
                              value="${escapeHtml((Number(v.priceCents) / 100).toFixed(2))}"
                              aria-label="Price in USD for ${escapeHtml(v.sku)}"
                              aria-describedby="var-price-error-${escapeHtml(v.id)}"
                            />
                            <label class="portal-check-label">
                              <input type="checkbox" name="active" ${v.active ? 'checked' : ''} />
                              <span>Active</span>
                            </label>
                            <button type="submit" class="portal-btn portal-btn--primary portal-btn--sm">Save SKU</button>
                          </div>
                          <p class="portal-field-error portal-row-error" id="var-price-error-${escapeHtml(v.id)}" hidden></p>
                        </form>
                      `
                    )
                    .join('')}
                </div>
              </article>
            `
          )
          .join('')}
      `;
    } else if (state.merchSubTab === 'promos') {
      bodyHtml = `
        <form class="portal-card portal-form" id="merch-promo-form" novalidate>
          <h3 class="portal-section-title">Create Promo Code</h3>
          <div class="portal-grid-3">
            <div class="portal-field">
              <label for="promo-code-input" class="portal-label">Code <span aria-hidden="true">*</span></label>
              <input type="text" id="promo-code-input" name="code" class="portal-input" placeholder="SUMMER15" required aria-describedby="promo-code-error" />
              <p class="portal-field-error" id="promo-code-error" hidden></p>
            </div>
            <div class="portal-field">
              <label for="promo-type-input" class="portal-label">Discount type</label>
              <select id="promo-type-input" name="type" class="portal-select">
                <option value="percent">Percent off (%)</option>
                <option value="fixed">Fixed USD off ($)</option>
                <option value="free_shipping">Free shipping</option>
              </select>
            </div>
            <div class="portal-field">
              <label for="promo-value-input" class="portal-label">Value (% or USD)</label>
              <input type="text" id="promo-value-input" name="value" class="portal-input" value="15" placeholder="15 or 5.00" aria-describedby="promo-value-error" />
              <p class="portal-field-error" id="promo-value-error" hidden></p>
            </div>
          </div>
          <div class="portal-grid-2">
            <div class="portal-field">
              <label for="promo-min-input" class="portal-label">Min subtotal (USD)</label>
              <input type="text" id="promo-min-input" name="minSubtotalUsd" class="portal-input" value="0.00" aria-describedby="promo-min-error" />
              <p class="portal-field-error" id="promo-min-error" hidden></p>
            </div>
            <div class="portal-field">
              <label for="promo-max-input" class="portal-label">Max uses (optional)</label>
              <input type="number" id="promo-max-input" name="maxUses" class="portal-input" min="1" step="1" placeholder="Unlimited" aria-describedby="promo-max-error" />
              <p class="portal-field-error" id="promo-max-error" hidden></p>
            </div>
          </div>
          <button type="submit" class="portal-btn portal-btn--primary">Create Promo Code</button>
        </form>

        <div class="portal-card">
          <div class="portal-card-head">
            <h4 class="portal-card-title">Existing Promotions</h4>
            <button type="button" class="portal-btn portal-btn--sm" id="merch-refresh-promos">Refresh</button>
          </div>
          <ul class="portal-item-list">
            ${state.opsPromotions
              .map((promo) => {
                const desc =
                  promo.type === 'percent'
                    ? `${promo.value}% off`
                    : promo.type === 'fixed'
                      ? `${formatCents(promo.value)} off`
                      : 'Free cold-chain shipping';
                return `
                  <li class="portal-item-row">
                    <div class="portal-item-main">
                      <strong class="portal-mono">${escapeHtml(promo.code)}</strong> — ${escapeHtml(desc)}
                      <div class="portal-card-sub portal-num">
                        Min ${escapeHtml(formatCents(promo.minSubtotalCents))} · Uses ${escapeHtml(promo.usesCount)}${promo.maxUses ? ` / ${escapeHtml(promo.maxUses)}` : ' (unlimited)'}
                      </div>
                    </div>
                    <div class="portal-btn-row">
                      ${renderBadge(promo.active ? 'Active' : 'Paused', promo.active ? 'success' : 'neutral')}
                      <button
                        type="button"
                        class="portal-btn portal-btn--sm"
                        data-toggle-promo="${escapeHtml(promo.id)}"
                        data-next-active="${promo.active ? '0' : '1'}"
                      >${promo.active ? 'Disable' : 'Enable'}</button>
                    </div>
                  </li>
                `;
              })
              .join('')}
          </ul>
        </div>
      `;
    } else if (state.merchSubTab === 'audit') {
      bodyHtml = `
        <div class="portal-card">
          <div class="portal-card-head">
            <h3 class="portal-section-title">System Audit Logs (${escapeHtml(state.opsAuditLogs.length)})</h3>
            <div class="portal-btn-row">
              <label for="audit-action-filter" class="sr-only">Filter by action</label>
              <input type="text" id="audit-action-filter" class="portal-input portal-input--compact" value="${escapeHtml(state.opsAuditActionFilter)}" placeholder="Filter action (e.g. order.create)" />
              <button type="button" class="portal-btn portal-btn--sm" id="merch-refresh-audit">Apply</button>
            </div>
          </div>
          ${
            state.opsAuditLogs.length === 0
              ? '<p class="portal-muted">No audit log entries match your filter.</p>'
              : state.opsAuditLogs
                  .map(
                    (log) => `
                      <div class="portal-item-row">
                        <div class="portal-item-main">
                          <strong class="portal-mono">${escapeHtml(log.action)}</strong> → ${escapeHtml(log.targetType)} <span class="portal-mono">${escapeHtml(log.targetId)}</span>
                          <div class="portal-card-sub">
                            Actor: ${escapeHtml(log.actorEmail || 'system')} (${escapeHtml(log.actorRole || 'anon')}) · ${escapeHtml(formatDate(log.createdAt, true))}
                          </div>
                          <details class="portal-disclosure portal-disclosure--nested">
                            <summary>Event details</summary>
                            <pre class="portal-pre">${escapeHtml(JSON.stringify(log.details || {}, null, 2))}</pre>
                          </details>
                        </div>
                      </div>
                    `
                  )
                  .join('')
          }
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="portal-card">
          <div class="portal-card-head">
            <div>
              <h3 class="portal-section-title">Local Notification Log (${escapeHtml(state.opsOutbox.length)})</h3>
              <p class="portal-card-sub">
                Simulated sandbox notification log stored locally for staff review; no external emails are sent.
              </p>
            </div>
            <div class="portal-btn-row">
              <label for="outbox-ref-filter" class="sr-only">Filter by reference ID</label>
              <input type="text" id="outbox-ref-filter" class="portal-input portal-input--compact" value="${escapeHtml(state.opsOutboxRefFilter)}" placeholder="Filter ref (e.g. SOLIS-...)" />
              <button type="button" class="portal-btn portal-btn--sm" id="merch-refresh-outbox">Filter</button>
            </div>
          </div>
          ${
            state.opsOutbox.length === 0
              ? '<p class="portal-muted">No notification log entries recorded yet.</p>'
              : state.opsOutbox
                  .map(
                    (msg) => `
                      <div class="portal-card portal-card--subtle">
                        <div class="portal-card-head">
                          <div>
                            <h4 class="portal-card-title">${escapeHtml(msg.subject)}</h4>
                            <p class="portal-card-sub">
                              To: ${escapeHtml(msg.toEmail)} · Ref: <span class="portal-mono">${escapeHtml(msg.referenceId || '—')}</span> · ${escapeHtml(formatDate(msg.createdAt, true))}
                            </p>
                          </div>
                          <div class="portal-badges">
                            ${renderBadge(msg.type, 'neutral')}
                            ${renderBadge(`Recorded (${msg.status})`, getStatusTone(msg.status))}
                          </div>
                        </div>
                        <details class="portal-disclosure">
                          <summary>View recorded message body</summary>
                          <pre class="portal-pre">${escapeHtml(msg.body)}</pre>
                        </details>
                      </div>
                    `
                  )
                  .join('')
          }
        </div>
      `;
    }

    return `
      <div class="portal-subtablist" role="tablist" aria-label="Merchandiser and admin tools" id="merch-subtablist">
        ${subTabs
          .map((st) => {
            const active = state.merchSubTab === st.id;
            return `
              <button
                type="button"
                id="merch-subtab-${st.id}"
                class="portal-subtab"
                role="tab"
                aria-selected="${active ? 'true' : 'false'}"
                tabindex="${active ? '0' : '-1'}"
                data-merch-subtab="${st.id}"
              >${escapeHtml(st.label)}</button>
            `;
          })
          .join('')}
      </div>
      ${bodyHtml}
    `;
  }

  function renderCsrTab() {
    const rmasHtml =
      state.opsReturns.length === 0
        ? `<div class="portal-empty"><p class="portal-empty-title">No matching return requests</p><p class="portal-muted">Customer damaged-can return requests appear here.</p></div>`
        : state.opsReturns
            .map((rma) => {
              const isResolved = ['rejected', 'refunded', 'replaced'].includes(rma.status);
              const confirmReject =
                state.pendingConfirm?.scope === 'csr-reject-rma' && state.pendingConfirm.key === rma.id;
              return `
                <article class="portal-card">
                  <div class="portal-card-head">
                    <div>
                      <h4 class="portal-card-title portal-mono">${escapeHtml(rma.id)} · Order ${escapeHtml(rma.orderId)}</h4>
                      <p class="portal-card-sub">
                        ${escapeHtml(rma.customerName)} (${escapeHtml(rma.customerEmail)}) · ${escapeHtml(formatDate(rma.createdAt, true))}
                      </p>
                    </div>
                    <div class="portal-badges">
                      ${renderBadge(formatStatusLabel(rma.status), getStatusTone(rma.status))}
                      <span class="portal-badge portal-badge--neutral portal-num">Est. Refund ${escapeHtml(formatCents(rma.refundCents))}</span>
                    </div>
                  </div>
                  <p class="portal-muted"><strong>Reason:</strong> ${escapeHtml(rma.reason)}${rma.notes ? ` — ${escapeHtml(rma.notes)}` : ''}</p>
                  ${
                    !isResolved
                      ? `
                        <form class="portal-card portal-card--subtle portal-form" data-csr-rma-form="${escapeHtml(rma.id)}" novalidate>
                          <div class="portal-grid-2">
                            <div class="portal-field">
                              <label for="csr-refund-${escapeHtml(rma.id)}" class="portal-label">Refund amount (USD)</label>
                              <input
                                type="text"
                                id="csr-refund-${escapeHtml(rma.id)}"
                                name="refundUsd"
                                class="portal-input"
                                value="${escapeHtml((Number(rma.refundCents || 0) / 100).toFixed(2))}"
                                aria-describedby="csr-refund-error-${escapeHtml(rma.id)}"
                              />
                              <p class="portal-field-error" id="csr-refund-error-${escapeHtml(rma.id)}" hidden></p>
                            </div>
                            <div class="portal-field">
                              <label for="csr-notes-${escapeHtml(rma.id)}" class="portal-label">CSR resolution notes</label>
                              <input type="text" id="csr-notes-${escapeHtml(rma.id)}" name="notes" class="portal-input" placeholder="Verified photo / cold-chain check" />
                            </div>
                          </div>
                          <label class="portal-check-label">
                            <input type="checkbox" name="restock" />
                            <span>Restock returned cans back to FEFO inventory</span>
                          </label>
                          <div class="portal-btn-row">
                            ${rma.status === 'requested' ? `<button type="button" class="portal-btn portal-btn--sm" data-rma-action="approve" data-rma-id="${escapeHtml(rma.id)}">Approve RMA</button>` : ''}
                            <button type="button" class="portal-btn portal-btn--primary portal-btn--sm" data-rma-action="refund" data-rma-id="${escapeHtml(rma.id)}">Issue Refund</button>
                            <button type="button" class="portal-btn portal-btn--accent portal-btn--sm" data-rma-action="replace" data-rma-id="${escapeHtml(rma.id)}">Approve Replacement</button>
                            <button type="button" class="portal-btn portal-btn--danger-outline portal-btn--sm" data-ask-reject-rma="${escapeHtml(rma.id)}">Reject RMA</button>
                          </div>
                        </form>
                        ${
                          confirmReject
                            ? `
                              <div class="portal-confirm-box" role="region" aria-label="Confirm RMA rejection">
                                <p class="portal-confirm-text">Reject RMA <span class="portal-mono">${escapeHtml(rma.id)}</span>?</p>
                                <div class="portal-btn-row">
                                  <button type="button" class="portal-btn portal-btn--danger portal-btn--sm" data-confirm-reject-rma="${escapeHtml(rma.id)}">Confirm Reject RMA</button>
                                  <button type="button" class="portal-btn portal-btn--sm" data-ops-abort-confirm>Cancel</button>
                                </div>
                              </div>
                            `
                            : ''
                        }
                      `
                      : `<p class="portal-hint">Resolution: ${escapeHtml(rma.resolution || rma.status)} · Updated ${escapeHtml(formatDate(rma.updatedAt, true))}</p>`
                  }
                </article>
              `;
            })
            .join('');

    return `
      <section class="portal-card" aria-labelledby="csr-rma-heading">
        <div class="portal-card-head">
          <h3 class="portal-section-title" id="csr-rma-heading">Customer RMAs &amp; Damaged-Can Claims</h3>
          <div class="portal-btn-row">
            <label for="csr-rma-status" class="sr-only">Filter RMA status</label>
            <select id="csr-rma-status" class="portal-select portal-select--compact">
              <option value="all" ${state.opsReturnStatusFilter === 'all' ? 'selected' : ''}>All RMAs</option>
              <option value="requested" ${state.opsReturnStatusFilter === 'requested' ? 'selected' : ''}>Requested</option>
              <option value="approved" ${state.opsReturnStatusFilter === 'approved' ? 'selected' : ''}>Approved</option>
              <option value="refunded" ${state.opsReturnStatusFilter === 'refunded' ? 'selected' : ''}>Refunded</option>
              <option value="replaced" ${state.opsReturnStatusFilter === 'replaced' ? 'selected' : ''}>Replaced</option>
              <option value="rejected" ${state.opsReturnStatusFilter === 'rejected' ? 'selected' : ''}>Rejected</option>
            </select>
            <button type="button" class="portal-btn portal-btn--sm" id="csr-refresh-rmas">Refresh</button>
          </div>
        </div>
        ${rmasHtml}
      </section>

      <section class="portal-card" aria-labelledby="csr-orders-heading">
        <h3 class="portal-section-title" id="csr-orders-heading">Search All Customer Orders</h3>
        <form class="portal-form" id="csr-order-search-form" novalidate>
          <div class="portal-grid-3">
            <div class="portal-field">
              <label for="csr-order-q" class="portal-label">Search query</label>
              <input type="search" id="csr-order-q" name="q" class="portal-input" value="${escapeHtml(state.opsCsrOrderQuery)}" placeholder="Order ID, email, name, SKU…" />
            </div>
            <div class="portal-field">
              <label for="csr-order-status" class="portal-label">Order status</label>
              <select id="csr-order-status" name="status" class="portal-select">
                <option value="" ${!state.opsCsrOrderStatus ? 'selected' : ''}>All statuses</option>
                <option value="confirmed" ${state.opsCsrOrderStatus === 'confirmed' ? 'selected' : ''}>Confirmed</option>
                <option value="packed" ${state.opsCsrOrderStatus === 'packed' ? 'selected' : ''}>Packed</option>
                <option value="shipped" ${state.opsCsrOrderStatus === 'shipped' ? 'selected' : ''}>Shipped</option>
                <option value="delivered" ${state.opsCsrOrderStatus === 'delivered' ? 'selected' : ''}>Delivered</option>
                <option value="cancelled" ${state.opsCsrOrderStatus === 'cancelled' ? 'selected' : ''}>Cancelled</option>
                <option value="refunded" ${state.opsCsrOrderStatus === 'refunded' ? 'selected' : ''}>Refunded</option>
              </select>
            </div>
            <div class="portal-field portal-field--end">
              <button type="submit" class="portal-btn portal-btn--primary">Search Orders</button>
            </div>
          </div>
        </form>

        ${
          state.opsCsrOrders.length === 0
            ? '<p class="portal-muted">No orders match the current search filter.</p>'
            : state.opsCsrOrders
                .map(
                  (o) => `
                    <div class="portal-item-row">
                      <div class="portal-item-main">
                        <strong class="portal-mono">${escapeHtml(o.id)}</strong> — ${escapeHtml(o.customerName)} (${escapeHtml(o.customerEmail)})
                        <div class="portal-card-sub">
                          ${escapeHtml(o.shippingLine1)}, ${escapeHtml(o.shippingCity)} ${escapeHtml(o.shippingPostal)} · ${escapeHtml(formatDate(o.createdAt, true))}
                        </div>
                      </div>
                      <div class="portal-badges">
                        ${renderBadge(formatStatusLabel(o.orderStatus), getStatusTone(o.orderStatus))}
                        ${renderBadge(formatStatusLabel(o.paymentStatus), getStatusTone(o.paymentStatus))}
                        <strong class="portal-num">${escapeHtml(formatCents(o.totalCents))}</strong>
                      </div>
                    </div>
                  `
                )
                .join('')
        }
      </section>
    `;
  }

  function renderFinanceTab() {
    const s = state.opsFinance.summary || {
      orderCount: 0,
      refundCount: 0,
      subtotalCents: 0,
      discountCents: 0,
      shippingCents: 0,
      taxCents: 0,
      grossRevenueCents: 0,
      refundsCents: 0,
      netRevenueCents: 0
    };
    const entries = state.opsFinance.entries || [];
    const qs = new URLSearchParams();
    if (state.opsFinanceFrom) qs.set('from', `${state.opsFinanceFrom}T00:00:00.000Z`);
    if (state.opsFinanceTo) qs.set('to', `${state.opsFinanceTo}T23:59:59.999Z`);
    const csvHref = `/api/ops/finance/export.csv${qs.toString() ? `?${qs.toString()}` : ''}`;

    return `
      <section class="portal-card" aria-labelledby="fin-summary-heading">
        <div class="portal-card-head">
          <div>
            <h3 class="portal-section-title" id="fin-summary-heading">Revenue, Tax &amp; Refund Summary</h3>
            <p class="portal-card-sub">Authoritative integer-cent ledger across charges and refunds.</p>
          </div>
          <a
            href="${escapeHtml(csvHref)}"
            download="solis-finance-ledger.csv"
            class="portal-btn portal-btn--primary portal-btn--sm"
            id="fin-export-csv"
          >Download CSV Ledger</a>
        </div>

        <form class="portal-grid-3" id="fin-filter-form" novalidate>
          <div class="portal-field">
            <label for="fin-from" class="portal-label">From ISO date</label>
            <input type="date" id="fin-from" name="from" class="portal-input" value="${escapeHtml(state.opsFinanceFrom)}" />
          </div>
          <div class="portal-field">
            <label for="fin-to" class="portal-label">To ISO date</label>
            <input type="date" id="fin-to" name="to" class="portal-input" value="${escapeHtml(state.opsFinanceTo)}" />
          </div>
          <div class="portal-field portal-field--end">
            <div class="portal-btn-row">
              <button type="submit" class="portal-btn portal-btn--sm">Filter</button>
              <button type="button" class="portal-btn portal-btn--sm" id="fin-clear-btn">Reset</button>
            </div>
          </div>
        </form>

        <div class="portal-kpi-grid">
          <div class="portal-kpi">
            <span class="portal-kpi-label">Gross Revenue (${escapeHtml(pluralize(s.orderCount, 'order'))})</span>
            <strong class="portal-kpi-value">${escapeHtml(formatCents(s.grossRevenueCents))}</strong>
          </div>
          <div class="portal-kpi">
            <span class="portal-kpi-label">Refunds (${escapeHtml(pluralize(s.refundCount, 'refund'))})</span>
            <strong class="portal-kpi-value">${escapeHtml(formatCents(s.refundsCents))}</strong>
          </div>
          <div class="portal-kpi">
            <span class="portal-kpi-label">Net Revenue</span>
            <strong class="portal-kpi-value">${escapeHtml(formatCents(s.netRevenueCents))}</strong>
          </div>
          <div class="portal-kpi">
            <span class="portal-kpi-label">Tax Collected (8.25%)</span>
            <strong class="portal-kpi-value">${escapeHtml(formatCents(s.taxCents))}</strong>
          </div>
          <div class="portal-kpi">
            <span class="portal-kpi-label">Shipping Collected</span>
            <strong class="portal-kpi-value">${escapeHtml(formatCents(s.shippingCents))}</strong>
          </div>
          <div class="portal-kpi">
            <span class="portal-kpi-label">Promo Discounts</span>
            <strong class="portal-kpi-value">${escapeHtml(formatCents(s.discountCents))}</strong>
          </div>
        </div>
      </section>

      <section class="portal-card" aria-labelledby="fin-ledger-heading">
        <h3 class="portal-section-title" id="fin-ledger-heading">Payment &amp; Refund Ledger (${escapeHtml(entries.length)})</h3>
        ${
          entries.length === 0
            ? '<p class="portal-muted">No charge or refund entries found for the selected range.</p>'
            : `
              <div class="portal-table-wrap">
                <table class="portal-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col">Reference</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Status</th>
                      <th scope="col">Tax</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${entries
                      .map(
                        (e) => `
                          <tr>
                            <td data-label="Date">${escapeHtml(formatDate(e.createdAt, true))}</td>
                            <td data-label="Type">${renderBadge(formatStatusLabel(e.entryType), e.entryType === 'refund' ? 'warning' : 'success')}</td>
                            <td data-label="Reference" class="portal-mono">${escapeHtml(e.referenceId)}</td>
                            <td data-label="Customer">${escapeHtml(e.customerName)}<br /><span class="portal-card-sub">${escapeHtml(e.customerEmail)}</span></td>
                            <td data-label="Status">${escapeHtml(formatStatusLabel(e.status))}</td>
                            <td data-label="Tax" class="portal-num">${escapeHtml(formatCents(e.taxCents))}</td>
                            <td data-label="Amount" class="portal-num"><strong>${escapeHtml(formatCents(e.signedAmountCents))}</strong></td>
                          </tr>
                        `
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            `
        }
      </section>
    `;
  }

  function renderOpsPortal(explicitFocusSelector = null) {
    const auth = getAuthState();
    if (!auth.authenticated || !auth.user || !isStaffRole(auth.user.role)) {
      closePortals({ restoreFocus: false });
      return;
    }

    const captured = dom.opsContent.contains(document.activeElement)
      ? captureFocusTarget(dom.opsContent)
      : null;

    const allowedTabs = getAllowedOpsTabs(auth.user.role);
    if (!allowedTabs.some((t) => t.id === state.opsTab)) {
      state.opsTab = allowedTabs[0]?.id || 'warehouse';
    }

    let panelHtml = '';
    if (state.opsTab === 'warehouse') panelHtml = renderWarehouseTab();
    else if (state.opsTab === 'merchandiser') panelHtml = renderMerchandiserTab();
    else if (state.opsTab === 'csr') panelHtml = renderCsrTab();
    else if (state.opsTab === 'finance') panelHtml = renderFinanceTab();

    dom.opsContent.innerHTML = `
      <div class="portal-user-banner">
        <div class="portal-user-meta">
          <p class="portal-user-name">${escapeHtml(auth.user.name)} ${renderBadge(`Role: ${formatStatusLabel(auth.user.role)}`, 'neutral')}</p>
          <p class="portal-user-email">${escapeHtml(auth.user.email)}</p>
        </div>
        <div class="portal-user-actions">
          <button type="button" class="portal-btn portal-btn--sm" id="ops-signout-btn">Sign Out</button>
        </div>
      </div>

      <div class="portal-tablist" role="tablist" aria-label="Staff operations workspaces" id="ops-tablist">
        ${allowedTabs
          .map((t) => {
            const active = state.opsTab === t.id;
            return `
              <button
                type="button"
                id="ops-tab-${t.id}"
                class="portal-tab"
                role="tab"
                aria-selected="${active ? 'true' : 'false'}"
                aria-controls="ops-panel-${t.id}"
                tabindex="${active ? '0' : '-1'}"
                data-ops-tab="${t.id}"
              >${escapeHtml(t.label)}</button>
            `;
          })
          .join('')}
      </div>

      <section
        id="ops-panel-${escapeHtml(state.opsTab)}"
        class="portal-tabpanel"
        role="tabpanel"
        aria-labelledby="ops-tab-${escapeHtml(state.opsTab)}"
      >
        ${panelHtml}
      </section>
    `;

    wireOpsEvents();
    restorePortalFocus('ops', captured, explicitFocusSelector);
  }

  async function loadOpsTabData(tab) {
    const auth = getAuthState();
    if (!auth.authenticated || !auth.user || !isStaffRole(auth.user.role)) return;

    try {
      if (tab === 'warehouse') {
        const [prodRes, ordRes, ledRes] = await Promise.all([
          portalFetch('/api/ops/products'),
          portalFetch('/api/ops/orders?limit=100'),
          portalFetch('/api/ops/inventory/ledger?limit=30')
        ]);
        state.opsProducts = prodRes.products || [];
        state.opsOrders = ordRes.orders || [];
        state.opsInventoryLedger = ledRes.ledger || [];
      } else if (tab === 'merchandiser') {
        if (state.merchSubTab === 'catalog') {
          const res = await portalFetch('/api/ops/products');
          state.opsProducts = res.products || [];
        } else if (state.merchSubTab === 'promos') {
          const res = await portalFetch('/api/ops/promotions');
          state.opsPromotions = res.promotions || [];
        } else if (state.merchSubTab === 'audit') {
          const qs = new URLSearchParams({ limit: '100' });
          if (state.opsAuditActionFilter) qs.set('action', state.opsAuditActionFilter);
          const res = await portalFetch(`/api/ops/audit-logs?${qs.toString()}`);
          state.opsAuditLogs = res.logs || [];
        } else if (state.merchSubTab === 'outbox') {
          const qs = new URLSearchParams({ limit: '100' });
          if (state.opsOutboxRefFilter) qs.set('referenceId', state.opsOutboxRefFilter);
          const res = await portalFetch(`/api/ops/outbox?${qs.toString()}`);
          state.opsOutbox = res.outbox || [];
        }
      } else if (tab === 'csr') {
        const rmaQs = new URLSearchParams();
        if (state.opsReturnStatusFilter && state.opsReturnStatusFilter !== 'all') {
          rmaQs.set('status', state.opsReturnStatusFilter);
        }
        const ordQs = new URLSearchParams({ limit: '100' });
        if (state.opsCsrOrderQuery) ordQs.set('q', state.opsCsrOrderQuery);
        if (state.opsCsrOrderStatus) ordQs.set('status', state.opsCsrOrderStatus);

        const [rmaRes, ordRes] = await Promise.all([
          portalFetch(`/api/ops/returns${rmaQs.toString() ? `?${rmaQs.toString()}` : ''}`),
          portalFetch(`/api/ops/orders?${ordQs.toString()}`)
        ]);
        state.opsReturns = rmaRes.returns || [];
        state.opsCsrOrders = ordRes.orders || [];
      } else if (tab === 'finance') {
        const qs = new URLSearchParams();
        if (state.opsFinanceFrom) qs.set('from', `${state.opsFinanceFrom}T00:00:00.000Z`);
        if (state.opsFinanceTo) qs.set('to', `${state.opsFinanceTo}T23:59:59.999Z`);
        const res = await portalFetch(`/api/ops/finance/ledger${qs.toString() ? `?${qs.toString()}` : ''}`);
        state.opsFinance = { summary: res.summary, entries: res.entries || [] };
      }

      if (state.activePortal === 'ops' && state.opsTab === tab) renderOpsPortal();
    } catch (err) {
      setLiveMessage('ops', 'error', err.message || 'Unable to load operations data.');
    }
  }

  function wireOpsEvents() {
    document.getElementById('ops-signout-btn')?.addEventListener('click', handleLogout);

    const opsTablist = document.getElementById('ops-tablist');
    const selectOpsTab = async (tabBtn) => {
      const next = tabBtn.dataset.opsTab;
      if (!next) return;
      state.opsTab = next;
      state.pendingConfirm = null;
      setLiveMessage('ops', 'info', '');
      renderOpsPortal(`#ops-tab-${CSS.escape(next)}`);
      await loadOpsTabData(next);
    };
    opsTablist?.querySelectorAll('[role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => selectOpsTab(btn));
    });
    wireRovingTablist(opsTablist, selectOpsTab);

    dom.opsContent.querySelectorAll('[data-ops-abort-confirm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const abortFallback = getConfirmCancelFallbackSelector(state.pendingConfirm);
        state.pendingConfirm = null;
        renderOpsPortal(abortFallback);
      });
    });

    // --- Warehouse Handlers ---
    document.getElementById('wh-status-filter')?.addEventListener('change', (e) => {
      state.opsOrderStatusFilter = e.target.value;
      renderOpsPortal();
    });
    document.getElementById('wh-refresh-orders')?.addEventListener('click', () => loadOpsTabData('warehouse'));

    dom.opsContent.querySelectorAll('[data-wh-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const orderId = btn.dataset.whStatus;
        const nextStatus = btn.dataset.nextStatus;
        setButtonBusy(btn, true, 'Updating…');
        try {
          await portalFetch(`/api/ops/orders/${encodeURIComponent(orderId)}/status`, {
            method: 'PATCH',
            body: { orderStatus: nextStatus }
          });
          setLiveMessage('ops', 'success', `Order ${orderId} transitioned to ${nextStatus}.`);
          await loadOpsTabData('warehouse');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to transition order status.');
        }
      });
    });

    dom.opsContent.querySelectorAll('[data-wh-toggle-ship]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.whToggleShip;
        state.openShipOrderId = state.openShipOrderId === id ? null : id;
        renderOpsPortal();
      });
    });

    dom.opsContent.querySelectorAll('[data-wh-ship-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const orderId = form.dataset.whShipForm;
        const btn = form.querySelector('button[type="submit"]');
        if (isBusy(btn)) return;
        const carrierEl = form.elements.carrier;
        const trackingEl = form.elements.trackingNumber;
        const carrierErr = document.getElementById(`ship-carrier-error-${orderId}`);
        const trackingErr = document.getElementById(`ship-tracking-error-${orderId}`);
        const carrier = carrierEl.value.trim();
        const trackingNumber = trackingEl.value.trim();
        const coldChainPack = form.elements.coldChainPack.checked;

        let firstInvalid = null;
        if (carrier.length < 2) {
          setFieldError(carrierEl, carrierErr, 'Enter a carrier name (at least 2 characters).');
          firstInvalid = carrierEl;
        } else {
          setFieldError(carrierEl, carrierErr, '');
        }
        if (trackingNumber.length < 3) {
          setFieldError(trackingEl, trackingErr, 'Enter a tracking number (at least 3 characters).');
          if (!firstInvalid) firstInvalid = trackingEl;
        } else {
          setFieldError(trackingEl, trackingErr, '');
        }
        if (firstInvalid) {
          firstInvalid.focus();
          setLiveMessage('ops', 'error', 'Complete the highlighted carrier and tracking fields.');
          return;
        }
        setButtonBusy(btn, true, 'Shipping…');
        try {
          await portalFetch(`/api/ops/orders/${encodeURIComponent(orderId)}/ship`, {
            method: 'POST',
            body: { carrier, trackingNumber, coldChainPack }
          });
          state.openShipOrderId = null;
          setLiveMessage('ops', 'success', `Order ${orderId} shipped via ${carrier} (${trackingNumber}).`);
          await loadOpsTabData('warehouse');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to dispatch shipment.');
        }
      });
    });

    dom.opsContent.querySelectorAll('[data-wh-ask-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingConfirm = { scope: 'wh-cancel', key: btn.dataset.whAskCancel };
        renderOpsPortal('[data-wh-confirm-cancel]');
      });
    });

    dom.opsContent.querySelectorAll('[data-wh-confirm-cancel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const orderId = btn.dataset.whConfirmCancel;
        setButtonBusy(btn, true, 'Cancelling…');
        try {
          await portalFetch(`/api/ops/orders/${encodeURIComponent(orderId)}/status`, {
            method: 'PATCH',
            body: { orderStatus: 'cancelled', note: 'Cancelled by warehouse operations' }
          });
          state.pendingConfirm = null;
          const app = getApp();
          if (app && typeof app.refreshCatalog === 'function') await app.refreshCatalog();
          setLiveMessage('ops', 'success', `Order ${orderId} cancelled and FEFO lots restored.`);
          await loadOpsTabData('warehouse');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to cancel order.');
        }
      });
    });

    document.getElementById('wh-adjust-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const deltaEl = document.getElementById('adj-delta');
      const deltaErr = document.getElementById('adj-delta-error');
      const submitBtn = document.getElementById('wh-adjust-submit');
      if (isBusy(submitBtn)) return;

      const delta = parseStrictIntegerInput(deltaEl.value);
      if (delta === null || delta === 0) {
        setFieldError(deltaEl, deltaErr, 'Enter a non-zero whole number (for example, 12 or -2).');
        deltaEl.focus();
        setLiveMessage('ops', 'error', 'Fix the inventory delta before applying adjustment.');
        return;
      }
      setFieldError(deltaEl, deltaErr, '');

      const variantId = Number(document.getElementById('adj-variant').value);
      const reason = document.getElementById('adj-reason').value;
      const lotNumber = document.getElementById('adj-lot').value.trim();
      const expiresAt = document.getElementById('adj-expiry').value.trim();

      setButtonBusy(submitBtn, true, 'Applying…');
      try {
        const res = await portalFetch('/api/ops/inventory/adjust', {
          method: 'POST',
          body: { variantId, delta, reason, lotNumber, expiresAt }
        });
        const app = getApp();
        if (app && typeof app.refreshCatalog === 'function') await app.refreshCatalog();
        setLiveMessage(
          'ops',
          'success',
          `Adjusted ${res.variant?.sku || 'SKU'} by ${delta > 0 ? `+${delta}` : delta}. Available stock is now ${res.variant?.available ?? 'updated'}.`
        );
        await loadOpsTabData('warehouse');
      } catch (err) {
        setButtonBusy(submitBtn, false);
        setLiveMessage('ops', 'error', err.message || 'Unable to adjust inventory.');
      }
    });

    // --- Merchandiser / Admin Handlers ---
    const merchTablist = document.getElementById('merch-subtablist');
    const selectMerchSubTab = async (btn) => {
      const next = btn.dataset.merchSubtab;
      if (!next) return;
      state.merchSubTab = next;
      state.pendingConfirm = null;
      setLiveMessage('ops', 'info', '');
      renderOpsPortal(`#merch-subtab-${CSS.escape(next)}`);
      await loadOpsTabData('merchandiser');
    };
    merchTablist?.querySelectorAll('[role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => selectMerchSubTab(btn));
    });
    wireRovingTablist(merchTablist, selectMerchSubTab);

    document.getElementById('merch-refresh-catalog')?.addEventListener('click', () => loadOpsTabData('merchandiser'));
    document.getElementById('merch-refresh-promos')?.addEventListener('click', () => loadOpsTabData('merchandiser'));

    document.getElementById('merch-refresh-audit')?.addEventListener('click', () => {
      state.opsAuditActionFilter = document.getElementById('audit-action-filter')?.value.trim() || '';
      loadOpsTabData('merchandiser');
    });
    document.getElementById('merch-refresh-outbox')?.addEventListener('click', () => {
      state.opsOutboxRefFilter = document.getElementById('outbox-ref-filter')?.value.trim() || '';
      loadOpsTabData('merchandiser');
    });

    dom.opsContent.querySelectorAll('[data-toggle-product-active]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const productId = btn.dataset.toggleProductActive;
        const active = btn.dataset.nextActive === '1';
        setButtonBusy(btn, true, 'Saving…');
        try {
          await portalFetch(`/api/ops/products/${encodeURIComponent(productId)}`, {
            method: 'PATCH',
            body: { active }
          });
          const app = getApp();
          if (app && typeof app.refreshCatalog === 'function') await app.refreshCatalog();
          setLiveMessage('ops', 'success', `Product ${active ? 'activated' : 'deactivated'}.`);
          await loadOpsTabData('merchandiser');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to update product.');
        }
      });
    });

    dom.opsContent.querySelectorAll('[data-variant-edit-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const productId = Number(form.dataset.variantEditForm);
        const variantId = Number(form.dataset.variantId);
        const btn = form.querySelector('button[type="submit"]');
        if (isBusy(btn)) return;

        const priceEl = form.elements.priceUsd;
        const priceErr = document.getElementById(`var-price-error-${variantId}`);
        const priceCents = parseDollarsToCents(priceEl.value);
        if (priceCents === null) {
          const errMsg = 'Enter a price >= $0.00 (for example, 18.00).';
          setFieldError(priceEl, priceErr, errMsg);
          priceEl.focus();
          setLiveMessage('ops', 'error', errMsg);
          return;
        }
        setFieldError(priceEl, priceErr, '');
        const active = form.elements.active.checked;
        setButtonBusy(btn, true, 'Saving…');
        try {
          await portalFetch(`/api/ops/products/${productId}`, {
            method: 'PATCH',
            body: { variants: [{ variantId, priceCents, active }] }
          });
          const app = getApp();
          if (app && typeof app.refreshCatalog === 'function') await app.refreshCatalog();
          setLiveMessage('ops', 'success', `SKU updated to ${formatCents(priceCents)} (${active ? 'Active' : 'Inactive'}).`);
          await loadOpsTabData('merchandiser');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to save SKU.');
        }
      });
    });

    document.getElementById('merch-promo-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const btn = form.querySelector('button[type="submit"]');
      if (isBusy(btn)) return;

      const codeEl = form.elements.code;
      const valueEl = form.elements.value;
      const minEl = form.elements.minSubtotalUsd;
      const maxEl = form.elements.maxUses;
      const codeErr = document.getElementById('promo-code-error');
      const valueErr = document.getElementById('promo-value-error');
      const minErr = document.getElementById('promo-min-error');
      const maxErr = document.getElementById('promo-max-error');

      const code = codeEl.value.trim().toUpperCase();
      const type = form.elements.type.value;
      const minSubtotalCents = parseDollarsToCents(minEl.value);
      const maxUsesRaw = maxEl.value.trim();
      const maxUses = maxUsesRaw ? parseStrictIntegerInput(maxUsesRaw) : null;

      let value = 0;
      let valueValid = true;
      let valueMsg = '';
      if (type === 'percent') {
        const pct = parseStrictIntegerInput(valueEl.value);
        if (pct === null || pct < 1 || pct > 100) {
          valueValid = false;
          valueMsg = 'Enter a whole percentage between 1 and 100.';
        } else {
          value = pct;
        }
      } else if (type === 'fixed') {
        const fixedCents = parseDollarsToCents(valueEl.value);
        if (fixedCents === null || fixedCents <= 0) {
          valueValid = false;
          valueMsg = 'Enter a positive fixed USD discount (for example, 5.00).';
        } else {
          value = fixedCents;
        }
      }

      let firstInvalid = null;
      if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
        setFieldError(codeEl, codeErr, 'Use 2–32 letters, numbers, dashes, or underscores.');
        firstInvalid = codeEl;
      } else {
        setFieldError(codeEl, codeErr, '');
      }

      if (!valueValid) {
        setFieldError(valueEl, valueErr, valueMsg);
        if (!firstInvalid) firstInvalid = valueEl;
      } else {
        setFieldError(valueEl, valueErr, '');
      }

      if (minSubtotalCents === null) {
        setFieldError(minEl, minErr, 'Enter a valid non-negative USD subtotal (for example, 0.00).');
        if (!firstInvalid) firstInvalid = minEl;
      } else {
        setFieldError(minEl, minErr, '');
      }

      if (maxUsesRaw && (maxUses === null || maxUses < 1)) {
        setFieldError(maxEl, maxErr, 'Leave blank for unlimited or enter a whole number >= 1.');
        if (!firstInvalid) firstInvalid = maxEl;
      } else {
        setFieldError(maxEl, maxErr, '');
      }

      if (firstInvalid) {
        firstInvalid.focus();
        setLiveMessage('ops', 'error', 'Fix the highlighted promo code fields and submit again.');
        return;
      }

      setButtonBusy(btn, true, 'Creating…');
      try {
        await portalFetch('/api/ops/promotions', {
          method: 'POST',
          body: { code, type, value, minSubtotalCents, maxUses }
        });
        setLiveMessage('ops', 'success', `Promo code ${code} created.`);
        await loadOpsTabData('merchandiser');
      } catch (err) {
        setButtonBusy(btn, false);
        setLiveMessage('ops', 'error', err.message || 'Unable to create promo code.');
      }
    });

    dom.opsContent.querySelectorAll('[data-toggle-promo]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const promoId = btn.dataset.togglePromo;
        const active = btn.dataset.nextActive === '1';
        setButtonBusy(btn, true, 'Updating…');
        try {
          await portalFetch(`/api/ops/promotions/${encodeURIComponent(promoId)}`, {
            method: 'PATCH',
            body: { active }
          });
          setLiveMessage('ops', 'success', `Promotion ${active ? 'enabled' : 'disabled'}.`);
          await loadOpsTabData('merchandiser');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to update promo code.');
        }
      });
    });

    // --- CSR Handlers ---
    document.getElementById('csr-rma-status')?.addEventListener('change', (e) => {
      state.opsReturnStatusFilter = e.target.value;
      loadOpsTabData('csr');
    });
    document.getElementById('csr-refresh-rmas')?.addEventListener('click', () => loadOpsTabData('csr'));

    document.getElementById('csr-order-search-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      state.opsCsrOrderQuery = document.getElementById('csr-order-q').value.trim();
      state.opsCsrOrderStatus = document.getElementById('csr-order-status').value;
      loadOpsTabData('csr');
    });

    dom.opsContent.querySelectorAll('[data-rma-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const rmaId = btn.dataset.rmaId;
        const action = btn.dataset.rmaAction;
        const form = btn.closest('form');
        const notes = form?.elements?.notes?.value?.trim() || '';
        const restock = Boolean(form?.elements?.restock?.checked);
        const body = { action, notes, restock };

        if (action === 'refund' && form?.elements?.refundUsd) {
          const refundEl = form.elements.refundUsd;
          const refundErr = document.getElementById(`csr-refund-error-${rmaId}`);
          const refundCents = parseDollarsToCents(refundEl.value);
          if (refundCents === null || refundCents <= 0) {
            setFieldError(refundEl, refundErr, 'Enter a positive refund amount in USD (for example, 34.00).');
            refundEl.focus();
            setLiveMessage('ops', 'error', 'Enter a positive refund amount in USD.');
            return;
          }
          setFieldError(refundEl, refundErr, '');
          body.refundCents = refundCents;
        }

        setButtonBusy(btn, true, 'Processing…');
        try {
          await portalFetch(`/api/ops/returns/${encodeURIComponent(rmaId)}`, {
            method: 'PATCH',
            body
          });
          const app = getApp();
          if (restock && app && typeof app.refreshCatalog === 'function') await app.refreshCatalog();
          setLiveMessage('ops', 'success', `RMA ${rmaId} updated (${action}). Outbox notification recorded.`);
          await loadOpsTabData('csr');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to process RMA action.');
        }
      });
    });

    dom.opsContent.querySelectorAll('[data-ask-reject-rma]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingConfirm = { scope: 'csr-reject-rma', key: btn.dataset.askRejectRma };
        renderOpsPortal('[data-confirm-reject-rma]');
      });
    });

    dom.opsContent.querySelectorAll('[data-confirm-reject-rma]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isBusy(btn)) return;
        const rmaId = btn.dataset.confirmRejectRma;
        setButtonBusy(btn, true, 'Rejecting…');
        try {
          await portalFetch(`/api/ops/returns/${encodeURIComponent(rmaId)}`, {
            method: 'PATCH',
            body: { action: 'reject', resolution: 'Rejected by CSR review' }
          });
          state.pendingConfirm = null;
          setLiveMessage('ops', 'success', `RMA ${rmaId} rejected.`);
          await loadOpsTabData('csr');
        } catch (err) {
          setButtonBusy(btn, false);
          setLiveMessage('ops', 'error', err.message || 'Unable to reject RMA.');
        }
      });
    });

    // --- Finance Handlers ---
    document.getElementById('fin-filter-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      state.opsFinanceFrom = document.getElementById('fin-from').value;
      state.opsFinanceTo = document.getElementById('fin-to').value;
      loadOpsTabData('finance');
    });

    document.getElementById('fin-clear-btn')?.addEventListener('click', () => {
      state.opsFinanceFrom = '';
      state.opsFinanceTo = '';
      loadOpsTabData('finance');
    });
  }

  /* ========================================================================
     8. Wire Bridge to window.SOLIS_APP & Custom Events
     ======================================================================== */
  function registerWithStoreApp() {
    const app = getApp();
    if (!app) return;

    if (typeof app.registerPortalHandlers === 'function') {
      app.registerPortalHandlers({
        openAccount: (opts) => openAccountPortal(opts || {}),
        openOps: (opts) => openOpsPortal(opts || {})
      });
    }

    if (typeof app.on === 'function') {
      app.on('solis:auth-changed', (detail) => {
        if (state.activePortal === 'ops' && (!detail?.authenticated || !isStaffRole(detail?.user?.role))) {
          closePortals({ restoreFocus: false });
        } else if (state.activePortal === 'account') {
          renderAccountPortal();
        }
      });

      app.on('solis:order-created', () => {
        state.ordersLoaded = false;
        if (state.activePortal === 'account' && state.accountTab === 'orders') {
          loadAccountTabData('orders');
        }
      });
    }
  }

  window.addEventListener('solis:open-account', (e) => {
    if (!getApp()?.registerPortalHandlers) {
      openAccountPortal(e.detail || {});
    }
  });

  window.addEventListener('solis:open-ops', (e) => {
    if (!getApp()?.registerPortalHandlers) {
      openOpsPortal(e.detail || {});
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerWithStoreApp);
  } else {
    registerWithStoreApp();
  }
})();

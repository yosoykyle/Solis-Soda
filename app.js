'use strict';

(() => {
  /* ========================================================================
     1. Presets & Pure Helpers
     ======================================================================== */
  const STAFF_ROLES = new Set(['admin', 'merchandiser', 'warehouse', 'csr', 'finance']);

  const FLAVOR_PRESETS = Object.freeze({
    'blood-orange': {
      slug: 'blood-orange',
      shortName: 'Blood Orange',
      canTitleHtml: 'BLOOD ORANGE<br />&amp; ROSEMARY',
      miniTitle: 'BLOOD ORANGE',
      calories: 35,
      tag: 'Signature',
      accentColor: '#a83516',
      canGradient: 'linear-gradient(155deg, #EB6B47 0%, #C93D1B 60%, #8A220A 100%)'
    },
    'yuzu-lime': {
      slug: 'yuzu-lime',
      shortName: 'Yuzu Lime',
      canTitleHtml: 'YUZU LIME<br />&amp; SEA SALT',
      miniTitle: 'YUZU LIME',
      calories: 30,
      tag: 'Ultra Crisp',
      accentColor: '#366926',
      canGradient: 'linear-gradient(155deg, #8CC265 0%, #4E8C3A 60%, #26541D 100%)'
    },
    'hibiscus-berry': {
      slug: 'hibiscus-berry',
      shortName: 'Hibiscus Berry',
      canTitleHtml: 'HIBISCUS &amp;<br />WILD BERRY',
      miniTitle: 'HIBISCUS BERRY',
      calories: 35,
      tag: 'Floral',
      accentColor: '#a62952',
      canGradient: 'linear-gradient(155deg, #EB6B88 0%, #BD345A 60%, #7E1B3A 100%)'
    },
    'ginger-peach': {
      slug: 'ginger-peach',
      shortName: 'Ginger Peach',
      canTitleHtml: 'GOLDEN GINGER<br />&amp; PEACH',
      miniTitle: 'GINGER PEACH',
      calories: 40,
      tag: 'Spiced',
      accentColor: '#8c5308',
      canGradient: 'linear-gradient(155deg, #F0B654 0%, #D98126 60%, #994D09 100%)'
    },
    variety: {
      slug: 'variety',
      shortName: 'Variety Box',
      canTitleHtml: 'VARIETY<br />12-PACK',
      miniTitle: 'ALL 4 FLAVORS',
      calories: 35,
      tag: 'Bundle',
      accentColor: '#0A5E9E',
      canGradient: 'linear-gradient(155deg, #6ba4d9 0%, #2c5b8c 58%, #183454 100%)'
    }
  });

  const FALLBACK_POLICIES = Object.freeze({
    privacy: {
      slug: 'privacy',
      title: 'Privacy Policy',
      updatedAt: '2026-11-01',
      summary:
        'SOLIS collects only the contact, shipping, and order details needed to fulfill cold-chain deliveries and manage your account. Payment tokens are sandbox-tokenized and raw card numbers are never stored.'
    },
    terms: {
      slug: 'terms',
      title: 'Terms of Sale',
      updatedAt: '2026-11-01',
      summary:
        'All prices are authoritative in USD cents. Orders are limited to 10 packs per SKU per transaction. Promo codes apply to eligible subtotals prior to tax (8.25%) and shipping calculation.'
    },
    shipping: {
      slug: 'shipping',
      title: 'Shipping & Cold-Chain Policy',
      updatedAt: '2026-11-01',
      summary:
        'Orders of $35.00 or more after discounts ship free; orders under $35.00 carry a flat $6.00 cold-chain shipping fee. Every pack ships chilled with insulated liner protection and FEFO lot tracking; refrigerate at 35–42°F (2–6°C) upon arrival.'
    },
    returns: {
      slug: 'returns',
      title: 'Returns & Refunds Policy',
      updatedAt: '2026-11-01',
      summary:
        'Confirmed orders may be cancelled with instant stock restoration and full refund prior to warehouse packing. Damaged or warm-in-transit cans qualify for fast RMA refund or replacement via your Account portal.'
    },
    nutrition: {
      slug: 'nutrition',
      title: 'Nutrition & Allergens',
      updatedAt: '2026-11-01',
      summary:
        'SOLIS botanical sparkling sodas contain 30-40 kcal, 3g organic agave inulin prebiotic fiber, and 3-5g organic blue agave nectar per 12 fl oz can. All flavors are gluten-free, vegan, non-GMO, and free from top 9 major allergens.'
    }
  });

  const POLICY_DETAILS = Object.freeze({
    privacy: [
      'Session cookies are HttpOnly and SameSite=Lax with CSRF protection on authenticated mutations.',
      'Guest tracking uses dual verification (Order ID + checkout email) and masks street address details.',
      'Sandbox notifications are recorded internally in the SOLIS Notification Log and do not transmit external emails.'
    ],
    terms: [
      'Authoritative totals are calculated server-side in integer cents via POST /api/checkout/quote and POST /api/orders.',
      'Sandbox promos: SOLIS10 (10% off eligible subtotal) and SOLIS5 ($5.00 off orders of $30.00+).'
    ],
    shipping: [
      'Refrigerate cans at 35–42°F (2–6°C) promptly on arrival.',
      'Every order allocates inventory using First-Expired, First-Out (FEFO) batch lots.',
      'Free chilled shipping unlocks automatically at $35.00+ post-discount subtotal; otherwise $6.00 flat rate.'
    ],
    returns: [
      'Cancellations prior to packing automatically restore FEFO lot inventory and create a sandbox refund record.',
      'Signed-in customers can also request an RMA directly from Account > Orders.'
    ],
    nutrition: [
      'Dietary flags: Certified Vegan, Gluten-Free, Non-GMO, 0g added cane sugar or stevia.',
      'Free from all top 9 US major allergens (milk, eggs, fish, crustacean shellfish, tree nuts, peanuts, wheat, soy, sesame).'
    ]
  });

  function escapeHtml(value) {
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
    const numeric = Number(cents);
    if (!Number.isFinite(numeric)) return '$0.00';
    const sign = numeric < 0 ? '-' : '';
    const abs = Math.abs(Math.round(numeric));
    return `${sign}$${(abs / 100).toFixed(2)}`;
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
  }

  function generateIdemKey(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function formatColdChainNotice(text) {
    return String(text ?? '')
      .replace(/35[–-]42°?F\s*\(2[–-]6°?C\)/gi, '35–42°F (2–6°C)')
      .replace(/35[–-]42°?F(?!\s*\()/gi, '35–42°F (2–6°C)');
  }

  function formatStatusLabel(status) {
    return String(status || 'unknown')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function buildTrackProgress(order) {
    const orderStatus = String(order.orderStatus || order.status || '').toLowerCase();
    const fulfillmentStatus = String(order.fulfillmentStatus || 'allocated').toLowerCase();
    const isCancelled = orderStatus === 'cancelled' || orderStatus === 'refunded';
    if (isCancelled) {
      return {
        isCancelled: true,
        activeIndex: -1,
        steps: ['Confirmed', 'Packed Chilled', 'Shipped', 'Delivered']
      };
    }

    let activeIndex = 0;
    if (fulfillmentStatus === 'packed') activeIndex = 1;
    else if (fulfillmentStatus === 'shipped') activeIndex = 2;
    else if (fulfillmentStatus === 'delivered') activeIndex = 3;
    else if (order.shipments && order.shipments.length > 0) activeIndex = 2;

    return {
      isCancelled: false,
      activeIndex,
      steps: ['Allocated', 'Packed', 'Shipped', 'Delivered']
    };
  }

  /* ========================================================================
     2. Shared State & Event Bridge (for js/portals.js)
     ======================================================================== */
  const listeners = new Map();

  const state = {
    authenticated: false,
    user: null,
    csrfToken: null,
    products: [],
    productBySlug: new Map(),
    variantById: new Map(),
    variantBySku: new Map(),
    selectedVariantBySlug: new Map(),
    filters: { q: '', tag: 'all', sort: 'featured' },
    config: {
      freeShippingThresholdCents: 3500,
      standardShippingCents: 600,
      taxRateBps: 825,
      maxItemQty: 10,
      coldChainNotice:
        'Perishable botanical beverage: refrigerate at 35–42°F (2–6°C) on arrival.'
    },
    cart: {
      id: null,
      promoCode: '',
      itemCount: 0,
      items: [],
      quote: {
        subtotalCents: 0,
        discountCents: 0,
        discountedSubtotalCents: 0,
        shippingCents: 600,
        taxCents: 0,
        totalCents: 0,
        freeShipping: false,
        freeShippingThresholdCents: 3500,
        amountToFreeShippingCents: 3500,
        promoCode: ''
      }
    },
    liveQuote: null,
    addresses: [],
    policies: new Map(Object.entries(FALLBACK_POLICIES)),
    policiesLoaded: false,
    checkoutStep: 'delivery',
    checkoutAttemptKey: null,
    activeDrawer: null,
    lastFocused: null,
    activeFlavor: 'blood-orange',
    orderQty: 1,
    motionReduced: false,
    motionPaused: false,
    externalInertRoot: null,
    handlers: {
      openAccount: null,
      openOps: null
    }
  };

  function emitEvent(name, detail) {
    const set = listeners.get(name);
    if (set) {
      for (const fn of set) {
        try {
          fn(detail);
        } catch (err) {
          console.error('[SOLIS_APP listener error]', name, err);
        }
      }
    }
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      // Ignore in restricted environments
    }
  }

  function onEvent(name, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  }

  async function apiFetch(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (
      state.authenticated &&
      state.csrfToken &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      !headers.has('X-CSRF-Token')
    ) {
      headers.set('X-CSRF-Token', state.csrfToken);
    }

    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof FormData) && typeof body !== 'string') {
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    } else if (typeof body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, {
      ...options,
      method,
      headers,
      body,
      credentials: 'same-origin'
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = data.error || data.message || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data.code || 'HTTP_ERROR';
      err.details = data.details || null;
      throw err;
    }
    return data;
  }

  /* ========================================================================
     3. DOM References
     ======================================================================== */
  const dom = {
    skipLink: document.querySelector('.skip-link'),
    header: document.getElementById('site-header'),
    main: document.getElementById('main'),
    footer: document.querySelector('.site-footer'),
    portalsRoot: document.getElementById('portals-root'),
    backdrop: document.getElementById('drawer-backdrop'),
    scrollProgress: document.getElementById('scroll-progress'),

    // Ambient + Header
    canvas: document.getElementById('fizz-canvas'),
    motionToggle: document.getElementById('motion-toggle'),
    motionLabel: document.querySelector('#motion-toggle .motion-label'),
    accountToggle: document.getElementById('account-toggle'),
    accountLabel: document.getElementById('account-toggle-label'),
    bagToggle: document.getElementById('bag-toggle'),
    bagCount: document.getElementById('bag-count'),
    mobileMenuToggle: document.getElementById('mobile-menu-toggle'),
    opsToggle: document.getElementById('ops-toggle'),

    // Hero
    heroTrack: document.getElementById('hero'),
    heroCan: document.getElementById('hero-can'),
    canShell: document.querySelector('.soda-can'),
    canFlavorName: document.getElementById('can-flavor-name'),
    canMeta: document.getElementById('can-meta'),
    flavorPills: Array.from(document.querySelectorAll('[data-flavor-btn]')),

    // Manifesto + Scrolly + Reveal
    manifestoSection: document.getElementById('manifesto'),
    manifestoLines: Array.from(document.querySelectorAll('.manifesto-line')),
    scrollyStage: document.getElementById('scrolly-stage'),
    chapters: Array.from(document.querySelectorAll('#tracked-chapters .chapter-card')),
    stageCards: [
      document.querySelector('.stage-card-1'),
      document.querySelector('.stage-card-2'),
      document.querySelector('.stage-card-3')
    ].filter(Boolean),
    stageBackdrop: document.querySelector('.stage-solar-backdrop'),
    revealTargets: Array.from(document.querySelectorAll('.reveal-calm')),

    // Collection
    scroller: document.getElementById('flavor-scroller'),
    carouselPrev: document.getElementById('carousel-prev'),
    carouselNext: document.getElementById('carousel-next'),
    collectionSearch: document.getElementById('collection-search'),
    tagFiltersWrap: document.getElementById('collection-tag-filters'),
    tagChips: Array.from(document.querySelectorAll('#collection-tag-filters [data-filter-tag]')),
    collectionSort: document.getElementById('collection-sort'),
    collectionStatus: document.getElementById('collection-status'),
    collectionEmpty: document.getElementById('collection-empty'),
    collectionEmptyMsg: document.getElementById('collection-empty-msg'),
    collectionClearBtn: document.getElementById('collection-clear'),

    // Reserve & Track Tabs
    tabReserve: document.getElementById('tab-reserve'),
    tabTrack: document.getElementById('tab-track'),
    panelReserve: document.getElementById('panel-reserve'),
    panelTrack: document.getElementById('panel-track'),
    orderHeading: document.getElementById('order-heading'),
    orderSubtitle: document.getElementById('order-subtitle'),
    packSummary: document.getElementById('pack-summary'),
    selectedPackLabel: document.getElementById('selected-pack-label'),
    selectedQtyLabel: document.getElementById('selected-qty-label'),
    packPrice: document.getElementById('pack-price'),
    shippingStatus: document.getElementById('shipping-status'),
    orderForm: document.getElementById('order-form'),
    packSelect: document.getElementById('pack-select'),
    qtyBtns: Array.from(document.querySelectorAll('.qty-btn')),
    qtyInput: document.getElementById('quantity-input'),
    emailInput: document.getElementById('email-input'),
    emailInputError: document.getElementById('email-input-error'),
    orderSubmit: document.getElementById('order-submit'),
    formFeedback: document.getElementById('form-feedback'),
    trackForm: document.getElementById('track-form'),
    trackOrderId: document.getElementById('track-order-id'),
    trackOrderIdError: document.getElementById('track-order-id-error'),
    trackOrderEmail: document.getElementById('track-order-email'),
    trackOrderEmailError: document.getElementById('track-order-email-error'),
    trackSubmit: document.getElementById('track-submit'),
    trackFeedback: document.getElementById('track-feedback'),

    // Mobile Nav Drawer
    mobileDrawer: document.getElementById('mobile-nav-drawer'),
    mobileClose: document.getElementById('mobile-nav-close'),
    mobileNavLinks: Array.from(document.querySelectorAll('.mobile-nav-link')),
    mobileAccountBtn: document.getElementById('mobile-account-btn'),
    mobileBagBtn: document.getElementById('mobile-bag-btn'),
    mobileBagCount: document.getElementById('mobile-bag-count'),
    mobileMotionToggle: document.getElementById('mobile-motion-toggle'),
    mobileOpsBtn: document.getElementById('mobile-ops-btn'),

    // Bag & Checkout Drawer
    bagDrawer: document.getElementById('bag-drawer'),
    bagClose: document.getElementById('bag-close'),
    bagEmpty: document.getElementById('bag-empty'),
    bagBrowseBtn: document.getElementById('bag-browse-btn'),
    bagContent: document.getElementById('bag-content'),
    bagItems: document.getElementById('bag-items'),
    promoForm: document.getElementById('promo-form'),
    promoInput: document.getElementById('promo-input'),
    promoApply: document.getElementById('promo-apply'),
    promoRemove: document.getElementById('promo-remove'),
    promoFeedback: document.getElementById('promo-feedback'),
    bagSubtotal: document.getElementById('bag-subtotal'),
    bagDiscountRow: document.getElementById('bag-discount-row'),
    bagDiscountLabel: document.getElementById('bag-discount-label'),
    bagDiscount: document.getElementById('bag-discount'),
    bagTax: document.getElementById('bag-tax'),
    bagShipping: document.getElementById('bag-shipping'),
    bagShippingNote: document.getElementById('bag-shipping-note'),
    bagTotal: document.getElementById('bag-total'),
    checkoutForm: document.getElementById('checkout-form'),
    stepPillDelivery: document.getElementById('step-pill-delivery'),
    stepPillPayment: document.getElementById('step-pill-payment'),
    stepDeliveryPane: document.getElementById('checkout-step-delivery'),
    stepPaymentPane: document.getElementById('checkout-step-payment'),
    savedAddressWrap: document.getElementById('saved-address-wrap'),
    savedAddressSelect: document.getElementById('saved-address-select'),
    chkName: document.getElementById('chk-name'),
    chkNameError: document.getElementById('chk-name-error'),
    chkEmail: document.getElementById('chk-email'),
    chkEmailError: document.getElementById('chk-email-error'),
    chkAddress: document.getElementById('chk-address'),
    chkAddressError: document.getElementById('chk-address-error'),
    chkCity: document.getElementById('chk-city'),
    chkCityError: document.getElementById('chk-city-error'),
    chkPostal: document.getElementById('chk-postal'),
    chkPostalError: document.getElementById('chk-postal-error'),
    chkContinueBtn: document.getElementById('checkout-continue-btn'),
    paymentShipPreview: document.getElementById('payment-ship-preview'),
    paymentAmountDue: document.getElementById('payment-amount-due'),
    chkSubmit: document.getElementById('checkout-submit'),
    chkBackBtn: document.getElementById('checkout-back-btn'),
    chkFeedback: document.getElementById('checkout-feedback'),
    chkReceipt: document.getElementById('checkout-receipt'),

    // Policy Drawer
    policyDrawer: document.getElementById('policy-drawer'),
    policyClose: document.getElementById('policy-close'),
    policyTabs: Array.from(document.querySelectorAll('.policy-tab')),
    policyContent: document.getElementById('policy-content'),
    policyTriggers: Array.from(document.querySelectorAll('[data-policy]'))
  };

  /* ========================================================================
     4. Accessibility Utilities (Inert Trapping, Validation, Busy Buttons)
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

  function setButtonBusy(btn, isBusy, busyLabel) {
    if (!btn) return;
    if (isBusy) {
      if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent.trim();
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('is-busy');
      if (busyLabel) btn.textContent = busyLabel;
    } else {
      btn.removeAttribute('aria-disabled');
      btn.classList.remove('is-busy');
      if (btn.dataset.idleLabel) {
        btn.textContent = btn.dataset.idleLabel;
      }
    }
  }

  function isButtonDisabled(btn) {
    return !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true';
  }

  function getFocusableElements(container) {
    if (!container) return [];
    const selector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([type="hidden"]):not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');
    return Array.from(container.querySelectorAll(selector)).filter((el) => {
      if (el.hidden || el.closest('[hidden]')) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  function setBackgroundInert(isInert, activeElementRoot = null) {
    state.externalInertRoot = isInert && activeElementRoot && dom.portalsRoot?.contains(activeElementRoot)
      ? activeElementRoot
      : null;

    const landmarks = [
      dom.skipLink,
      dom.header,
      dom.main,
      dom.footer,
      dom.bagDrawer,
      dom.mobileDrawer,
      dom.policyDrawer,
      dom.portalsRoot
    ].filter(Boolean);

    for (const el of landmarks) {
      const keepActive =
        el === activeElementRoot ||
        (activeElementRoot && el.contains(activeElementRoot));
      if (isInert && !keepActive) {
        el.inert = true;
        el.setAttribute('aria-hidden', 'true');
      } else {
        el.inert = false;
        el.removeAttribute('aria-hidden');
      }
    }
  }

  function getActiveDrawerEl() {
    if (state.activeDrawer === 'bag') return dom.bagDrawer;
    if (state.activeDrawer === 'mobile') return dom.mobileDrawer;
    if (state.activeDrawer === 'policy') return dom.policyDrawer;
    return null;
  }

  function syncDrawerAriaExpanded() {
    dom.bagToggle?.setAttribute('aria-expanded', state.activeDrawer === 'bag' ? 'true' : 'false');
    dom.mobileMenuToggle?.setAttribute('aria-expanded', state.activeDrawer === 'mobile' ? 'true' : 'false');
  }

  function closeStoreDrawers({ restoreFocus = true } = {}) {
    const prevDrawer = state.activeDrawer;
    if (!prevDrawer) return;
    state.activeDrawer = null;

    if (dom.bagDrawer) dom.bagDrawer.hidden = true;
    if (dom.mobileDrawer) dom.mobileDrawer.hidden = true;
    if (dom.policyDrawer) dom.policyDrawer.hidden = true;
    if (dom.backdrop) dom.backdrop.hidden = true;

    setBackgroundInert(false);
    syncDrawerAriaExpanded();

    if (restoreFocus && state.lastFocused && state.lastFocused.isConnected) {
      try {
        state.lastFocused.focus();
      } catch {
        // Ignore unfocusable fallback
      }
    }
    state.lastFocused = null;
  }

  function openStoreDrawer(kind, focusTarget) {
    const drawerEl =
      kind === 'bag'
        ? dom.bagDrawer
        : kind === 'mobile'
          ? dom.mobileDrawer
          : kind === 'policy'
            ? dom.policyDrawer
            : null;
    if (!drawerEl) return;

    if (!state.activeDrawer && document.activeElement instanceof HTMLElement) {
      state.lastFocused = document.activeElement;
    }

    if (dom.bagDrawer && kind !== 'bag') dom.bagDrawer.hidden = true;
    if (dom.mobileDrawer && kind !== 'mobile') dom.mobileDrawer.hidden = true;
    if (dom.policyDrawer && kind !== 'policy') dom.policyDrawer.hidden = true;

    state.activeDrawer = kind;
    drawerEl.hidden = false;
    if (dom.backdrop) dom.backdrop.hidden = false;
    setBackgroundInert(true, drawerEl);
    syncDrawerAriaExpanded();

    const target = focusTarget || getFocusableElements(drawerEl)[0];
    if (target && typeof target.focus === 'function') {
      window.requestAnimationFrame(() => target.focus());
    }
  }

  function wireDrawerFocusAndKeys() {
    dom.backdrop?.addEventListener('click', () => closeStoreDrawers({ restoreFocus: true }));
    dom.bagClose?.addEventListener('click', () => closeStoreDrawers({ restoreFocus: true }));
    dom.mobileClose?.addEventListener('click', () => closeStoreDrawers({ restoreFocus: true }));
    dom.policyClose?.addEventListener('click', () => closeStoreDrawers({ restoreFocus: true }));

    document.addEventListener('keydown', (e) => {
      const drawerEl = getActiveDrawerEl();
      if (!drawerEl) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeStoreDrawers({ restoreFocus: true });
        return;
      }

      if (e.key === 'Tab') {
        const focusables = getFocusableElements(drawerEl);
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
  }

  /* ========================================================================
     5. Ambient Fizz Canvas & Hero / Scrollytelling Choreography
     ======================================================================== */
  const prefersReducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  state.motionReduced = Boolean(prefersReducedQuery.matches);
  state.motionPaused = state.motionReduced;

  let fizzRaf = 0;
  let bubbles = [];

  function initBubbles() {
    if (!dom.canvas || typeof dom.canvas.getContext !== 'function') return;
    const width = window.innerWidth || 1280;
    const height = window.innerHeight || 720;
    const count = width < 640 ? 20 : 38;
    bubbles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 3 + Math.random() * 14,
      vy: 0.25 + Math.random() * 0.65,
      vx: (Math.random() - 0.5) * 0.22,
      wobble: Math.random() * Math.PI * 2,
      alpha: 0.16 + Math.random() * 0.28
    }));
  }

  function resizeFizzCanvas() {
    if (!dom.canvas || typeof dom.canvas.getContext !== 'function') return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    dom.canvas.width = Math.floor(w * dpr);
    dom.canvas.height = Math.floor(h * dpr);
    dom.canvas.style.width = `${w}px`;
    dom.canvas.style.height = `${h}px`;
    const ctx = dom.canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawFizzFrame(advance) {
    if (!dom.canvas || typeof dom.canvas.getContext !== 'function') return;
    const ctx = dom.canvas.getContext('2d');
    if (!ctx) return;
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    ctx.clearRect(0, 0, w, h);

    for (const b of bubbles) {
      if (advance) {
        b.wobble += 0.014;
        b.y -= b.vy;
        b.x += b.vx + Math.sin(b.wobble) * 0.18;
        if (b.y < -b.r * 2) {
          b.y = h + b.r * 2;
          b.x = Math.random() * w;
        }
        if (b.x < -b.r * 2) b.x = w + b.r;
        if (b.x > w + b.r * 2) b.x = -b.r;
      }

      const grad = ctx.createRadialGradient(
        b.x - b.r * 0.32,
        b.y - b.r * 0.32,
        b.r * 0.1,
        b.x,
        b.y,
        b.r
      );
      grad.addColorStop(0, `rgba(255, 255, 255, ${Math.min(0.85, b.alpha + 0.35)})`);
      grad.addColorStop(0.55, `rgba(186, 224, 252, ${b.alpha})`);
      grad.addColorStop(1, 'rgba(92, 168, 224, 0.03)');

      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(0.75, b.alpha + 0.25)})`;
      ctx.stroke();
    }
  }

  function renderMotionButton() {
    const paused = state.motionPaused;
    const text = paused ? 'Resume Fizz' : 'Pause Fizz';
    if (dom.motionToggle) {
      dom.motionToggle.classList.toggle('is-paused', paused);
      dom.motionToggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
      dom.motionToggle.setAttribute('aria-label', `${text} — ambient bubbles`);
      if (dom.motionLabel) dom.motionLabel.textContent = text;
    }
    if (dom.mobileMotionToggle) {
      dom.mobileMotionToggle.classList.toggle('is-paused', paused);
      dom.mobileMotionToggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
      dom.mobileMotionToggle.setAttribute('aria-label', `${text} — ambient bubbles`);
      dom.mobileMotionToggle.textContent = text;
    }
  }

  function stopFizzLoop() {
    if (fizzRaf) {
      window.cancelAnimationFrame(fizzRaf);
      fizzRaf = 0;
    }
    drawFizzFrame(false);
  }

  function startFizzLoop() {
    if (state.motionPaused || !dom.canvas || typeof dom.canvas.getContext !== 'function') return;
    if (fizzRaf) return;
    const tick = () => {
      if (state.motionPaused) {
        fizzRaf = 0;
        return;
      }
      drawFizzFrame(true);
      fizzRaf = window.requestAnimationFrame(tick);
    };
    fizzRaf = window.requestAnimationFrame(tick);
  }

  function initAmbientAndScroll() {
    resizeFizzCanvas();
    initBubbles();
    renderMotionButton();
    drawFizzFrame(false);
    if (!state.motionPaused) startFizzLoop();

    window.addEventListener('resize', () => {
      resizeFizzCanvas();
      initBubbles();
      drawFizzFrame(false);
    });

    const toggleFizz = () => {
      state.motionPaused = !state.motionPaused;
      renderMotionButton();
      if (state.motionPaused) stopFizzLoop();
      else startFizzLoop();
    };
    dom.motionToggle?.addEventListener('click', toggleFizz);
    dom.mobileMotionToggle?.addEventListener('click', toggleFizz);

    if (typeof prefersReducedQuery.addEventListener === 'function') {
      prefersReducedQuery.addEventListener('change', (e) => {
        state.motionReduced = Boolean(e.matches);
        if (state.motionReduced) {
          state.motionPaused = true;
          renderMotionButton();
          stopFizzLoop();
          for (const el of dom.revealTargets) {
            el.classList.remove('js-reveal-ready');
            el.classList.add('is-visible');
          }
        }
      });
    }

    // Reveal Observer for .reveal-calm blocks (respects prefers-reduced-motion)
    if (state.motionReduced || prefersReducedQuery.matches || !('IntersectionObserver' in window)) {
      for (const el of dom.revealTargets) {
        el.classList.remove('js-reveal-ready');
        el.classList.add('is-visible');
      }
    } else {
      const revealObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
              revealObserver.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.12 }
      );
      for (const el of dom.revealTargets) {
        el.classList.add('js-reveal-ready');
        revealObserver.observe(el);
      }
    }

    const supportsViewTimeline =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('animation-timeline: view()');

    let scrollScheduled = false;
    function updateScrollVisuals() {
      scrollScheduled = false;
      const docEl = document.documentElement;
      const scrollable = Math.max(1, docEl.scrollHeight - window.innerHeight);
      const docProgress = clamp(window.scrollY / scrollable, 0, 1);
      if (dom.scrollProgress) {
        dom.scrollProgress.style.transform = `scaleX(${docProgress.toFixed(4)})`;
      }

      if (state.motionReduced || state.motionPaused) {
        if (dom.heroCan) dom.heroCan.style.transform = '';
        for (const line of dom.manifestoLines) line.style.opacity = '1';
        return;
      }

      if (!supportsViewTimeline) {
        if (dom.heroTrack && dom.heroCan) {
          const rect = dom.heroTrack.getBoundingClientRect();
          const heroRange = Math.max(1, dom.heroTrack.offsetHeight - window.innerHeight);
          const hp = clamp(-rect.top / heroRange, 0, 1);
          const lift = -hp * 22;
          const tilt = (0.5 - hp) * 4;
          dom.heroCan.style.transform = `translate3d(0, ${lift.toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
        }

        if (dom.manifestoLines.length > 0) {
          const midY = window.innerHeight * 0.56;
          for (const line of dom.manifestoLines) {
            const r = line.getBoundingClientRect();
            const lineMid = r.top + r.height / 2;
            const dist = Math.abs(lineMid - midY);
            const focus = clamp(1 - dist / (window.innerHeight * 0.42), 0.35, 1);
            line.style.opacity = focus.toFixed(3);
          }
        }

        if (dom.chapters.length > 0 && dom.stageCards.length === 3) {
          const midY = window.innerHeight * 0.5;
          let activeIdx = 0;
          let minDist = Infinity;
          dom.chapters.forEach((card, idx) => {
            const r = card.getBoundingClientRect();
            const d = Math.abs(r.top + r.height / 2 - midY);
            if (d < minDist) {
              minDist = d;
              activeIdx = idx;
            }
          });
          dom.stageCards.forEach((sc, idx) => {
            sc.style.opacity = idx === activeIdx ? '1' : '0';
            sc.style.zIndex = idx === activeIdx ? '3' : '1';
          });
        }
      }
    }

    window.addEventListener(
      'scroll',
      () => {
        if (scrollScheduled) return;
        scrollScheduled = true;
        window.requestAnimationFrame(updateScrollVisuals);
      },
      { passive: true }
    );
    updateScrollVisuals();
  }

  function applyActiveFlavor(slug) {
    const preset = FLAVOR_PRESETS[slug] || FLAVOR_PRESETS['blood-orange'];
    const live = state.productBySlug.get(preset.slug);
    state.activeFlavor = preset.slug;
    document.documentElement.setAttribute('data-flavor', preset.slug);

    for (const btn of dom.flavorPills) {
      const isMatch = btn.dataset.flavorBtn === preset.slug;
      btn.classList.toggle('is-active', isMatch);
      btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
    }

    if (dom.canFlavorName) dom.canFlavorName.innerHTML = preset.canTitleHtml;
    const calories = live?.calories ?? preset.calories;
    if (dom.canMeta) {
      dom.canMeta.innerHTML = `<span>${escapeHtml(calories)} CAL</span><span>0G ADDED SUGAR</span><span>12 FL OZ</span>`;
    }
    if (dom.canShell) {
      const labelName = live?.name || preset.shortName;
      dom.canShell.setAttribute('aria-label', `SOLIS ${labelName} 12 fl oz aluminum can`);
    }
  }

  /* ========================================================================
     6. Catalog, Variants, Stock Badges & Reserve Pack Summary
     ======================================================================== */
  function getDefaultVariantForProduct(product) {
    if (!product || !Array.isArray(product.variants) || product.variants.length === 0) return null;
    const savedId = state.selectedVariantBySlug.get(product.slug);
    if (savedId) {
      const match = product.variants.find((v) => v.id === savedId && v.active);
      if (match) return match;
    }
    const preferred =
      product.variants.find((v) => v.packSize === 12 && v.active && v.inStock) ||
      product.variants.find((v) => v.packSize === 12 && v.active) ||
      product.variants.find((v) => v.active && v.inStock) ||
      product.variants[0];
    if (preferred) state.selectedVariantBySlug.set(product.slug, preferred.id);
    return preferred;
  }

  function buildStockBadgeInfo(variant) {
    const avail = Number(variant?.available ?? 0);
    if (!variant || avail <= 0 || !variant.inStock) {
      return { className: 'stock-badge is-out-of-stock', text: 'Out of stock' };
    }
    if (avail <= 5) {
      return { className: 'stock-badge is-low-stock', text: `Low stock · ${avail} left` };
    }
    return { className: 'stock-badge is-in-stock', text: `In stock · ${avail} ready` };
  }

  function indexProducts(products) {
    state.products = Array.isArray(products) ? products : [];
    state.productBySlug.clear();
    state.variantById.clear();
    state.variantBySku.clear();

    for (const p of state.products) {
      state.productBySlug.set(p.slug, p);
      if (Array.isArray(p.variants)) {
        for (const v of p.variants) {
          const enriched = { ...v, productName: p.name, productSlug: p.slug, tag: p.tag, calories: p.calories };
          state.variantById.set(Number(v.id), enriched);
          state.variantBySku.set(String(v.sku).toUpperCase(), enriched);
        }
      }
    }
  }

  function buildFlavorCardEl(product) {
    const preset = FLAVOR_PRESETS[product.slug] || {
      slug: product.slug,
      canGradient: 'linear-gradient(155deg, #6ba4d9 0%, #2c5b8c 58%, #183454 100%)',
      miniTitle: String(product.name || '').toUpperCase().slice(0, 16)
    };
    const accent = product.accentColor || preset.accentColor || '#0A5E9E';
    const activeVariant = getDefaultVariantForProduct(product);
    const activeVariants = (product.variants || []).filter((v) => v.active !== false);
    const stockInfo = buildStockBadgeInfo(activeVariant);
    const lotText = activeVariant?.nextLot?.lotNumber
      ? `Lot ${activeVariant.nextLot.lotNumber} · Exp ${activeVariant.nextLot.expiresAt}`
      : (product.coldChainRequired ? 'Ships chilled · 35–42°F (2–6°C)' : '');
    const cardBtnDisabled = !activeVariant || !activeVariant.inStock || activeVariant.available <= 0;

    const article = document.createElement('article');
    article.className = 'flavor-card';
    article.dataset.flavorId = product.slug;
    article.style.setProperty('--card-accent', accent);

    const variantsMarkup = activeVariants
      .map((v) => {
        const isSel = activeVariant && v.id === activeVariant.id;
        return `<button type="button" class="variant-pill${isSel ? ' is-active' : ''}" data-variant-id="${escapeHtml(v.id)}" data-product-slug="${escapeHtml(product.slug)}" aria-pressed="${isSel ? 'true' : 'false'}">${escapeHtml(v.label)}</button>`;
      })
      .join('');

    article.innerHTML = `
      <div class="flavor-card-top">
        <span class="flavor-tag">${escapeHtml(product.tag)}</span>
        <span class="flavor-cal">${escapeHtml(product.calories)} cal</span>
      </div>
      <div class="mini-can-wrap">
        <div class="mini-can" style="--can-bg: ${escapeHtml(preset.canGradient)};">
          <div class="mini-can-rim-top"></div>
          <div class="mini-can-neck"></div>
          <div class="mini-can-body">
            <div class="mini-can-condensation"></div>
            <div class="mini-can-label">
              <span class="mini-can-kicker">${product.slug === 'variety' ? 'CURATED BOX' : 'BOTANICAL'}</span>
              <div class="mini-can-band">
                <span class="mini-can-brand">SOLIS</span>
                <span class="mini-can-sub">${escapeHtml(preset.miniTitle)}</span>
              </div>
              <div class="mini-can-art" aria-hidden="true">
                <span class="mini-art-sun"></span>
                <span class="mini-art-wave"></span>
              </div>
              <span class="mini-can-oz">${escapeHtml(product.calories)} CAL · 12 OZ</span>
            </div>
            <div class="mini-can-specular"></div>
          </div>
          <div class="mini-can-rim-bottom"></div>
        </div>
      </div>
      <h3>${escapeHtml(product.name)}</h3>
      <p>${escapeHtml(product.description)}</p>
      <div class="variant-pills" role="group" aria-label="Pack size for ${escapeHtml(product.name)}">
        ${variantsMarkup}
      </div>
      <div class="card-meta-row">
        <strong class="flavor-price">${escapeHtml(formatCents(activeVariant ? activeVariant.priceCents : product.minPriceCents))}</strong>
        <span class="${escapeHtml(stockInfo.className)}">${escapeHtml(stockInfo.text)}</span>
      </div>
      ${lotText ? `<p class="cold-chain-note">${escapeHtml(lotText)}</p>` : ''}
      <button type="button" class="btn btn-outline add-pack-btn" data-add-variant-id="${escapeHtml(activeVariant ? activeVariant.id : '')}" data-add-flavor="${escapeHtml(product.slug)}"${cardBtnDisabled ? ' aria-disabled="true"' : ''}>
        ${cardBtnDisabled ? 'Out of Stock' : `Add ${escapeHtml(activeVariant ? activeVariant.label : 'Pack')} to Bag`}
      </button>
    `;
    return article;
  }

  function renderCollection(products) {
    if (!dom.scroller) return;
    dom.scroller.innerHTML = '';

    const count = products.length;
    if (dom.collectionEmpty) dom.collectionEmpty.hidden = count > 0;
    if (dom.scroller) dom.scroller.hidden = count === 0;

    if (dom.collectionStatus) {
      dom.collectionStatus.textContent =
        count === 0
          ? '0 selections shown.'
          : `Showing ${count} ${count === 1 ? 'selection' : 'selections'}.`;
    }

    const fragment = document.createDocumentFragment();
    for (const p of products) {
      fragment.appendChild(buildFlavorCardEl(p));
    }
    dom.scroller.appendChild(fragment);
  }

  function syncPackSelect(allProducts) {
    if (!dom.packSelect) return;
    const prevValue = dom.packSelect.value;
    const options = [];
    for (const p of allProducts) {
      for (const v of p.variants || []) {
        if (v.active === false) continue;
        options.push({
          sku: v.sku,
          variantId: v.id,
          label: p.slug === 'variety' ? p.name : `${p.name} (${v.label})`,
          priceCents: v.priceCents,
          inStock: v.inStock,
          available: v.available
        });
      }
    }

    if (options.length === 0) return;

    dom.packSelect.innerHTML = options
      .map(
        (opt) =>
          `<option value="${escapeHtml(opt.sku)}" data-variant-id="${escapeHtml(opt.variantId)}" data-price-cents="${escapeHtml(opt.priceCents)}">${escapeHtml(opt.label)} — ${escapeHtml(formatCents(opt.priceCents))}${opt.inStock ? '' : ' (Out of stock)'}</option>`
      )
      .join('');

    const keepPrev = options.some((o) => o.sku === prevValue);
    if (keepPrev) {
      dom.packSelect.value = prevValue;
    } else {
      const def = options.find((o) => o.sku === 'SOLIS-VAR-12') || options[0];
      dom.packSelect.value = def.sku;
    }
    updateReserveSummary();
  }

  function updateReserveSummary() {
    if (!dom.packSelect) return;
    const sku = String(dom.packSelect.value || '').toUpperCase();
    const selectedOpt = dom.packSelect.selectedOptions?.[0];
    const variant = state.variantBySku.get(sku);
    const qty = clamp(Number(state.orderQty || 1), 1, state.config.maxItemQty);

    const labelText = variant
      ? (variant.productSlug === 'variety' ? variant.productName : `${variant.productName} (${variant.label})`)
      : (selectedOpt?.textContent.split(' — ')[0] || 'Variety 12-Pack (All 4 Flavors)');

    const unitCents = variant
      ? variant.priceCents
      : Number(selectedOpt?.dataset.priceCents || 3400);

    const subtotalCents = unitCents * qty;
    const threshold = state.config.freeShippingThresholdCents;
    const remainingCents = Math.max(0, threshold - subtotalCents);

    if (dom.selectedPackLabel) dom.selectedPackLabel.textContent = labelText;
    if (dom.selectedQtyLabel) dom.selectedQtyLabel.textContent = `${qty} × Pack`;
    if (dom.packPrice) dom.packPrice.textContent = formatCents(subtotalCents);
    if (dom.shippingStatus) {
      dom.shippingStatus.textContent =
        remainingCents === 0
          ? 'Complimentary chilled shipping unlocked'
          : `Add ${formatCents(remainingCents)} for free shipping`;
      dom.shippingStatus.classList.toggle('is-free', remainingCents === 0);
    }
  }

  let catalogRequestSeq = 0;
  async function refreshCatalog(filterOverrides = null) {
    if (filterOverrides && typeof filterOverrides === 'object') {
      state.filters = { ...state.filters, ...filterOverrides };
    }
    const seq = ++catalogRequestSeq;
    const params = new URLSearchParams();
    if (state.filters.q.trim()) params.set('q', state.filters.q.trim());
    if (state.filters.tag && state.filters.tag !== 'all') params.set('tag', state.filters.tag);
    if (state.filters.sort) params.set('sort', state.filters.sort);

    try {
      const data = await apiFetch(`/api/products?${params.toString()}`);
      if (seq !== catalogRequestSeq) return state.products;

      if (data.freeShippingThresholdCents !== undefined) {
        state.config.freeShippingThresholdCents = Number(data.freeShippingThresholdCents);
      }
      if (data.standardShippingCents !== undefined) {
        state.config.standardShippingCents = Number(data.standardShippingCents);
      }
      if (data.taxRateBps !== undefined) state.config.taxRateBps = Number(data.taxRateBps);
      if (data.maxItemQty !== undefined) state.config.maxItemQty = Number(data.maxItemQty);
      if (data.coldChainNotice) state.config.coldChainNotice = formatColdChainNotice(data.coldChainNotice);

      const list = Array.isArray(data.products) ? data.products : [];
      const isFiltered = Boolean(params.get('q') || params.get('tag'));
      if (!isFiltered) {
        indexProducts(list);
        syncPackSelect(list);
      } else if (state.products.length === 0) {
        // Ensure full catalog is indexed if first load happened filtered
        const full = await apiFetch('/api/products').catch(() => null);
        if (full && Array.isArray(full.products)) {
          indexProducts(full.products);
          syncPackSelect(full.products);
        }
      }

      renderCollection(list);
      applyActiveFlavor(state.activeFlavor);
      emitEvent('solis:catalog-updated', { products: list, config: state.config });
      return list;
    } catch (err) {
      if (dom.collectionStatus) {
        dom.collectionStatus.textContent = `Showing offline menu preview (${err.message}).`;
      }
      return state.products;
    }
  }

  /* ========================================================================
     7. Shopping Bag, Live Server Quote, & 2-Step Sandbox Checkout
     ======================================================================== */
  function invalidateCheckoutAttempt() {
    state.checkoutAttemptKey = null;
  }

  function setCheckoutStep(step) {
    state.checkoutStep = step === 'payment' ? 'payment' : 'delivery';
    const isPayment = state.checkoutStep === 'payment';
    if (dom.stepDeliveryPane) dom.stepDeliveryPane.hidden = isPayment;
    if (dom.stepPaymentPane) dom.stepPaymentPane.hidden = !isPayment;
    dom.stepPillDelivery?.classList.toggle('is-active', !isPayment);
    dom.stepPillPayment?.classList.toggle('is-active', isPayment);
  }

  function renderBagTotals(quote) {
    const q = quote || state.cart.quote;
    if (!q) return;

    if (dom.bagSubtotal) dom.bagSubtotal.textContent = formatCents(q.subtotalCents);
    if (dom.bagDiscountRow) {
      const hasDiscount = Number(q.discountCents || 0) > 0;
      dom.bagDiscountRow.hidden = !hasDiscount;
      if (hasDiscount) {
        if (dom.bagDiscountLabel) {
          dom.bagDiscountLabel.textContent = q.promoCode ? `Promo (${q.promoCode})` : 'Promo discount';
        }
        if (dom.bagDiscount) dom.bagDiscount.textContent = `-${formatCents(q.discountCents)}`;
      }
    }
    if (dom.bagTax) dom.bagTax.textContent = formatCents(q.taxCents);
    if (dom.bagShipping) {
      dom.bagShipping.textContent = Number(q.shippingCents || 0) === 0 ? 'Free' : formatCents(q.shippingCents);
    }
    if (dom.bagShippingNote) {
      dom.bagShippingNote.textContent = q.freeShipping
        ? 'Complimentary chilled shipping applied.'
        : `Add ${formatCents(q.amountToFreeShippingCents)} more for complimentary chilled shipping.`;
    }
    if (dom.bagTotal) dom.bagTotal.textContent = formatCents(q.totalCents);
    if (dom.paymentAmountDue) dom.paymentAmountDue.textContent = formatCents(q.totalCents);

    const activePromo = q.promoCode || state.cart.promoCode || '';
    if (dom.promoInput && document.activeElement !== dom.promoInput) {
      dom.promoInput.value = activePromo;
    }
    if (dom.promoRemove) dom.promoRemove.hidden = !activePromo;
  }

  function buildBagItemLi(item) {
    const li = document.createElement('li');
    li.className = 'bag-item';
    li.dataset.variantId = String(item.variantId);
    const maxAllowed = Math.min(state.config.maxItemQty, Number(item.available ?? state.config.maxItemQty));
    const atMax = item.quantity >= maxAllowed;

    li.innerHTML = `
      <div class="bag-item-info">
        <strong class="bag-item-name">${escapeHtml(item.productName)}</strong>
        <span class="bag-item-price">${escapeHtml(item.label)} · ${escapeHtml(item.sku)} · ${escapeHtml(formatCents(item.lineTotalCents))}</span>
      </div>
      <div class="bag-item-controls">
        <button type="button" class="bag-qty-btn" data-bag-action="dec" data-variant-id="${escapeHtml(item.variantId)}" aria-label="Decrease quantity of ${escapeHtml(item.productName)} ${escapeHtml(item.label)}">−</button>
        <span class="bag-item-qty">${escapeHtml(item.quantity)}</span>
        <button type="button" class="bag-qty-btn" data-bag-action="inc" data-variant-id="${escapeHtml(item.variantId)}" aria-label="Increase quantity of ${escapeHtml(item.productName)} ${escapeHtml(item.label)}"${atMax ? ' aria-disabled="true"' : ''}>+</button>
        <button type="button" class="bag-remove-btn" data-bag-action="remove" data-variant-id="${escapeHtml(item.variantId)}">Remove</button>
      </div>
    `;
    return li;
  }

  function renderBag(focusVariantId = null) {
    const cart = state.cart;
    const count = Number(cart.itemCount || 0);
    if (dom.bagCount) dom.bagCount.textContent = String(count);
    if (dom.mobileBagCount) dom.mobileBagCount.textContent = String(count);

    const isEmpty = !Array.isArray(cart.items) || cart.items.length === 0;
    const showingReceipt = Boolean(dom.chkReceipt && !dom.chkReceipt.hidden);

    if (dom.bagEmpty) dom.bagEmpty.hidden = !isEmpty || showingReceipt;
    if (dom.bagContent) dom.bagContent.hidden = isEmpty;

    const wasFocusInsideItems = Boolean(
      dom.bagItems &&
      document.activeElement instanceof HTMLElement &&
      dom.bagItems.contains(document.activeElement)
    );

    if (dom.bagItems) {
      dom.bagItems.innerHTML = '';
      if (!isEmpty) {
        const frag = document.createDocumentFragment();
        for (const item of cart.items) frag.appendChild(buildBagItemLi(item));
        dom.bagItems.appendChild(frag);
      }
    }

    renderBagTotals(state.liveQuote || cart.quote);

    if (wasFocusInsideItems && state.activeDrawer === 'bag') {
      let nextFocus = null;
      if (focusVariantId !== null) {
        nextFocus = dom.bagItems?.querySelector(
          `[data-variant-id="${CSS.escape(String(focusVariantId))}"] button`
        );
      }
      if (!nextFocus && dom.bagItems) {
        nextFocus = dom.bagItems.querySelector('button');
      }
      if (!nextFocus) {
        nextFocus = isEmpty ? dom.bagBrowseBtn || dom.bagClose : dom.bagClose;
      }
      if (nextFocus && typeof nextFocus.focus === 'function') nextFocus.focus();
    }
  }

  async function fetchLiveCheckoutQuote() {
    if (!state.cart.items || state.cart.items.length === 0) {
      state.liveQuote = null;
      renderBagTotals(state.cart.quote);
      return state.cart.quote;
    }
    try {
      const payload = {
        items: state.cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        promoCode: state.cart.promoCode || ''
      };
      const data = await apiFetch('/api/checkout/quote', {
        method: 'POST',
        body: payload
      });
      state.liveQuote = data.quote || data;
      renderBagTotals(state.liveQuote);
      return state.liveQuote;
    } catch {
      renderBagTotals(state.cart.quote);
      return state.cart.quote;
    }
  }

  async function refreshCart(focusVariantId = null) {
    try {
      const data = await apiFetch('/api/cart');
      if (data.cart) state.cart = data.cart;
      state.liveQuote = state.cart.quote || null;
      renderBag(focusVariantId);
      if (state.cart.items && state.cart.items.length > 0) {
        await fetchLiveCheckoutQuote();
      }
      emitEvent('solis:cart-updated', { cart: state.cart, quote: state.liveQuote || state.cart.quote });
      return state.cart;
    } catch {
      renderBag(focusVariantId);
      return state.cart;
    }
  }

  async function addToBag({ variantId, sku, quantity = 1, openBag = false } = {}) {
    const body = { quantity: Number(quantity) || 1 };
    if (variantId) body.variantId = Number(variantId);
    else if (sku) body.sku = String(sku);

    const data = await apiFetch('/api/cart', { method: 'POST', body });
    invalidateCheckoutAttempt();
    if (data.cart) state.cart = data.cart;
    if (dom.chkReceipt) dom.chkReceipt.hidden = true;
    await fetchLiveCheckoutQuote();
    renderBag();
    emitEvent('solis:cart-updated', { cart: state.cart, quote: state.liveQuote || state.cart.quote });
    if (openBag) {
      setCheckoutStep('delivery');
      openStoreDrawer('bag', dom.bagClose);
    }
    return state.cart;
  }

  async function updateBagItemQty(variantId, quantity) {
    const numQty = Number(quantity);
    invalidateCheckoutAttempt();
    const data = await apiFetch('/api/cart', {
      method: 'PATCH',
      body: { variantId: Number(variantId), quantity: numQty }
    });
    if (data.cart) state.cart = data.cart;
    await fetchLiveCheckoutQuote();
    renderBag(numQty > 0 ? variantId : null);
    emitEvent('solis:cart-updated', { cart: state.cart, quote: state.liveQuote || state.cart.quote });
  }

  function showPromoFeedback(message, isError = false) {
    if (!dom.promoFeedback) return;
    dom.promoFeedback.textContent = message;
    dom.promoFeedback.classList.toggle('is-error', isError);
    dom.promoFeedback.classList.toggle('is-success', !isError && Boolean(message));
  }

  function showCheckoutFeedback(message, isError = false) {
    if (!dom.chkFeedback) return;
    dom.chkFeedback.textContent = message;
    dom.chkFeedback.classList.toggle('is-error', isError);
    dom.chkFeedback.classList.toggle('is-success', !isError && Boolean(message));
  }

  function validateDeliveryFields() {
    const fields = [
      {
        el: dom.chkName,
        err: dom.chkNameError,
        check: (v) => v.trim().length >= 2,
        msg: 'Enter recipient full name (at least 2 characters).'
      },
      {
        el: dom.chkEmail,
        err: dom.chkEmailError,
        check: (v) => isValidEmail(v),
        msg: 'Enter a valid email address for receipt & order tracking.'
      },
      {
        el: dom.chkAddress,
        err: dom.chkAddressError,
        check: (v) => v.trim().length >= 4,
        msg: 'Enter a complete street address.'
      },
      {
        el: dom.chkCity,
        err: dom.chkCityError,
        check: (v) => v.trim().length >= 2,
        msg: 'Enter delivery city.'
      },
      {
        el: dom.chkPostal,
        err: dom.chkPostalError,
        check: (v) => v.trim().length >= 3,
        msg: 'Enter a valid postal or ZIP code.'
      }
    ];

    let firstInvalid = null;
    for (const f of fields) {
      const ok = f.el ? f.check(f.el.value || '') : false;
      setFieldError(f.el, f.err, ok ? '' : f.msg);
      if (!ok && !firstInvalid) firstInvalid = f.el;
    }
    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
  }

  function renderCheckoutReceipt(order) {
    if (!dom.chkReceipt) return;
    const itemRows = (order.items || [])
      .map((item) => {
        const lotInfo = item.lotNumber
          ? ` · Lot ${escapeHtml(item.lotNumber)}${item.expiresAt ? ` (Exp ${escapeHtml(item.expiresAt)})` : ''}`
          : '';
        return `<li><strong>${escapeHtml(item.quantity)}×</strong> ${escapeHtml(item.productName)} (${escapeHtml(item.variantLabel)})${lotInfo} — <strong>${escapeHtml(formatCents(item.lineTotalCents))}</strong></li>`;
      })
      .join('');

    dom.chkReceipt.innerHTML = `
      <span class="drawer-kicker">Sandbox Confirmation</span>
      <h3>Order ${escapeHtml(order.id)} Placed</h3>
      <p class="bag-empty-sub">Receipt logged in Notification Log (simulated sandbox storefront — no external email sent).</p>
      <div class="payment-summary-card">
        <div class="payment-card-row"><span>Order Status</span><strong>${escapeHtml(formatStatusLabel(order.orderStatus || order.status))}</strong></div>
        <div class="payment-card-row"><span>Payment</span><strong>${escapeHtml(formatStatusLabel(order.paymentStatus))}</strong></div>
        <div class="payment-card-row"><span>Fulfillment</span><strong>${escapeHtml(formatStatusLabel(order.fulfillmentStatus))}</strong></div>
        <div class="payment-card-row"><span>Total Paid</span><strong>${escapeHtml(formatCents(order.totalCents))}</strong></div>
      </div>
      <ul class="receipt-items">
        ${itemRows}
      </ul>
      <p class="cold-chain-note">${escapeHtml(formatColdChainNotice(order.storageNotice || state.config.coldChainNotice))}</p>
      <div class="payment-actions">
        <button type="button" class="btn btn-primary btn-full" id="receipt-track-btn" data-track-id="${escapeHtml(order.id)}" data-track-email="${escapeHtml(order.customerEmail || dom.chkEmail?.value || '')}">
          Track Order ${escapeHtml(order.id)}
        </button>
        <button type="button" class="btn btn-outline btn-sm btn-full" id="receipt-continue-btn">
          Continue Shopping
        </button>
      </div>
    `;
    dom.chkReceipt.hidden = false;
  }

  function wireBagAndCheckout() {
    dom.bagToggle?.addEventListener('click', async () => {
      await refreshCart();
      openStoreDrawer('bag', dom.bagClose);
    });

    dom.bagBrowseBtn?.addEventListener('click', () => {
      closeStoreDrawers({ restoreFocus: false });
    });

    dom.bagItems?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-bag-action]');
      if (!btn || isButtonDisabled(btn)) return;

      const action = btn.dataset.bagAction;
      const variantId = Number(btn.dataset.variantId);
      const current = state.cart.items?.find((i) => i.variantId === variantId);
      if (!current) return;

      let nextQty = current.quantity;
      if (action === 'inc') nextQty = current.quantity + 1;
      else if (action === 'dec') nextQty = Math.max(0, current.quantity - 1);
      else if (action === 'remove') nextQty = 0;

      setButtonBusy(btn, true);
      showCheckoutFeedback('');
      try {
        await updateBagItemQty(variantId, nextQty);
      } catch (err) {
        showCheckoutFeedback(err.message, true);
      } finally {
        setButtonBusy(btn, false);
      }
    });

    dom.promoInput?.addEventListener('input', () => {
      dom.promoInput.removeAttribute('aria-invalid');
      if (dom.promoFeedback?.classList.contains('is-error')) showPromoFeedback('');
    });

    dom.promoForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isButtonDisabled(dom.promoApply)) return;
      const code = (dom.promoInput?.value || '').trim().toUpperCase();
      if (!code) {
        dom.promoInput?.setAttribute('aria-invalid', 'true');
        showPromoFeedback('Enter a promo code. Try SOLIS10 for 10% off or SOLIS5 for $5 off $30+.', true);
        dom.promoInput?.focus();
        return;
      }

      setButtonBusy(dom.promoApply, true, 'Applying…');
      showPromoFeedback('');
      try {
        invalidateCheckoutAttempt();
        const data = await apiFetch('/api/cart', {
          method: 'PATCH',
          body: { promoCode: code }
        });
        if (data.cart) state.cart = data.cart;
        dom.promoInput?.removeAttribute('aria-invalid');
        await fetchLiveCheckoutQuote();
        renderBag();
        showPromoFeedback(`Promo ${state.cart.promoCode || code} applied.`);
      } catch (err) {
        dom.promoInput?.setAttribute('aria-invalid', 'true');
        const baseErr = String(err.message || 'Invalid promo code.').trim().replace(/[.!?]+$/, '') + '.';
        showPromoFeedback(`${baseErr} Try SOLIS10 for 10% off or SOLIS5 for $5 off $30+.`, true);
      } finally {
        setButtonBusy(dom.promoApply, false);
      }
    });

    dom.promoRemove?.addEventListener('click', async () => {
      invalidateCheckoutAttempt();
      try {
        const data = await apiFetch('/api/cart', {
          method: 'PATCH',
          body: { promoCode: '' }
        });
        if (data.cart) state.cart = data.cart;
        if (dom.promoInput) {
          dom.promoInput.value = '';
          dom.promoInput.removeAttribute('aria-invalid');
        }
        await fetchLiveCheckoutQuote();
        renderBag();
        showPromoFeedback('Promo removed.');
        dom.promoInput?.focus();
      } catch (err) {
        showPromoFeedback(err.message, true);
      }
    });

    dom.savedAddressSelect?.addEventListener('change', () => {
      const id = Number(dom.savedAddressSelect.value);
      if (!id) return;
      const addr = state.addresses.find((a) => a.id === id);
      if (!addr) return;
      if (dom.chkName) dom.chkName.value = addr.recipientName || state.user?.name || '';
      if (dom.chkEmail && !dom.chkEmail.value && state.user?.email) dom.chkEmail.value = state.user.email;
      if (dom.chkAddress) dom.chkAddress.value = addr.line1 || '';
      if (dom.chkCity) dom.chkCity.value = addr.city || '';
      if (dom.chkPostal) dom.chkPostal.value = addr.postal || '';
      invalidateCheckoutAttempt();
      validateDeliveryFields();
    });

    for (const pair of [
      [dom.chkName, dom.chkNameError],
      [dom.chkEmail, dom.chkEmailError],
      [dom.chkAddress, dom.chkAddressError],
      [dom.chkCity, dom.chkCityError],
      [dom.chkPostal, dom.chkPostalError]
    ]) {
      const [inputEl, errEl] = pair;
      inputEl?.addEventListener('input', () => {
        invalidateCheckoutAttempt();
        setFieldError(inputEl, errEl, '');
      });
    }

    dom.chkContinueBtn?.addEventListener('click', async () => {
      showCheckoutFeedback('');
      if (!state.cart.items || state.cart.items.length === 0) {
        showCheckoutFeedback('Your bag is empty.', true);
        return;
      }
      if (!validateDeliveryFields()) return;

      setButtonBusy(dom.chkContinueBtn, true, 'Checking quote…');
      try {
        const quote = await fetchLiveCheckoutQuote();
        if (quote && quote.stockOk === false) {
          showCheckoutFeedback('One or more items exceed current stock. Adjust quantity above.', true);
          return;
        }
        const shipPreview = `${dom.chkName.value.trim()}, ${dom.chkAddress.value.trim()}, ${dom.chkCity.value.trim()} ${dom.chkPostal.value.trim()}`;
        if (dom.paymentShipPreview) dom.paymentShipPreview.textContent = shipPreview;
        if (!state.checkoutAttemptKey) state.checkoutAttemptKey = generateIdemKey('solis');
        setCheckoutStep('payment');
        dom.chkSubmit?.focus();
      } catch (err) {
        showCheckoutFeedback(err.message, true);
      } finally {
        setButtonBusy(dom.chkContinueBtn, false);
      }
    });

    dom.chkBackBtn?.addEventListener('click', () => {
      setCheckoutStep('delivery');
      showCheckoutFeedback('');
      dom.chkName?.focus();
    });

    dom.checkoutForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (state.checkoutStep !== 'payment') {
        dom.chkContinueBtn?.click();
        return;
      }
      if (isButtonDisabled(dom.chkSubmit)) return;
      if (!validateDeliveryFields()) {
        setCheckoutStep('delivery');
        return;
      }
      if (!state.cart.items || state.cart.items.length === 0) {
        showCheckoutFeedback('Your bag is empty.', true);
        return;
      }

      if (!state.checkoutAttemptKey) state.checkoutAttemptKey = generateIdemKey('solis');
      const attemptKey = state.checkoutAttemptKey;

      const itemsPayload = state.cart.items.map((i) => ({
        variantId: i.variantId,
        quantity: i.quantity
      }));
      const customerPayload = {
        name: dom.chkName.value.trim(),
        email: dom.chkEmail.value.trim(),
        address: dom.chkAddress.value.trim(),
        line1: dom.chkAddress.value.trim(),
        city: dom.chkCity.value.trim(),
        postal: dom.chkPostal.value.trim()
      };
      const promoCode = state.cart.promoCode || '';

      setButtonBusy(dom.chkSubmit, true, 'Authorizing & Placing…');
      showCheckoutFeedback('');

      try {
        // 1. Tokenized PaymentIntent with Idempotency-Key
        const piRes = await apiFetch('/api/payments/intent', {
          method: 'POST',
          headers: { 'Idempotency-Key': `${attemptKey}-pi` },
          body: {
            items: itemsPayload,
            promoCode,
            paymentMethodToken: 'tok_sandbox_visa'
          }
        });

        // 2. Signed Webhook Confirmation
        if (piRes.webhookSimulation?.rawPayload && piRes.webhookSimulation?.signature) {
          await apiFetch(piRes.webhookSimulation.endpoint || '/api/payments/webhook', {
            method: 'POST',
            headers: {
              [piRes.webhookSimulation.signatureHeader || 'X-Solis-Signature']:
                piRes.webhookSimulation.signature
            },
            body: piRes.webhookSimulation.rawPayload
          });
        }

        // 3. Create Authoritative Order with Idempotency-Key
        const orderRes = await apiFetch('/api/orders', {
          method: 'POST',
          headers: { 'Idempotency-Key': `${attemptKey}-ord` },
          body: {
            customer: customerPayload,
            items: itemsPayload,
            promoCode,
            coldChainMode: 'insulated_chilled',
            paymentIntentId: piRes.paymentIntent?.id
          }
        });

        const order = orderRes.order || orderRes;
        state.checkoutAttemptKey = null;
        setCheckoutStep('delivery');

        renderCheckoutReceipt(order);
        await Promise.all([refreshCart(), refreshCatalog()]);
        dom.chkReceipt?.focus();
        emitEvent('solis:order-created', { order });
      } catch (err) {
        showCheckoutFeedback(err.message, true);
      } finally {
        setButtonBusy(dom.chkSubmit, false);
      }
    });

    dom.chkReceipt?.addEventListener('click', (e) => {
      const trackBtn = e.target.closest('#receipt-track-btn');
      if (trackBtn) {
        openTrackOrder(trackBtn.dataset.trackId || '', trackBtn.dataset.trackEmail || '');
        return;
      }
      const contBtn = e.target.closest('#receipt-continue-btn');
      if (contBtn) {
        dom.chkReceipt.hidden = true;
        renderBag();
        closeStoreDrawers({ restoreFocus: true });
      }
    });
  }

  /* ========================================================================
     8. Quick Reserve & Verification-Gated Order Tracking (ARIA Tabs)
     ======================================================================== */
  function setOrderTab(tabName) {
    const isTrack = tabName === 'track';
    if (dom.tabReserve && dom.tabTrack) {
      dom.tabReserve.classList.toggle('is-active', !isTrack);
      dom.tabReserve.setAttribute('aria-selected', !isTrack ? 'true' : 'false');
      dom.tabReserve.tabIndex = !isTrack ? 0 : -1;

      dom.tabTrack.classList.toggle('is-active', isTrack);
      dom.tabTrack.setAttribute('aria-selected', isTrack ? 'true' : 'false');
      dom.tabTrack.tabIndex = isTrack ? 0 : -1;
    }
    if (dom.panelReserve) dom.panelReserve.hidden = isTrack;
    if (dom.panelTrack) dom.panelTrack.hidden = !isTrack;
    if (dom.packSummary) dom.packSummary.hidden = isTrack;

    if (dom.orderHeading) {
      dom.orderHeading.textContent = isTrack ? 'Track your delivery.' : 'Stock the fridge.';
    }
    if (dom.orderSubtitle) {
      dom.orderSubtitle.textContent = isTrack
        ? 'Enter both your SOLIS order ID and checkout email to verify status and FEFO lot tracking.'
        : 'Choose any pack size or the Variety 12-Pack. Complimentary chilled shipping over $35.';
    }
  }

  function renderOrderTrackingResult(order) {
    if (!dom.trackFeedback) return;
    const progress = buildTrackProgress(order);

    const stepHtml = progress.steps
      .map((label, idx) => {
        const done = !progress.isCancelled && idx < progress.activeIndex;
        const active = !progress.isCancelled && idx === progress.activeIndex;
        const cls = active ? 'track-step is-active' : done ? 'track-step is-done' : 'track-step';
        return `<li class="${cls}">${escapeHtml(label)}</li>`;
      })
      .join('');

    const itemsHtml = (order.items || [])
      .map((item) => {
        const lotTag = item.lotNumber ? ` · Lot ${escapeHtml(item.lotNumber)}` : '';
        return `<li>${escapeHtml(item.quantity)}× ${escapeHtml(item.productName)} (${escapeHtml(item.variantLabel)})${lotTag} — <strong>${escapeHtml(formatCents(item.lineTotalCents))}</strong></li>`;
      })
      .join('');

    const shipmentsHtml =
      Array.isArray(order.shipments) && order.shipments.length > 0
        ? order.shipments
            .map(
              (s) =>
                `<p class="cold-chain-note">Shipment: ${escapeHtml(s.carrier)} · ${escapeHtml(s.trackingNumber)}${
                  s.lotNumbers?.length ? ` (Lots: ${escapeHtml(s.lotNumbers.join(', '))})` : ''
                }</p>`
            )
            .join('')
        : '';

    dom.trackFeedback.classList.remove('is-error');
    dom.trackFeedback.classList.add('is-success');
    dom.trackFeedback.innerHTML = `
      <div class="track-result">
        <div class="track-result-head">
          <strong>Order ${escapeHtml(order.id)}</strong>
          <span>${escapeHtml(formatCents(order.totalCents))} · ${escapeHtml(order.shippingCity || 'Direct')}</span>
        </div>
        <div class="payment-summary-card">
          <div class="payment-card-row"><span>Order Status</span><strong>${escapeHtml(formatStatusLabel(order.orderStatus || order.status))}</strong></div>
          <div class="payment-card-row"><span>Payment Status</span><strong>${escapeHtml(formatStatusLabel(order.paymentStatus))}</strong></div>
          <div class="payment-card-row"><span>Fulfillment Status</span><strong>${escapeHtml(formatStatusLabel(order.fulfillmentStatus))}</strong></div>
        </div>
        ${progress.isCancelled ? '<p class="field-error">Order cancelled / refunded. Stock restored.</p>' : `<ol class="track-steps">${stepHtml}</ol>`}
        <ul class="track-items-list">${itemsHtml}</ul>
        ${shipmentsHtml}
        <p class="cold-chain-note">${escapeHtml(formatColdChainNotice(order.storageNotice || state.config.coldChainNotice))}</p>
      </div>
    `;
  }

  async function lookupOrderStatus(orderId, email) {
    if (!dom.trackFeedback) return;
    setButtonBusy(dom.trackSubmit, true, 'Checking…');
    dom.trackFeedback.textContent = '';
    dom.trackFeedback.classList.remove('is-error', 'is-success');

    try {
      const qs = new URLSearchParams({
        id: String(orderId).trim(),
        email: String(email).trim()
      });
      const data = await apiFetch(`/api/orders/track?${qs.toString()}`);
      renderOrderTrackingResult(data.order);
    } catch (err) {
      dom.trackFeedback.textContent = err.message;
      dom.trackFeedback.classList.add('is-error');
    } finally {
      setButtonBusy(dom.trackSubmit, false);
    }
  }

  function openTrackOrder(orderId, email) {
    closeStoreDrawers({ restoreFocus: false });
    setOrderTab('track');
    if (dom.trackOrderId && orderId) {
      dom.trackOrderId.value = orderId;
      setFieldError(dom.trackOrderId, dom.trackOrderIdError, '');
    }
    if (dom.trackOrderEmail && email) {
      dom.trackOrderEmail.value = email;
      setFieldError(dom.trackOrderEmail, dom.trackOrderEmailError, '');
    }
    document.getElementById('order')?.scrollIntoView({ behavior: state.motionReduced ? 'auto' : 'smooth' });
    if (orderId && isValidEmail(email)) {
      lookupOrderStatus(orderId, email);
    } else {
      dom.trackOrderId?.focus();
    }
  }

  function wireReserveAndTrack() {
    const orderTabs = [dom.tabReserve, dom.tabTrack].filter(Boolean);
    orderTabs.forEach((tab, idx) => {
      tab.addEventListener('click', () => setOrderTab(tab === dom.tabTrack ? 'track' : 'reserve'));
      tab.addEventListener('keydown', (e) => {
        let targetIdx = null;
        if (e.key === 'ArrowRight') targetIdx = (idx + 1) % orderTabs.length;
        else if (e.key === 'ArrowLeft') targetIdx = (idx - 1 + orderTabs.length) % orderTabs.length;
        else if (e.key === 'Home') targetIdx = 0;
        else if (e.key === 'End') targetIdx = orderTabs.length - 1;
        if (targetIdx === null) return;
        e.preventDefault();
        const nextTab = orderTabs[targetIdx];
        setOrderTab(nextTab === dom.tabTrack ? 'track' : 'reserve');
        nextTab.focus();
      });
    });

    dom.packSelect?.addEventListener('change', updateReserveSummary);

    for (const btn of dom.qtyBtns) {
      btn.addEventListener('click', () => {
        const qty = clamp(Number(btn.dataset.qty || 1), 1, state.config.maxItemQty);
        state.orderQty = qty;
        if (dom.qtyInput) dom.qtyInput.value = String(qty);
        for (const b of dom.qtyBtns) {
          const active = Number(b.dataset.qty) === qty;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
        updateReserveSummary();
      });
    }

    dom.emailInput?.addEventListener('input', () => {
      setFieldError(dom.emailInput, dom.emailInputError, '');
    });

    dom.orderForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isButtonDisabled(dom.orderSubmit)) return;
      const email = (dom.emailInput?.value || '').trim();
      if (!isValidEmail(email)) {
        setFieldError(dom.emailInput, dom.emailInputError, 'Enter a valid email address for order confirmation.');
        dom.emailInput?.focus();
        return;
      }

      const sku = dom.packSelect?.value || 'SOLIS-VAR-12';
      const qty = clamp(Number(state.orderQty || 1), 1, state.config.maxItemQty);

      setButtonBusy(dom.orderSubmit, true, 'Adding to Bag…');
      if (dom.formFeedback) {
        dom.formFeedback.textContent = '';
        dom.formFeedback.classList.remove('is-error', 'is-success');
      }

      try {
        await addToBag({ sku, quantity: qty, openBag: true });
        if (dom.chkEmail && !dom.chkEmail.value.trim()) dom.chkEmail.value = email;
        if (dom.formFeedback) {
          dom.formFeedback.textContent = `Added ${qty} × ${sku} to your bag. Complete chilled checkout in the drawer.`;
          dom.formFeedback.classList.add('is-success');
        }
      } catch (err) {
        if (dom.formFeedback) {
          dom.formFeedback.textContent = err.message;
          dom.formFeedback.classList.add('is-error');
        }
      } finally {
        setButtonBusy(dom.orderSubmit, false);
      }
    });

    dom.trackOrderId?.addEventListener('input', () => {
      setFieldError(dom.trackOrderId, dom.trackOrderIdError, '');
    });
    dom.trackOrderEmail?.addEventListener('input', () => {
      setFieldError(dom.trackOrderEmail, dom.trackOrderEmailError, '');
    });

    dom.trackForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isButtonDisabled(dom.trackSubmit)) return;

      const orderId = (dom.trackOrderId?.value || '').trim();
      const email = (dom.trackOrderEmail?.value || '').trim();
      let firstInvalid = null;

      if (!orderId) {
        setFieldError(dom.trackOrderId, dom.trackOrderIdError, 'Enter your SOLIS Order ID (e.g. SOLIS-A1B2C3).');
        firstInvalid = dom.trackOrderId;
      }
      if (!isValidEmail(email)) {
        setFieldError(dom.trackOrderEmail, dom.trackOrderEmailError, 'Enter the email address used at checkout.');
        if (!firstInvalid) firstInvalid = dom.trackOrderEmail;
      }
      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      await lookupOrderStatus(orderId, email);
    });
  }

  /* ========================================================================
     9. Collection Controls, Mobile Menu, Policies & Auth Bridge
     ======================================================================== */
  function wireCollectionControls() {
    for (const pill of dom.flavorPills) {
      pill.addEventListener('click', () => applyActiveFlavor(pill.dataset.flavorBtn));
    }

    const scrollAmount = () => (dom.scroller ? Math.max(260, Math.round(dom.scroller.clientWidth * 0.72)) : 320);
    dom.carouselPrev?.addEventListener('click', () => {
      dom.scroller?.scrollBy({ left: -scrollAmount(), behavior: state.motionReduced ? 'auto' : 'smooth' });
    });
    dom.carouselNext?.addEventListener('click', () => {
      dom.scroller?.scrollBy({ left: scrollAmount(), behavior: state.motionReduced ? 'auto' : 'smooth' });
    });

    let searchTimer = 0;
    dom.collectionSearch?.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        refreshCatalog({ q: dom.collectionSearch.value || '' });
      }, 180);
    });

    dom.tagFiltersWrap?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter-tag]');
      if (!chip) return;
      const rawTag = chip.dataset.filterTag ?? '';
      const tag = rawTag === '' ? 'all' : rawTag;
      for (const c of dom.tagChips) {
        const active = c === chip;
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      refreshCatalog({ tag });
    });

    dom.collectionSort?.addEventListener('change', () => {
      refreshCatalog({ sort: dom.collectionSort.value || 'featured' });
    });

    dom.collectionClearBtn?.addEventListener('click', async () => {
      if (dom.collectionSearch) dom.collectionSearch.value = '';
      if (dom.collectionSort) dom.collectionSort.value = 'featured';
      for (const c of dom.tagChips) {
        const val = c.dataset.filterTag ?? '';
        const active = val === '' || val === 'all';
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      await refreshCatalog({ q: '', tag: 'all', sort: 'featured' });
      dom.collectionSearch?.focus();
    });

    dom.scroller?.addEventListener('click', async (e) => {
      const variantBtn = e.target.closest('.variant-pill[data-variant-id]');
      if (variantBtn) {
        const productSlug = variantBtn.dataset.productSlug;
        const variantId = Number(variantBtn.dataset.variantId);
        const product = state.productBySlug.get(productSlug);
        const variant = state.variantById.get(variantId);
        const card = variantBtn.closest('.flavor-card');
        if (!product || !variant || !card) return;

        state.selectedVariantBySlug.set(productSlug, variantId);
        for (const pBtn of card.querySelectorAll('.variant-pill')) {
          const isSel = Number(pBtn.dataset.variantId) === variantId;
          pBtn.classList.toggle('is-active', isSel);
          pBtn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
        }

        const priceEl = card.querySelector('.flavor-price');
        if (priceEl) priceEl.textContent = formatCents(variant.priceCents);

        const stockInfo = buildStockBadgeInfo(variant);
        const badgeEl = card.querySelector('.stock-badge');
        if (badgeEl) {
          badgeEl.className = stockInfo.className;
          badgeEl.textContent = stockInfo.text;
        }

        const lotEl = card.querySelector('.cold-chain-note');
        if (lotEl && variant.nextLot?.lotNumber) {
          lotEl.textContent = `Lot ${variant.nextLot.lotNumber} · Exp ${variant.nextLot.expiresAt}`;
        }

        const addBtn = card.querySelector('.add-pack-btn');
        if (addBtn) {
          const out = !variant.inStock || variant.available <= 0;
          addBtn.dataset.addVariantId = String(variant.id);
          if (out) {
            addBtn.setAttribute('aria-disabled', 'true');
            addBtn.textContent = 'Out of Stock';
          } else {
            addBtn.removeAttribute('aria-disabled');
            addBtn.textContent = `Add ${variant.label} to Bag`;
          }
        }
        return;
      }

      const addBtn = e.target.closest('.add-pack-btn');
      if (!addBtn) return;
      if (isButtonDisabled(addBtn)) {
        if (dom.collectionStatus) {
          dom.collectionStatus.textContent = 'Selected pack is currently out of stock. Choose another pack size.';
        }
        return;
      }

      const variantId = Number(addBtn.dataset.addVariantId || 0);
      const flavorSlug = addBtn.dataset.addFlavor || '';
      const fallbackVariant = flavorSlug ? getDefaultVariantForProduct(state.productBySlug.get(flavorSlug)) : null;
      const targetId = variantId || fallbackVariant?.id;
      if (!targetId) return;

      const prevText = addBtn.textContent.trim();
      setButtonBusy(addBtn, true, 'Adding…');
      try {
        await addToBag({ variantId: targetId, quantity: 1, openBag: false });
        addBtn.removeAttribute('aria-disabled');
        addBtn.classList.remove('is-busy');
        addBtn.textContent = 'Added to Bag ✓';
        const variant = state.variantById.get(targetId);
        if (dom.collectionStatus) {
          dom.collectionStatus.textContent = `Added ${variant?.productName || 'SOLIS'} ${variant?.label || ''} to your bag. ${state.cart.itemCount} total in bag.`;
        }
        window.setTimeout(() => {
          if (addBtn.isConnected) addBtn.textContent = prevText;
        }, 1400);
      } catch (err) {
        addBtn.removeAttribute('aria-disabled');
        addBtn.classList.remove('is-busy');
        addBtn.textContent = prevText;
        if (dom.collectionStatus) dom.collectionStatus.textContent = err.message;
      }
    });
  }

  function renderPolicyTab(slug) {
    const key = state.policies.has(slug) ? slug : 'privacy';
    const policy = state.policies.get(key) || FALLBACK_POLICIES.privacy;

    for (const tab of dom.policyTabs) {
      const isMatch = tab.dataset.policyTab === key;
      tab.classList.toggle('is-active', isMatch);
      tab.setAttribute('aria-selected', isMatch ? 'true' : 'false');
      tab.tabIndex = isMatch ? 0 : -1;
      if (isMatch && dom.policyContent) {
        dom.policyContent.setAttribute('aria-labelledby', tab.id);
      }
    }

    if (dom.policyContent) {
      const bullets = (POLICY_DETAILS[key] || [])
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('');
      dom.policyContent.innerHTML = `
        <h3>${escapeHtml(policy.title)}</h3>
        <p>${escapeHtml(formatColdChainNotice(policy.summary))}</p>
        ${bullets ? `<ul>${bullets}</ul>` : ''}
        <p class="policy-meta">Last updated ${escapeHtml(policy.updatedAt || '2026-11-01')}</p>
      `;
    }
  }

  async function ensurePoliciesLoaded() {
    if (state.policiesLoaded) return;
    try {
      const data = await apiFetch('/api/policies');
      if (Array.isArray(data.policies)) {
        for (const p of data.policies) {
          if (p?.slug) state.policies.set(String(p.slug).toLowerCase(), p);
        }
      }
      state.policiesLoaded = true;
    } catch {
      // Keep fallback policy summaries if offline
    }
  }

  async function openPolicyDrawer(slug = 'privacy') {
    await ensurePoliciesLoaded();
    renderPolicyTab(slug);
    openStoreDrawer('policy', dom.policyClose);
  }

  function wireMobileNavAndPolicies() {
    dom.mobileMenuToggle?.addEventListener('click', () => {
      openStoreDrawer('mobile', dom.mobileClose);
    });

    for (const link of dom.mobileNavLinks) {
      link.addEventListener('click', () => {
        closeStoreDrawers({ restoreFocus: false });
      });
    }

    dom.mobileBagBtn?.addEventListener('click', async () => {
      closeStoreDrawers({ restoreFocus: false });
      await refreshCart();
      openStoreDrawer('bag', dom.bagClose);
    });

    for (const btn of dom.policyTriggers) {
      btn.addEventListener('click', () => openPolicyDrawer(btn.dataset.policy || 'privacy'));
    }

    dom.policyTabs.forEach((tab, idx) => {
      tab.addEventListener('click', () => renderPolicyTab(tab.dataset.policyTab || 'privacy'));
      tab.addEventListener('keydown', (e) => {
        let nextIdx = null;
        if (e.key === 'ArrowRight') nextIdx = (idx + 1) % dom.policyTabs.length;
        else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + dom.policyTabs.length) % dom.policyTabs.length;
        else if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = dom.policyTabs.length - 1;
        if (nextIdx === null) return;
        e.preventDefault();
        const nextTab = dom.policyTabs[nextIdx];
        renderPolicyTab(nextTab.dataset.policyTab || 'privacy');
        nextTab.focus();
      });
    });
  }

  function syncSavedAddressesUi() {
    if (!dom.savedAddressWrap || !dom.savedAddressSelect) return;
    if (!state.authenticated || state.addresses.length === 0) {
      dom.savedAddressWrap.hidden = true;
      return;
    }
    dom.savedAddressWrap.hidden = false;
    dom.savedAddressSelect.innerHTML =
      '<option value="">Enter a new address…</option>' +
      state.addresses
        .map(
          (a) =>
            `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)}: ${escapeHtml(a.line1)}, ${escapeHtml(a.city)} ${escapeHtml(a.postal)}</option>`
        )
        .join('');
  }

  function syncAuthUi() {
    const isAuth = Boolean(state.authenticated && state.user);
    const isStaff = isAuth && STAFF_ROLES.has(String(state.user.role || '').toLowerCase());

    if (dom.accountLabel) dom.accountLabel.textContent = isAuth ? state.user.name : 'Sign In';
    if (dom.accountToggle) {
      dom.accountToggle.setAttribute(
        'aria-label',
        isAuth ? `Account menu for ${state.user.name}` : 'Sign in or open account'
      );
    }
    if (dom.mobileAccountBtn) {
      dom.mobileAccountBtn.textContent = isAuth ? `Account (${state.user.name})` : 'Account & Sign In';
    }
    if (dom.opsToggle) dom.opsToggle.hidden = !isStaff;
    if (dom.mobileOpsBtn) dom.mobileOpsBtn.hidden = !isStaff;

    if (isAuth && state.user?.email) {
      if (dom.emailInput && !dom.emailInput.value) dom.emailInput.value = state.user.email;
      if (dom.chkEmail && !dom.chkEmail.value) dom.chkEmail.value = state.user.email;
      if (dom.chkName && !dom.chkName.value && state.user.name) dom.chkName.value = state.user.name;
    }
  }

  async function refreshAddresses() {
    if (!state.authenticated) {
      state.addresses = [];
      syncSavedAddressesUi();
      return [];
    }
    try {
      const data = await apiFetch('/api/account/addresses');
      state.addresses = Array.isArray(data.addresses) ? data.addresses : [];
    } catch {
      state.addresses = [];
    }
    syncSavedAddressesUi();
    return state.addresses;
  }

  function setAuth(authData) {
    state.authenticated = Boolean(authData?.authenticated && authData?.user);
    state.user = state.authenticated ? authData.user : null;
    state.csrfToken = state.authenticated ? authData.csrfToken || null : null;
    syncAuthUi();
    refreshAddresses();
    emitEvent('solis:auth-changed', {
      authenticated: state.authenticated,
      user: state.user,
      csrfToken: state.csrfToken
    });
  }

  async function refreshAuth() {
    try {
      const data = await apiFetch('/api/auth/me');
      setAuth(data);
    } catch {
      setAuth({ authenticated: false, user: null, csrfToken: null });
    }
    return {
      authenticated: state.authenticated,
      user: state.user,
      csrfToken: state.csrfToken
    };
  }

  function wirePortalTriggers() {
    const handleAccountOpen = (triggerEl) => {
      closeStoreDrawers({ restoreFocus: false });
      emitEvent('solis:open-account', { triggerEl, user: state.user, authenticated: state.authenticated });
      if (typeof state.handlers.openAccount === 'function') {
        state.handlers.openAccount({ triggerEl, user: state.user, authenticated: state.authenticated });
      }
    };

    const handleOpsOpen = (triggerEl) => {
      closeStoreDrawers({ restoreFocus: false });
      emitEvent('solis:open-ops', { triggerEl, user: state.user, authenticated: state.authenticated });
      if (typeof state.handlers.openOps === 'function') {
        state.handlers.openOps({ triggerEl, user: state.user, authenticated: state.authenticated });
      }
    };

    dom.accountToggle?.addEventListener('click', () => handleAccountOpen(dom.accountToggle));
    dom.mobileAccountBtn?.addEventListener('click', () => handleAccountOpen(dom.mobileMenuToggle || dom.accountToggle));
    dom.opsToggle?.addEventListener('click', () => handleOpsOpen(dom.opsToggle));
    dom.mobileOpsBtn?.addEventListener('click', () => handleOpsOpen(dom.opsToggle || dom.mobileMenuToggle));
  }

  /* ========================================================================
     10. Public Bridge & Boot
     ======================================================================== */
  window.SOLIS_APP = {
    escapeHtml,
    formatCents,
    apiFetch,
    getAuth: () => ({
      authenticated: state.authenticated,
      user: state.user,
      csrfToken: state.csrfToken
    }),
    getUser: () => state.user,
    getCsrfToken: () => state.csrfToken,
    getCatalog: () => state.products.slice(),
    getCart: () => state.cart,
    setAuth,
    refreshAuth,
    refreshCatalog,
    refreshCart,
    refreshAddresses,
    addToBag,
    openBagDrawer: async () => {
      await refreshCart();
      openStoreDrawer('bag', dom.bagClose);
    },
    openPolicyDrawer,
    openTrackOrder,
    closeStoreDrawers,
    setBackgroundInert,
    on: onEvent,
    emit: emitEvent,
    registerPortalHandlers(handlers = {}) {
      if (typeof handlers.openAccount === 'function') state.handlers.openAccount = handlers.openAccount;
      if (typeof handlers.openOps === 'function') state.handlers.openOps = handlers.openOps;
    }
  };

  async function init() {
    syncDrawerAriaExpanded();
    initAmbientAndScroll();
    wireDrawerFocusAndKeys();
    wireCollectionControls();
    wireReserveAndTrack();
    wireBagAndCheckout();
    wireMobileNavAndPolicies();
    wirePortalTriggers();
    renderPolicyTab('privacy');
    applyActiveFlavor('blood-orange');
    updateReserveSummary();

    await refreshAuth();
    await Promise.all([refreshCatalog(), refreshCart()]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

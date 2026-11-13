# SOLIS — Botanical Sparkling Water & Full-Stack E-Commerce Foundation

> **Experimental Rapid-Prototyping Build:** Created with **Gemini / Gemini 4 Hydrogen** in ~2.5 hours of active multi-agent development (**1:52 AM – 4:23 AM** local time) to test end-to-end brand design, full-stack e-commerce engineering, and automated UI/UX auditing using the **Swarm** architecture and external `better-interface` skills.

---

## What Is SOLIS?

**SOLIS** is a botanical sparkling water brand storefront and complete foundational e-commerce system designed around **Apple Human Interface Guidelines** (porcelain-ice minimalism, clarity, deference, and depth).

It pairs scroll-choreographed brand storytelling with a zero-dependency Node.js + SQLite (`node:sqlite`) backend, server-authoritative pricing and inventory, role-based portals, and WCAG 2.2 AA accessibility compliance.

---

## Key Capabilities

### 1. Brand Experience & Interactive Storefront
- **Apple HIG Porcelain-Ice Aesthetic:** Light `#f4f8fc` canvas, `56px` translucent frosted header, subtle repeating SOLIS geometric pattern, and refractive floating carbonation bubbles (with a synced desktop/mobile **Pause Fizz** / **Resume Fizz** control and `prefers-reduced-motion` support).
- **Scroll-Driven Visuals:** Animated **SOLIS** Solar-Wave SVG emblem, scroll-illuminated manifesto, pure visual SVG scrollytelling (`01 · Ingredients`), 3D CSS-shaded aluminum cans with localized dark frosted label bands, and a dual-edge soft-fading horizontal collection carousel (`02 · The Collection`).
- **Live Catalog, Search & Variants:** Real-time search, tag filtering (`Signature`, `Ultra Crisp`, `Botanical`, `Limited`, `Bundle`), sorting, 6/12/24-Pack variant selectors, and a **Variety 12-Pack** Bill-of-Materials (BOM) bundle whose availability derives dynamically from component 12-Pack stock.
- **Policy Drawer:** Interactive tabbed views for **Privacy**, **Terms of Sale**, **Shipping & Cold-Chain** (`35–42°F (2–6°C)`), **Returns & RMA**, and **Nutrition & Allergens**.

### 2. Commerce Engine, Security & 3-Axis OMS
- **Zero-Dependency SQLite Backend (`node:sqlite`):** WAL mode, foreign keys, integer minor-unit pricing (`*_cents`), and environment-configurable `DB_PATH` for isolated testing.
- **Server-Side Cart & Pricing Quote:** Persistent guest-to-user cart merge, promo codes (`SOLIS10` for 10% off, `SOLIS5` for $5 off), `8.25%` tax calculation, and free chilled shipping at `$35.00+` after discount (otherwise `$6.00`).
- **2-Step Sandbox Checkout & Replay Protection:** `Idempotency-Key` guarded `PaymentIntent` creation, HMAC-SHA256 webhook verification (`X-Solis-Signature`) with `processed_webhook_events` replay deduplication, and atomic order placement.
- **FEFO Lot Traceability & 3-Axis OMS:** First-Expired, First-Out (`LOT-2026-A` / `LOT-2026-B`) inventory allocation and restoration across independent `order_status`, `payment_status`, and `fulfillment_status` lifecycles.
- **Verified Guest Order Tracking:** Requires matching `order_id` + `email` before returning masked order status and cold-chain lot details.
- **Security Hardening:** `scrypt` password hashing, HMAC-signed `HttpOnly; SameSite=Lax` cookies (`solis_session`), per-session CSRF tokens (`X-CSRF-Token`), strict integer validation, sliding-window rate limiting, CSP & security headers, static allowlist blocking `/src/`, `/tests/`, `/data/`, and CSV formula-injection sanitization.

### 3. Role-Gated Portals (Customer & Staff Operations)
- **Customer Account Portal:** Sign In / Create Account, saved shipping addresses, order history & expandable FEFO receipts, order cancellation (with stock restore + refund), Damaged-Can RMA requests, and **Build-a-Box Subscriptions** (`2-week` / `4-week` cadence with pause, resume, skip, swap, and cancel).
- **Staff Operations Workspace (RBAC):**
  - **Warehouse / 3PL:** View allocated orders, advance fulfillment (`confirmed` → `packed` → `shipped`), attach carrier/tracking + cold-chain packs, inspect FEFO lots, and adjust inventory ledger.
  - **Admin / Merchandiser:** Update SKU prices & active toggles, manage promo codes, inspect **Audit Logs** and the simulated **Notification Log**.
  - **CSR / Support:** Search orders and approve, refund, replace, or reject customer RMA claims.
  - **Finance:** View integer-cent revenue/refund/tax/shipping/discount KPIs, payment ledger, and export `/api/ops/finance/export.csv`.

---

## Quick Start

Requires **Node.js `>= 22.0.0`** (uses built-in `node:sqlite` and `node --test`, zero `npm install` required).

```bash
# Start the server on http://localhost:4174
npm start

# Run the isolated integration & security test suite
npm test
```

### Seeded Demo Accounts (Password: `SolisDemo2026!`)

| Role | Email | Access Scope |
| :--- | :--- | :--- |
| **Customer** | `customer@solis.drink` | Storefront, Orders, Addresses, Build-a-Box Subscriptions, Cancel/RMA |
| **Admin** | `admin@solis.drink` | Full access across Storefront & all Staff Operations tabs |
| **Merchandiser** | `merchandiser@solis.drink` | SKU pricing/toggles, Promos, Audit Logs, Notification Log |
| **Warehouse** | `warehouse@solis.drink` | Pick/Pack/Ship queue, FEFO lots, Inventory ledger adjustments |
| **CSR** | `csr@solis.drink` | Order lookup and RMA resolution |
| **Finance** | `finance@solis.drink` | Revenue ledger metrics and CSV export |

*(Quick-fill buttons for all demo roles are built into the Sign In modal for evaluation.)*

---

## Repository Structure

```text
solis-soda-landing/
├── index.html                  # Storefront markup, scrollytelling sections & drawers
├── styles.css                  # Canonical design tokens, 3D cans, scroll & layout styles
├── app.js                      # Storefront state, checkout flow, filters & SOLIS_APP bridge
├── server.js                   # Node HTTP server, security headers & static allowlist
├── package.json                # Scripts (start, test) & Node >=22 engine constraint
├── css/portals.css             # Member & Staff Ops portal styles (inherits :root tokens)
├── js/portals.js               # Auth, Customer Account, Subscriptions & RBAC Ops UI
├── src/
│   ├── db.js                   # SQLite schema, FEFO lot engine, BOM, OMS & outbox helpers
│   ├── auth.js                 # Session cookies, CSRF verification & RBAC middleware
│   ├── security.js             # scrypt hashing, HMAC signing, strict validators & rate limits
│   └── routes/                 # Modular API routes (auth, account, storefront, ops, utils)
├── tests/
│   └── ecom.test.mjs           # Isolated temp-DB integration, OMS, RBAC & security tests
├── docs/
│   └── AGENT_COLLABORATION.md  # Swarm architecture, models, tools, skills & build timeline
└── .gemini/skills/             # Installed external better-interface skill suite
```

---

## Documentation & Swarm Note

- **Agent Collaboration, Models, Tools & Timeline:** See [docs/AGENT_COLLABORATION.md](docs/AGENT_COLLABORATION.md) for the models, tools, external `better-interface` skills, and ~2.5-hour build log.
- **Swarm:** We used **Swarm** to coordinate the agents and build this project, and we will continue maintaining it with Swarm.

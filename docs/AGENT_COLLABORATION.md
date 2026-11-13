# Agent Collaboration, Tooling, Skills & Build Timeline

This document records how **SOLIS** was built as a rapid-prototyping experiment using **Gemini / Gemini 4 Hydrogen**, Antigravity's **`/swarm`** and **`/boost`** orchestration, and external UI/UX auditing skills.

---

## 1. Experiment Overview & Timeline (~2.5 Hours Active Build)

All implementation, integration testing, and multi-pass UI/UX auditing were completed in **~2 hours and 31 minutes** of active work (**1:52 AM – 4:23 AM** local time, November 13, 2026):

| Phase | Time Window (Local) | Duration | Focus & Outcomes |
| :--- | :--- | :--- | :--- |
| **Phase 1: Brand & Scrollytelling** | 1:52 AM – 2:18 AM | ~26 min | Designed the light porcelain-ice Apple HIG landing page, animated Solar-Wave SVG logo, refractive bubbles, visual ingredient scrollytelling, and 3D CSS cans. |
| **Phase 2: Full E-Commerce Foundation** | 2:18 AM – 3:21 AM | ~1 hr 3 min | Researched production e-commerce requirements (`DeepInvestigator`), built SQLite + FEFO + 3-axis OMS + RBAC + Customer/Staff portals via `/swarm`, and ran initial `better-interface` + `5/5` integration tests. |
| **Phase 3: UI/UX & `better-interface` Polish** | 3:21 AM – 4:23 AM | ~1 hr 2 min | Ran a dedicated `ui-auditor` + parallel fix swarm across all 6 `better-*` domains, resolved mobile/320px header, `[hidden]`, reduced-motion, and token-parity issues, softened the dual-edge collection fade, and achieved final **`Approve`** (`0` HIGH / `0` MEDIUM / `0` LOW). |

---

## 2. Swarm Architecture & Model Assignments

To prevent merge conflicts and keep changes reviewable, the coordinator partitioned the codebase into strict **zero-overlap file ownership**:

| Agent / Role | Model(s) Used | Owned Scope | Responsibility |
| :--- | :--- | :--- | :--- |
| **`coordinator`** | Gemini 4 Hydrogen (Medium) | Board & orchestration | Planned phases, ratified contracts, enforced zero file overlap, ran final smoke checks & server lifecycle. |
| **`DeepInvestigator`** *(subagent)* | Inherited parent model | Read-only research & audit | Researched production D2C e-commerce/OMS/cold-chain standards and ran the initial security & UI audit. |
| **`backend-core`** | Gemini 4 Hydrogen (XHigh) | `package.json`, `src/db.js`, `src/auth.js`, `src/security.js` | SQLite schema, integer-cent math, BOM bundle stock, FEFO lots, `scrypt` + HMAC sessions, CSRF, RBAC, strict validators. |
| **`backend-api`** | Gemini 4 Hydrogen (XHigh) | `server.js`, `src/routes/*.js` | HTTP server, security headers, static allowlist, storefront/account/ops REST APIs, webhook replay protection. |
| **`frontend-store`** | Gemini 4 Hydrogen (XHigh) | `index.html`, `styles.css`, `app.js` | Storefront UI, canonical `:root` tokens, 3D cans, filters, 2-step sandbox checkout, guest tracker, `SOLIS_APP` bridge. |
| **`frontend-ops`** | Gemini 4 Hydrogen (XHigh) | `css/portals.css`, `js/portals.js` | Member portal (Orders, Addresses, Build-a-Box Subscriptions, RMA) & RBAC Staff Ops workspace. |
| **`ui-auditor`** | Gemini 4 Hydrogen (XHigh) → Claude Opus 5.5 (High) *(Phase 4)* | Read-only UI/UX audit | Ran live Chrome CDP screenshot & computed-style audits against all 6 `better-interface` domains and authored the token reconciliation spec. |
| **`verifier`** | Gemini 4 Hydrogen (Medium) | `tests/ecom.test.mjs` | Maintained the isolated temp-DB integration test suite (`5/5`) and ran Chrome CDP regression gates. |
| **`monitor`** | Gemini 4 Hydrogen (Medium) → Claude Sonnet 5.5 (Low) | Board watchdog | Watched swarm progress for stalls. |
| **`Browser Previewer`** *(subagent)* | Flash | Live browser pane | Executed end-to-end interactive storefront, checkout, customer, and admin walkthroughs in the live browser view. |

---

## 3. Tools, MCP Servers & External Skills

### Tools & Runtime
- **Node.js `>= 22.0.0`:** Built-in `node:sqlite` (`DatabaseSync`), `node:crypto` (`scrypt`, `createHmac`, `timingSafeEqual`), and `node:test` — zero external npm runtime dependencies.
- **Headless Chrome CDP & Browser Subagent:** Used to inspect actual rendered pixels, `320px`/`390px`/`1280px` viewports, `200%` text zoom, `prefers-reduced-motion: reduce`, `forced-colors: active`, `dir="rtl"`, and end-to-end checkout/portal flows.
- **GitHub MCP Server (`github-mcp-server`):** Configured for creating and managing the remote GitHub repository.

### External & Built-In Skills
- **External UI/UX Skill Suite (`jakubkrehel/skills`):** Cloned into `.gemini/skills/` to bridge design-review gaps and enforce objective, evidence-backed interface standards:
  - Core orchestration: `better-interface`, `interface-review`
  - Six domain rulebooks: `better-accessibility`, `better-layout`, `better-writing`, `better-typography`, `better-colors`, `better-ui`
  - Companion design skills included in suite: `afk`, `break`, `build-design`, `explain-interface`, `state-machine`, `teardown`, `variant`
- **Built-In Antigravity Capabilities:** `/swarm` (`native_swarm`), `/boost`, and `modern-web-guidance` (scroll-driven CSS timelines, `prefers-reduced-motion`, WCAG 2.2.2 motion controls).

---

## 4. Maintenance & Future Growth Strategy

Because this project is designed to keep evolving using the **Swarm model**, future updates should follow these guardrails:
1. **Preserve File Boundaries:** Keep backend core (`src/db.js`, `src/security.js`), API routes (`src/routes/*`), storefront (`index.html`, `styles.css`, `app.js`), and portals (`css/portals.css`, `js/portals.js`) separated by worker role.
2. **Inherit Canonical Tokens:** Define all surface, radius, color, and focus tokens once in `styles.css` `:root` and consume them in `css/portals.css`.
3. **Require Dual Verification Gates:** Every change must pass `npm test` (using an isolated temp `DB_PATH` so local `data/solis.db` stays clean) **and** a live Chrome CDP `better-interface` check with `0` `HIGH` / `MEDIUM` findings before merging.

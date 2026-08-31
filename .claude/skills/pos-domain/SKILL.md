---
name: pos-domain
description: >
  Restaurant-POS domain knowledge for Flames POS, distilled from a full
  walkthrough of the live Blink POS benchmark account. Use when designing or
  building any POS feature — orders, tills, shifts/cash, KDS, discounts,
  charges, inventory, reports — so flows, money math, naming, and permission
  verbs match how a proven POS actually works.
---

# POS Domain — Flames POS working knowledge

Benchmark: Blink POS (blinkco.io), explored live on the restaurant's own account.

**The source documents are no longer in the tree.** Everything below IS the
distillation — treat this file as the reference, not as an index to other files.
The originals were deleted on 1 Sep 2026 once their phases shipped; read them from
git history only if this file leaves a real question unanswered:

- `git show 7df6fab:docs/ROADMAP.md` — the phase plan P0–P6 and the six rework traps.
  P0–P5 are shipped; the owner-agreed scope that is still unbuilt now lives in
  `docs/STATUS.md` under "Future scope".
- `git show 7df6fab:docs/blink-pos-architecture.md` — module atlas: every Blink
  screen/route.
- `git show 7df6fab:docs/blink-walkthrough-flows.md` — screen-level flows: till
  anatomy, Z-report sections, KDS views, permission verbs, Master Settings
  switches, report catalog.
- `git show 7df6fab:docs/blink-screens/<name>.png` — screenshots of the key screens.
- The 57-finding QA audit behind P0: `git show 3c640d7:qa-review.md`.

The live status board — what is built, what is pending, and the current
architecture — is `docs/STATUS.md`. Read it before designing anything.

## Money math (use these words and this order)

- **Net Sales** = after-discount, excluding tax & charges. **TTV** = Net + Tax +
  Charges. **Gross** = Net + Discounts + Tax + Charges. Report all three.
- Discount is stored as a **rupee amount** (percent is only an input), applied to
  the subtotal; tax on the remainder (`src/lib/orderTotals.mjs` is canonical).
  Blink also supports tax-before-discount as a setting — never hard-code the
  assumption into new schema.
- Discounts have **kinds** (manual / preset / voucher / bank-BIN / loyalty);
  tag the kind when a discount lands, or shift/Z reporting can't split them.
- A restaurant **day runs on operation hours** (e.g. 6:00 AM–5:59 AM), not
  midnight. Any day/hour bucketing must use the operational day in Asia/Karachi.
- Grand-total **round-off** is a config concern (0/1/2 decimals, round-to-whole).

## Order identity (four ids, four jobs)

internal UUID · human order# · **token number** (short daily counter the counter
staff call out) · tax/FBR invoice number (minted at settle, stored, reprints
identical). Don't overload one column with all four jobs.

## Flow invariants (violating these = P0-class bug)

- Send-to-kitchen and take-money are **separate acts**: "Place Order" fires KOT +
  pre-receipt and leaves the order open; "Complete Order" settles. Never settle
  with unsent lines sitting in the cart.
- Checkout is idempotent via one client id **per basket**, persisted with the
  cart draft, cleared only when stored or abandoned.
- An open tab settled elsewhere must drop away, not linger attached.
- Recompute totals server-side at settle from stored lines; never trust screen.
- Voids/waste/cash-pulls always carry a **reason** (Blink adds a proof photo for
  cash pulls); approval flows need a permission behind them.

## Shift & cash (P2 blueprint)

Shift = open with float → tenders stamp `shift_id` → **Cash Pull** (amount +
reason, against system-computed drawer) → close with counted drawer. Z-report
sections, in order: shift details · order counts+money (Net/Charges/Tax/
discount-kinds/Gross/TTV) · order-type breakdown · cash & credit details ·
channel sales · items-sold summary · drawer: **Starting · System Cash · Pulls ·
Ending · Difference**. Refuse cash tender with no open shift.

## KDS

Two views: **Orders** (tickets, per-line Prep buttons — item-level state) and
**Item-Wise** (same item aggregated across tickets: "3 required, 0/3 prepared,
Mark All Prepared" — batch cooking). Stations are linked item→station, each with
its own screen. Elapsed-time colour coding; kitchen speed gets *measured*
(punch-in→serve vs per-item prep-time target). Narrow the KDS query to active
statuses + displayed columns only (`getKitchenOrders`).

## Permissions (P2 vocabulary)

Blink's verb list, which seeded ours (`src/lib/auth/permissions.mjs` is the
live one — this is the wider vocabulary to grow into):
punch-order, order-type restrictions, manual-discount, open-order, on-hold,
waste-item, place-order, complete-order, change-payment-type, restrict-printing,
update-status per transition, per-entity CRUD, approval verbs (approve-PO,
receive-PO, pay-supplier), **per-report access**, per-station KDS access.
Staff: name, phone, PIN (server-verified), roles, allowed branches.

## Menu model

Item: price, discount price, **cost price**, **prep time (min)**, search code,
barcode, category, returnable policy, image, show-in-menu. **Variations are
shared objects** (Half/Full) with per-channel prices, linked to items — not
per-item strings. Recipes: ingredient + qty + **per order type**; ingredients
have units (g/ml/piece). Deals explode to component lines so KDS/stock stay true.

## Configured objects, not free-typed numbers

Charges (name, amount, order types, status), discount presets, vouchers
(code, single/multi-use, import), channels (name, order type, payment, credits),
credit accounts (khata) — all admin-CRUD tables the till *selects from*.
Free-typing money at the till is the exception (manual discount) and permission-gated.

## The menu (MySQL owns it; Sanity was a one-time import)

**MySQL is the source of truth for the menu.** The live Sanity sync and the
Menu Management screen are both retired — the website's Sanity dataset seeded
the menu once and the POS has owned it since. `src/lib/sanityMenu.js` and
`scripts/migrate-to-mysql/` survive ONLY to run that import against production
at cutover; they are deleted afterwards. **No Sanity write token ever belongs
on a till.**

These rules governed the import and still explain the data you will find:

- **Sanity's `price` was the SMALLEST size; `menu_items.price` is the LARGEST**
  (the grid tile shows it, and ModifierModal defaults to the last variant).
  Copy one into the other and every karahi silently drops to half price.
  Variants are ordered ascending by price.
- `menu_items.sanity_id` is **not unique** — one dish can map to several POS
  rows (a dish sitting in two menu sections), and they price together with
  distinct POS names.
- A `sizes` value can be JSON null; type-check before iterating (this crashed
  the import once).
- `is_available` — the kitchen's 86 switch — is POS-owned and must survive any
  future re-import, because a CMS cannot know what is in the walk-in.
- Never delete-and-recreate a menu row to "resync" it: `order_items.
  menu_item_id` points at it, and the order history goes with it.

## Working on this codebase

- Stack: Next.js 16 App Router (plain JS, CSS modules) + **MySQL 8** via
  `mysql2`. Migrations are numbered SQL in `mysql/migrations/`, applied by
  `scripts/db/migrate.mjs`. Supabase and Sanity are both retired — if a doc or
  comment still mentions them, it is stale, not a second source of truth.
- The foundations those old phase gates protected are all in place now:
  `order_items` is canonical, `payments` is a real ledger, users have per-person
  roles and permissions, every table carries `branch_id`. Build on them; do not
  re-derive the ordering.
- Live-DB discipline: additive-only migrations, rehearse against
  `flames_pos_test`, reconcile backfills by COUNT/SUM before promoting.
- Money paths are the five verbs in `src/lib/db/orders.mjs`. Their error strings
  are a cross-checked contract (the till string-matches them; tests assert them)
  — never reword or fork one. Keep
  `DB_NAME=flames_pos_test node --test 'tests/mysql/*.test.mjs'` green.
- To re-explore Blink hands-on: Playwright `launchPersistentContext` with
  `--remote-debugging-port=9222`, let Adnan log in, then attach via
  `connectOverCDP` — navigate by clicking the app's own sidebar links (direct
  URLs bounce), watch for stray Bootstrap modal backdrops, and **stay
  read-only: never Place/Complete/Save/Delete on the live account.**

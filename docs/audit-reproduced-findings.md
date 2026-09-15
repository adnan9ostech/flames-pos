# Findings from the orchestrator's own pass (each reproduced first-hand)

## CRITICAL — C1. The browser sets the price. The server never consults the menu.
Repro: signed in as `cashier` (audit1234), POSTed the `addOrder` server action
(id 40238997211f474ad652d62117c8b649205e06f040) to /orders with
`items: [{ id: <real menu_item_id>, name: '…', price: 1, qty: 1 }]`,
`payment_status: 'paid'`.
Observed: order 512728. `order_items.menu_item_id` = the real Mutton White Qorma,
`order_items.unit_price` = **1.00**, while `menu_items.price` = **8995.00**.
Settled paid at Rs 2.00. Fiscal invoice **FBR-260904-0127** minted. GL sale
journal **SV-260904-0055** posted at Rs 2.00.
Root cause: `createOrder` / `insertRoundItems` in src/lib/db/orders.mjs write the
client's `price` into `unit_price`. No server-side lookup of menu_items.price,
the variant price, the modifier price, or branch_menu_items.
Impact: anyone with a till login can sell anything at any price; the bill, the
receipt, the fiscal invoice and the books all agree with the tampered figure.
Fix: price server-side from the menu (base price, chosen variant, modifiers,
branch override) and keep `expectedTotal` as the "your screen is stale" check.
A line with no `menu_item_id` should be refused — genuine history has 1 such
line in 164 (all 134 others are today's probe data).

## HIGH — C2. `pos` is not enforced on create / append / settle.
Repro: signed in as `kitchen` (kds right ONLY), landed on /kds, POSTed `addOrder`
to **/kds itself** (the action is bundled into app/kds/page, so no cross-page
trickery is needed). Observed: order 072118, Rs 1,420 **paid cash**, `paid_at`
stamped, Rs 185 GST, payment row, invoice FBR-260904-0114, GL journal
SV-260904-0050.
src/lib/orderActions.js:76,132,154 use `requireUser()`; the module header states
the intent as "requireUser on everything, the `void` right on void". But the
permission map defines `pos`, src/proxy.js enforces it on /pos,
/api/orders/open requires it, and ROLE_DEFAULTS withholds it from kitchen and
from accountant — whose comment reads "Reads the money, never rings it".
Fix: `requirePermission('pos')` on addOrder / appendRoundToOrder / settleOrder.
`bumpOrder` must accept `kds` OR `orders` (both /kds and /orders call it).
`setMenuItemAvailability` → `menu` (only /menu calls it; /pos does not).

## HIGH — C3. No record of who rang or who took the money.
Repro: `SELECT action, COUNT(*), SUM(staff_id IS NULL) FROM audit_log GROUP BY action`
→ create_order 199/199 with no actor, settle_order 159/159, void_order 14/14.
Meanwhile remove_item 5/5 DOES record one, as do the expense and user actions.
`orders` has no operator column (waiter_name is the table's server, set on 7 of
205); `payments` has none either.
Voids are the exception worth stating: `orders.cancelled_by` IS populated
(13 of 14), so a void can be attributed even though its audit row cannot.
Impact: the drawer comes up short and the system cannot say who was on the till.
Unrecoverable retroactively. Compounds C1 and C2 — a tampered, unauthorised sale
is also an untraceable one.
Fix: thread `user.id` from the action wrappers into the kernel's existing
auditLog calls. `audit_log.staff_id` already exists and other paths use it.

## HIGH — C4. At a branch with its own tax rate, the till and the server disagree.
Caused by yesterday's per-branch tax work. `src/lib/dataClient.js:213 getTaxRates()`
reads `getSettings()` → `store_settings` only: no branch awareness, and a
module-level `taxRatesCache` that is never invalidated (so switching branch in
the rail does not even re-read it). The server, since yesterday, prices through
`taxRatesFor(conn, branchId)` (src/lib/db/orders.mjs:70).
Observed: a branch-2 order priced by the server at 5% (tax 50, total 1051) while
the till's own rate source returns the company 15%.
Two failure modes: settling a tab at Lahore is REFUSED outright
(orders.mjs:299, "Total mismatch … reload before settling", and reloading cannot
help); and on pay-now the till DISPLAYS 15% while the server stores 5%, so the
cashier reads one number to the customer and the bill prints another.
Fix: make the till's rate read branch-aware and drop or key the cache by branch.

## HIGH (latent) — C5. A paise-priced dish makes the till refuse its own sale.
`calcTotals` (src/lib/orderTotals.mjs:20) sums in floating point and never
quantises; the column is DECIMAL(10,2); the kernel compares with strict `!==`
at orders.mjs:299, 561 and 647.
Repro: `calcTotals([{price:19.99, qty:7}], true, {taxRate:0.16})` → total
161.92999999999998, which MySQL stores as 161.93 → strict inequality → "Total
mismatch". `cleanPrice` (src/lib/menu/rules.mjs:37) returns
`Math.round(n*100)/100`, so paise ARE permitted.
Latent: 0 of 135 dishes carry paise today. tests/mysql/totals.test.mjs states the
assumption in its own header — "Prices are integer rupees (as the menu's are)" —
and seeds `price: randInt(0,5000)`, so the property test can never see it.
Fix: quantise the subtotal in calcTotals (provably identical for integer prices),
and extend the property test to paise.

## HIGH (latent, measured) — C6. The KDS poll scans the whole order history.
`getKitchenOrders` (src/lib/db/reads.mjs:66) filters branch + status with no date
bound, ordered by last_round_at.
Today (131 orders): `type: ALL, key: NULL, rows: 131, Using filesort`.
Measured on an isolated 22,000-order copy with a realistic 18 live tickets:
`type: ref, key: fk_orders_branch, rows: 10867, Using filesort` — it examines
every order the branch has ever taken and sorts them, every few seconds, on every
kitchen screen. FORCE INDEX onto a (branch, status, last_round_at) composite drops
it to `rows: 10`, but the optimiser will not choose it unaided (branch_id
cardinality samples as 1).
Robust fix, measured: add `business_date = <open day>` to the kitchen read AND the
composite index → the optimiser picks it on its own, **10,867 rows → 10**. Also
more correct: a ticket stuck in 'preparing' for three weeks should not be on
today's kitchen screen.

## CRITICAL (dependency) — C7. next 16.1.4 carries a critical advisory.
`npm audit --omit=dev`: 6 vulnerabilities in the production tree — CRITICAL
`next` (HTTP request smuggling, Image Optimizer DoS), HIGH `postcss`, `sharp`,
`ws`, `nanoid`, MODERATE `baseline-browser-mapping`. Fix is
`next@16.3.5`, a semver-MINOR bump that also clears postcss and sharp.

## HIGH (prevention) — C8. `no-undef` is off in a plain-JavaScript codebase.
eslint.config.mjs is `eslint-config-next/core-web-vitals` alone; `npx eslint
--print-config` confirms `no-undef` is "(not set)". There is no type checker.
Proven: a probe reproducing the exact `/api/orders` 500 that shipped yesterday
(a `const` declared inside the authenticating try{} and read after it) is caught
by `no-undef` and is NOT caught by the current config. Enabling it across
src+tests+scripts produces **zero** violations today, so it is free.
This repo has hit that class twice.

## MEDIUM — C9. Drawer write verbs gate on bare requireUser.
`openDrawer`, `recordMovement`, `closeDrawer` (src/app/drawer/actions.js:233,296,345)
use requireUser() while /drawer the ROUTE requires the `drawer` right and
`listSessions` requires it. The file header calls this deliberate ("the cashier
owns their drawer"), but the reasoning does not cover the role that lacks
`drawer` entirely: `recordMovement` changes the expected cash figure directly and
`closeDrawer` freezes a variance and posts a ledger journal.

## MEDIUM — C10. Login throttle is bypassable and unbounded.
src/app/login/actions.js:41 keys the backoff on
`${identifier}|${x-forwarded-for}`. The header is attacker-controlled, so
rotating it resets the throttle. The `attempts` Map (line 21) is never evicted,
so a flood of distinct keys grows it without bound.
Everything else in that path is right: identical message for both failures,
bcrypt compared even when no user exists (constant time), entry cleared on success.

## LOW — C11. Stale comment in the money file.
src/lib/orderTotals.mjs:4-6 points at `store_settings.tax_rate` (the column is
tax_rate_cash / tax_rate_card) and at `getTaxRate() in supabaseDb.js` (removed
with Supabase). Wrong directions in the highest-risk file in the repo.

---

# Proven SOUND (worth stating, because "not broken" is a finding too)

- The general ledger balances exactly: debits = credits (Rs 1,269,604 after the
  audit's own 46 new journals); 0 journals unbalanced on their lines; 0 headers
  disagreeing with their lines; 0 duplicate voucher numbers per (branch, no);
  0 empty journals.
- Every order's own arithmetic holds once `orders.rounding` is included:
  subtotal − discount − rounding + charges + tax = total, 0 exceptions in 205.
  (My first check flagged 3 — that was my own omission of the rounding column,
  which the ledger books through Discounts Allowed.)
- 0 genuine double payments. The 4 orders with two payment rows are void
  reversal pairs (−3014 + 3014) on cancelled orders — the honest way to reverse.
- 0 duplicate invoice numbers per (branch, business_date).
- 189 exported server actions in src/app; only `login` and `logout` lack a
  permission call, which is correct.
- requireUser re-reads the account from the database on EVERY action, enforces
  token_version and is_active, and takes permissions from the DB rather than the
  cookie — so a forged cookie reaches a page but cannot perform an action.
- Session cookie: WebCrypto HMAC verify (not a string compare), httpOnly,
  sameSite=lax, secure in production, `exp` enforced, absent perms treated as
  none rather than as everything.
- No secret in the client bundle: SESSION_SECRET, DB_PASSWORD, DB_USER and the
  FBR token value are all absent from .next/static (the only hit is UI help text
  naming the variables). No .env file is tracked; .gitignore covers `.env*`.
- Indexing is otherwise thorough — 16 keys on orders alone.

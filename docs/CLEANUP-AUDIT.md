# Cleanup audit

Code quality and maintainability review of the Flames POS codebase.
Re-run with `/cleanup-audit`; the mechanical half is `node scripts/audit_deadcode.mjs`.

**Last run:** 2 Sep 2026 · 178 code files · 46 stylesheets · 37,616 lines of JS ·
branch `mysql-migration` at `160a3df`

**Method.** The script found what an import graph can prove (clean — see §0).
Six reviewers then read one area each, a seventh hunted the same helper defined
in many files, and three skeptics re-read every claim with a grep before it was
allowed in here. 122 raw claims → 87 confirmed, 0 refuted outright, 35 merged
into their families below. Where a skeptic corrected a count or a line, the
corrected figure is the one printed.

---

## How to read this

Findings are ordered by **how safe they are to act on**, not by size.
"Safe now" can be done today. "Needs test" touches the till, the money verbs,
the receipt or a screen with no test — do it with a Playwright pass or a
manual click-through named in the plan. "Scheduled" is dead code that is
*deliberately* still here and has a trigger. "Do not touch" needs a decision
from the owner, not an engineer.

Every finding states why it is unnecessary, what removing it buys, and what
could go wrong. The risk is written **before** the plan on purpose.

Two things are true of this run that were not true of the last one. First, the
Supabase era is gone from the tree: `supabaseDb.js`, `src/lib/supabase/`,
`middleware.js`, `reset-pin`, `auth/confirm`, `MenuSyncPanel` — checked, all
absent, nothing to delete. Second, the Accounts module landed two days ago from
seven agents working in parallel, and it shows: the largest debt in this report
is the same helper restated per file, and the largest single win is to finish
what `src/lib/accounts/kit.mjs` started.

---

## 0. The mechanical scan — clean

```
Files nothing imports          0
Exports nothing imports        2   computePlanDiscount, allocate  (deliberate test seams)
Dependencies nothing imports   0
CSS modules nothing imports    0
public/ files nothing refs     0   (125 menu photos are referenced by menu_items.image — see below)
Runtime deps only scripts use  1   @supabase/supabase-js  (scheduled, §5)
```

**The script learned its third trap this run.** It reported all 125 files under
`public/menu-images/` as unreferenced, because nothing in `src/` names a photo —
the *database* does, one path per `menu_items.image` row. The script now counts
that directory separately ("referenced from the database, not the bundle") so a
genuinely orphaned photo still has a line to appear on. Compare its count with
`SELECT COUNT(*) FROM menu_items WHERE image LIKE '/menu-images/%'` (125 = 125).

---

## 1. Safe now

### 1.1 The same helper, written many times — the dominant finding
The seven-agent build restated small helpers per file rather than importing
them. `kit.mjs` (2 Sep) already consolidated seven copies of the voucher
counter; the rest of the family is still scattered. **This is one refactor, not
nine**, and it should land as one commit with the suite as its net.

| Family | Copies | Canonical home | Notes |
|---|---:|---|---|
| Rupee formatter (`rupees`/`money`/`rs`/`num`) | ~34 module-level + ~20 inline | new `src/lib/money.js` (client-safe) | **Five different fraction policies** today: none / 0 dp / 2 dp / mixed. Decide once per domain: till and receipts integer (they are integer-exact by `orderTotals.mjs`), accounts 2 dp. `ReportTools.jsx` and `DiscountPlans.jsx` are the two that already do it right. |
| Karachi "today" (`karachiDay`/`todayKarachi`/`karachiToday`) | 26 under 5 names, plus `KARACHI_TZ` ×3 | new `src/lib/karachi.mjs` (no imports) re-exported by `kit.mjs` | Must be dependency-free: `kit.mjs` pulls the MySQL pool and cannot be imported by `'use client'` files. Two copies live in `orders.mjs` and `consume.mjs` — money path, run the suite. |
| Open-business-day resolver | 20 outside `kit.mjs` (4 different shapes) | `kit.currentBusinessDate(conn)` / `kit.businessDate()` | The single most important date rule in the system, written 20 times. Handover omits `branch_id`; the reports disagree on the fallback (MAX(business_date) vs today) — see 2.4. Keep `orders.mjs`'s as a thin alias; it is tested. |
| `audit_log` writer | 13 functions + 4 inline INSERTs (19 sites) | `kit.audit(conn, {…})` | **Two stamp the wrong day**: `floor/actions.js:19` and `users/actions.js:32` write `CURRENT_DATE` — UTC on this pool, so between 00:00 and 05:00 Karachi the row lands on yesterday. Six writers re-run the business-day SELECT per audit row. `helpers.mjs` keeps a positional adaptor over the object form; pick the object form (it carries `orderId`) and drop the adaptor. |
| CSV escaper + Blob download | 8 escapers, 10 download tails | `ReportTools.downloadCsv` → move to `src/lib/csv.js` | Only the canonical one writes the UTF-8 BOM; the ledger's copy mojibakes `·` and `—` in Excel, `expenses/page.js` quotes numbers so spreadsheets read amounts as text. Same bug fixed once and not the other seven times. |
| Measured `@page` print routine | 3 (`printReceipt.js`, `kotPrint.js`, `item-wise/page.js`) | new `src/lib/printPage.js` `printWithPageSize({rootId, widthMm})` | Constants included (`PX_PER_MM`, `TAIL_MM`). The next auto-cutter fix has to be made three times. Hardware-facing: verify with one real print. `kotPrint`'s afterprint queue must wrap the shared block unchanged. |
| Order-type label map | 5 | `src/lib/orderDisplay.js` (exists, is the stated owner) | `{'dine-in':'Dine-in',…}` in pos, orders, kds, TabsDrawer, KotSlips. The three *status* maps deliberately differ — leave those. |
| `YYYY-MM-DD → label` date helpers | 8 under three locales (en-GB, en-US, en-PK) | `timeFormat.js` (already pins clock times to en-PK — dates were left out) | Choosing en-PK day-first changes chart ticks from "Sep 02" to "2 Sep". `users/page.js whenSeen` drops the Karachi timezone entirely. |
| `requireId` / YYYY-MM-DD validator | 4 + 3 | `kit.requireId`, `kit.requireDate` | Skeptic's note: `requireDate` does not reject 2026-02-31 (V8 rolls it to March). Add a calendar check while consolidating. |
| Modifier-name flattening | 3 | `orderDisplay.formatModifiers` (adopt `kotPrint`'s tolerant body) | The POS cart row hand-inserts separators; only the KOT copy tolerates a bare string. |
| Compact axis money (`Rs 12.5k`) | 5 with three unit rules | `money.js compactRupees` | item-wise and menu-analytics are byte-identical; the other three each round differently. |
| `hourLabel` / `karachiHour` | 2 + 2 | `timeFormat.js` | Cash Register renders `18:00` while everything else says `6 PM`. |
| Small twins: `UUID_RE`, `num()`, `isDuplicateKey` | 2 / 2 / 12 sites in two idioms | `serialize.mjs` or `kit` | Ride along with the above. |

**Why unnecessary.** Each family is one job with N spellings; every divergence
listed in the Notes column is a bug that exists *because* of the copy.
**Impact.** Roughly 700 lines removed across the families; one rendering rule
for money, one definition of "today" and "the open trading day", one audit
column list, one CSV writer. **Risks.** Pure refactor except where noted (money
path files, receipt, till) — those are needs-test and are called out. Nothing
here string-matches a contract. **Plan.** In order: (1) `src/lib/karachi.mjs`
and `src/lib/money.js` — dependency-free, importable everywhere; (2) point
`kit.mjs` and `timeFormat.js` at them; (3) replace the families file by file,
running `DB_NAME=flames_pos_test node --test 'tests/mysql/*.test.mjs'` after
each of `orders.mjs`, `consume.mjs`, `expensePost.mjs`; (4) one Playwright pass
over pay-now / open-tab / settle and one real receipt print at the end.

### 1.2 Dead code the graph cannot see — all verified by hand this run
| Where | What | Fix |
|---|---|---|
| `public/sw.js:51` | Caches a `/icons/` prefix; no such directory (the PWA icon is `/icon.png`, already matched by `.png`) | Delete the clause |
| `src/app/profile/actions.js:6` | `readSession` imported, never used | Drop from the import |
| `src/lib/dataClient.js:28` | `KITCHEN_STATUSES` exported, imported by nothing (`reads.mjs` has its own private copy — the one the query uses) | Delete; fix the `kds/page.js:15` comment to point at `reads.mjs` |
| `src/proxy.js:14` | `'/logout'` in `ALWAYS_ALLOWED` — there is no `/logout` page, only a server action | Remove; while there, replace the Next boilerplate matcher comment with what the exclusion does |
| `src/components/Layout/Sidebar.module.css:183` | `.spacer` has no element | Delete |
| `src/components/POS/ModifierModal.jsx:92` | `basePrice` stored on every modified cart line, read nowhere — rides through the draft, the request and into `order_items.modifiers` JSON | Delete the line |
| `src/app/accounts/chart/actions.js:29,76,131,160` | `has_postings` computed by a correlated `EXISTS` in three queries; the chart page never reads it | Remove the clause and the `toRow` field |
| `src/app/accounts/actions.js:22,40,46-47,52` | Hub overview runs `gl_settings` and `COUNT(accounts)` queries the page never renders | Drop both and the three response fields |
| `src/app/accounts/expense-codes/actions.js:31,48`, `expense-vouchers/actions.js:39` | `category_code`, `posted_at` selected and shaped, never displayed | Remove or display |
| `src/lib/accounts/expensePost.mjs:90-102, 44` | `nextJournalNo` is a byte-for-byte copy of `kit.nextVoucherNo` (the file already imports from kit); `export { money }` has no importer | Import from kit; delete both |
| `src/lib/auth/permissions.mjs:96` | `can(session, key)` has no production caller — `AppLayout` builds its own closure | Either delete it and its 8-line test, or make `AppLayout.jsx:65` use it. Delete is simpler |
| `src/lib/db/auth.mjs:62-73` | `requireAdmin` ≡ `requirePermission('users')` (admin always holds `users`); 7 callers, all in `users/actions.js`; two error strings for one condition | Replace the 7 calls, delete the function, fix the `inventory.mjs:9` comment that still names it |
| `src/app/reports/page.js:541,693` | Tooltip formatter branches for a series the chart never plots | Collapse to one branch. **Keep** `hourly[].orders` server-side — the skeptic found it drives the window trim at `actions.js:268` |
| `src/app/settings/page.js:193,247-253` | A comment about percentage fields that moved to `/settings/tax`, and six blank lines where the inputs were | Delete both |
| `src/app/inventory/page.js:12-16` | "linked before those pages exist — a dead link during the build-out beats…" — all five pages exist | One-line comment |
| `src/components/Auth/LoginForm.jsx:135-138` | The submit button's spinner + "Signing in…" sit under an 88%-opaque full-screen overlay; never visible | Constant label; drop the `Loader2` branch |

### 1.3 Two dead affordances that should become live ones
- **`ReceiptPreview` FBR block can never render** (`ReceiptPreview.jsx:20,218-234`).
  The `order` prop it reads was added with the FBR module; neither caller
  passes it. When FBR goes live, a reprint is the only way a *backfilled*
  invoice number reaches paper. **Fix:** `orders/page.js:767` add
  `order={receiptOrder}` (the row already carries `fbr_invoice_number`). Keep
  the block; do not delete it.
- **Cash Register's voucher link goes nowhere** (`cash-register/page.js:144`)
  — `/accounts/journals?voucher=…`, and the journals page reads no search
  params. The row already has `journal_id`. **Fix:** link to
  `/accounts/journals/${journal_id}` as the voucher page already does.
- **Posting Health is unreachable from the hub that shows its number**
  (`accounts/page.js:106-119`). The "Bills not in the ledger" card is the count
  Health explains; it has no link. **Fix:** wrap the card in a Link when
  `can('accounts_admin')`.

### 1.4 Redundant queries and round trips
- **Handover runs ten independent queries in series**, and one is the SUM of
  the next (`handover/actions.js:49-163`). Nine round trips saved on a shared
  cPanel pool with one `Promise.all`; `expenseTotal` = `byCategory.reduce`.
  Daily-sales and item-wise each await two independent queries back to back.
- **Handover also leaks raw database error text** to the client and folds the
  permission check into the same catch (`:37-44, 220-222`) — the only report
  action that does. Two-line fix to match its six siblings.
- **`getOpenTabs` sorts client-side to reverse the server's `ORDER BY`**
  (`dataClient.js:114-118`) on every 4-second poll. Say `DESC` in the SQL.
- **Six audit writers re-run the business-day SELECT per audit row** — folds
  into the audit family above.

### 1.5 Small debts
- **Login throttle Map grows without bound** (`login/actions.js:21,58`): a
  failed key is only evicted by a later *success* on that exact key. On the
  public internet, credential-stuffing adds an entry per username forever.
  Store `{n, at}`, sweep entries older than an hour, cap at 10k.
- **Report `branch_id` is pinned in four actions and absent in three**
  (`gross-profit`, `menu-analytics`, `handover`), while the hub previews claim
  to match them. One convention; fix the comment either way.
- **Date-picker `max` on the reports hub is the UTC day**, not Karachi
  (`reports/page.js:428,437`) — before 05:00 PKT the picker refuses today.
- **User-admin audit rows stamp `CURRENT_DATE`** — folded into the audit family.
- **`.env` loader copied into four scripts** and the readline prompt into two
  (`fbr-worker`, `db/migrate`, `db/seed-users`, `db/set-password`). One
  `scripts/db/_env.mjs`; ~100 lines.
- **Components declared inside render bodies** remount on every keystroke:
  `cityledger/page.js:120` (`Note`), `inventory/masters/page.js:115-150`
  (`FormActions`, `EditBtn`). The same `Note` block is pasted inline in four
  more screens — one shared `<Note>` closes both.
- **Six identical `<style jsx global>` print blocks** across the Accounts
  screens differ only in a root id; `accounts.module.css` already owns
  `@media print`. Move the four body-level rules to `globals.css`, delete six.
- **Merchant name looked up three times, its fallback string in three files**;
  `cleanRange` duplicates `range`. One `merchantName()` in kit.
- **Three GET routes share a 20-line auth-then-read skeleton**
  (`kitchen`, `open`, `unpaid-count`). One `readRoute({permission, read})`.
- **`STATUS_CLASS` ×4, `TYPE_TABS` ×2, a hand-typed `GROUP_LABEL`** beside a
  derived one, in the Accounts screens. Export once from `constants.mjs`.

---

## 2. Needs test

### 2.1 The receipt prints the wrong tax rate — a defect, not cleanup
`ReceiptPreview.jsx:70` reads `settings?.tax_rate`, **a column that does not
exist** (store_settings has `tax_rate_cash` and `tax_rate_card`), so it always
falls back to 16%. **A card bill taxed at 5% prints "GST (16%)" above a 5%
amount, and every reprint asserts 16% regardless of what was charged.** The
POS already computes the right label (`taxPercentLabel`) and orders carry
`tax_rate` since migration 008, so the data is in both callers' hands.
**Fix:** a `taxRate` prop; POS passes its rate, the reprint passes
`Number(order.tax_rate)` with the default for pre-008 rows. Print a cash and
a card bill and a reprint of each. **This is the first thing to do from this
report.**

### 2.2 24 bare `toLocaleString()` on money — the receipt varies by device locale
`ReceiptPreview.jsx` ×7, `pos/page.js` ×11, `orders/page.js` ×3,
`customer/page.js` ×2, `TabsDrawer.jsx` ×1. `timeFormat.js` pins clock times to
en-PK precisely to stop this class of drift; money was left out. On an en-IN
till the receipt prints `Rs. 12,34,567`; on de-DE, `Rs. 1.234.567`. Lands with
the money-formatter family in 1.1 — use en-PK with no fraction options so
today's integer output is unchanged. Add a `tests/` grep (or an ESLint
`no-restricted-syntax`) so a bare call cannot come back. **Everywhere else in
the tree is clean** — reports, accounts and back office all pin a locale.

### 2.3 The till and the money path
- **POS fetches `/api/menu` three times on load** (`pos/page.js:169-173`):
  nine SELECTs and three round trips where `getFullMenuData()` — written for
  the customer page, "One request, not three" — does it in one. Five-line
  change; then delete `getCategories`/`getModifiers` from `dataClient` if
  nothing else imports them.
- **`getSettings` is called three times per sale** for one row (`dataClient:179`,
  `pos/page.js:217`, `ReceiptPreview.jsx:57`), the last of which gates the
  Print button behind a "Loading…" flash on every receipt. One page-lifetime
  settings cache; pass `settings` into the receipt as a prop.
- **Pay-now `createOrder` recomputes the order twice** and re-reads tax rates,
  business date and charges inside one transaction (`orders.mjs:427-446`) —
  seven redundant statements on the most common transaction the till runs.
  Let `settleOrderTx` accept pre-resolved `{rates, businessDate}`. **Money
  path: no error string moves, the expected-total check stays where it is,
  17 concurrency tests must stay green.**
- **`getOrdersVersion` runs `COUNT(*)` over the whole orders table every 4 s
  per open terminal** (`reads.mjs:68-74`). InnoDB `COUNT(*)` is a full index
  scan that grows with every sale ever made. Window it:
  `WHERE updated_at >= UTC_TIMESTAMP(3) - INTERVAL 2 DAY` uses the existing
  index and keeps the same-millisecond tiebreak for anything touched recently.
  Orders are never deleted, so the semantics hold. `EXPLAIN` it on a
  prod-sized table.
- **Unreachable `?? 0` after `Number()`** (`orders.mjs:261`): the intent was a
  fallback for a bad value; `Number(x) || 0` is what does that.
- **Five components declared inside `OrdersPage`** (`orders/page.js:310-416`)
  remount every card's subtree — thumbnails included — on every 4-second poll
  that finds a change. Hoist them; pass the five closed-over values as props.

### 2.4 Reports
- **The hub still aggregates the `orders.items` JSON snapshot in JS**
  (`reports/actions.js:57-76, 239-253`) — the column the schema itself labels
  "display snapshot; order_items is canonical". Top Selling and Trending are
  the only figures in the tree still built from it (and they ignore
  `line_total`). Two `GROUP BY order_items` queries replace ~35 lines.
- **`SELECT * FROM orders` twice** (current + previous window), every column
  including the JSON, then aggregated in JS with most of the previous window's
  work thrown away (`:203-222, 57-146`). Five aggregate queries return under 60
  rows. Skeptic's caveat: `previous.itemCounts` *is* consumed by Trending, so
  that one stays until 2.4's first bullet lands.
- **Three hour-of-day bucketings that disagree**, two of them on the hub at
  once (`actions.js:40-42,119-124,343`; `hourly/actions.js`). One SQL fragment,
  one decision (paid-at vs created-at), zero-fill in JS.

### 2.5 Accounts
- **Three list + side-form screens are one screen pasted three times**
  (chart, expense-categories, expense-codes: 1,330 lines). The `?new=1` focus
  effect is character-for-character identical in two of them; the 4-second
  success-clear effect is in ten files tree-wide. Extract `useFlash()`,
  `useNewParamFocus()`, `useEditableList()`; ~400 lines. No UI tests — click
  through add/edit/toggle on all three, with and without `accounts_admin`.
- **Three catalog action files restate the same save/toggle transaction shape**
  and the "account must carry link X and be active" check. One
  `catalog.mjs`; ~120 lines. Categories and codes actions have no test — add
  them while there.
- **Expense Report and Payables exist twice with different data sources**
  (`api/accounts/export/route.js:47-93` reads the voucher tables; the screen
  and CSV read `expenses`, which also holds legacy chits). Same date range,
  two totals; the Excel ignores `summarize`. Move the builders to a plain
  module both can import.
- **Each voucher verb re-SELECTs the header it just wrote**, then the action
  discards it and reloads the whole document (`expensePost.mjs:622,753,815`).
  The tests read the returned `.voucher`, so keep the shape; skip the reload.
- **`statements.mjs` has no test** — trial balance, income statement, balance
  sheet and cash register rest on it, and every other lib in the module is
  tested. Add one before touching the report layer.

### 2.6 Back office
- **Pages gate UI on `role === 'admin'` while their actions gate on permissions
  a manager and an accountant also hold** (`expenses`, `drawer`, four inventory
  pages). The server already allows it; the screens hide the forms. Replace
  seven role-string checks with `can('<key>')`. Confirm with the owner that a
  manager should post receivings and counts.
- **`/floor` writes are non-transactional**, audit at `CURRENT_DATE`, and
  `deleteWaiter`/`deleteTable` write the audit row *before* the DELETE — a
  failed delete leaves an audit trail for something that did not happen. Six
  dead `revalidatePath` calls. Wrap in `withTransaction`, audit through kit.
- **City Ledger loads eight queries for whichever tab is open**, and "charged
  per company" is summed three different ways that could disagree on
  rounding. Fetch per tab; one definition of a company's balance.
- **`closeBusinessDay` reads pending bills twice, once outside the lock**, and
  `loadState` a third time. Read once under `FOR UPDATE`; the audit row's
  `carried_orders` becomes exact.
- **City-ledger invoice numbers come from `COUNT(*) LIKE 'CL-YYMM-%'`** with a
  "try again" message for the race, beside a `kit.nextVoucherNo` that already
  serialises under a counter lock. Format differs (`CL-YYMM-NNN`, monthly) —
  key the counter on the first of the month.
- **The on-hand derivation `SUM(delta) FROM stock_ledger GROUP BY …` is written
  six times** and the inventory hub scans the ledger twice per load. A
  `v_stock_on_hand` view (additive migration) gives one definition and one
  scan.
- **725-line users screen**: `UserRow` takes 22 props; four sub-components live
  in the page. Split; collapse the three panel states into one `{kind, id}`.
  Seven manual flows to re-check, listed in the finding.

---

## 3. Scheduled — deliberate, with a trigger

- **The OLD `/expenses` screen** (1,799 lines) is superseded by Accounts expense
  vouchers: every job it does has a newer owner, and it is the last write path
  that can put cash out of the drawer *without a journal* — the Health page's
  "legacy chits" list exists to catch exactly that. **Trigger:** Health's
  legacy-chit count is 0 in production. Then delete the directory, the nav
  entry, and repoint `landingPath('expenses')`.
- **`scripts/migrate-to-mysql/`, `src/lib/sanityMenu.js`, `@supabase/supabase-js`** —
  unreferenced by the app, load-bearing for the one-time production menu
  import. **Trigger: cutover.** Nothing new found about them this run.
- **`applicablePlans` accepts `orderType` and ignores it** — the schema has no
  per-mode discount scoping yet; the till passes it anyway. Either implement
  (migration + `/discounts` UI, and the ChowPOS benchmark wants it) or drop the
  parameter. Owner's call.
- **Two competing page-load idioms across 30 pages** (`useCallback load` +
  effect vs cancelled-flag effect). A `useServerAction()` hook would remove
  ~300 lines, but a one-commit sweep across 30 untested screens is how
  regressions happen. **Adopt it on the next page that gets touched; never as
  one sweep.**
- **The reports hub is a 795-line Tailwind + styled-jsx page** in a tree that
  is otherwise CSS modules, carrying a second dashboard under the card grid.
  Split after the data-layer fixes in 2.4 land; its print view is what the
  owner prints, so re-verify it.
- **`useRole()` still drives UI in eight screens** after the move to per-key
  permissions — a cashier granted `reports` by override is exactly the case
  the override exists for, and these branches ignore it. Page by page.

---

## 4. Do not touch — owner's decisions

- **The receipt prints fake fiscal numbers**: `NTN: 1234567-8 | STRN: 1234567890123`
  are hard-coded placeholders on a document FBR may inspect. There is no
  settings column for the real ones. **Needs Adnan's numbers**; add `ntn`/`strn`
  to Tax & FBR settings and omit the line until set. Never invent them.
- **`branch_id` is hard-coded to 1** in the verbs while every table carries the
  column. `kit.mjs` exports `BRANCH_ID`; import it rather than writing `1` in
  six places, and record the decision (single-branch by design, or a second
  branch later) in STATUS.md. Do not change behaviour.

---

## 5. Checked and found clean

So the next run knows what was considered, not just what was found:

- **No Supabase/Sanity/Vercel code remains** in `src/`: `supabaseDb.js`,
  `src/lib/supabase/`, `middleware.js`, `reset-pin`, `auth/confirm`,
  `MenuSyncPanel` all absent. `sanityMenu.js` is the scheduled import tool.
- **Every runtime dependency is imported by `src/`** except the scheduled
  `@supabase/supabase-js`; every devDependency is used.
- **All CSS-module classes are referenced** in every area (334 in the till,
  255 in reports, 811 lines of `accounts.module.css`, 15 back-office modules)
  except `Sidebar.module.css .spacer` (§1.2).
- **No bare `toLocaleString()`** anywhere in reports, accounts or back office —
  the 24 in §2.2 are all in the till/receipt area.
- **Auth and session**: `session.mjs` verifies with `crypto.subtle` (constant
  time), enforces `exp` and `token_version`; `proxy.js` makes zero DB calls;
  `login/actions.js` does a dummy-hash compare on unknown users; `users/actions.js`
  never returns a hash and guards the last admin. `/api/*` routes each gate
  themselves — two that did not (`/api/orders`, `/api/orders/open`) were
  fixed by the security review in `160a3df`. **Gap:** `session.mjs` has no
  test at all (§1.5 of the previous list — add `tests/mysql/session.test.mjs`).
- **The money verbs**: error strings and `calcTotals` untouched by every area;
  `orders.mjs` is the only writer of `orders.items`; `postLedger` is the single
  stock-ledger writer; `consume.mjs` reads `order_items` (the canonical rows).
- **Polling**: one `useRealtimeTable`, three call sites, in-flight guard,
  hidden-tab pause, jittered timer; no second poller and no leftover KDS
  interval.
- **Idempotency on the till**: `requestIdRef`, `roundRequestIdRef`,
  `settleRequestIdRef` minted per basket, reused on failure, cleared on success.
- **`kotPrint.runPrintQueue`** is the only afterprint queue; `printReceipt` does
  not duplicate it (only the `@page` block, §1.1).
- **Inventory**: no N+1 — receiving and docs batch line fetches with `IN (?)`;
  every `inventory.mjs` export has a caller; the on-hand SUM is correct, just
  restated (§2.6).
- **Accounts**: every `constants.mjs` and `xlsx.mjs` export consumed; no
  component declared inside a render body on any of the 16 screens; `gaps.mjs`
  is four set-based queries; `nextVoucherNo` now exists once.
- **`public/`**: `fbr-logo.png`, both logo SVGs, `sw.js`, `offline.html`,
  `manifest.webmanifest` all referenced; the 125 photos are DB-referenced (§0).
- **Scripts and deploy**: `fbr-worker` drains on SIGTERM and imports the pool
  after env load; `deploy.sh`/`ecosystem.config.js` bind loopback and migrate
  before reload; `scripts/test_qr.mjs` stays (parked Raast work).

---

## What changed since the last run (28 Aug 2026)

The 28 Aug report described the Supabase-era tree; its §1 ("safe now") was
done that day and everything else it named was deleted wholesale by the MySQL
migration rather than cleaned. That report was removed on 1 Sep once it stopped
being true; this file starts fresh.

- **Fixed since / during this run:** seven restated copies of the voucher
  counter consolidated into `kit.mjs` (`d7398d7`); two API routes that skipped
  their permission gate (`160a3df`); the audit script taught that menu photos
  are database-referenced (this commit).
- **Newly found:** everything above. The two that are defects rather than
  debt — the receipt's tax label (§2.1) and its device-locale money formatting
  (§2.2) — go first.
- **Still open from before:** nothing carried; the migration retired the list.

# Cleanup audit

Code quality and maintainability review of the Flames POS codebase.
Re-run with `/cleanup-audit`; the mechanical half is `node scripts/audit_deadcode.mjs`.

**Last run:** 9 Sep 2026 · 198 code files · 56 stylesheets · ~54,000 lines of JS ·
branch `mysql-migration` at `69afbbc` **plus a large uncommitted working tree**

**Baseline:** `DB_NAME=flames_pos_test node --test 'tests/mysql/*.test.mjs'` —
**139/139 pass in 2.5s.** `npm run build` green. `npm run lint` **exits 1**
(37 errors, 9 warnings — §1.1).

**Method.** The mechanical scan ran first. Then twelve reviewers read one area
each and three more hunted across the whole tree for duplicated helpers,
redundant queries and abandoned files; a skeptic re-verified every claim with a
grep or a read before it was allowed in here, and a completeness critic looked
for what nobody had opened. 208 claims + 57 skeptic additions → merged into the
families below. Where a skeptic corrected a count, a line or a safety level, the
corrected figure is the one printed. Nothing in this file is a claim nobody
checked twice.

**What is different about this run.** The tree audited on 2 Sep was 178 files.
This one is 198, and the difference is almost entirely *uncommitted*: menu
management, theming, ESC/POS thermal printing, the cash drawer, day rollover,
the order-detail panel, nine migrations (010–018) and four test suites all
landed since and none of it has ever been swept. That is where most of what
follows lives.

---

## Read this first — the ten defects

Ordering below is by *how safe to act on*, which puts several real bugs low on
the page. These are the ones that are wrong today, with the section that
explains each:

| | What is broken | Where |
|---|---|---|
| 1 | ~~Chart of Accounts cannot save a new account~~ — **FIXED 9 Sep.** `pattern="\d{5}"` had survived migration 018, which made every number four digits, so the form refused the number the app itself suggested. | §2.1 |
| 2 | ~~`updateTaxSettings` UPDATEs `store_settings` with no `WHERE`~~ — **FIXED 9 Sep.** It reported success even when it wrote nothing. These are the two GST rates every bill is taxed at. | §2.2 |
| 3 | ~~An empty GST box silently sets the tax rate to 0%~~ — **FIXED 9 Sep.** The fallbacks written to prevent it were unreachable, on the client and on the server. | §2.2 |
| 4 | **The till's Pay Now / Settle buttons print the pre-discount total** one row under the discounted Total. | §2.3 |
| 5 | ~~Opening a tab throws away the discount reason~~ — **FIXED 9 Sep.** It was the only path in the till where money came off a bill with no stored reason. | §2.3 |
| 6 | ~~`addToCart` mutates React state in place~~ — **FIXED 9 Sep.** On the most-tapped handler on the money screen. | §2.3 |
| 7 | **Day Close can be permanently blocked**: the pending-bill gate reads every unpaid order ever taken, with no branch and no business date. | §2.5 |
| 8 | **KOT slips ask for an 80mm page on a 58mm till** — `SLIP_WIDTH_MM` is a constant where the receipt measures. | §2.6 |
| 9 | **FBR invoices are POSTed without claiming the queue row** — one sale can be filed twice. Latent until `FBR_ENABLED=true`; fix before cutover. | §2.4 |
| 10 | **The Reports hub's Gross Profit card costs recipes variant-blind**, so its margin contradicts the report the card links to. | §2.7 |

---

## Fixed in this run (9 Sep 2026)

Five of the ten defects above are closed. Suite 139/139, `npm run build` exits
0, `npx eslint` on the four touched files reports 0 errors (the tree-wide count
is unchanged at 37 — none of those rules were in scope).

- **§2.1 Chart of Accounts.** `pattern="\d{4}"` / `maxLength={4}`
  (`chart/page.js:359-360`). The screen's subtitle was worse than stale — it
  printed the *retired ChowPOS series* ("3 income · 4 expense · 5 equity")
  while `GROUPS` has said 3 equity, 4 income, 5–9 expense since migration 018,
  so the one line telling an accountant how the chart is numbered was telling
  him the wrong thing. It is now derived from `GROUPS` and reads
  "1xxx asset · 2xxx liability · 3xxx equity · 4xxx income · 5–9xxx expense",
  which cannot drift again. Five-digit example in `suggestNumber`'s comment
  corrected too.
- **§2.2 Tax settings, both halves.** `updateTaxSettings` now reads the row and
  branches — `UPDATE … WHERE id = ?` when it exists, `INSERT` naming only the
  tax columns when it does not, so it cannot blank a merchant field the General
  tab owns. **No `affectedRows` check was added, deliberately:** the pool sets
  no `CLIENT_FOUND_ROWS`, so re-saving unchanged values reports 0 rows affected
  and the check would have failed honest saves. The read-then-branch makes
  "wrote nothing" unreachable instead.
- **§2.2 The empty box.** The defect was in *two* places, and fixing only the
  server would have left it live: `tax/page.js` posted its hidden field as
  `Number(taxCash) || 0`, so a cleared box arrived as a hard `"0"` that the
  server could not tell from a deliberate 0%. Both percent inputs are now
  `required`, and a new `percentField()` posts blank as blank so the server's
  fallback is actually reachable.
- **§2.3 `addToCart`.** Replaces the line instead of mutating it, matching
  `updateQty` twelve lines below.
- **§2.3 Open-tab discount reason.** `handleOpenTab`'s payload now carries the
  same `discount_reason` expression `handlePayNow` uses. Verified through the
  kernel: `orderActions.js:85` forwards it and `orders.mjs:384,401` persists it
  on the create path, so it lands on an unpaid tab, not only at settle.

**Still owed on these:** the till pair have no automated coverage — there is no
Playwright harness in this tree — so pay-now, open-tab-and-round and settle
still want a manual pass before this ships. `computePlanDiscount` remains
untested (§1.11 of the plan list), which is what a discount test would have
caught.

---

## How to read this

Findings are ordered by **how safe they are to act on**, not by size.
"Safe now" can be done today. "Needs test" touches the till, the money verbs,
the receipt, the printer or a screen with no test — do it with the manual pass
named in the plan. "Scheduled" is dead code that is *deliberately* still here
and has a trigger. "Do not touch" needs a decision from the owner.

Every finding states why it is unnecessary, what removing it buys, and what
could go wrong. The risk is written **before** the plan on purpose.

---

## 0. The mechanical scan

```
Files nothing imports          0
Exports nothing imports       26   (was 2 on 2 Sep)
Dependencies nothing imports   0
Dev dependencies unused        0
CSS modules nothing imports    0
public/ files nothing refs     0
Runtime deps only scripts use  1   @supabase/supabase-js  (scheduled, §3)
public/ referenced from the DB 125 menu photos — matches menu_items.image
```

**The 2 → 26 jump is the story of this run.** Adjudicated one at a time:

- **3 dead outright** — delete: `useUserName` (`AppLayout.jsx:26-28`; the sidebar
  takes `name` as a prop at `:109`), `groupForNumber` (`constants.mjs:45-48`,
  arrived with the 018 chart work, never called), `AXIS_TICK`/`LABEL_TICK`
  (`chartTheme.mjs:65-67` — and they would be wrong to adopt as they stand:
  every one of the 14 tick sites sets its own `fontSize`).
- **12 over-exported** — drop the `export`, keep the name: `SIDEBAR_GROUPS`
  (`navIndex.mjs:324`), `groupRoundByCategory`/`groupRoundByItem`
  (`kotPrint.js:129,169`), `uploadDir` + `currentBusinessDate`
  (`menu/kit.mjs:13,21`), `UUID_RE`/`MODIFIER_KEY_RE`/`IMAGE_FILE_RE`/
  `IMAGE_TYPES` (`menu/rules.mjs`), `thermalAgentReady` (`thermalAgent.js:33`).
- **5 deliberate toolkit** — `CMD`, `columnsFor`, `rule`, `row`, `stampOf` in
  `print/escpos.mjs`. Leave exported; the module header says a test is expected
  to load it. Write that test and the question answers itself.
- **4 the half-built day worker** — `BRANCH_ID`, `openDayTx`, `pendingBillsTx`,
  `closeDayTx` in `day/rollover.mjs`. See §2.5, the largest finding in this run.
- **2 deliberate test seams** — `computePlanDiscount`, `allocate`. Unchanged.

**The script has a fourth blind spot, and it hid the biggest finding.**
`orphanFiles` counts any file with a non-empty `importedBy`, and `importedBy`
includes `tests/` as a consumer — correct for exports, wrong for files. A module
whose *only* importer is its own test is laundered into "reachable". That is
exactly `src/lib/day/rollover.mjs`, and the scan reports "Files nothing imports
0" while the app runs a different copy of the same logic. **Teach the script:**
add a "Files only tests import" section after the orphan block, worded as a
question ("reachable only from tests — finished, or abandoned?"), matching the
file's own "Candidates, not verdicts" footer.

**The scan does not measure CSS classes, only CSS modules.** A per-class sweep
of all 55 modules found 27 apparently-unreferenced names, of which 24 are
composed dynamically (``styles[`status_${o.status}`]``) and 3 are genuinely
dead (§1.4). Worth teaching the script both directions — it should also flag
classes *referenced with no rule behind them*, which is how `.status_cancelled`
(§2.9) and two `.logo` references (§1.4) went unnoticed.

---

## 1. Safe now

### 1.1 `npm run lint` has never been run — and it fails
`package.json:9` defines `"lint": "eslint"`, and `eslint.config.mjs:4` extends
`eslint-config-next/core-web-vitals`, so the project has already opted into the
React Hooks and Next correctness rules. It exits 1: **37 errors, 9 warnings.**
Fifteen reviewers hand-read 208 files this run and none of them ran it; the
2 Sep report called the mechanical half "clean" on the strength of
`audit_deadcode.mjs` alone.

Two of the four failing rules are correctness classes that hand-reading missed
entirely — `react-hooks/refs` ×10 and `react-hooks/static-components` ×2
(§1.6, §2.10). The other 25 are `react-hooks/set-state-in-effect`, the standard
`useEffect(() => { load() }, [load])` idiom, which works.

**Why unnecessary.** A three-second gate exists and is switched off.
**Impact.** Turns a 208-file hand audit into a command. **Risks.** Do **not**
bulk-fix the 25 set-state errors — that rewrites the data-loading path of 23
untested screens in one commit, the single change most likely to break a screen.
**Plan.** (1) Land the two small mechanical groups (§1.6, §2.10) — 12 errors,
four files. (2) Leave the 25 alone; adopt the correct pattern one screen at a
time, and the pattern to adopt already exists at
`accounts/reports/trial-balance/page.js:27-41`. (3) Only once the count is zero,
change the script to `eslint --max-warnings=0`.

### 1.2 The four statement pages nobody read already solve six other areas' problems
`src/app/accounts/reports/` holds 669 lines that no reviewer had opened, and
they contain working implementations of three things other findings propose to
invent: the stale-response guard (`trial-balance/page.js:29-37`, the `let
cancelled` + response-key shape, with a comment explaining it) that the two
orders screens lack; derived loading instead of a stored flag
(`trial-balance/page.js:41`), which is the fix for the hub blanking its screen;
and one shared CSV exporter with a UTF-8 BOM (`ReportTools.jsx:52-65`) against
which seven private copies are counted in §2.12.

**Impact.** Changes six other plans from "design a shared helper" to "import the
one that four money screens already use". **Risk.** `ReportTools.rupees` uses
`{min: 0, max: 2}` fraction digits — one of the six policies in §2.12. Do **not**
adopt it as the tree-wide default; `src/lib/money.js` is the sanctioned
formatter, and the right move is to make `ReportTools.rupees` delegate to it.
**Plan.** Read `ReportTools.jsx` and `trial-balance/page.js:27-55` — 68 and 30
lines — *before* actioning any duplication finding below.

### 1.3 Dead code the graph cannot see — every item grep-verified this run
| Where | What | Fix |
|---|---|---|
| `src/lib/dataClient.js:19,206-207` | `setMenuItemAvailability` re-export is dead — Menu Management imports the action directly from `@/lib/orderActions` (`menu/page.js:19`). 17 of 18 dataClient exports are live; this is the one that is not | Delete 4 lines |
| `src/lib/accounts/constants.mjs:45-48` | `groupForNumber` — one occurrence in the tree, its own definition | Delete |
| `src/lib/accounts/statements.mjs:397,31,20` | `groupRank` has no call site; `GROUP_ORDER` exists only to feed it; the `GROUPS` import dies with them | Delete all three |
| `src/components/Layout/AppLayout.jsx:26-28` | `useUserName` — the sidebar takes `name` as a prop | Delete |
| `src/lib/reports/chartTheme.mjs:65-67` | `AXIS_TICK`/`LABEL_TICK` — no consumer, and adopting them would lose the `fontSize` all 14 sites set | Delete |
| `src/app/reports/page.js:541-543,699-701` | Two tooltip `else` branches for series the charts never plot (one `Area`, one `Bar`, both without a `name` prop, so recharts can only ever pass the dataKey) | Collapse to one branch each |
| `src/app/reports/actions.js:231,234` | `chartData[].orders` computed and never read. **Keep** `summarize()`'s `hourly[].orders` — it drives the window trim at `:268-272`; strip it only from the returned objects | Delete 2 lines |
| `src/app/accounts/expense-vouchers/actions.js:39`, `expense-codes/actions.js:31,48` | `posted_at` and `category_code` selected, ISO-stringified and returned on every list row; neither screen renders them | Remove, or display `posted_at` — the list has no "when posted" column and the field is already there |
| `src/app/globals.css:408-489` | 82 lines of hand-rolled Tailwind clones (`.font-bold`, `.container`, `.flex-col`…). Verified by compiling the real pipeline: `.font-bold` is emitted twice with identical output; `.flex-col` only ever comes from the hand-rolled copy because Tailwind never sees the class used | Delete — 13% of globals.css |
| `tailwind.config.js:18-43` | A 12-shade `gray` ramp behind a comment ending "Do not reach for it in new work". `grep -rnoE '\-gray\-[0-9]+' src` → 0 | Delete, or point the values at the CSS variables they were copied from |
| `tailwind.config.js:14` | `darkMode: ['class', '[data-theme="dark"]']`. `grep -rnoE '\bdark:[a-z-]+' src` → 0, and nothing toggles a `.dark` class — `ThemeProvider` stamps `data-theme` | Delete, replacing with one line saying theming is variable-based so `dark:` is never the answer here |
| `src/components/Auth/login.module.css:215-225` | `.spinner`, its `@keyframes spin` and the reduced-motion guard — orphaned by the 2 Sep fix that removed the invisible submit spinner from the JSX. The pending state is `CookingLoader` now | Delete 11 lines |
| `src/app/pos/page.js:230` | `console.debug('POS loadData: …')` on the till's mount path | Delete |

Small print worth keeping: `.summaryCell`/`.summaryValue`/`.summary`/`.metaMono`
in `expense-vouchers/voucher.module.css:49-53,84-102,122` are dead too — but
`expense-vouchers/actions.js:187-250` really does compute and return a `summary`
that nothing renders. Delete the CSS; **raise the unrendered payload with the
owner** rather than assuming it was abandoned.

### 1.4 Three CSS classes referenced with no rule behind them
The inverse of the usual check, and it found what the forward check could not.
`customer/page.js:120` and `:128` both compose ``${styles.logo} ${styles.logoOnDark}``
— but `customer.module.css` defines only `.logoOnDark` and `.logoOnLight`.
Because it is a template literal, `undefined` stringifies, and both logos on the
customer-facing display ship `class="undefined customer_logoOnLight__hash"`.
`kds/page.js:363` names a `.laneLabel` that does not exist.

**Risks.** Deleting the `styles.logo` reference is safe — both `<Image>`
elements already set explicit dimensions, which is why nobody noticed. *Adding*
a `.logo` rule would be a visual change and is not cleanup. **Plan.** Drop the
dead reference from all three; then teach `audit_deadcode.mjs` to run the check
both ways so this class is measured, not spotted.

### 1.5 `.tmp-review/` — 185 lines of scratch SQL sitting in the repo root
Five untracked files from the 3 Sep gross-profit work: `q1.mjs`, `q2.mjs`,
`q2.mjs.bak`, `q2.mjs.bak2`, `q3.mjs`. `.gitignore` covers neither the directory
nor `*.bak`, so `git add -A` on a branch carrying a delta this large will sweep
them in — including `q2.mjs`, which interpolates `${target.id}` straight into a
query string **and writes** (`INSERT … SELECT` into `recipe_lines`).

**Do not just delete them.** `q2.mjs:46` asserts that the gross-profit COGS and
the per-day handover COGS agree to 1e-6 across a synthetic Half-only recipe —
a genuinely good check that was never turned into a test, and the only surviving
record of how the two COGS paths were reconciled. **Plan.** (1) Lift that
assertion into `tests/mysql/`. (2) Add `.tmp-*/` and `*.bak` to `.gitignore`
beside the existing scratch patterns. (3) `rm -rf .tmp-review/`.

### 1.6 Two inventory screens mutate a ref during render
`inventory/docs/page.js:37-39` and `inventory/receiving/page.js:33,40` seed
state with `useState({...})` whose initialiser calls a key-minting function, so
the counter climbs on every render rather than every line created — typing
twenty characters into a receiving line burns forty key values. This is 5 of the
37 lint errors. **Fix:** `useState(() => ({ ... }))` — five characters per site.
**Risk:** `key` drives reconciliation of the line rows; the initialiser's return
is only used on the first render, so lines already on screen keep their keys.
**Re-test:** add three lines, delete the middle one, type into the rest.

### 1.7 The `/inventory/recipes` move left three fossils
The screen is now `/menu/recipes` (984 lines) and gated on the `menu` right, not
`inventory`. Surviving references: `Sidebar.jsx:58`, whose comment explains
prefix-matching with an example page that no longer exists, and
`permissions.test.mjs:137`, which asserts a route that is gone. `next.config.mjs:5-7`
carries the redirect and its comment is accurate — leave it.
**Plan.** Repoint the comment; turn the test line into `'/menu/recipes' → 'menu'`,
which converts a fossil into a live assertion pinning the move. `:138` already
covers the rule the line was demonstrating, so nothing is lost.

### 1.8 Supabase copy still on the till's screen
`pos/page.js:1085` tells a cashier looking at an empty menu to "Check Supabase
row access, policies, or the correct project environment." `:218` comments
"Load menu data from Supabase". Both are user- and reader-facing on the money
screen. **And the branch is more reachable than it looks:** all three getters
in the mount `Promise.all` swallow their own errors and return `[]`
(`dataClient.js:61-64,70-73,79-82`), so a genuine `/api/menu` failure never
reaches the catch — it lands on the empty-menu branch and prints the Supabase
message. **Plan.** Rewrite the copy to name the real causes ("No dishes
published — add them under Menu › Dishes, or the menu failed to load"), fix the
comment, delete the debug log.

### 1.9 The Supplier Ledger is unreachable from its own section
`/inventory/suppliers` — 392 lines carrying payables, per-supplier statements
and `recordPayment`, the only money-out verb in the subsystem — is not in the
inventory hub's `SURFACES` array. `grep -rn 'inventory/suppliers' src scripts tests docs`
returns exactly two hits: the navIndex entry and the search test that exercises
it. The sidebar deliberately does not list inventory sub-pages, which is sound
for Masters or Docs and not sound for this.
**Plan.** Add the sixth tile (`Truck` is already imported); reword the Masters
blurb, which currently claims "suppliers" and would then overlap. No `perm` key
needed — the page is already behind the `inventory` right that gates the hub.

### 1.10 Fourteen `revalidatePath` calls that refresh nothing
`floor` ×6, `users` ×6, `settings`, `settings/tax`. All four pages are
`'use client'` and fetch through server actions from a `useEffect`, then call
`load()` themselves after a write. Their RSC payloads carry no data, so
invalidating them does nothing. **Caveat the skeptic added, and it matters:**
`src/app/layout.js:50-53` *is* an async server component that reads the users
table, so the "confirm nothing above reads these tables" step comes back false —
the calls are still inert for these screens' data, but say so deliberately
rather than as a formality. 18 lines with the four imports.

### 1.11 Smaller safe items
- **`Note` is declared inside `CityLedgerPage`'s render body**
  (`cityledger/page.js:120-131`), used at `:222` and `:369`, so React remounts
  it on every keystroke in the two forms above it. It closes over nothing but
  its prop — a straight hoist.
- **Docs describe a tree that moved on.** `README.md:12,71` still say "PIN
  login"; migration 005 renamed `pin_hash` to `password_hash` and the credential
  has been a password since. `001_baseline.sql:6` points at `src/lib/db/orders.js`
  — the file is and always was `.mjs`. README has no Tests section, so the
  139-test command is undiscoverable from the file people read first.
- **`scripts/check-theme-contrast.mjs` is a 185-line accessibility guard that
  nothing runs.** It works — I ran it: "160 pairs checked, 0 failing", exit 0.
  It is untracked, absent from `package.json`, and mentioned only in STATUS.md.
  Wire it in via `spawnSync` from `theme.test.mjs` (it calls `process.exit()`,
  so it cannot simply be imported) and add a `check:theme` script.
- **The receipt print block's header comment describes an `@page` rule that does
  not exist** (`globals.css:527-542`) and is contradicted by another comment 35
  lines below. `grep -n '@page' globals.css` returns two lines, both inside
  comments. This sits above the CSS that makes a receipt print as an 80mm strip
  instead of a blank page. Rewrite it; move the genuinely useful `size: 80mm auto`
  knowledge into `printReceipt.js`, next to the code that builds the string.
- **The three after-settle side effects swallow their own import failures**
  (`orderActions.js:40,49,52,62,65` — five `.catch(() => {})`). The
  fire-and-forget posture is right and well argued; the problem is that the
  catch also swallows the *dynamic import* failing, which nobody else reports.
  If `consume.mjs` stops resolving, every sale still succeeds and stock silently
  stops being consumed until a stock count finds it. Log, still swallow, never
  await.

---

## 2. Needs test

### 2.1 Chart of Accounts cannot save an account — migration 018 half-landed
`chart/page.js:359` is `pattern="\d{5}"` and `:360` `maxLength={5}`. Migration
018 made every account number four digits; `ACCOUNT_NUMBER_RE` is `/^\d{4}$/`
(`constants.mjs:35`) and the server refuses anything else
(`chart/actions.js:45-47`). `suggestNumber` pre-fills four digits. The field is
`required`, the form has no `noValidate`, so HTML constraint validation runs
first and the browser refuses with "Please match the requested format".
**Add account and Save changes are both dead for every value the server would
accept**; the only way through is to type a fifth digit, which the server then
rejects.

**Why unnecessary.** It is v1 enforcement outliving v1. **Impact.** Restores the
whole screen. **Risks.** Almost none — `maxLength` 5→4 truncates nothing valid,
and the `onChange` already strips non-digits. Confirm no seeded account still
carries five digits before shipping. **Plan.** Change both attributes; rewrite
the prose subtitle at `:182` from `GROUPS` rather than by hand (the group tabs
already render `digitsLabel(g)`); then, as `accounts_admin`, add an account,
edit one, and try a three-digit number to confirm the refusal still fires.
Two more v1 fossils sit on the same screen: `chart/page.js:29`'s comment still
reasons in five digits, and `chart/actions.js:41` with it.

### 2.2 The Tax settings form can fail silently, and can zero the tax rate
Three defects in one small file, all on the numbers every bill is taxed at.

- **No `WHERE`, no `affectedRows` check.** `settings/tax/actions.js:28-33` is
  `UPDATE store_settings SET tax_rate_cash = ?, tax_rate_card = ?, tax_label = ?, updated_at = …`
  with no `WHERE` and no INSERT branch, and `:40` returns
  `{ success: 'Tax settings updated' }` unconditionally. Its sibling
  `settings/actions.js:75-98` does it correctly: read, `UPDATE … WHERE id = ?`,
  INSERT when absent. On a fresh install with no settings row, the tax form
  reports success and writes nothing.
- **An empty box means 0%.** `tax/actions.js:20-25` clamps
  `Number(formData.get(key))` and falls back only when the value is not finite —
  but an empty input yields `""`, and `Number("")` is `0`, which is finite. The
  fallback is unreachable dead code and the store's tax rate becomes 0%.
- **Three disagreeing defaults for `tax_rate_card`:** 16% in the schema
  (`001_baseline.sql:127`), 5% in the server fallback (`tax/actions.js:25`),
  `5` on the screen (`tax/page.js:23`).

**Risks.** This reprices every future bill — the highest-consequence change in
this report. Do not touch the rates themselves. When adding the INSERT branch,
copy the defaults for the columns this form does not own (merchant name,
`raast_id`, `kot_mode`) from `EMPTY` in `settings/page.js:14-24` rather than
inventing them. **Plan.** Mirror `updateSettings` exactly; treat empty as
missing, not as zero; settle one default for the card rate and make all three
agree; consider a `UNIQUE` singleton guard in a new additive migration so the
table can never hold two rows. **Re-test:** save on a fresh install, save with an
empty GST box, save a real change, then ring a cash bill and a card bill and
check both rates on paper. Both Settings actions also answer `{success}` rather
than the house `{data}|{error}` envelope — fix while there.

### 2.3 The till
- **The Pay Now and Settle buttons print the pre-discount total.**
  `pos/page.js:1538` and `:1548` render `roundTotals`/`tabTotals`, computed with
  `priceOpts`, which carries no discount; only `billTotals` (`:478-481`) passes
  it. The button therefore shows a larger figure one row under the discounted
  Total. Cosmetic in the sense that the stored total is right, and not cosmetic
  at all in the sense that it is the number a cashier reads aloud.
- **Opening a tab throws away the discount reason.** `handlePayNow` sends
  `discount_reason` (`:718`); `handleOpenTab`'s payload (`:758-767`) does not.
  It is the only path in the till by which money comes off a bill with nothing
  recorded about why, and `attachTab`'s restore at `:655-658` has nothing to
  restore. One line, copied verbatim from `:718`. Do **not** fold it into
  `billColumns` — that helper is about totals columns.
- **`addToCart` mutates state in place.** `:400-401` is `const newCart = [...prev]`
  followed by `newCart[existingIndex].qty += 1` — a shallow copy, so the element
  is the same object React still holds. `updateQty` twelve lines down does it
  correctly (`:419`). Strict mode double-invokes the updater in `next dev`, so
  the symptom is reproducible. One line; do not touch the `uniqueId` comparison.
- **`printKotSlips` prints from a stale snapshot on the round path.**
  `handleSendRound` passes `tab` (`:798`), derived from `openTabs` before the
  append; `loadTabs` runs after. The slip can miss the round it was printed for.
- **The whole `menu_items` row rides into the cart, `localStorage` and the order
  payload** (`:388`, `ModifierModal.jsx:89-96`, `:715`) — `reads.mjs:17-21` is
  `SELECT *`. `billColumns` (`:488-493`) then sends `subtotal`, `tax` and
  `status` on every order and the server reads none of them.

### 2.4 The money kernel
- **`getOrdersVersion` runs an unfiltered `COUNT(*)` over `orders` on every
  4-second poll, per open terminal** (`reads.mjs:73-79`). This is the one query
  whose cost grows with lifetime sales: at 100k orders and four terminals that
  is ~60 full index scans a minute, ~86k a day, to produce a string that changes
  a few dozen times an hour. **Window it** on `updated_at >= UTC_TIMESTAMP(3) - INTERVAL 2 DAY`
  — the index already exists and `001_baseline.sql:190` says so in a comment.
  Do **not** window on `created_at`: a KDS bump moves `updated_at` only. A
  windowed count can decrease as rows age out, which triggers one harmless
  refetch. `EXPLAIN` both forms before and after.
- **Every poll costs two queries, not one.** `requireUser()` re-reads the users
  row on every call (`auth.mjs:33`), and this is cross-cutting — every server
  action pays it, so a page firing N actions pays N users lookups.
- **Pay-now recomputes the order twice inside one transaction**
  (`orders.mjs:379,427,428-432,441-446`): `resolveBusinessDate`, then
  `getTaxRates`, then `recomputeOrder`, then `settleOrderTx` re-reads all of it.
  Seven redundant statements on the commonest transaction the till runs. Let
  `settleOrderTx` accept pre-resolved `{rates, businessDate}`. **No error string
  moves, `calcTotals` is untouched, the expected-total check stays where it is,
  and the six race tests must stay green.**
- **`dataClient` caches a *failed* tax-rate read for the life of the page**
  (`:172-187`): the assignment at `:182-186` sits outside the `try`, so a null
  read is cached forever. And it is more reachable than it looks — `getSettings`
  catches everything including auth failures and returns `null` rather than
  throwing, so the catch never fires and the fallback is stored as if it were
  real. One blip at load prices every later card bill at 16% instead of 5%, and
  the cashier meets `Total mismatch: till shows … — reload before settling`.
  Only assign the cache when `row` is non-null.
- **FBR can file one sale twice.** `afterSettle.mjs:46-53` and
  `fbr-worker.mjs:80-92` both `SELECT status` then POST, with nothing claiming
  the row between; `attempts` is incremented only afterwards. If a settle-time
  post and the worker overlap, two invoice numbers are minted and the second
  overwrites `orders.fbr_invoice_number`, so the duplicate is invisible locally.
  Latent — FBR is gated on `FBR_ENABLED === 'true'` — but this is a filing the
  restaurant cannot unsend. **Fix before cutover:** an atomic
  `UPDATE … WHERE status='pending' AND (claimed_at IS NULL OR claimed_at < now - 1 min)`,
  POST only when `affectedRows === 1`, with the claim window longer than the 5s
  client timeout.
- **`serialize.mjs` `BOOL_COLUMNS` covers 4 of the 18 tables it is called with**
  (`:11-16`), so `dining_tables.is_active` reaches the client as `1`, not `true`.
- **Two unreachable fallbacks on the money path:** `orders.mjs:261`
  (`discount ?? Number(order.discount) ?? 0` parses as `(a ?? b) ?? 0`, and
  `Number()` never returns null) and `pos/page.js:446`.
- **A forked `DEFAULT_TAX_RATE` inside the kernel** — `orders.mjs:52-53`
  hardcodes `?? 0.16` twice, in a module that already imports from
  `orderTotals.mjs` at `:23`.
- **Order-history search strips PostgREST metacharacters instead of escaping
  LIKE wildcards** (`reads.mjs:102-109`), against its own comment — and a search
  term made only of stripped characters becomes empty and returns every order.

### 2.5 The half-built day worker — the largest finding in this run
`src/lib/day/rollover.mjs` (188 lines) is imported by **nothing except
`tests/mysql/dayrollover.test.mjs:18`**. Its own header says why it exists: the
day-close logic used to live inside `dayclose/actions.js`, which is fine while a
human presses Close but unreachable from a scheduled worker with no session
cookie, so it was extracted into plain Node "so the server action and
`scripts/day-worker.mjs` share one definition of what closing a day means."

**`scripts/day-worker.mjs` does not exist.** `dayclose/actions.js` still carries
its own copies, and those are the ones production runs. So:

- **11 tests exercise code the application never executes** — and they pass,
  which is what makes this expensive rather than merely untidy.
- **The live copy has the bug the extracted copy fixed.** `fetchPendingBills`
  (`actions.js:27-33`) is `WHERE payment_status = 'unpaid' AND status <> 'cancelled'`
  — no branch, no business date. `pendingBillsTx` (`rollover.mjs:106-116`) adds
  both, and its comment at `:100-104` states the failure verbatim. **Today one
  forgotten unpaid tab blocks every future close, permanently**: the only escape
  is to tick `force` on every close from now until someone voids it, and each of
  those closes then writes a false `carried_orders` audit list.
- **Migration 014's `day_start_time` / `day_end_time` are read by nothing** in
  the running app. `dueToClose` (`rollover.mjs:71-84`) is the consumer, and it
  has no caller either.
- **`docs/cash-handling.md:88` describes the scheduled close as shipped.**

**Risks.** Adopting `rollover.mjs` *loosens* the pending-bill gate: bills unpaid
on an earlier day stop blocking tonight's close. That is the intended behaviour
and it is argued explicitly in the module, but it is a real change — an operator
relying on the close to nag about an old tab loses the nag. **Plan.** This is
one decision, not a cleanup: either **(a)** finish it — write
`scripts/day-worker.mjs`, point `dayclose/actions.js` at `openDayTx` /
`pendingBillsTx` / `closeDayTx`, and the tests start guarding production; or
**(b)** abandon it — delete `rollover.mjs`'s database half and its tests, fix
the pending-bill predicate in place, and correct `docs/cash-handling.md`.
**Do not leave it as it is** — the current state is the worst of the three,
because the test suite reports green on logic nothing runs. **Owner's call:**
does the day close on a schedule, or only when someone presses the button?
(§4.1.)

Three more day-close defects, independent of that decision:

- **`startBusinessDay` reads its return state on a different pool connection
  from inside its own open transaction** (`actions.js:192,203,239,260` calling
  `loadState`, whose six reads all go through `pool.query`). The screen shows
  the day it just started as not started, and on a 5-connection pool this is a
  deadlock path. `closeBusinessDay` is already written correctly at `:391-392` —
  copy its shape.
- **The open-drawer gate is branch-wide but the screen's is day-scoped**
  (`actions.js:294-298` vs `:46-53`), so a drawer left open on an earlier day
  refuses every close and the documented `force` override is unreachable —
  `page.js:464` disables the button before the tick can be read. Make the screen
  see what the server sees rather than narrowing the server.
- **Two drawers open at once both count the same cash sales.** `sessionFlows`
  (`drawer/actions.js:109-114`) sums by branch and method between the session's
  `opened_at` and now; `payments` has no session or cashier column. The expected
  balance is the whole branch's takings, not this till's — and `closeDrawer`
  then overwrites `business_days.closing_cash` with only the closing session's
  carry.

### 2.6 Printing — three renderers, one of them a fork
- **KOT slips hardcode 80mm.** `kotPrint.js:237` is `const SLIP_WIDTH_MM = 80`
  and `:260` writes it into `@page`. `printReceipt.js:69-71` measures
  `offsetWidth` off its print root with 80 as the fallback, which is what the
  58mm setting from migration 012 is for. The slip root is already laid out at
  the right width, parked off-screen at `left:-9999px`, so the measurement is
  available. Two lines. **Hardware-facing:** an 80mm store must come out
  byte-identical — verify that first, then print a round at 58mm and check
  nothing is clipped. `reports/item-wise/page.js:107` has the same hardcoded 80
  and a worse failure mode, since its strip mounts under `id='receipt-print-root'`.
- **`scripts/print-thermal.mjs` is a superseded second ESC/POS renderer.**
  149 lines re-implementing `src/lib/print/escpos.mjs`, written 6 minutes before
  it (21:16 vs 21:22) and superseded by `print-agent.mjs` at 21:30. **Its copy
  has diverged and prints a bill whose lines do not add up to its total** — it
  omits service charges. Its `row()` also has no minimum-space floor, so a wide
  figure jams against its label; `escpos.mjs:59` guards that. And it writes with
  `writeFileSync(DEVICE, …)` — a synchronous write to a serial port, exactly the
  wedge `docs/kiosk-printing.md:319-327` warns about. **Delete it**, after
  confirming the owner is not using it as the manual fallback.
- **`renderKotSlip` is written, exported and wired to nothing.** The agent
  serves only `/health` and `/receipt`; kitchen slips still go through the
  browser. Half a feature. **Owner's question:** will any kitchen station get a
  thermal printer? If no, delete 19 lines and note it in STATUS.md; if yes,
  finish it — a `/kot` route, a `printKotViaAgent`, and a browser fallback.
- **`thermalAgent` caches a negative probe for the life of the page**
  (`:20,33-46`), so an agent started mid-service is never used until reload.
- **The two receipts disagree on more than the prior report knew.** The thermal
  bill drops both QR codes, the NTN/STRN line and the FBR block that the browser
  bill prints, and the two use different date formats and different private
  rupee formatters (`escpos.mjs:48`, `print-thermal.mjs:63`) — neither of them
  `src/lib/money.js`. **No test covers either renderer.**
- **The measured `@page` routine is still written three times**, constants and
  all: `PX_PER_MM` at `printReceipt.js:40`, `kotPrint.js:235`,
  `item-wise/page.js:88`; `TAIL_MM` at `:47`, `:241`, `:89`. The prior report's
  claim, unchanged, and one of the three now admits it in a comment.
- **`docs/kiosk-printing.md:384-393` still says "This is browser printing, not
  ESC/POS … Direct ESC/POS would be a separate piece of work."** It shipped.
  Hold the rewrite until the KOT decision above lands, or it gets written twice.

### 2.7 Reports
- **The hub's Gross Profit card costs recipes variant-blind.**
  `reports/actions.js:408-413` groups `recipe_lines` by `menu_item_id` alone and
  joins on it, while migration 010 gave recipes a `variant_name` and
  `gross-profit/actions.js:58-60` uses the shared `RECIPE_COST_TABLE` /
  `RECIPE_VARIANT_FOR_LINE` fragments correctly. Wherever a size has its own
  recipe the hub's COGS is overstated and its margin understated — against the
  very report the card links to, and against a header comment at `:298-301`
  promising exactly the opposite. **Import the fragments; do not edit them** —
  `consume.mjs:77` and `menu.test.mjs:178,187` depend on their current form.
- **`getDashboardStats` runs `SELECT *` over `orders` twice** (current and
  previous window, 36 columns including the `items` JSON) and rebuilds five
  aggregates in JavaScript. Five aggregate queries return under 60 rows.
- **Top Selling and Trending are the last readers of the `orders.items` JSON
  snapshot** — the column the schema itself labels "display snapshot;
  `order_items` is canonical" (`001_baseline.sql:152`). Two `GROUP BY order_items`
  queries replace ~35 lines. `previous.itemCounts` is consumed by Trending, so
  that one goes when this does.
- **Handover fires ten serial queries**, one of which (`expenseTotal`, `:116`)
  is the SUM of the next; it is also the only report action that hands raw MySQL
  error text to the client and the only one that swallows a failure without
  logging it.
- **Three disagreeing hour-of-day bucketings**, two of them rendered on the same
  screen (`actions.js:40-42`, `:116-124`, `:342-352`, `hourly/actions.js:13-17`)
  — and the hub's two hourly charts trim empty hours by two different rules, one
  of which keeps a negative hour and drops a zero one.
- **Six report cards state a range figure and link to reports that cannot show
  that range** — no report screen reads search params.
- **The date picker caps at the UTC day** (`page.js:424,433`), so between
  midnight and 05:00 PKT the native picker greys out today. Two lines.
- **The gross-profit table keys rows on `item.name`**, which the query does not
  guarantee is unique — while the chart twelve lines above keys on
  `${name}-${idx}` with a comment explaining why. The map has no index
  parameter, so this is a two-token fix, not one.
- **The hub prints two date orders on one screen** — "Aug 27" on the hero chart
  (`actions.js:45-46`, pinned `en-US`), "27 Aug" on the card previews.

### 2.8 Accounts
- **The four statement pages print with the sidebar on the paper.** Trial
  balance, income statement, balance sheet and cash register — the four
  documents an accountant actually prints and sends — come off the printer with
  the nav sidebar down the left, the Accounts tab strip across the top, no A4
  page box, and the content shifted right and clipped. The print CSS exists as
  six byte-identical `<style jsx global>` blocks pasted into the *other* six
  pages, differing only in a root id. One shared rule in `globals.css` fixes four
  broken documents and deletes six blocks — kept outside the receipt block's
  `body:has(#receipt-print-root)` guard, which must stay scoped.
- **The journal-header writer exists five times** (`post.mjs:113-172`,
  `otherPost.mjs:167-224`, `expensePost.mjs:96-140`, `manualJournal.mjs:63-108`,
  `gl.mjs:349-375`), each restating the SAVEPOINT → `nextVoucherNo` →
  `INSERT … ON DUPLICATE KEY UPDATE` → `if (!result.insertId)` contract and the
  `CLIENT_FOUND_ROWS` subtlety. ~200 lines. **The balance assertion — the one
  check between a bug and an unbalanced ledger — has five implementations, and
  two have already drifted.** This is the money path; all five have tests, which
  is what makes the consolidation checkable, but the refusal strings differ
  between copies and some are asserted, so take the message prefix as a `label`
  parameter and keep every caller's wording exactly.
- **Expense Report and Payables are built twice from different tables** — the
  screen reads `expenses` (which also holds legacy chits), the workbook reads
  `expense_vouchers`. Same date range, two totals, and the Excel button silently
  ignores the Summarize toggle. A manager who prints the screen and emails the
  `.xlsx` sends two different numbers. **`expenses` is the right source** — but
  switching the workbook to it changes the workbook's totals for any range
  containing a chit, so that is a decision, not a refactor.
- **Three catalog screens are one screen pasted three times** (chart,
  expense-categories, expense-codes — 1,334 lines, `wc -l` exactly). The `?new=1`
  focus effect is character-identical in two of them. They give three different
  answers to "what does the user see when one of several saves fails".
- **Three catalog action files restate the same save/toggle transaction** and
  the same "account must carry link X and be active" check; two of the three
  have no test at all.
- **Each voucher verb re-SELECTs the header it just wrote** and the action
  discards it (`expensePost.mjs:607,738,800`); the open business day is read
  three times in one Save & Post. The tests read the returned `.voucher`, so
  keep the shape and skip the reload.
- **`statements.mjs` and `statementRows.mjs` have no test** — the four statutory
  statements, and every other library in the module is covered.
- **Thirteen module-level rupee formatters** under three fraction policies, none
  of them `src/lib/money.js`; **`ledger/page.js:30-42` drops the UTF-8 BOM** that
  `ReportTools.jsx:59` writes, so every exported description with a `·` or a `—`
  mojibakes in Excel.
- `STATUS_CLASS` ×4, `TYPE_TABS` ×2, a hand-typed `GROUP_LABEL` beside the
  derived one, two correction-hint tables. Note that `statusDraft`/`statusPosted`/
  `statusVoid` are reached through `styles[…]` and must not be pruned by a class
  sweep.

### 2.9 Orders, KDS and the order APIs
- **A voided order's badge renders `class="statusBadge undefined"`** —
  `orders.module.css` has `.status_new/_preparing/_ready/_completed` and no
  `.status_cancelled`, while `cancelled` is a legal status
  (`001_baseline.sql:194`). `orderDetail.module.css:224-227` has already picked
  the tokens; copy them and add the `|| ''` guard at both composition sites.
- **Five components are still declared inside `OrdersPage`'s render body**
  (`:325-447`), remounting every card's subtree — thumbnails included — on every
  poll that finds a change.
- **The detail panel re-runs its five queries on every list load**, because
  `load()` bumps `dataVersion` unconditionally (`page.js:182`).
- **The unpaid-tab count is refetched on every filter, sort, page and search
  change**, though `getUnpaidOrdersCount` takes no arguments and counts the whole
  table.
- **Neither orders screen guards against a stale response**, though twelve
  others in the tree do — and the guard to copy is at
  `trial-balance/page.js:29-37` (§1.2).
- **A failed order-history read paints "No orders yet."** `dataClient` catches
  and returns `{rows: [], total: 0}`; the screen cannot tell a database failure
  from an empty day.
- **`/api/orders/kitchen` and `/api/orders/unpaid-count` gate on `requireUser()`**
  while the screens they serve require a right — the same class the 2 Sep
  security pass fixed on two other routes.
- **Three order GET routes are the same 22-line file three times**, and
  `NO_STORE` is declared in seven. One `readRoute({gate, read, label})` removes
  ~45 lines — but the status-code split is load-bearing: the gate's catch must
  return `e.status ?? 401` and the reader's 500, because `useRealtimeTable`
  treats any non-ok as an unhealthy channel.
- **The KDS and the customer display each fetch the modifiers table and never
  read it.** The customer page's `modifiers: {}` state is a lie about what the
  page holds, on a route anyone can hit.
- **`@keyframes spin` is declared twice in `orders.module.css`** (`:362` and
  `:609`), and five rules are copy-pasted between the two order stylesheets with
  drift — `.metaChip` padding differs by 1px, `.alignRight` is `tabular-nums` in
  one and not the other.

### 2.10 Inventory
- **`stock_ledger` has no index on `(source_type, source_id)`**
  (`002_features.sql:266-267` declares only item and date indexes), so **every
  settled order full-scans the whole ledger** — twice, if the order is later
  voided. The table grows by one row per ingredient per sold dish and never
  shrinks: ~1,000 rows a night, ~365k a year. One additive migration, zero
  application lines. Confirm with `SHOW INDEX FROM stock_ledger` first.
- **Only two of the five stock verbs lock their items.** `transferStock`,
  `adjustStock` and `miscConsumption` call `fetchItems` with no options, so no
  `FOR UPDATE` — and `receiveStock`/`postCount` read on-hand from a snapshot
  taken *before* their lock.
- **Four of the six stock verbs and both consumption verbs have no test**, on
  the subsystem whose kernel writes the stock ledger.
- **The 14-day consumption average counts a voided sale's ingredients as demand
  forever** — the window sums `source_type IN ('sale','misc')` and
  `reverseForOrder` posts the put-back as `'void'`.
- **The inventory screens' permission gates disagree with the model in both
  directions**: three screens gate the UI on `role === 'admin'` while their
  actions accept a right a manager and an accountant also hold, and
  `listIngredients` is a fifth loose read gated on `requireUser()` alone.
- **`FormActions` and `EditBtn` are declared inside `MastersPage`'s render
  body**, remounting four form footers on every keystroke (2 of the 37 lint
  errors), and `masters/page.js:20-23` restates the rupee formatter.
- **On-hand is derived by `SUM(delta)` over the whole ledger in nine places**,
  seven of them unbounded; the inventory hub scans it twice per load, and the
  reports consumption query scans it twice inside one statement. A
  `v_stock_on_hand` view (additive) gives one definition and one scan.
- **The Karachi-day and open-business-day resolvers are restated five times
  inside inventory alone.**
- **Two state machines have states nothing can write**: `stock_docs.posted` is
  never set to 0, so `WHERE d.posted = 1` in the Variance report can never
  exclude a row; `demand_drafts.cancelled` is allowed by the CHECK and written
  by nothing, so an abandoned kitchen draft stays `open` forever and crowds the
  `LIMIT 20` picker. **Do not drop either column.** The better fix for the second
  is to build the missing `cancelDraft` verb.

### 2.11 Back office and auth
- **`/expenses` hides its whole UI behind `role === 'admin'`** while its actions
  gate on a right a manager and an accountant both hold — and its own comment at
  `:214-215` admits it. Seven role-string checks across `expenses`, `drawer` and
  four inventory pages. `useRole()` still drives UI in seven screens (down from
  eight). **Owner's question:** should a manager post receivings and counts?
- **`/floor` writes are non-transactional**, stamp the audit at UTC
  `CURRENT_DATE` (so between 00:00 and 05:00 Karachi the row lands on
  yesterday), and write the audit row *before* the DELETE — a failed delete
  leaves a trail for something that did not happen.
- **The login throttle Map grows without bound** and is defeated by rotating an
  `X-Forwarded-For` header (`:41` keys on `identifier|ip`, while `:18` claims
  per-identifier). Store `{n, at}`, sweep hourly, cap it.
- **`src/lib/auth/session.mjs` has no test** — the cookie contract that gates
  every screen. It is the only untested module in the auth path.
- **The Charges worked example is priced at a hard-coded 16% and labelled
  "GST"** (`charges/page.js:91,416`) regardless of `/settings/tax`.
- **`getSettings` breaks the `{data}|{error}` envelope** and turns an expired
  session into silently wrong tax rates on screen.
- **730-line users screen**: `UserRow` takes 22 props and six sub-components live
  in the page file. `wouldStrandUserAdmin` can never return true at two of its
  three call sites.
- **City Ledger loads all four datasets for whichever single tab is showing**,
  and a company's balance is defined three ways with the aging buckets as a
  disagreeing fourth.
- **`users/page.js:34-39` renders "last login" in the viewer's timezone** — no
  `timeZone` on the `toLocaleString`.

### 2.12 The duplication families, measured today
`src/lib/money.js` landed since the last audit and 16 files import it — the
formatter family is the one that moved. The rest have grown, because three new
subsystems arrived and none of them imported what existed.

| Family | Copies today | Canonical home | The divergence that makes it a bug |
|---|---:|---|---|
| Rupee formatter | **24 outside money.js**, six fraction policies | `src/lib/money.js` (exists, 16 importers) | Accounts prints 2 dp, reports 0, three report screens print rupees to **three decimal places** |
| Karachi "today" | 26 under six names | new `src/lib/karachi.mjs`, re-exported by `kit.mjs` | Three resolve to a different day than the others between 00:00 and 05:00 PKT |
| Open-business-day resolver | 24 in four shapes | `kit.currentBusinessDate(conn)` | Reports disagree on the fallback (MAX vs today); handover omits `branch_id` |
| `audit_log` writer | 21 INSERT sites, 7 local helpers | `kit.audit(conn, {…})` | **Three still stamp `CURRENT_DATE`** — UTC on this pool. Six re-run the business-day SELECT per row |
| DATE → `'YYYY-MM-DD'` | 10 under four names | `karachi.mjs` | **Eight of ten drop the string truncation**, so a string input survives unnormalised |
| Paise rounding (`round2`) | 9, four NaN policies | `kit.mjs` | Four different answers for `NaN` |
| CSV escaper + download tail | 7 escapers / 8 tails | `ReportTools.downloadCsv` → `src/lib/csv.js` | **Only one writes the UTF-8 BOM.** `/expenses` also quotes numbers, so Excel reads amounts as text |
| Measured `@page` print | 3, constants included | new `src/lib/printPage.js` | The next auto-cutter fix must be made three times |
| Label maps | 20 (8 order-type, 4 method, 4 status-class, 2 tab, 2 group) | `orderDisplay.js` / `accounts/constants.mjs` | `OrderDetail.jsx:48` says `'City ledger'`, `handover/page.js:15` says `'City Ledger'` — two screens a manager compares nightly |
| Compact axis money | 5, three unit rules | `money.compactRupees` | Rs 1,250,000 prints as **"Rs 1.25M"** on two screens and **"Rs 1.3m"** on three |
| `hourLabel` / `karachiHour` | 5 | `timeFormat.js` | Cash Register says `18:00`, everything else `6 PM`, the Hourly axis `6 pm` |
| Validator twins (`DATE_RE` ×7, `UUID_RE` ×4, `requireId` ×3) | 14 | `kit.mjs` / `menu/rules.mjs` | Two UUID case policies; `requireDate` still accepts `2026-02-31` |
| Modifier flattening | 4 | `orderDisplay.formatModifiers` | The canonical one is the only copy that can print `"undefined"` |
| Script boot preamble | `.env` loader ×8, DB connect ×7, readline ×2 | `scripts/db/_env.mjs` | `import-blink-recipes.mjs` drops `decimalNumbers`, which `pool.mjs:8-11` calls load-bearing, not a preference |
| React page idioms | 25 flash-clear effects (three durations), 42 pages in two load idioms | a shared `useFlash` / `useServerAction` | `menu/ingredients/page.js:50-59` is the only load-on-mount in the tree with **no cancellation guard** |
| `@keyframes spin` | **33 blocks in 32 stylesheets, 121 lines** | `globals.css:513-526` already owns it | — |
| Stylesheet shell | `menu.module.css` is **84% verbatim `accounts.module.css`** (606 of 720 lines) | — | A `.note` contrast fix has to be made 29 times |

**Plan for the whole table.** Build the two dependency-free modules first
(`karachi.mjs`, and extend `money.js`), point `kit.mjs` and `timeFormat.js` at
them, then replace family by family, running the suite after each of
`orders.mjs`, `consume.mjs` and `expensePost.mjs`. Adopt `ReportTools`'s existing
CSV exporter rather than writing a new one (§1.2). **Do not sweep the React
idioms across 42 screens in one commit** — adopt on the next page each is opened
for another reason. Finish with one Playwright-or-manual pass over pay-now,
open-tab-and-round and settle, and one real receipt print.

### 2.13 Theming — what a tree-wide sweep left behind
- **49 `outline: none` declarations in 33 stylesheets cancel the app-wide
  `:focus-visible` ring**, and two search inputs (`accounts.module.css:280-281`,
  `menu.module.css:220-221`) have no focus indicator at all in either theme.
  The three focus-ring tokens have no consumer outside the one global rule.
- **The light brand orange was re-tuned to `#a83f08` and three copies of the old
  `#b34309` were left** — including the light focus ring (`globals.css:287`),
  `public/offline.html:49-50`, and the file header at `:26-27` that still states
  the *old* colour's contrast ratios. That header is the document a future
  re-tune will be reasoned from.
- **67 raw hex/rgb literals remain in 13 stylesheets** after the sweep; two are
  genuine theme misses, the rest are deliberate print/overlay colours.
- **`public/manifest.webmanifest` hard-codes a black splash and title bar** — a
  third un-importable copy of the theme, alongside the boot script and
  `offline.html`, and no test guards it.
- **Six byte-identical `<style jsx global>` print blocks across Accounts** —
  folds into §2.8.
- `--info-border` and `--surface-sunken-strong` have no consumers. Delete from
  **both** `:root` blocks or `theme.test.mjs:92-124` goes red — that is the
  guard working.

### 2.14 Menu management — new, and never swept
- **Uploaded dish photos are written and never deleted.** `api/menu/images/route.js:48-52`
  mints a UUID filename and writes; nothing in the tree removes one. Every
  replace, every remove and every abandoned edit leaks a file into `/uploads/`,
  which `.gitignore` correctly keeps out of the repo and which therefore nobody
  is watching.
- **Menu photos uploaded through the new screen are excluded from the offline
  cache** — `sw.js:73` returns early on `/api/`, and `/api/uploads/...` is where
  they now live.
- **The dish list's reorder arrows renumber the whole category** while the person
  is looking at a filtered subset, and `moveDish` treats any direction that is
  not `'up'` as `'down'` — a server action reachable with any value —  while
  `moveCategory` validates and refuses.
- **The "prices must not fall as sizes grow" rule is implemented twice**, on the
  client and in the action, and `cleanSetOptions` re-implements `cleanVariants`'s
  name rules with two duplicated error strings — in a module whose whole point
  (`rules.mjs`) is that these rules live in one place.
- **`recipes/page.js` is one 744-line component doing five jobs**; every write on
  the Variations screen rebuilds the entire board in four serial queries.
- **Two menu screens fall back to `window.confirm`**, one of them guarding a real
  DELETE, while the other four use the app's own dialog.
- **The public customer menu is the only surface that quotes a sized dish at its
  largest price** rather than as a range — `menu_items.price` is documented in
  the schema as the largest size.

### 2.15 Infrastructure
- **`gl_settings.default_expense_account_id` and `suspense_account_id` are
  `NOT NULL`, FK-constrained, seeded, documented as fallbacks — and read by no
  code.** Six references in the tree, all inside `mysql/migrations/`.
- **`date-fns` is a runtime dependency for ten helpers used in one 35-line
  function of one file** (`orders/page.js:87-117`). Weigh against
  `src/lib/timeFormat.js`, which already exists.
- **`public/` carries three ~14.6KB logo SVGs.** Two of the three are the same
  drawing differing only in fill; the third is genuinely a different asset.
- **The service worker caches every navigation response regardless of status**,
  into an unbounded cache — the asset branch guards with `if (response.ok)`
  twelve lines above and the navigation branch does not.
- **`print-agent.mjs`'s pool never pins the session timezone**, unlike
  `src/lib/db/pool.mjs`.
- **Both credential scripts stamp their audit row at `CURRENT_DATE`** on a
  UTC-pinned connection — the same wrong-day bug as `/floor` and `/users`.
- **The test harness reseeds only 17 tables**, so the newest subsystems have no
  database coverage to reset — which is how `dayrollover.test.mjs` came to pass
  against code nothing runs.
- **`loading.js` covers 7 of 57 route segments** and none of the subsystems added
  this cycle. Decide the rule and write it down; either is defensible.

---

## 3. Scheduled — deliberate, with a trigger

- **`scripts/migrate-to-mysql/`, `src/lib/sanityMenu.js`, `@supabase/supabase-js`**
  — unreferenced by the app, load-bearing for the one-time production menu
  import. **Trigger: cutover.** Nothing new found this run.
- **`scripts/menu/blink-recipes.json` (142KB) and `import-blink-recipes.mjs`** —
  new since the last audit and the same shape: 167 ingredients, 124 recipes,
  1,359 recipe lines, run once on the server. The script states its own cutover
  trigger at `:11-14`. **Add it to the post-cutover sweep in STATUS.md**, which
  currently names only the three above.
- **The legacy `/expenses` screen** — now 1,815 lines (grown, not shrunk).
  **Trigger unchanged:** Posting Health's legacy-chit count is 0 in production.
  Correction to the prior report: it is no longer the *only* non-journal cash-out
  path, so the trigger is about the chits themselves, not about exclusivity.
- **The Reports hub is an 801-line Tailwind + styled-jsx page** in a CSS-modules
  tree, carrying a second dashboard under the card grid. Split after §2.7's data
  work lands; its print view is what the owner prints, so re-verify it.
- **Tailwind itself** now serves three files. Removing it is a real change, not
  cleanup — record the trigger (those three pages converted) rather than doing it
  now.
- **`applicablePlans` accepts `orderType` and ignores it**, and the till refetches
  it on every order-type tap. Either implement per-mode scoping (migration + UI)
  or drop the parameter. Owner's call.
- **Two competing page-load idioms across 42 pages.** Still: adopt on the next
  page touched, never as one sweep.

---

## 4. Do not touch — owner's decisions

### 4.1 Does the trading day close on a schedule?
§2.5 cannot be resolved by an engineer. Finish the worker, or abandon it. The
current half-state is the only wrong answer.

### 4.2 The Raast payment QR is not parked
The memory says the QR work is on hold pending merchant onboarding. The code
does not agree: `emvco.js` is live and correct, and `ReceiptPreview.jsx:82`
gates the printed "Scan to Pay" QR on `settings?.raast_id` alone. **The moment a
Raast ID is entered in Settings, the till starts printing a QR that no bank app
can act on**, because the acquirer scheme GUID and the ISO 18245 category code
are placeholders. **Do not guess them** — not the GUID, and not `5812` for
restaurants just because it is the right trade code. **The safe half is an
engineering change:** make the gate also require a configured scheme identifier,
so a half-configured merchant prints *no* QR rather than an unpayable one.
Adnan supplies the real values at onboarding.

### 4.3 The receipt prints placeholder fiscal numbers
`ReceiptPreview.jsx:134` is still the literal
`NTN: 1234567-8 | STRN: 1234567890123`, one line below a row that correctly reads
the merchant name from settings. On a document FBR may inspect. **Needs Adnan's
numbers**; add `ntn`/`strn` to Tax & FBR settings and omit the line until set.

### 4.4 Migration 006 seeds a chart that 018 rewrites in full
Every one of the 68 accounts seeded by `006_accounts.sql:212-288` is renumbered
by `018_chart_of_accounts_v2.sql`. A fresh install runs both. That is correct
and additive — migrations here are never edited — but it means the v1 chart
exists for the length of one migration run, and anyone reading 006 to learn the
chart learns the wrong one. **Record the decision** rather than changing
anything: a comment at the head of 006 pointing at 018.

### 4.5 `branch_id` is hard-coded
Pinned in 13 places in the report queries alone, absent in four, and the two
disagree inside one file. `kit.mjs` exports `BRANCH_ID`; import it rather than
writing `1`. **Do not change behaviour** — record in STATUS.md whether this is
single-branch by design.

### 4.6 Two live editors write `inventory_items`
`/menu/ingredients` (right: `menu`) and `/inventory/masters` (right:
`inventory`) both edit the ingredient master, with different fields and
different rights. Neither is wrong; having both is a decision nobody has made.

---

## 5. Checked and found clean

So the next run knows what was considered, not just what was found.

- **The 2 Sep report's two headline defects are fixed.** The receipt's tax label
  now takes a `taxRate` prop (POS passes the mode's rate, the reprint passes
  `order.tax_rate`), and **bare `toLocaleString()` on money is gone from the
  tree** — `src/lib/money.js` owns it, 16 files import it, and the only
  remaining occurrence of the bare form is the sentence in money.js's own
  comment explaining why not to use it. Also fixed: `ModifierModal`'s dead
  `basePrice`, and `ReceiptPreview`'s FBR block now renders because
  `orders/page.js:829` passes the order.
- **No Supabase/Sanity/Vercel code remains in `src/`** beyond the comments in
  §1.8 and the scheduled import tooling.
- **Every runtime dependency is imported by `src/`** except the scheduled
  `@supabase/supabase-js`; every devDependency is used. `crc`, `qrcode.react`,
  `lucide-react`, `recharts`, `mysql2`, `bcryptjs` all live.
- **CSS is in good shape.** 1,832 class names across 55 modules; 3 dead, 3
  referenced-but-undefined. The apparent orphans are dynamic composition.
- **The money verbs.** Error strings and `calcTotals` untouched by every area;
  `orders.mjs` is still the only writer of `orders.items`; `postLedger` the only
  stock-ledger writer; the till's expected total and the server's recomputation
  agree on charge scoping and rate selection, and the percent-discount base
  matches `calcTotals`'s subtotal definition exactly.
- **Idempotency on the till** is intact: `requestIdRef`, `roundRequestIdRef` and
  `settleRequestIdRef` minted per basket, reused on failure, cleared on success
  — with the one ordering nit at `pos/page.js:795`.
- **Polling**: one `useRealtimeTable`, three call sites, in-flight guard,
  hidden-tab pause, jittered timer. No second poller.
- **No component is declared inside a render body on any of the 16 Accounts
  screens.** The seven that exist tree-wide are named in §1.11, §2.9 and §2.10.
- **`KotSlips.slipTime` is a deliberate divergence, not a duplicate** — it pins
  Asia/Karachi so a kitchen slip cannot drift with a mis-set till clock. Left
  alone, and documented in place.
- **The three ORDER STATUS maps deliberately differ per screen.** Do not
  consolidate those; only the order-type and method maps in §2.12.
- **Receiving and Docs batch their line fetches with `IN (?)`** — no N+1.
- **`gaps.mjs` is four set-based queries.** `nextVoucherNo` exists once.
- **`session.mjs` verifies with `crypto.subtle`, enforces `exp` and
  `token_version`; `proxy.js` makes zero DB calls; `login/actions.js` does a
  dummy-hash compare on unknown users; `users/actions.js` never returns a hash
  and guards the last admin.** The gap is coverage, not correctness (§2.11).

---

## What changed since the last run (2 Sep 2026)

**Fixed.** The receipt's tax label (§2.1 of that report — the item it called
"the first thing to do"); all 24 bare `toLocaleString()` money calls, via a new
`src/lib/money.js`; the whole of its §1.2 and §1.3 — the dead `basePrice`, the
unimported `KITCHEN_STATUSES`, `/logout` in the proxy allow-list, `.spacer`,
`has_postings` ×3, `nextJournalNo`, `can()`, `requireAdmin`, the invisible login
spinner, and the three dead affordances made live.

**Still open, verified line by line.** The till's three `/api/menu` fetches and
its repeated `getSettings`; the pay-now double recompute; `getOrdersVersion`'s
unfiltered `COUNT(*)`; `getOpenTabs`'s client-side re-sort; the `orders.items`
JSON aggregation and the double `SELECT *` on the hub; handover's ten serial
queries and its raw error text; the three hour bucketings; the three catalog
screens; the six Accounts print blocks; the measured `@page` ×3; `/floor`'s
non-transactional writes and `CURRENT_DATE` audit; the unbounded login throttle;
the 725-line users screen (now 730); `applicablePlans`'s ignored parameter; the
hard-coded NTN/STRN; `branch_id`.

**Partly fixed.** `useRole()` is down from eight screens to seven. The rupee
formatter has a canonical home and 16 adopters, with 24 copies still outside it.
`kit.mjs` consolidated the voucher counter; the rest of the audit-writer family
did not follow.

**Newly found.** Everything the new subsystems brought: the half-built day
worker and its 11 tests guarding code nothing runs (§2.5); the Chart of Accounts
form that cannot submit (§2.1); the tax form's missing `WHERE` and its
empty-box-means-zero (§2.2); the till's pre-discount button total and dropped
discount reason (§2.3); the FBR double-file race (§2.4); the 80mm KOT slip and
the forked `print-thermal.mjs` (§2.6); the variant-blind gross-profit card
(§2.7); the four statement pages that print with the sidebar on them (§2.8); the
missing `stock_ledger` index (§2.10); the leaking photo uploads (§2.14); the
un-parked Raast QR (§4.2). And the two that make the next run cheaper: **the
lint script that was never run**, and **the scan's fourth blind spot**.

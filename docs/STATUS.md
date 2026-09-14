# Project status — living document

> Update this file whenever meaningful work lands. A fresh Claude session (or
> a human) should be able to read this top to bottom and know exactly where
> things stand. Last update: **11 Sep 2026** (branch
> `main`, repo `adnan9ostech/flames-pos`).

## What this project is

Flames by the Indus POS — Next.js 16 (plain JS) restaurant till for a
soon-to-open Islamabad restaurant. Migrated OFF Vercel+Supabase onto
**MySQL 8 + in-house auth**, to be self-hosted at **pos.flamesbytheindus.com**
on Adnan's shared cPanel server (`/home/ostech/`, ~150 tenant sites — never
touch global config; full runbook in `docs/deploy-cpanel.md`).

## Stack facts a new session needs

- DB: MySQL 8.0 local via Homebrew (`mysql@8.0`), dbs `flames_pos_dev`
  (real menu, admin PIN 123456 / staff 654321 — DEV ONLY) and
  `flames_pos_test`. Migrations: `mysql/migrations/*.sql` via
  `node scripts/db/migrate.mjs` (env `DB_NAME=…`).
- Money verbs live in `src/lib/db/orders.mjs` (locks/idempotency/invoices;
  error strings are contracts). Money math: `src/lib/orderTotals.mjs`
  `calcTotals` — SHARED by till and server; supports per-payment-mode tax
  (cash 16% / card 5%, editable in Settings) and auto charges.
- Auth: HMAC cookie `fbi_session` (`src/lib/auth/session.mjs`), bcrypt PINs
  in `users`, gates in `src/proxy.js` + `requireUser/requireAdmin`.
- Transport: pages import `@/lib/dataClient` (19 supabaseDb-compatible
  exports) → GET routes under `src/app/api/*` + server actions
  `src/lib/orderActions.js`. Realtime = 4s version polling
  (`useRealtimeTable` → `/api/orders/version`).
- Tests: `DB_NAME=flames_pos_test node --test 'tests/mysql/*.test.mjs'`
  (139 tests incl. concurrency races — keep green).
- Run locally: `ALLOW_HTTP_COOKIES=true npx next start -p 3210`
  (LAN devices: http://<mac-ip>:3210; Secure-cookie override is LAN-only).
- FBR Digital Invoicing: module `src/lib/fbr/*` + `scripts/fbr-worker.mjs`;
  OFF until `FBR_ENABLED=true` + bposid/token env (Adnan HAS production
  credentials; sandbox first; server IP must be whitelisted with FBR).
- Business day: orders stamp `business_date` (open `business_days` row,
  fallback Karachi calendar day). Reports bucket by it.

## Done (verified)

- [x] MySQL kernel + schema 001 — commit 4a5c493
- [x] Full app on MySQL (transport/auth/polling/KOT/FBR/import tooling)
      — commit a3e44a0; 17/17 tests; prod build green; UI-verified
- [x] Real menu imported: 125 dishes Sanity-priced (zero diffs), 20
      categories, photos in `public/menu-images/` — commit 051344e
- [x] GitHub: authed as adnan9ostech; all work on `main` — `mysql-migration`
      was fast-forwarded in and deleted 9 Sep 2026, and `main` is the default
- [x] Card GST 5% / cash 16%; both % editable in Settings
- [x] Service charge: charges-engine row seeded 5% dine-in taxable
      (migration 003) + Settings quick-edit field
- [x] Phases F–J schema (migration 002) applied dev+test
- [x] Kernel extensions: charges in recompute, city_ledger settles
      (+company validation, void reversal), pay-now company pass-through,
      inventory consume hooks in orderActions — tests still 17/17
- [x] F–J feature build: all 11 agent streams delivered (dayclose+handover,
      reports rebucket by business_date, expenses, drawer, daily-sales/
      hourly/item-wise reports, menu-analytics+gross-profit, companies+
      cityledger+CompanyPicker, charges+discounts+DiscountPlans,
      inventory core/flow/reports)
- [x] Integration (mine): proxy routes, Sidebar "Back office" section,
      reports hub links, ReceiptPreview charge lines, settings service
      charge, orderActions hooks

## In progress RIGHT NOW (updated after the Tax tab request)

- (nothing — F–J fully integrated and the Settings split is done; next
  step is Adnan's acceptance pass, see Pending)

Also done since:
- [x] Settings split into tabs: General (merchant/QR/print) and
      **Tax & FBR** at /settings/tax — GST cash/card %, tax name, service
      charge % moved there, plus a read-only FBR Digital Invoicing panel
      (enabled/mode, credential presence, queue pending/sent/failed).
      updateSettings and updateTaxSettings each write only their own
      columns so the two forms can't blank each other.
- [x] POS top-bar responsive fix: search shrinks (flex, was fixed 400px),
      pills nowrap, header wraps whole rows on narrow tills.

Also done in the integration pass (was "in progress" above):
- [x] Till wiring: charges price the cart live (scoped by order type, tab's
      type wins), City Ledger third pay mode with CompanyPicker (guards on
      both pay-now and settle; picker cancel falls back to cash), discount
      plan one-tap chips fill amount+reason
- [x] Test harness owns charge config (resetDb clears `charges`); new test
      11 proves the 5% dine-in service charge end-to-end incl. the
      expected-total refusal — suite is now 18/18
- [x] Build green (36 routes), server at :3210 restarted on the new build,
      UI-verified: Back-office nav, Day Close (implicit-day + clear-to-close
      gate), Handover report rendering live numbers, POS grid intact

## Later additions (9 Sep session — till/kitchen requests)

Migration `019_kitchen_routing_and_fees.sql` (dev+test applied). Tests
138/138, prod build green.

- [x] **Kitchen tickets routed off the till.** New `store_settings.kot_route`
      ('kds' default | 'till'). Under 'kds' the till prints ONLY the customer
      receipt (`printKotSlips` returns early); the **KDS auto-prints each new
      round** on its own printer — a jam/roll-change pause is
      `kds_auto_print`. This is the fix for slips and receipt fighting over one
      printer. `loadOrders` now enqueues the latest round's slips on a
      module-scope drain (`drainAutoQueue`), reusing the same builder/queue as
      the manual reprint; manual reprint and auto-drain are mutually exclusive.
      'till' keeps the old single-printer behaviour. Settings → General has the
      route picker + KDS auto-print switch. "Section-wise" = set kot_mode to
      **Per station** (still the operator's choice, not forced).
- [x] **Delivery Charge** (fixed Rs150 placeholder, delivery-only, after tax)
      and **POS Fee** (fixed Re.1, all order types, after tax — the FBR POS
      service fee) seeded into `charges`. No money-math change: the charges
      engine + order-type scoping already carried it. Verified via calcTotals:
      dine-in = service+POS, takeaway = POS only, delivery = delivery+POS;
      service charge never lands on takeaway/delivery. Amounts are editable on
      the Charges screen — the Rs150 is a placeholder Adnan should set.
- [x] **Manager PIN + reason + audit log to remove a cart line.** New
      `store_settings.void_requires_pin` (**now ON in dev**). When on,
      `removeItem` and a decrement-past-1 open `VoidPinDialog`, which asks for
      a **reason AND a PIN** (both required). `approveVoid` accepts the PIN
      only for an active user holding the `void` permission (admin/manager or
      override) — a cashier's own hash is never in the checked set — then
      writes `audit_log` (`action='remove_item'`, `staff_id`=approver,
      `order_id`=tab or null, details = item/qty/price/variant, reason,
      approved_by AND removed_by). Toggle on Settings → General.
      Verified 10 Sep: empty reason rejected, cashier PIN rejected, manager PIN
      approved + audit row written with both parties.
- [!] **Dev passwords were reset 10 Sep** — the hashes no longer matched the
      `123456`/`654321` this file documented, so nobody could have signed in.
      Now: **admin `123456`, manager `222222`, cashier `333333`** (dev only;
      change on the Users screen). frontdesk/kitchen/accountant untouched and
      their passwords remain unknown.
- [x] **"Open Offer" promo removed** from the dev `discount_plans` (ad-hoc dev
      data, never migration-seeded, so prod is unaffected). The discount-plan
      chips + manual "Add a discount" feature stays.

## Later additions (10 Sep session — menu sync, kitchen-hold, settings tabs)

Tests 138/138, prod build green (63 routes incl. new /settings/kitchen).

- [x] **Menu synced to the website.** Pulled the live Sanity dataset
      (project byr90f6b, read-only apicdn) and diffed against the POS: prices,
      variants and item set were already a perfect match (0 diffs). The one
      gap was availability — the website renders 42 dishes as "Coming soon"
      (a front-end flag, not a Sanity field; extracted from the rendered
      /menu HTML). Marked those 42 `is_available=0` (now 83 sellable / 42
      86'd). Reversible from the till's 86 switch when each starts serving.
- [x] **Kitchen fires when an order is SENT** (every order type). Briefly
      built "hold until paid" (a `payment_status='paid'` gate on
      getKitchenOrders) on 9 Sep, then reverted 10 Sep: it made dine-in
      circular — a table is cooked and served before it settles, so the
      kitchen can't wait on payment. So getKitchenOrders is back to
      `status IN (kitchen)` with no payment gate; handleOpenTab/handleSendRound
      fire the KOT on send; handleSettle only takes money + prints the bill.
      The KDS auto-print prints a new order in full and only the new round on
      an added round. (The owner considered a dine-in-fires / takeaway-pay-first
      split but chose "everything fires when sent".)
- [x] **Settings is now four tabs**: General (merchant/QR, cash policy, void
      PIN), **Kitchen & Printer** (new `/settings/kitchen` — receipt
      auto-print, paper width, KOT route, KDS auto-print, cut mode),
      **Charges** (the existing `/charges`, now on the strip), Tax & FBR.
      Shared `SettingsTabs` + extracted `controls.jsx` (SettingSwitch,
      ChoiceGroup). `updateKitchenSettings` writes only the kitchen columns,
      `updateSettings` only the general ones — same "each form owns its
      columns" rule as the tax split, so no tab can blank another's fields.

## Thermal printing — the counter printer (10 Sep, tested on real hardware)

The printer is **`PrinterCMD_ESCPO_POS80_Printer_USB`** (80mm, USB), a **raw
ESC/POS** device. Two hard rules learned by printing on it:

- **NEVER print to it from the browser.** Chrome → CUPS runs the job through
  the `cgpdftops` filter, which emits **PostScript**; the printer has no
  PostScript interpreter and prints the *source code* as text. One tap cost a
  115 KB job and most of a roll (`%%Creator: (Chrome Helper: cgpdftops CUPS
  filter)` on the paper is the signature). Stop it with
  `cupsdisable -c <queue>` then `cancel -a -x <queue>`.
- **The only correct path is the agent**, which writes raw ESC/POS bytes:
  `DB_NAME=flames_pos_dev node scripts/print-agent.mjs --queue
  PrinterCMD_ESCPO_POS80_Printer_USB --width 80 --port 9110`, then the till's
  `printReceiptViaAgent()` finds it on `127.0.0.1:9110` (probed once per page
  load — reload the POS page after starting it).

- [x] **Fixed: receipts were cut mid-tail.** `renderReceipt`/`renderKotSlip`
      ended `'\n\n\n' + CMD.cut` — only three feeds, but the POS80's head sits
      ~15–20mm (4–5 lines) before the cutter, so the blade landed inside the
      "Thank you" block and the leftover lines surfaced on the next bill. Now
      `feed(TAIL_FEED=6)` — an explicit `ESC d 6` — before the cut, in both
      renderers; `asPlainText` strips `ESC d n` too. Byte-neutral (3 bytes
      either way). **Verified on paper 10 Sep: clean.**

- [x] **Real logo on the receipt** (was the merchant NAME in double-size text,
      i.e. the printer's own typeface, not the restaurant's mark). Now printed
      as a raster: `renderLogo()` emits ESC/POS `GS v 0` from
      `src/lib/print/logo.mjs`. That module is **generated** — run
      `node scripts/print/make-logo.mjs --preview` when the artwork changes.
      It rasterises `public/flames-by-the-indus-logo-for-receipt.svg` using
      **headless Chrome as the rasteriser** (canvas → threshold → packed bits →
      base64), so the till needs no image library at runtime: 512×182 dots for
      80mm, 384×137 for 58mm. Falls back to the text header if no bitmap
      matches the paper. `asPlainText` now measures and steps over a raster
      block (`stripRasters`) instead of regex-stripping it — the image data
      contains 0x1b/0x1d itself and a regex dumped binary into the terminal.
      Receipt grew 739 → ~12.4 KB. **Verified on paper 10 Sep.**

- [x] **Phone on the bill, and two labelled copies** (migration 021).
      `store_settings.merchant_phone` (seeded `0304 5666516`, editable on
      Settings → General) prints under the city. `receipt_copies` (default 2,
      Settings → Kitchen & Printer) drives `renderReceiptJob`, which renders
      the bill once per copy stamped `*** CUSTOMER COPY ***` /
      `*** RESTAURANT COPY ***` near the top. **The cut between them is not
      special-cased** — renderReceipt already ends every bill with feed+cut, so
      two back to back come off the roll as two separated slips (verified: 2
      cut commands per job). Do NOT join the copies with a separator; that
      would add a third cut and eject a blank stub.

NOTE: `scripts/print-thermal.mjs` has its OWN inline renderer and does NOT
import escpos.mjs — so its `--dry` output still shows the old text header and
none of the escpos fixes. It is a bench diagnostic only; the agent is the real
path. Worth collapsing the two renderers into one.

- [x] **No more silent browser fallback.** Migration 020 adds
      `store_settings.print_transport` ('agent' default | 'browser'). Under
      'agent' the till NEVER falls back to `window.print()` — it says "print
      agent not running" and leaves the sale stored for a reprint from Orders.
      Chosen on Settings → Kitchen & Printer.
- [x] **Kitchen tickets through the agent.** New `POST /kot`
      `{orderId, round, reprint}` renders from the database (order_items +
      menu/categories + `kot_mode`) via `buildKotSlips` → `renderKotSlip`, and
      spools the whole round as ONE job so CUPS cannot interleave two jobs and
      shuffle the runner's pile. `printKotViaAgent()` in thermalAgent.js; the
      KDS uses it for both auto-print and the reprint button, and the till uses
      it when `kot_route='till'`. **Verified on paper: 3 section slips.**
- [x] **Agent autostarts.** `bash scripts/print/install-agent-service.sh`
      installs a per-user LaunchAgent (`com.flamesbytheindus.printagent`,
      RunAtLoad + KeepAlive, binds 127.0.0.1, no root, nothing system-wide).
      `--uninstall` removes it. Logs in `~/Library/Logs/`.
- [x] **Logo reduced to 80%**, and **the raster must be sent in STRIPS.**
      This took several attempts on real paper; the findings, so nobody repeats
      them:
      * The printer takes a `GS v 0` of ~1 KB fine — solid bars at 512, 576 AND
        384 dots all printed as clean black rectangles, so raster width was
        never the problem and `GS v 0` is well supported.
      * Hand it the whole logo in ONE command (9.5 KB) and its raster buffer
        gives up partway and prints the REMAINING BYTES AS TEXT — pages of
        random characters. The same bytes in **24-row strips print perfectly**.
        `BAND_ROWS = 24` in escpos.mjs; renderLogo emits one `GS v 0` per strip
        and the printer stacks them with no visible seam.
      * The bitmap is generated at the full paper width with the artwork
        centred in WHITE inside it and printed **left-aligned**. `ESC a 1`
        centres a raster byte-wise, so a logo whose margin is not a whole
        number of bytes smears — a 408-dot centred logo did exactly that.
      * Geometry now: **512×148** (80mm, 64 bytes/row) and 384×114 (58mm),
        artwork 416/320 dots inside. `PAPER`/`LOGO` in make-logo.mjs.
      **Verified on paper 10 Sep: "the logo looks good now".**

KDS print settings, verified correct 10 Sep: `print_transport=agent`,
`kot_route=kds`, `kds_auto_print=1`, **`kot_mode=category`** (section-wise, as
the owner asked — it was still `item`), `receipt_width_mm=80`, `auto_print=1`.

Known gaps (NOT yet built):
- Each DEVICE needs its own agent: the KDS talks to `127.0.0.1:9110` on the
  kitchen machine, so the kitchen box needs the LaunchAgent installed against
  the KITCHEN printer's queue. Only the till machine has one so far.

## Later additions (1 Sep session)

- [x] Service charge had TWO editors (Settings quick-field + Charges screen)
      and the Settings one matched by hard-coded name — removed. Charges is
      the only editor; Tax & FBR shows active charges read-only with a link.
- [x] Day **start**: `startBusinessDay` — the first day ever, and the
      "shut Tuesday, trading Thursday" case where the auto-opened day has
      gone stale (an empty stale day is re-dated; one with orders refuses
      and tells you to close it). Start Day button + stale warning on the
      Day Close screen.
- [x] `closeBusinessDay` now refuses to close a day that has not started
      (future-dated with no orders) — repeated clicks were walking the
      calendar forward. Its transaction callback's refusals are now
      inspected, not discarded.
- [x] **Waiters & Tables** admin screen (`/floor`, admin-only): edit/retire
      waiters, and a new `dining_tables` master (migration 004) with
      name/seats/area/sort. Neither is ever deleted — retiring keeps history
      readable. The till's table field is now a picker over active tables
      that still accepts a typed name.

- [x] Hard **delete** for waiters and tables, behind a risk dialog that
      quotes the real impact for that row: a waiter's bills keep the printed
      name (orders.waiter_name is denormalised) but lose the link reports
      group by — that dialog demands the name be typed; a table's past
      orders store text with no FK, so nothing historical changes. Both
      write the full deleted row into audit_log first, and "Retire instead"
      is offered as the reversible option.

## Users, roles & permissions (1 Sep)

- Migration 005: `users` gains email + username (both UNIQUE, sign in with
  either), full_name, permissions JSON, must_change_password, is_active,
  last_login_at; pin_hash→password_hash, pin_version→token_version; the
  one-row-per-role UNIQUE is gone. Roles: admin, manager, cashier,
  frontdesk, kitchen, accountant (+ legacy staff, suspended).
- `src/lib/auth/permissions.mjs` is the single source: PERMISSIONS,
  ROLE_DEFAULTS, effectivePermissions(role, overrides), permissionForPath,
  landingPath. Granted keys ride in the SIGNED cookie so the proxy gates
  routes with zero DB calls; requireUser() re-reads live rights for actions.
  Changing a role/permission/password bumps token_version → other devices
  re-authenticate.
- `/users` (admin): create with generated password, edit, per-user
  permission overrides, reset password, suspend, hard delete — with
  last-admin and self-action guards. Login is identifier + password;
  handed-over passwords force a change at first login. Profile: own name,
  email, password, and a read-only list of what you can access.
- Sidebar draws only what the account can open, scrolls, and pins
  Profile/Logout; Settings sits last. Tests: 34/34 (permissions suite added).
- Dev accounts (password `flames1234`), sign in with the USERNAME:
  `admin`/`manager`/`cashier`/`frontdesk`/`kitchen`/`accountant`. (This list
  said `adnan` until 3 Sep 2026; there has never been such a row, and it cost
  an agent a run.) Old shared `staff` row suspended; `admin` still exists
  with the old PIN as its password and must_change_password set.

## Reports rework (1 Sep)

- `src/app/reports/layout.js` + `ReportsNav.jsx`: the library strip is a
  NESTED LAYOUT, so it persists on every report screen and marks the current
  one. It previously lived only on the index page — opening any report was a
  one-way trip.
- `/reports` is now a hub: the range controls, KPI tiles and revenue chart
  stay on top; below them a card grid, one card per report, each with a
  headline number and a preview sparkline. All six previews come from ONE
  action (`getReportPreviews`), not six.
- Every report page gained the chart its data calls for: hourly = 24-hour
  columns with bills as a SEPARATE small multiple (never a dual axis);
  item-wise and menu-analytics = sorted top-10 horizontal bars labelled
  "top 10 of N"; gross-profit = the 10 WORST margins with recipe-less items
  excluded and footnoted; handover = payment split + profit waterfall, both
  print-safe.
- **Chart palette is validated, not chosen**: #3987e5, #d95926, #199e70,
  #c98500, #d55181, #9085e9 — passes all six dataviz checks (lightness,
  chroma, CVD separation, normal-vision floor, contrast) against the app's
  real #0d0b0a surface. A first candidate FAILED CVD separation (violet vs
  blue, ΔE 5.2). Single-series charts use slot 2, never brand orange, so
  data never reads as chrome. Re-validate with the dataviz skill's
  scripts/validate_palette.js before changing any of them.

## POS bill panel redesign (1 Sep)

- The reported bug: only ONE cart line was visible at a time. The panel's
  fixed chrome (header 72px + order details ~190px + bill ~420px) was eating
  ~660px of a 900px screen, and each cart row was ~110px because the 44px
  qty stepper sat UNDER the dish name.
- Fixes, in order of how much height each returned to the list:
  - Cart row is one line: stepper BESIDE the name, so its 44px height sets
    the row's (~52px) instead of stacking on it. **The 44px touch target is
    unchanged** — it is why the row is 52px and not 36px.
  - Fields wear their icon inside the control; the stacked uppercase caption
    above every input is gone (aria-label carries the name instead).
  - The discount editor folds behind "Add a discount", and re-opens itself
    whenever a discount is actually applied.
  - The FBR tax checkbox moved onto the tax row it governs.
  - Payment chips moved DOWN to sit directly above Send & Pay — one decision
    in one place, and switching cash/card repoints the tax row above it.
  - `.cartItems` gained `min-height: 0` (a column flex child will not shrink
    below its content without it), `.cartSummary` a `max-height: 60vh`.
  - Panel 400px → 420px so every 44px target survives the tighter row.
- Result at 1440×900: 8 lines visible, was 1. At 1280×720: 4–5, was 1.
- Dead CSS removed with the markup it served: `.field`, `.fieldLabel`,
  `.fieldInput`, `.detailsRow`, `.phoneRow`, `.taxToggle`, `.cartItemRight`.

## Theme system — Light / Dark / System (3 Sep)

A full dual-theme system. The app was dark-only (a single `:root` in
`globals.css` pinning `--background:#000`); it now ships a polished light theme
and a system-following option, with dark preserved as-is.

Design decisions (owner-confirmed): preference is **per-device** (localStorage
`fbi.theme`, same pattern as `fbi.sidebarCollapsed`), **default Dark** so
existing tills are untouched until someone opts in, and **KDS follows the theme**
like everything else.

- **Tokens** (`src/app/globals.css`): dark on `:root`, light on
  `:root[data-theme="light"]`. Dark carries the app if the boot script never
  runs. Light is NOT an inversion — each accent is retuned so one value serves
  both text and fill roles (`--primary` #F26513→#a83f08); neutrals matched by
  contrast RATIO, chromatics by hue. New tokens: surface raise/sunken/
  translucent, overlay, shadow-sm/md/lg + shadow-drawer, focus-ring, disabled-*,
  and status triples (`--{success,danger,warning,info,neutral}-{soft,soft-strong,border,text}`).
  Also defined the never-declared `--sidebar-muted`.
- **Runtime**: `src/lib/theme.mjs` (single source: key, default, resolve, boot
  script, chrome colours), `src/components/Layout/ThemeProvider.jsx`
  (`useSyncExternalStore` over localStorage + a `matchMedia` listener that only
  re-resolves under 'system'), a blocking boot script in `layout.js` that stamps
  `data-theme` AND the `theme-color` meta before first paint (anti-flash;
  `suppressHydrationWarning` on `<html>`). Chrome meta follows the RESOLVED theme,
  not the OS.
- **Switcher** `src/components/Layout/ThemeSwitcher.jsx`: a `radiogroup` with
  roving tabindex; full control in a Profile "Appearance" card (reachable by
  everyone — `/profile` is in `ALWAYS_ALLOWED`), compact in the sidebar rail
  (cycles when collapsed).
- **Tailwind**: only 3 pages used it (reports, settings, settings/tax);
  `darkMode:['class','[data-theme="dark"]']` + semantic colours backed by the
  same vars; 242 gray-ramp classes converted. Translucent chrome uses
  `--surface-translucent` because TW3 drops opacity modifiers on `var()`.
- **CSS modules**: ~350 hardcoded literals → tokens across ~46 files. NEVER
  touched: `@media print` blocks, the item-wise 80mm preview, ReceiptPreview
  `.modal{background:white}` (the QR quiet-zone field), kotSlips `.slip`.
- **Charts**: `src/lib/reports/chartTheme.mjs` (one palette, var() strings recharts
  resolves as SVG attrs). Light re-steps ONE slot (amber) so a series keeps its
  identity; validated with the dataviz skill (CVD, contrast). Paper prints the
  light palette regardless of screen theme.
- **Logo**: the wordmark SVG is white and vanishes on light, so
  `flames-by-the-indus-dark-ink.svg` was generated (flame kept orange) and
  swapped in CSS (no re-render) in both the sidebar and the customer header.
- **Offline page** (`public/offline.html`): standalone + cached by name, so it
  carries its own two-palette copy + boot script; SW bumped v2→v3 so tills get it.
- **Bugs fixed in passing** (pre-existing, in dark): `--destructive-foreground`
  was white on #ef4444 (3.76:1, failed AA); `.itemThumbFallback` used `--muted`
  (a text token) as a background (1.38:1 invisible glyph); the POS till search
  had no focus ring; an emerald glow sat under the orange category tab.
- **Verification**: build green (62 routes); `node --test tests/mysql` 114/114
  (incl. new `theme.test.mjs` — resolve rules + boot-script/offline key parity +
  a guard that every themed token has a light value); a re-runnable
  `scripts/check-theme-contrast.mjs` checks 160 token pairs incl. composited
  status chips (0 failing, both themes); System-follows-OS and the anti-flash
  boot verified via headless-Chrome CDP; a 5-dimension adversarial review
  workflow (each finding double-verified) surfaced 3 real defects, all fixed.

## Pending (ordered)

1. Local acceptance testing by Adnan of everything incl. F–J screens
2. FBR sandbox pass (needs a Test POS ID from e.fbr.gov.pk)
3. Server deployment: `docs/deploy-cpanel.md` phases 0–5
   (subdomain+AutoSSL → MySQL → nvm/PM2 → Apache userdata include → verify)
4. Production import run on the server (scripts/migrate-to-mysql 01–05 +
   seed-users with REAL PINs), FBR production env + IP whitelisting
5. Cutover: kiosk shortcuts → https://pos.flamesbytheindus.com/pos, PWA
   reinstall, archive Supabase order-history CSV, pause Vercel, revoke keys
6. Post-cutover sweep: drop @supabase/supabase-js + sanityMenu.js +
   scripts/migrate-to-mysql + scripts/menu/ (blink-recipes.json and its
   importer are the same one-time-import shape); run `/cleanup-audit`
7. Confirm with accountant: FBR posture for tax-off orders and BTC
   (city-ledger) invoices

## Accounts module (2 Sep) — double-entry GL, modelled on ChowPOS

Owner asked for ALL sixteen tiles of ChowPOS's Accounts Dashboard (mapped
read-only from rms.roomy.pk; findings + screenshots were in the session
scratchpad; the decoded link-code mechanism is documented in
`src/lib/accounts/constants.mjs`). Decisions taken as the expert, not asked:
one GST Payable account for both the 16% cash and 5% card rate (same
authority — FBR); Cash Over/Short is an expense; the ledger starts at go-live
with an Opening Balance JV for capital invested; chart edits need
`accounts_admin` (admin + accountant, NOT manager); sales journal on the
order's business_date, corrections on the current open day, never blocking
a settle.

Built so far:
- [x] Step 1 — schema: migrations 006 (11 tables, seeded 68-account chart,
      gl_links, gl_settings; re-runnable) + 007 (ALTERs on expenses /
      expense_categories). gl_journals CHECK debit_total = credit_total;
      expenses.voucher_line_id UNIQUE so a voucher can never project twice.
      **Expense vouchers are the DOCUMENT; `expenses` rows are their
      PROJECTION** (drawer expected-cash and handover read `expenses`).
- [x] Step 2 — permissions `accounts` + `accounts_admin`, `/accounts` route
      gate, sidebar entry (after City Ledger), 16 searchable inner pages,
      section shell (`layout.js` + `AccountsNav` strip, 7 stops), hub with
      4 stat cards + the 16 tiles in ChowPOS's 4 groups.
- [x] Step 3 — Chart of Accounts (`/accounts/chart`): list with group
      tabs / search / show-inactive, side form with number (leading digit
      enforced per group, next-free suggested), name, category (datalist),
      link-code checkbox matrix with plain-English labels, active. System
      accounts can be renamed, never switched off. No delete, ever.
      Server-validated; every write audited with staff_id.

Steps 4–12 — ALL BUILT (2 Sep, one orchestrated pass: 7 build agents with
disjoint file ownership, then build + suite, two browser smoke agents, three
adversarial reviewers, a fix pass; then my own consolidation + review):
- [x] Posting engine `src/lib/accounts/post.mjs`: after-commit hooks in
      orderActions.js (4 lines, same posture as FBR/inventory). SV per order
      at its business_date; SM per payments row; voids write contras from the
      STORED lines on the current open day. Idempotent on UNIQUE
      (source_type, source_id) — mysql2 reports affectedRows=1 on a duplicate
      ODKU, so the twin signal is `insertId === 0` (probed). Orders now stamp
      `tax_rate` at settle (migration 008) so the FBR return can split by rate.
      Refuses (logs, no journal) if Σ line_total ≠ subtotal.
- [x] Fix-pass hardening the reviewers forced: counter locks always taken
      SV-then-SM (a void previously deadlocked a concurrent settle 39/40
      runs); `orders FOR UPDATE` first so a void racing its own settle hook
      cannot lose the reversal; a void SM reverses the STORED SM lines, not a
      live re-resolve of the payment mapping; the screen "Reverse" refuses
      engine journals (void the bill / reverse the voucher instead) so a sale
      can never be un-booked twice; a PV debits the payable the EV actually
      credited; expense documents cannot be future-dated; split/part-paid
      voucher lines are refused at post (a projection must be whole-line so
      the drawer sum is exact).
- [x] General Ledger `/accounts/ledger`, Voucher List `/accounts/journals`,
      voucher document `/accounts/journals/[id]` (Print, Reverse for manual
      JVs only), manual JV `/accounts/journals/new` (balanced client+server+
      CHECK; "Opening balance" mode pre-lines Opening Balance Equity).
- [x] Statements: Trial Balance (Balanced chip, Print/CSV/Excel), Income
      Statement (ChowPOS shape), Balance Sheet (with current-period earnings
      so A = L + E and it says so), Cash Register (running balance). Excel via
      `src/lib/reports/xlsx.mjs` — zero-dependency .xlsx writer (deflateRaw +
      crc32 from the existing `crc` dep), route `/api/accounts/export`.
- [x] Expense Categories + Codes screens; migration 009 seeds 8 categories
      and 23 codes mapped onto the chart (payable = 20100 Sundry).
- [x] Expense Vouchers (ChowPOS document: DRAFT → Save & Post → Add payment →
      Reverse), EV/PV journals, PROJECTION into `expenses` (voucher_line_id;
      paid_from matches what the drawer filters on; created_at inside the
      drawer window). The OLD /expenses screen now refuses Mark-paid/Delete on
      projected rows and links to the voucher; its default range covers the
      open business day. Expense Report (Summarize toggle) + Expense Payables.
- [x] Posting Health `/accounts/health` (accounts_admin): settled bills with
      no SV, payments with no SM, unbalanced headers, and legacy chits typed
      on the old Expenses screen (never reach the GL — re-enter as vouchers);
      Repost / Repost all. Day Close shows "N bills not in the ledger" as an
      amber note, never a blocker.
- [x] Other postings `src/lib/accounts/otherPost.mjs`: RV on city-ledger
      receipts, PV on supplier payments + Dr Inventory/Cr AP on stock
      receivings (both or AP runs negative), drawer-close variance to Cash
      Over/Short. Nothing posts from company_invoices (double-count trap).
- [x] `src/lib/accounts/kit.mjs`: the one copy of money/ymd/nextVoucherNo/
      audit/currentBusinessDate (plain Node, relative imports); helpers.mjs
      is now `server-only` + re-exports. The agents had restated these in 7
      files because helpers.mjs cannot load in `node --test`.

Deferred, deliberately (follow-ups, not defects): a client_request_id on
expense vouchers / receipts / supplier payments (needs a migration + UI
keys; the editors' busy flag blocks double submits today); the legacy
add-expense path posts nothing (surfaced on Health with its rupee total).

DEV DATA STATE: smoke agents moved gl_settings.start_date on flames_pos_dev
to 2026-09-01 (the still-open business day) and left 4 expense vouchers,
~10 journals and 2 extra POS sales behind; the 25 pre-engine seeded bills
show on Posting Health until "Repost all" or a data wipe. Wipe with the 22
seeded orders when Adnan wants a clean slate.

## Menu Management (3 Sep 2026) — dishes, sizes, modifiers, recipes, costs

The owner asked for a dedicated Menu section with name, category, variation
and recipe, plus ingredient prices, and for the Blink account to be read for
recipes. All of it is built and the recipes are imported.

Decisions taken as the expert, not asked:

- **The menu is its own permission.** `menu` (admin + manager) covers dishes,
  prices, sizes, modifiers, recipes and ingredient costs; the old shared key
  became **`setup`** for charges / discounts / waiters / tables, which the
  front desk keeps. Pricing a karahi and retiring a waiter are not the same
  authority. No stored override used the old key, so nothing had to migrate.
- **A dish is archived, never deleted** (`menu_items.is_archived`, migration
  010) — `order_items.menu_item_id` FKs it and the bill history goes with the
  row. Archived dishes leave the till, the KDS and the customer menu.
- **Sizes are shared objects** (`variation_sets`, migration 011), the way
  Blink and ChowPOS model them: the SET owns the option names and their order,
  the DISH owns the prices. All 44 sized dishes linked themselves to the four
  vocabularies already in use. `menu_items.variants` stays the denormalised
  truth the till reads, so POS/KDS/customer needed no change.
- **A recipe can differ per size** (`recipe_lines.variant_name`, migration
  010; `''` is the base). A sold line uses its own size's lines when that size
  has any, else the base — one resolution, stated once in
  `src/lib/menu/rules.mjs` and imported by consumption, gross profit and the
  handover's COGS so the three can never disagree.
- **Ingredient cost is editable until the first delivery.** `avg_cost` was
  only ever written by a receiving, so with no purchase history every recipe
  costed zero forever. It is now typed on the Ingredients screen, audited old
  → new, and the moving average takes ownership from the first receiving.
- **Photos upload to `UPLOAD_DIR`, not `public/`** — `next start` serves only
  what `public/` held at build time (probed: a file dropped in afterwards
  404s). `POST /api/menu/images` writes, `/api/uploads/menu-images/<uuid>`
  serves. The directory is gitignored and must be in the server backup set
  (see `docs/deploy-cpanel.md`).
- **`src/lib/money.js` is the one rupee formatter.** Every bare
  `toLocaleString()` is gone from the till, the receipt, the orders list and
  the customer menu — the same bill was printing `1,250` on one device and
  `1.250` on another.

Screens, all under `/menu` with a section strip: Dishes (list + editor),
Categories, Sizes & Variations, Modifiers, Recipes, Ingredients. `/inventory/
recipes` redirects to `/menu/recipes`; the old screen is deleted.

**Blink import (one-time, committed so it can run again on production).**
`scripts/menu/blink-recipes.json` + `scripts/menu/import-blink-recipes.mjs`
(dry run by default, `--apply`, `--replace`). Read read-only out of the
restaurant's own Blink account on 3 Sep 2026: **167 ingredients and 126
recipes / 1,371 lines**, of which **124 recipe names matched all 125 of our
dishes** (Channay is two rows sharing one name). Quantities were converted
from the recipe unit to the PURCHASING unit — 280 g becomes 0.28 kg — so a
cost is typed the way the kitchen buys ("Rs 850 a kilo"), and every dish now
has a base recipe.

**Blink holds no ingredient prices** (its own Ideal Food Cost reads Rs 0), so
all 167 land unpriced and every recipe costs zero until Adnan types what he
pays. That is the one outstanding input, and the Ingredients screen counts it.

## Printing — verified 3 Sep 2026

**Paper width is now a setting.** Settings → Receipt paper width, 58mm or 80mm.
One value drives the preview's own width, the print rules and the `@page` handed
to the printer, and the KOT slips follow it — and `printReceipt`/`printKotSlip`
MEASURE the rendered width rather than being told it a second time, so the page
can never disagree with the layout it was measured from. Migration 012 adds
`store_settings.receipt_width_mm` (default 80). At 58mm the receipt's own
container query stacks the date and operator and spaces the Qty/Amount headings,
so nothing runs into the margin. Verified end to end: 58mm lays out at 219px and
pages `58mm x 158mm`; 80mm at 302px and `80mm x 130mm`.

**The restaurant's Black Copper Bluetooth printer cannot be printed to from the
browser on macOS, and that is not fixable here.** Tested 3 Sep 2026: it pairs and
connects, but advertises only a Braille ACL service and no SDP printing record,
so `/usr/libexec/cups/backend/bluetooth` finds it and then declines to build a
queue (`No SDP record`). `lpstat -p` never lists it, `lpinfo -v` shows no
bluetooth device, and a browser cannot print to a printer that has no queue.
It IS reachable as a serial port (`/dev/cu.BlueToothPrinter`) and ESC/POS bytes
written there print — `scripts/print-thermal.mjs` renders a real bill that way
at 32 columns for 58mm, which is how the printer and the layout were verified.
That script is a bench test, not a print path: nothing calls it during a sale.
The resolution is Windows, where pairing yields a virtual COM port and the
vendor driver builds a real queue; or a USB/network thermal printer on the Mac.
If Bluetooth-on-Mac ever has to work, it needs a local ESC/POS agent the till
posts to — a real piece of work, not a setting.

Bluetooth pocket printers are documented in `docs/kiosk-printing.md`. The
constraint worth knowing: this app prints through the browser, so the printer
must appear in Printers & Scanners as a real queue. Pairing alone is not enough,
and a pocket printer that only prints from its vendor's phone app cannot be
reached at all without separate ESC/POS work.

Checked by measurement in print media, not by reading the CSS. Two defects
found and fixed:

- **The receipt printed blank.** `body:has(#receipt-print-root) *` scores
  (1,0,1) — `:has()` takes its most specific argument — while the re-show rule
  `#receipt-print-root` scores (1,0,0), so the hide won on the receipt itself
  and on every child. The KOT slip had the identical bug, with `!important` on
  both halves settling nothing. Both re-show rules now repeat the ancestor.
  This was wrong in every build since the technique was introduced.
- **The receipt printed the wrong tax rate.** It read `settings.tax_rate`,
  a column that stopped existing when cash and card rates were split, and fell
  back to 16% — so every 5% card bill printed "GST (16%)". The rate now
  travels with the bill: the till passes the mode's rate, a reprint passes
  `orders.tax_rate`, and a pre-migration bill prints no percentage rather than
  a wrong one.

Confirmed working: auto-print switch reads from `store_settings.auto_print`;
`@page` is injected at the measured height (80mm × 130mm on a three-line bill)
and removed after, so no later print in the app inherits a receipt roll; the
sidebar and the modal's own buttons stay off the paper; a KOT slip takes the
paper off a receipt mounted at the same time; and a page with neither mounted
(the Handover report's PDF export) prints normally. Windows/Chrome kiosk setup
is unchanged — `docs/kiosk-printing.md`.

## Table headers and the POS list view (3 Sep 2026)

**The header misalignment the owner reported was real, and the first sweep
missed it.** Measuring `<th>` against `<td>` bounding boxes found nothing: the
CELLS line up perfectly. What does not line up is the text INSIDE them — a
`.table th { text-align: left }` rule outranks a bare `.alignRight`, so every
money column printed its figures hard right under a title sitting hard left.
**68 columns across 24 screens.** Each stylesheet now repeats its table selector
(`.table th.alignRight { text-align: right }`), and a probe that compares
computed text-align per column reports 0 across all 37 screens.

**The Users screen had a second, worse one**: `display: flex` on a `<td>`. That
takes the cell out of table layout, so it stopped stretching to its row — 44px
against the row's 67px — and its bottom border drew 23px above every other
cell's, which is the staggered double divider under each person. The buttons now
flex inside a wrapper and the cell stays a cell.

Also fixed from a measured audit of 40 screens: Day Close overflowed the page
sideways at 1024, the Users table spilled its card with no way to scroll, and
Waiters & Tables declared six columns in a four-column table.

**The POS grid now has a list view.** A segmented Grid/List control in the till
header, remembered per terminal in localStorage (the counter till and the
phone-order desk disagree, so it is not a store setting). The list is the same
cards restyled — one piece of markup, so a dish behaves identically either way.
It wraps into columns rather than running one row across the full width: **33
dishes visible at 1440 against the grid's 8**, 22 at 1280, 10 at 1024. Sized
dishes show their price range in place of the "Variants" chip, which says the
same thing in space the price already used and cut clipped names from 20 to 2.
The 86 switch moved out of the photo (which is clipped to 44px in a row) and
into the row itself, so a dish can still be marked sold out.

## KDS, the order view, and kitchen tickets (3 Sep 2026)

The owner said the KDS flow was not clear to him: if an order completes there,
what happens on the till? The answer, which was true but nowhere stated:

**An order carries two independent statuses.** `orders.status` is the KITCHEN
(new → preparing → ready → completed) and `orders.payment_status` is the MONEY
(unpaid → paid). The KDS moves the first, the till moves the second, and neither
moves the other. Pressing Serve finishes the cooking and takes no money; the
order stays in Open Tabs until a cashier settles it. An order is done when both
are done. Nothing is lost when the kitchen completes an order.

Built in response:

- **An order detail drawer** (`/orders`, click any row or card). Kitchen and
  Payment as two separately labelled chips — never merged, because merging them
  is the confusion. A kitchen stepper with the next action, the lines grouped by
  ROUND with each round's fired time, the bill at the rate it was settled at,
  the `payments` rows, and the audit trail. It holds only an order id and reads
  everything fresh, so it can never disagree with the row behind it.
  **A KDS bump reflects in an open panel in about 3 seconds** — measured: Start
  on the board moved the panel New → Preparing with nobody touching it. It rides
  the list's existing 4s version poll rather than adding a second one.
- **Kitchen tickets can print per ITEM** (migration 013, `store_settings.
  kot_mode`), which is what the owner asked for: a ticket travels with each
  dish. Default is `item`. Per station (category) is one tap away on Settings,
  and the hint states the real cost — a 12-line order prints 12 tickets against
  about 4. A line of qty 3 is ONE ticket reading "3 x": three identical scraps
  cannot be told apart if one comes back.
- **Reprint from the KDS**, per ticket, behind a two-tap arm (4s) rather than a
  modal — a confirm dialog is a thing to dismiss with a wet glove mid-service,
  and the primed button states the cost. Reprints carry a knockout REPRINT band,
  because a reprint indistinguishable from a fresh fire is food cooked twice.

**The till no longer flips availability.** The eye switch is off the POS tiles;
Menu → Dishes owns it, beside the price and the recipe. The "Sold out" tag stays
on the tile, because whoever is selling has to see it. One switch, one place,
one audit trail.

## Printing to a Bluetooth thermal printer (3 Sep 2026)

`scripts/print-agent.mjs` — a local service the till POSTs an order id to, which
renders the bill as ESC/POS (`src/lib/print/escpos.mjs`) and writes it to the
device. `src/lib/thermalAgent.js` is the client: it probes once per page load
and returns false for anything wrong, so the browser print path is exactly what
it always was when no agent is running. Wired into the till's settle and pay-now
and the Orders reprint. Nothing here is required for a sale.

It exists because the browser path cannot reach this printer at all (see the
Printing section above) and because the serial link is far too slow for a
rasterised page — the bill as text is under a kilobyte.

**A stalled printer blocks its writer in an uninterruptible kernel wait** (state
`U`), which `kill -9` cannot clear until the device lets go; power-cycling the
printer releases it. Found the hard way. The agent guards against entering that
state with a write deadline (`PRINT_WRITE_TIMEOUT_MS`, 15s), so it fails in a way
the till can fall back from instead of wedging.

## Cash drawer: the carry-forward close (3 Sep 2026)

Asked for as "day close pe proper amount add karwani hai, aur jitne amount pe
close hoga wo agle din ka opening balance hoga". Built to the way POS systems
actually do it (Toast, Lightspeed, Petpooja: declared float, blind count,
over/short, cash left vs cash handed over). Full operating manual:
`docs/cash-handling.md`.

**Migrations 015–017**, one ALTER each, per the 007/008/012/013/014 rule:
- `drawer_sessions.carry_forward`, `.handover_amount`, `.denominations` (JSON).
  Invariant: `counted_amount = carry_forward + handover_amount`, always.
- `business_days.opening_cash`, `.closing_cash` — stamped, not derived, because
  a report somebody signs must not recompute itself. First drawer to open on the
  day writes `opening_cash` (once, never overwritten); every close restates
  `closing_cash`.
- `store_settings.default_opening_float`, `.cash_variance_tolerance`. Both
  default 0, and 0 is exactly today's behaviour — propose no float, explain
  every difference — so the migration changes nothing until an admin sets them.

**`src/lib/cash/drawer.mjs`** — the arithmetic as pure functions (no Node
imports, no `server-only`), so the browser previews a close with the same code
the server enforces and `node --test` asserts it without a database. Precedent:
`src/lib/menu/rules.mjs`. 13 tests in `tests/mysql/cashdrawer.test.mjs`; suite is
**139**.

**The close is now a form, not a confirmation.** Note-by-note entry over the
Pakistani denominations, largest first; a breakdown that disagrees with the
typed total is refused server-side. **The expected figure stays hidden until the
count is entered** — a blind count, which is the one control that stops a short
drawer being closed for exactly the right amount. Then the split: what stays for
tomorrow, what is handed over. A variance past the tolerance cannot close
without a written reason, enforced in the action and not only in the browser.

**The chain.** `openDrawer` proposes last close's `carry_forward` (falling back
to the standing float when there is no previous close) and audits any figure
typed over it, with `float_differs_by`. `getDrawerState` returns
`suggestedFloat` + `lastClose` when no drawer is open, so the screen can say
"Rs. 5,000 was left here at the 2 Sep close".

**Day Close refuses to close over an open drawer** (same `force` tick as the
unpaid-bills gate; the audit row records `uncounted_drawers`). The scheduled
close is the deliberate exception — a machine must not invent a count, and must
not stall the calendar. The screen gained a cash card (opened with / expected /
counted / over-short / handed over / left for tomorrow) and the history table
now shows the opening→closing chain running back. `/reports/handover` gained
**Handed over** and **Left in till** columns.

**Known gap, stated on purpose:** the handover does not post to the GL. There is
no Cash in Safe account mapped, and inventing one to post against would be worse
than the gap. The variance still posts to Cash Over & Short as it always did.

## The accountant's chart of accounts (3 Sep 2026)

His file (`Flames - Chart of Accounts 2.xlsx`, 82 lines) loaded by
**migration 018**. Full review, including the four errors found in the file and
the five questions back to him: `docs/chart-of-accounts.md` — that page is the
one to send.

**The numbering convention changed.** ChowPOS's 1/2/3/4/5 =
asset/liability/income/expense/equity became the standard series every
accounting package uses: **1 asset, 2 liability, 3 equity, 4 income, 5–9
expense**, four digits. `GROUPS` in `src/lib/accounts/constants.mjs` now carries
`digits: []` per group instead of a single `digit`, plus `ACCOUNT_NUMBER_RE`,
`digitsLabel()` and `groupForNumber()`. The chart form and its server-side
validation moved with it.

**Every account was renumbered in place** — `UPDATE ... WHERE account_number`,
never delete-and-reinsert — so all 239 journal lines, 25 expense codes, 10
gl_links and 9 gl_settings pointers stayed attached through the change and
nothing needed repointing. 90 active, 8 retired (switched off, history kept).
His 8 parent accounts became `accounts.category` values, since this chart is
flat.

**One live break found and fixed.** `resolveApSuppliers` (`otherPost.mjs`) found
the payables control by matching a NAME containing "Suppliers" — the old seed's
wording. His chart calls it "Accounts Payable", so every GRN and supplier
payment would have stopped posting **silently**, since those hooks swallow their
own errors. Now resolved by structure (link code + category + lowest number),
and the `nameLike` option was deleted from `accountByLinkCode` so name coupling
cannot come back.

**4090 Discounts is in category CONTRA REVENUE, not REVENUE.** `statements.mjs`
negates that category; filed under REVENUE a discount would be added to sales
and the P&L would overstate revenue by twice every discount. The other two
category strings the code matches on (`ACCOUNTS PAYABLE`, `COST OF GOODS SOLD`)
were preserved deliberately for the same reason.

Verified after loading: trial balance 949,409 = 949,409; balance sheet
356,253 = 192,641 + 163,612, difference 0; 139 tests pass.

## Sidebar, sorted by category (3 Sep 2026)

Thirteen links under one "Back office" heading, in the order they happened to be
written, became six labelled groups. `sidebarSections()` in `navIndex.mjs`
groups the back-office rail on the same `section` values the search palette
already uses — so a screen is filed once and the rail and the palette cannot
disagree — with a "More" catch-all so a screen added under an unlisted section
appears rather than vanishing.

- **(no heading)** POS · Orders · Kitchen Display · Customer View
- **Cash & Day** Cash Drawer · Day Close · Expenses
- **Menu & Stock** Menu · Inventory
- **Accounts** Accounts · Companies · City Ledger
- **Reports** Reports
- **Setup** Waiters & Tables · Charges · Discounts · Users · Settings

Reports moved off the primary rail so it gets a heading like everything else.
Collapsed, the headings become the separator rules that were already drawn.

## Future scope — agreed with the owner, deliberately not built

Rescued from `docs/ROADMAP.md` before it was deleted (1 Sep). These are
DECISIONS, not guesses, and nothing in the code implies them:

- **QR dine-in ordering** — in scope: table QR → `/customer` gains a cart →
  the order lands unpaid on the KDS tied to that table, settled at the till.
- **Inventory goes all the way to procurement** (suppliers/POs/GRN) — this
  one is DONE, shipped as phase J.
- **Aggregators: channel tracking now, Foodpanda API later.** The API needs
  partner access from Foodpanda — external and unbounded, so it was never
  scheduled.
- **Branch #2 = insert a row.** Every table already carries `branch_id` and
  every unique index includes it. No branch UI until a second branch is real.
- **Loyalty (lite)** and **notifications** (order-ready, low-stock,
  day-end summary): agreed as low priority, after the above.
- **Online ordering with payment** unblocks when the merchant account lands —
  the Raast/EMVCo QR work is half-built and parked (`scripts/test_qr.mjs` and
  the `crc` dep are kept for it deliberately).

The rest of ROADMAP.md was the Supabase/Postgres design (SECURITY DEFINER
RPCs, RLS, jsonb backfills, pgTAP) — superseded by the MySQL migration, and
its phases P0–P5 are shipped. Read it from history if ever needed.

## Cleanup done (31 Aug, post-F–J)

- Deleted the retired Postgres layer `supabase/` (migrations/tests/seed —
  git history is the archive), `scripts/menu/` (legacy Supabase-Storage
  one-offs), `scripts/test_crc.js`, the stray `.env.local.bak-*`, and the
  `dotenv` devDependency (the scripts hand-roll .env loading).
  (The Blink benchmark docs that moved into `docs/` here were themselves
  deleted on 1 Sep — see below.)
- KEPT deliberately, still load-bearing until the production import runs on
  the server: `scripts/migrate-to-mysql/`, `src/lib/sanityMenu.js`,
  `@supabase/supabase-js`. Delete these in the post-cutover sweep.
- KEPT (not code): gitignored asset originals `menu-images/` (15M masters)
  and `social-media/` (37M) — they never ship and deleting originals is not
  reversible; remove by hand if you have them backed up elsewhere.
- Audit script taught that Next 16's `proxy.js` is framework-discovered
  (it was reporting it as an orphan).

## Docs pruned (1 Sep)

`docs/` is now three files, all of them live: this one, `deploy-cpanel.md`
(the runbook, not yet executed) and `kiosk-printing.md` (Windows/Chrome
silent printing — stack-independent and still exactly right).

Deleted, with git history as the archive:

- `ROADMAP.md` — the Supabase/Postgres phase plan. P0–P5 are shipped and its
  "current assessment" described an architecture that no longer exists. The
  owner-agreed scope worth keeping is in "Future scope" above.
- `CLEANUP-AUDIT.md` — a 28 Aug point-in-time report citing `supabaseDb.js`
  and a `supabase/` tree that are both gone. `/cleanup-audit` regenerates it.
- `blink-pos-architecture.md`, `blink-walkthrough-flows.md` and
  `blink-screens/` (10 PNGs, **5.8 MB** — the whole weight of `docs/`).
  Benchmark research against blinkco.io whose findings are distilled into the
  `pos-domain` skill and already shipped as phases F–J.

## Cleanup audit — 9 Sep 2026

Full sweep of the working tree (198 code files, ~54k lines) in
`docs/CLEANUP-AUDIT.md`. Suite 139/139, build green — but `npm run lint`
**exits 1 with 37 errors** and had never been run.

Ten defects found, listed at the top of that file.

**Five fixed the same day** (suite 139/139, build green): the chart's
`pattern="\d{5}"` and its subtitle, which printed the retired ChowPOS number
series at an accountant; `updateTaxSettings`'s missing `WHERE` and its
empty-box-means-0%, on both the client and the server; the till's `addToCart`
state mutation; and the discount reason dropped when a tab is opened. **The
till pair still want a manual pay-now / open-tab-and-round / settle pass —
there is no Playwright harness in this tree.**

**Day close: settled 9 Sep — manual only.** The owner's decision: the day closes
when someone presses the button, never on a schedule. Acted on the same day:
`src/lib/day/rollover.mjs` (the transitions extracted for a worker that was
never written) is gone, and with it `dueToClose` and eight tests that were
passing against logic the app did not run. The four date helpers survive as
`src/lib/day/karachi.mjs`, now imported by the day-close action and its screen
instead of being restated in three places — so those tests guard production.

The defect that hid behind the fork is fixed: the unpaid-bill gate asked for
every unpaid order ever taken, so one forgotten tab blocked every future close
permanently. It is now scoped to branch and business date, and read once inside
the close transaction under its `FOR UPDATE`, so the gate and the audit row's
`carried_orders` are the same list. Migration 014's `day_start_time` /
`day_end_time` are now formally a vestige — see `docs/cash-handling.md`.

Suite 131/131 (was 139), build green. **Still owed: a manual pass** — close a
day, and ring/settle a bill on the till — since the day-close verbs sit behind
`requirePermission` in a `'use server'` file and have no automated coverage.

## Cash drawer, and "Complete Order" — 11 Sep 2026

Migration `023_cash_drawer.sql` (dev+test applied). Suite 138/138, build green.

- [x] **The cash drawer opens on a completed sale.** A POS drawer has no cable
      to the computer: it hangs off the PRINTER's RJ11 socket and opens only on
      an ESC/POS pulse (`ESC p m t1 t2`, now `drawerKick()` in
      `src/lib/print/escpos.mjs`). So the whole decision lives in the print
      agent — `POST /drawer {orderId, force}` — which is the only process that
      knows this terminal's printer. New `store_settings.drawer_kick`
      ('cash' default | 'always' | 'never') and `drawer_pin` (2 default | 5),
      both on Settings → Kitchen & Printer. Under 'cash' the agent opens the
      drawer only when the bill's `payment_mode` is cash **or** any of its
      `payments` rows is cash (a split bill is still cash at the counter); a
      card or city-ledger bill leaves it shut. The till calls it after pay-now
      and after settle, NOT gated on `auto_print` — a jammed printer is no
      reason to unlock a till by hand — and skipped outright on a
      browser-printing terminal, which cannot carry a control code. A reprint
      never fires it, because the reprint paths do not ask.
      Verified against a file-backed agent, all four branches: cash→`1b 70 00
      19 fa`, card→shut ("paid by card"), 'never'→shut, 'always'+pin 5→
      `1b 70 01 19 fa`.
- [x] **"Settle Bill" is now "Complete Order"** on the till, the tabs drawer
      ("Complete order"), the receipt button ("Print & Complete Order") and the
      notices. Labels only — `settleOrder`, `receiptMode === 'settle'`, the
      `settle_order` verb and every error contract in `src/lib/db/orders.mjs`
      are untouched.
- [ ] **Owed: a hardware pass.** The pulse is proven byte-for-byte, but no real
      drawer has been attached yet. On the counter machine: plug the drawer into
      the printer, take one cash sale, and confirm it throws on Pin 2.

## Menu levelled against Blink — 11 Sep 2026

Read straight out of the Blink account (Items screen, 11 Sep) with a scripted
Chrome session, and diffed against this database. `scripts/menu/sync-blink-menu.mjs`
+ `blink-menu-sync.json` hold both the data and the replay, the same shape as
the recipe import beside them, because cutover will need it run again.

**Blink carries 222 items, and only 134 are the menu.** The other 88 are
deactivated `<dish> Half` / `<dish> Full` duplicates left over from an older
way of doing sizes; Blink now prices sizes as variations, which is what this
database already does. Diffing against all 222 would have invented 88 dishes.

- [x] **Ten dishes added** that the website import never carried: the cold
      drinks counter (Soft Drink (Can) 295, Mineral Water Small 175 / Large 315,
      Fresh Lime Sprite 345, Lassi Sweet & Salted 475, Perrier Small 1075 /
      Large 1695) and two raitas (Zeera, Mint — 190 each).
- [x] **Karak Chai repriced 415 → 560.** The 415 came from the website export;
      560 is what the restaurant rings on its own till. The script refuses to
      reprice anything that is not still at the price the diff saw.
- [x] **Menu now matches Blink exactly: 134 active dishes = 134 here**, and all
      **88 variant prices** across the 44 sized dishes verified line by line
      against Blink's own Half/Full rows. Zero price differences left.

- [x] **The duplicate `Channay` is archived** (owner: "jo Blink mein hai wo
      rakho"). Blink lists it once, under Subah Ka Nashta, and fills the
      Daal & Sabzi slot with `Daal Channa Fry`, which this menu also carries —
      so the Daal & Sabzi copy was an import duplicate. `is_archived = 1`,
      never a DELETE: order lines point at the row, and it had four of them.
      The script archives only the named category's copy, and only while a copy
      survives in the category Blink keeps it in.

**Parity, checked after the run: 134 active dishes in Blink, 134 live here,
every category count equal, and nothing on either side the other lacks.**

## The notice board — 11 Sep 2026

Migration `024_notifications.sql` (dev+test). Suite 138/138, build green.

A bell in the rail, on every screen, for the things the system already knows
are wrong and currently tells nobody: a receipt that did not print, a day left
open overnight, an FBR invoice the queue gave up on, a table unpaid for hours,
an ingredient under its reorder level. Deliberately NOT "an order was placed" —
the till shows orders, and a bell that rings for normal work stops being read.

- **Derived vs raised.** Four kinds are recomputed from live data on every read
  (`src/lib/notifications/scan.mjs`) and, crucially, RESOLVED when the
  condition stops being true — the list empties itself. `print_failed` is an
  event with no live condition, so it is dismissed by hand or swept at the end
  of its business day.
- **Scanned on read, not on a timer.** This app runs no worker by the owner's
  own decision (the day closes on a button). The route throttles the scan to
  once per 30s per process and collapses concurrent scans, so six terminals
  polling do not run six scans.
- **One row per dedupe key, and the index is on `dedupe_key` alone.** The first
  cut indexed `(dedupe_key, resolved_at)` to keep history; NULL never equals
  NULL in a MySQL index, so ON DUPLICATE KEY never fired and every scan
  inserted a fresh copy — caught by a two-scan test before it shipped. A key
  that clears and comes back reopens its row and un-reads it. What happened is
  `audit_log`'s job; the bell is what is wrong now.
- Notices carry a `permission`, so a cashier is never told the FBR queue is
  failing, and each links to the screen that can fix it.
- Verified against dev data: it found the 4 Sep business day still open and a
  41-hour unpaid tab; three scans left one row; settling the tab resolved it;
  re-staling it reopened it unread.

## Cash change at the counter — 11 Sep 2026

Migration `025_cash_change.sql` (dev+test). Suite **139/139** (new test 12),
build green. The first of the Blink gaps, and the one with the most daily use.

The checkout now asks what the customer handed over and answers with the
change: a big right-aligned box, quick-tender buttons for the notes people
actually hand over (exact, then the next 100/500/1000/5000 above the bill,
deduplicated), and a live "Change due" line. `orders.cash_received` and
`orders.change_due` store both halves, and both print on the receipt — the
customer's copy and the restaurant's.

- **The server does the arithmetic**, not the till: change is computed inside
  the settle transaction from the total it just recomputed, so a mistyped bill
  cannot hand out the wrong money.
- **A short tender is refused**, on both the pay-now and settle paths, and the
  print button is disabled behind it. Recording a shortfall as "no change"
  would leave the drawer short at close with nothing to explain it.
- **Card and city-ledger bills store neither column.** Zero there would be a
  claim about money that never crossed the counter, so both stay NULL and the
  receipt prints neither line.
- Switched by `store_settings.cash_change` (Settings → General), on by default.

## The Blink gap list, built — 11 Sep 2026

Migrations 025–031 (dev+test). Suite **143/143**, build green. Everything the
owner picked off the gap list below, in the order he picked it.

- **Cash change** (025) — the checkout asks what was handed over, the server
  works out the change inside the settle transaction, both halves print, a
  short tender is refused. Card and city-ledger store neither column.
- **Kitchen notes + KOT QR** (026) — the column and the slip already existed;
  there was no way to type one. The QR ships OFF: a centimetre of roll per
  ticket earns nothing until somebody scans them.
- **Card reference** (027) — the terminal slip's number, on the PAYMENT (a bill
  could one day be settled across two cards), printed on both copies,
  compulsory only if the store says so.
- **Customers** — a screen over the table the till has filled since day one.
  Phone search compares digits to digits. Read-only: the row is written by the
  sale.
- **Purchase orders** (028) — what was ordered, at what price, for when.
  Receiving goes through the same kernel verb as every delivery, with the
  order's id attached; the verb closes it. Status moves one way.
- **Sub-recipes** (029) — an ingredient made of ingredients, as a PHANTOM:
  never held, never counted, exploded on consumption. Its cost is cached onto
  its own `avg_cost` so every screen that already prices a recipe is right
  without being taught anything.
- **Deals** (030) — a set of dishes for one price. Ringing one puts the dishes
  on the bill at menu price and the difference into the order's discount, so
  the kitchen gets real tickets, the stock room consumes real recipes, and the
  money math needs no new concept. The saving is computed live, never stored.
- **Collations aligned** (031) — four tables added that day were written
  utf8mb4_unicode_ci out of habit against a 0900_ai_ci schema. Harmless while
  every foreign key was over BIGINT; it surfaced the moment `deals` tried to
  point at `menu_items`, and was straightened while the tables were empty.

The last four followed the same day (migrations 032–035), and **all four ship
OFF** so nothing that worked before changes until somebody asks:

- **Waste** (032) — food cooked and then binned, recorded in DISHES (what the
  person over the bin knows) and exploded through the recipe as a sale is.
  Neither a sale nor a void; the ledger row says 'waste'; the reason is
  compulsory. Entirely additive.
- **Tokens** (033) — a short number for takeaway and delivery, restarted daily,
  minted when the order is rung (that is when the customer is handed it),
  double-size on the receipt and on the KDS. Dine-in excluded: it has a table.
- **Stock gate** (034) — 'off' | 'flag' | 'hide'. The safety rule is about
  ABSENCE, not zero: an ingredient with no stock movements at all is untracked
  and can never close a dish. Without it, "we have not started counting flour"
  and "we are out of flour" would be the same sentence in a restaurant that has
  not opened.
- **Rounding** (035) — always DOWN, never up: rounding up charges money the
  bill did not say was owed. Computed last, after tax, so nothing is circular,
  and posted to Discounts Allowed — which is both what it is and what keeps the
  sale journal balanced (total + discount + rounding = revenue + charges + tax,
  asserted in test 20). The server reads the step itself rather than trusting
  the till; if the two disagreed the expected-total check would refuse the sale.

**Verified after the lot**: suite 147/147, build green, all 30 screens rendered
under a real admin session with no runtime errors, `/api/menu` unchanged in
shape bar its new fields, zero unbalanced journals, and every new setting
reading off in the dev database.

## The cost side of the books — 11 Sep 2026

Migration 036. Suite **148/148**, build green. The real accounting gap, and it
was the whole cost half of the ledger.

Receiving booked Dr Inventory / Cr Supplier, and **nothing ever took it back
out**. A sold dish moved its ingredients on the stock ledger and left the
general ledger untouched, so the books showed revenue with no cost of sales, a
gross margin of one hundred per cent, and an inventory balance that only ever
climbed. Waste, spoilage and count variances were invisible the same way. The
Gross Profit *report* was right all along — it costs recipes directly — but the
ledger the accountant reads was not.

`src/lib/accounts/stockPost.mjs` now books four events, all of them Cr
Inventory:

| event | entry |
|---|---|
| sale | Dr Cost of Sales (5000) |
| void | the mirror — cost comes back out with the stock |
| dish waste | Dr Inventory Variance and Wastage (5099) |
| misc consumption, adjustment, count | Dr 5099, or Cr it when a count finds stock |

- **Valued at `avg_cost` at posting time**, moments after the movement — the
  same number the Gross Profit report and the stock valuation already use, so
  the three agree with each other. Not period costing, and it does not pretend
  to be.
- **A transfer is deliberately not booked**: both warehouses sit in the same
  inventory account, so the journal would be a line against itself.
- Idempotent on `(source_type, source_id)`, gated on `gl_settings`, and
  fire-and-forget like every other poster: a ledger fault must never un-sell a
  dish or un-bin a dropped plate.
- Waste lands on **5099**, not 5097 Wastage, because 5097 is switched OFF in
  this chart and the resolver only returns active accounts. Migration 036 gives
  5097 the `WASTAGE` link code anyway, so the day somebody activates it, waste
  moves there by itself.
- **Posting Health gained two checks** — sales whose cost never reached the
  ledger, and waste documents with no journal. Listed rather than repostable:
  both hooks are idempotent and fire on their own, so a row there means the
  posting *failed* (an unmapped account, usually) and a button would fail the
  same way until the chart is fixed.

## A photo of the bill, on the expense — 14 Sep 2026

Migration 042. Suite 151/151, build green, driven through the real screen.

An expense is a line that says money left the drawer. The paper that proves it
— the mandi slip, the diesel receipt, the plumber's chit — lives in a shoebox,
and by the time anybody asks, it is gone. The form now takes a photo, and on a
phone `capture="environment"` opens the camera straight from the counter, which
is the only moment that slip is ever in somebody's hand.

- Uploaded the instant it is picked, not on submit, so a slow phone upload
  cannot hold the voucher hostage and a failed one is a message beside the
  button rather than a lost entry.
- Optional, and said to be: most vouchers are a line in a book, and demanding a
  photo for every one is how people stop entering the small ones at all.
- Stored as a path this app serves through the route the Menu and Brand screens
  already use, which now admits the `expenses` right alongside `menu` and
  `settings` — it is the same act in all three.
- The list shows a paperclip beside the description rather than a thumbnail:
  that column is for reading descriptions, and forty little pictures would bury
  them.

Verified in a browser: picked a file, watched it preview, recorded the expense,
and confirmed the row stored the path, that the image fetches, and that the
paperclip appears. Several documents against one purchase still belong on the
expense VOUCHER side of the accounts, which is built for that.

## Branches, part one — 14 Sep 2026

Migration 041. Suite **151/151**, build green. The spine is in; the scoping is
half done, and the half that is missing is named below rather than glossed.

**Done**

- **Schema.** `branches` gains code/address/phone/active; `users.branch_id`
  (NULL = every branch, which is how an owner and an accountant see the
  company); printers move to one-per-role-**per-branch**; and
  `branch_menu_items` holds only the DIFFERENCES — a dish off at one outlet, or
  priced differently there. No row means the menu's own answer, so a dish
  priced once cannot drift branch by branch. That is the owner's own
  requirement: same menu, not everything everywhere, sometimes not at the same
  price.
- **One rule** for which branch a request is (`src/lib/db/branch.mjs`): tied to
  a branch → that branch, no switching; tied to none → the branch last picked,
  in a cookie; neither → the lowest active branch, which on one outlet is
  invisible. The cookie is a preference and never a permission: checked against
  the table every time, ignored for anyone tied to a branch.
- **The kernel does not decide it.** Which outlet a sale belongs to is a fact
  about the request; `orders.mjs` knows nothing about requests, which is what
  lets the suite drive it. The action layer resolves and passes it in.
- **Scoped:** open tabs, the kitchen board, the version poll, the unpaid count,
  the Orders screen (branch first and unconditional), Day Close, the Drawer,
  and the menu read — which now applies the per-branch price and availability
  in SQL, so the till needs to know nothing about branches at all. A branch can
  switch a dish off; it cannot switch on what the company switched off.

**Not done, and why a second branch must not be created yet**

Twenty-five queries still carry the literal `branch_id = 1`: the reports, the
"which day is open" lookup that a dozen screens share, the ledger poster and
the notice board. They are filtered — just to the constant. Until each takes
the resolved branch, a second outlet would read the first one's numbers on
those screens.

So there is deliberately **no Branches screen**: nothing in the app can create
a second branch, which means the unsafe state is unreachable rather than merely
undocumented. The remaining work, in order: parameterise those 25, add the
branch switcher to the rail, then the Branches CRUD, then per-branch menu
overrides on the Menu screen.

## White label: the brand is data now — 14 Sep 2026

Migrations 039 and 040. Suite 150/150, build green, proven by repainting the
whole app as another restaurant and putting it back.

The name, the logos and the colour were written into the source: fourteen
files, four assets and a stylesheet. Handing this POS to another restaurant
meant editing all of them, which is a fork per customer rather than a product.

- **One vhost and one database per restaurant** (the deploy runbook's model), so
  a deployment IS a brand. No tenant column anywhere, and there should not be:
  isolation comes from the database being its own, which beats any WHERE clause.
- **Settings → Brand**: name, two logos (uploaded through the existing image
  route, which now accepts the `settings` right as well as `menu`), and **one
  colour**.
- **One colour, because four would be a trap.** These accents are read as text
  AND used as fills, in two themes: #F26513 is 3.11:1 as text on white, and a
  colour dark enough for white text is mud on black. So the screen takes the
  brand's colour and derives the rest — the light theme gets a darker version
  of the same hue until it clears AA on a card, and the label is white or
  near-black by measurement. The screen shows the real ratios, not a swatch.
  White is preferred wherever it clears 3:1, so this restaurant's own
  white-on-orange buttons are unchanged.
- Blank colour renders no CSS at all, leaving globals.css exactly as written.
- `zero` hardcoded mentions of the brand remain in `src`.

Verified in a browser: default orange and the Flames name; then one row changed
to "Bartlett Coffee" / #1e88e5 and the app repainted, tab title and login
included; then #ffe600, where the label flipped to near-black by itself.

## Any thermal printer, set up on a screen — 14 Sep 2026

Migration 038. Suite **150/150**, build green, proven end to end against a
file-backed printer and the real agent.

**What was wrong.** A printer was named in the launchd plist that starts the
agent (`--queue PrinterCMD_ESCPO_POS80_Printer_USB`). So every machine was set
up at a shell prompt, and the day a printer is replaced — or its cable moves to
another USB port, which makes macOS rename the queue — the till silently stops
printing until somebody edits a file. And "ESC/POS" is a family, not a
standard: cheap units cut with `GS V 1` or have no cutter, take a different
drawer pin, need a code page before Latin text renders, and differ by
centimetres in the head-to-cutter gap.

**How it works now.**

- The agent is started with **what it is for** — `--role receipt` or
  `--role kitchen` — and looks the printer up in the new `printers` table.
  `install-agent-service.sh` takes no printer name at all, and installs one
  launchd job per role so the KDS machine's agent cannot replace the till's.
- **Settings → Kitchen & Printer** now opens with *Printers on this terminal*:
  the list comes from the agent on the machine you are sitting at (only it can
  know), and each role gets a printer, a width, a cutter mode, a feed-before-cut
  and a drawer pin. Save it and **the next bill prints on it with nothing
  restarted** — the agent resolves per print, not at boot.
- **A fresh machine prints before anybody opens Settings**: with nothing
  configured, the agent picks the single obvious thermal printer it can see.
  One candidate is a guess worth making; two is not, and then the screen asks.
- **Test print** puts a page out that names the printer, how it was reached,
  the width in characters, the cut mode and the drawer pin — so a wrong setting
  reads as a wrong setting rather than as a mystery.
- `PRINTER_QUEUE` in `.env.local` is now **ignored** (noted once in the log).
  Leaving it as an override would have been the same trap in a new coat: the
  Settings screen would look broken while being right. `--queue` on the command
  line still wins, for debugging.

The store-wide paper width and drawer pin remain as fallbacks for a terminal
whose printer has not been set up yet, and say so on the screen.

## Ingredients and recipes, made simpler — 14 Sep 2026

Suite 149/149, build green, the whole flow driven in a real browser.

The owner's words were that this side felt heavy. Four things were making it so,
and none of them was the idea — it was the number of screens the idea was spread
across:

- **You could not add an ingredient while writing a recipe.** Meeting one the
  menu had never named happens roughly once a dish, and the answer was: leave,
  go to Ingredients, add it, come back, find the dish, find the line. A hundred
  and twenty-five times. The picker now ends in **＋ New ingredient…**, which
  opens a three-field row in place and drops the result straight into the line
  that asked. The rate is optional there on purpose — receiving sets the real
  one, and stopping to ask "what does a kilo cost" is the interruption this
  removes.
- **Two doors made an ingredient, and one of them was a trap.** Inventory →
  Masters → Items wrote the same table but could not set a rate, so anything
  born there was silently uncosted and every recipe using it priced at zero.
  Items is now the stock view it was always good at — on hand, reorder, cost —
  and both its Add and its per-row Edit point at Menu → Ingredients, the one
  screen that does the whole job.
- **The ingredient form asked six things.** An ingredient is a name, a unit and
  a rate; category, reorder level and the active switch are real but rarely
  touched, so they fold away behind **More** — and open by themselves when the
  ingredient in hand actually uses one, because an edit must never hide a value
  that is already set.
- **Sub-recipes read as a third concept.** They are not: "this one is made here
  rather than bought" is a fact about an ingredient. The Ingredients list now
  says which ones are, and links straight into that ingredient's sub-recipe —
  `/menu/sub-recipes?item=<id>` opens it whether one exists yet or not.

Nothing was removed and no verb changed: the same screens, the same data, fewer
trips between them.

## Channels, order management, PDF and a rail you can navigate — 11 Sep 2026

Migration 037. Suite **149/149**, build green, every touched screen rendered
under a real session.

- **Sales channels.** `sales_channels` + `orders.channel_id`. The till shows a
  picker only once there is more than one channel (until the restaurant lists
  somewhere, every bill is a walk-in and a one-option picker is furniture), the
  Orders screen filters on it, and the detail panel names it. A new order that
  names no channel takes the DEFAULT rather than NULL; bills that predate the
  column stay NULL, because nobody asked them. Settings → Sales Channels adds
  Foodpanda and friends; a channel with orders against it is switched off, not
  deleted. **Commission and the aggregator receivable are deliberately not
  built** — that is a receivable, a settlement and a deduction, i.e. the shape
  City Ledger already has, and a commission column nobody posts is a number
  that lies on a report.
- **Order management.** Two filters that reconciliation actually asks for —
  payment method and channel — plus, next to the row count, **what the current
  filter adds up to across every page of it**, voids excluded, with the unpaid
  share called out.
- **PDF.** Four of the six reports could not print at all; Handover and
  Item-wise each had their own copy of the print CSS. There is now one
  `PrintButton` and one `.print-root` block in globals.css, and Daily Sales,
  Hourly, Gross Profit, Menu Analytics and Orders all carry it. It is
  `window.print()` on purpose: every browser saves a PDF, the output is real
  searchable text rather than a picture of a table, and it adds no library to a
  till that ships to a shared cPanel box.
- **Navigation.** The rail now grows where you are — see the commit; forty-odd
  screens were reachable only by Ctrl-K or a hub tile.

## Day close, checked against ChowPOS — 11 Sep 2026

Nothing to take. The Bartlett's account exposes only POS, KDS and All Orders;
there is no day-close screen in it to compare against, and this app's day close
came out of the earlier ChowPOS walkthrough in the first place (phases F–J).

What it has now, for the record: a cash gate (an open drawer blocks the close,
with a `force` override that is audited), an unpaid-bill gate scoped to branch
and business date and read inside the close transaction, a `FOR UPDATE` lock so
two people pressing Close produce one close, and a guard against closing a day
that has not happened yet. Its settings are `default_opening_float`,
`cash_variance_tolerance`, the cash policy (017) and drawer carry-forward
(015). Migration 014's `day_start_time` / `day_end_time` remain a vestige — the
owner's decision is that the day closes on the button, never on a schedule.

One thing ChowPOS's till does have that this one does not: **a channel picker**
on the order (BART / Foodpanda), which tags where an order came from. Worth
having the day third-party orders start arriving — it is the same idea as the
named payment methods noted below.

## Two ideas worth stealing from ChowPOS (rms.roomy.pk) — 11 Sep 2026

The Bartlett's account exposes only POS, KDS and All Orders — no back office —
so there was little to learn beyond the till itself, which the earlier
walkthrough had already mined for phases F–J. Two things on that till are worth
having:

- **Delivery charge as a per-order field**, not a fixed charge row. Distance
  varies; this restaurant's Rs. 150 is a placeholder that a cashier currently
  cannot adjust.
- **Named payment methods** — its dropdown reads "Credit Card (UBL)", not
  "Card". Tagging a card sale with the acquiring bank or terminal pairs exactly
  with the card reference added today and would make a card batch reconcilable
  without opening a single bill.

Its checkout button, for what it is worth, says **Complete Sale**.

## Where Blink is still ahead — 11 Sep 2026

Read off Blink's Master Settings and sidebar the same session. Worth building,
roughly in order: **cash-change calculation at checkout** (type cash received,
show change — Blink has it on, this till has nothing), **token numbers** for
counter orders, **waste with a reason** (distinct from a void — it moves
stock), **hide/flag items at zero stock** on the till, **grand-total rounding**,
then deals/combos, a customer screen over the `customers` table already being
filled, sub-recipes (a masala batch used by twenty dishes), purchase orders
ahead of receiving, and a card reference number for reconciliation.

Not worth building for one restaurant: everything multi-branch (branch-wise
toggle, transfer/stock requests, warehouse stock, air inventory, branch
devices, marketplace, rider management, BI report).

**SUPERSEDED on 14 Sep 2026** for the branch half of that list — Adnan asked
for branches and white label together, so the spine is now built and live. See
"Branches, per-branch settings and yield" below. Transfer/stock requests
between outlets remain unbuilt and remain the right call until there is a
second kitchen actually asking for stock.

Going the other way, this app already carries what Blink's screens do not show:
double-entry accounting with journals, FBR Digital Invoicing, and day close +
handover.

## Known cautions

- Old MariaDB datadir preserved at
  `/opt/homebrew/var/mysql.mariadb-bak-20260831` (don't delete blindly).
- `.env.local` holds dev DB creds + SESSION_SECRET; never commit env files.
- Supabase project stays alive (read-only source) until cutover archive.
- The plan of record: `/Users/adnanmalik/.claude/plans/jaunty-fluttering-quokka.md`
  (machine-local); session memory in
  `~/.claude/projects/-Users-adnanmalik-Flames-by-the-Indus-POS/memory/`.


## Branches, per-branch settings and yield (14 Sep 2026)

Built after a walk through Blink's `/branch`, `/branch_settings` and
`/branch_ingredient_warehouse` at Adnan's request.

**The branch spine.** `branch_id` was already on fifteen tables, all writing 1.
`src/lib/db/branch.mjs` turns that constant into an answer: a user tied to a
branch works there and cannot switch; one tied to none works at the branch a
cookie remembers; failing both, the lowest active branch. The cookie is a
preference, re-validated against the table on every read, never a permission.

Two refactors made the reads safe rather than threading a parameter through
forty screens:

- `src/lib/day/openDay.mjs` — twenty-four copies of "which day is open"
  collapsed into one that resolves the branch itself.
- `src/lib/db/audit.mjs` — ten copies of the audit INSERT, every one writing
  `branch_id` as 1. A mis-filed audit row is worse than a missing one.

**Zero literal `branch_id = 1` remain in `src`.** Keep it that way; grep is
the check.

**Per-branch settings are DIFFERENCES, not copies.** `branch_settings` has one
nullable column per overridable field and NULL means "the company's answer", so
an outlet that agrees with everything has no row and raising the company's GST
still reaches it. This is deliberately unlike Blink, which writes all twenty-five
fields to every branch and lets them drift.

What is per branch: tax rate and authority (FBR / PRA / SRB / KPRA / BRA — a
Lahore outlet genuinely answers to a different body at a different rate), the
outlet's own FBR POS registration, bill address and footer, trading hours,
till float and variance tolerance. What is not, and must stay in
`store_settings`: brand, KOT split, drawer, tokens, rounding.

The merge tests `== null`, never falsiness. A branch exempt from sales tax sets
0, and `||` would read that as unset and charge it 16%. There is a test for
that line alone.

**FBR tokens are NOT in the table** — credentials stay server-env only, per the
project rule. A second outlet supplies `FBR_TOKEN_<branch id>`.

**Yield %** on `inventory_items`, default 100. The recipe stays written in what
the chef plates; yield is the bridge to what the shelf gave up. The division
happens ONCE, at the leaf of `expandToRaw`, which is the only thing anybody
ever bought — cost follows for free because cost is computed off the quantity.
A phantom is never divided. Refused outside 1-100 at the form and defended
again at the divisor, so a 0 cannot empty the store.

Ingredients also gained stock value, 28-day average daily consumption (divided
by days that actually traded, not by the calendar) and days of cover.

**Screens**: Settings → Branches (list + editor, every override box empty by
default with the company's answer as its placeholder), and a rail switcher that
draws nothing at all on a single-outlet restaurant.

**Still unbuilt from that walk**, in the order worth doing: per-branch menu
availability and price on the Menu screen (`branch_menu_items` already carries
it and `getMenuItems` already applies it — only the UI is missing), inclusive
tax, dine-in guest count, mandatory table/waiter, and warehouse-to-branch stock
requests.

Verified: 160 tests, build green, twenty-two screens loaded in a real browser
with a clean console, and a live two-branch proof — the same Rs 1,000 bill
taxed 15% at Islamabad and 5% at Lahore in the same run.

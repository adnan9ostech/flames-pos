# Project status — living document

> Update this file whenever meaningful work lands. A fresh Claude session (or
> a human) should be able to read this top to bottom and know exactly where
> things stand. Last update: **31 Aug 2026, late night** (branch
> `mysql-migration`, repo `adnan9ostech/flames-pos`).

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
  (17 tests incl. concurrency races — keep green).
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
- [x] GitHub: authed as adnan9ostech; main + mysql-migration pushed
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
- Dev accounts (password `flames1234`): adnan/manager/cashier/frontdesk/
  kitchen/accountant. Old shared `staff` row suspended; `admin` still exists
  with the old PIN as its password and must_change_password set.

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
   scripts/migrate-to-mysql; run `/cleanup-audit`
7. Confirm with accountant: FBR posture for tax-off orders and BTC
   (city-ledger) invoices

## Cleanup done (31 Aug, post-F–J)

- Deleted the retired Postgres layer `supabase/` (migrations/tests/seed —
  git history is the archive), `scripts/menu/` (legacy Supabase-Storage
  one-offs), `scripts/test_crc.js`, the stray `.env.local.bak-*`, and the
  `dotenv` devDependency (the scripts hand-roll .env loading).
  `blink-pos-architecture.md` moved into `docs/`.
- KEPT deliberately, still load-bearing until the production import runs on
  the server: `scripts/migrate-to-mysql/`, `src/lib/sanityMenu.js`,
  `@supabase/supabase-js`. Delete these in the post-cutover sweep.
- KEPT (not code): gitignored asset originals `menu-images/` (15M masters)
  and `social-media/` (37M) — they never ship and deleting originals is not
  reversible; remove by hand if you have them backed up elsewhere.
- `docs/CLEANUP-AUDIT.md` still describes the Supabase-era architecture —
  regenerate it with `/cleanup-audit` after cutover rather than trusting it.
- Audit script taught that Next 16's `proxy.js` is framework-discovered
  (it was reporting it as an orphan).

## Known cautions

- Old MariaDB datadir preserved at
  `/opt/homebrew/var/mysql.mariadb-bak-20260831` (don't delete blindly).
- `.env.local` holds dev DB creds + SESSION_SECRET; never commit env files.
- Supabase project stays alive (read-only source) until cutover archive.
- The plan of record: `/Users/adnanmalik/.claude/plans/jaunty-fluttering-quokka.md`
  (machine-local); session memory in
  `~/.claude/projects/-Users-adnanmalik-Flames-by-the-Indus-POS/memory/`.

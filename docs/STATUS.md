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

## In progress RIGHT NOW

- (nothing — F–J fully integrated; next step is Adnan's acceptance pass,
  see Pending)

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

## Known cautions

- Old MariaDB datadir preserved at
  `/opt/homebrew/var/mysql.mariadb-bak-20260831` (don't delete blindly).
- `.env.local` holds dev DB creds + SESSION_SECRET; never commit env files.
- Supabase project stays alive (read-only source) until cutover archive.
- The plan of record: `/Users/adnanmalik/.claude/plans/jaunty-fluttering-quokka.md`
  (machine-local); session memory in
  `~/.claude/projects/-Users-adnanmalik-Flames-by-the-Indus-POS/memory/`.

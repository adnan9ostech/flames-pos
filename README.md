# Flames by the Indus — POS

Point of sale for the restaurant: the till (`/pos`), kitchen display (`/kds`),
orders and reports, settings, and a public customer menu (`/customer`).

## Stack

- **Next.js 16** (App Router), plain JavaScript — no TypeScript — with CSS
  Modules
- **MySQL 8** via `mysql2`; the pool, serializers and order verbs live in
  `src/lib/db/` (`.mjs` so plain Node scripts and workers import them too)
- **Signed-cookie sessions** with PIN login (`src/lib/auth/session.mjs`,
  `src/lib/db/auth.mjs`) — no external auth service
- All money math in one shared module: `src/lib/orderTotals.mjs`

## Local development

### 1. MySQL 8

```bash
brew install mysql@8.0
brew services start mysql@8.0
mysql -u root -e "CREATE DATABASE flames_pos_dev; CREATE DATABASE flames_pos_test;"
```

MySQL must be **8.0.16 or newer** — the migrator refuses older versions
because CHECK constraints have to be enforced.

### 2. Environment

Create `.env.local` in the repo root:

```ini
DB_NAME=flames_pos_dev
DB_USER=root
DB_PASSWORD=
DB_HOST=127.0.0.1
DB_PORT=3306
SESSION_SECRET=<openssl rand -hex 32>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

All variables:

| Variable | Required | What it is |
|---|---|---|
| `DB_NAME` | yes | Database to use (`flames_pos_dev` locally) |
| `DB_USER` | yes | MySQL user (`root` locally) |
| `DB_PASSWORD` | yes | MySQL password (empty locally) |
| `DB_HOST` / `DB_PORT` | TCP only | `127.0.0.1` / `3306` locally |
| `DB_SOCKET` | socket only | Unix socket path; replaces host/port (production uses this) |
| `SESSION_SECRET` | yes | 32+ random bytes for session signing — `openssl rand -hex 32` |
| `NEXT_PUBLIC_SITE_URL` | yes | Public origin; **bakes into the client bundle at build time** |
| `FBR_ENABLED` | for FBR | `true` to queue fiscal invoices |
| `FBR_MODE` | for FBR | `sandbox` or `production` |
| `FBR_BPOSID` | for FBR | POS registration id issued by FBR |
| `FBR_TOKEN` | for FBR | API bearer token issued by FBR |
| `FBR_SELLER_NTN` | for FBR | Business NTN on the invoice |
| `FBR_SALE_TYPE` | for FBR | FBR sale-type code |
| `FBR_HS_CODE` | for FBR | HS code reported per line |
| `FBR_UOM` | for FBR | Unit of measure reported per line |

### 3. Schema, then run

```bash
node scripts/db/migrate.mjs      # applies mysql/migrations/*.sql in order
npm run dev
```

`node scripts/db/migrate.mjs --status` lists applied vs pending migrations.
Open [http://localhost:3000](http://localhost:3000) and log in with a PIN.

## Deployment

Production runs on a shared cPanel box behind Apache, managed by PM2 —
**not** on Vercel. The full first-time runbook, and the one-command update
path (`deploy.sh`), are in [`docs/deploy-cpanel.md`](docs/deploy-cpanel.md).

## Other docs

- [`docs/deploy-cpanel.md`](docs/deploy-cpanel.md) — production runbook
- [`docs/kiosk-printing.md`](docs/kiosk-printing.md) — silent receipt
  printing on the till machines (Windows + Chrome)

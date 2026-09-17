# Getting the menu onto a new install

**18 Sep 2026.** `node scripts/db/migrate.mjs` builds the schema. It does not
build a menu, and until today nothing did — a first deploy would have opened
with 66 empty tables and somebody retyping 135 dishes, 125 recipes and 1,371
recipe lines by hand. `scripts/db/export-master.mjs` closes that gap.

## What the migrations give you on their own

52 migrations, 66 tables, and the reference rows a POS cannot boot without:
one branch, the units, two warehouses, the service charge, 68 chart-of-accounts
rows, the expense codes, the variation sets, a sales channel and a printer.

Enough to start the app. Nothing to sell.

## What the export carries

```
DB_NAME=flames_pos_dev node scripts/db/export-master.mjs
```

Writes `mysql/master-data.sql` — 30 tables, ~2,000 rows, about 180 KB. The menu
and its prices and sizes, the categories, the recipes and their lines, the
ingredients, the suppliers, the customers, the dining tables, the waiters, the
charges, the printers, the chart of accounts as edited, and the store settings.

**It is not committed** (`.gitignore`): it holds customer names, and a snapshot
in git would rot the first time somebody edits a price. Generate it when you
need it.

## What it deliberately leaves behind

This is the half that matters more.

| Left behind | Why |
|---|---|
| 30 transaction tables | Dev holds 56 test bills, 53 test payments and 279 test journal lines. Carried across, the first live P&L, the first sales report and the ledger itself would contain money that was never taken. **A new install's books start empty or they are not books.** |
| 4 counter tables | So the first real bill is invoice 1 and token 1, not 57. Both rows self-create on first use, so leaving them out is safe as well as correct — and an FBR sequence starting mid-count is a conversation nobody wants. |
| `users` | Dev passwords are known. A fresh install seeds its own admin, flagged to change it at first sign-in. |
| `schema_migrations` | Belongs to the migrator, which will disagree with a copied one. |

Every one of the 66 tables is classified in `scripts/db/master-tables.mjs`, and
a test asserts it: add a table without classifying it and the export refuses
and names it, rather than silently leaving a restaurant's data behind.

## The order on the new box

```
# 1. schema first, always
node scripts/db/migrate.mjs

# 2. the menu and everything behind it
mysql -u ostech_flamespos -p ostech_flamespos < master-data.sql

# 3. one admin, flagged to change its password
SEED_ADMIN_PASSWORD='<choose one>' node scripts/db/seed-users.mjs
```

Getting the file there: `scp` on Method 1, or cPanel's File Manager plus
phpMyAdmin's Import tab on Method 2 — which needs no SSH at all.

**Menu photos need no copying.** All 125 dishes that use one point at
`public/menu-images/`, which is committed, so `git clone` carries them. Only
photos uploaded later from the Menu screen live in `UPLOAD_DIR`, outside the
git tree; the export script counts both and tells you if any fall in the second
group.

## The collation trap — read this before creating the database

The migrations are written against MySQL 8's own default,
**`utf8mb4_0900_ai_ci`**, and several compare a literal against a column.
Create the database with anything else — cPanel's dropdown offers several, and
`utf8mb4_unicode_ci` is a common pick — and migration 009 dies on *"Illegal mix
of collations"* with eight migrations already applied and implicitly committed.
That half-applied state is the worst outcome available on a first deploy.

`migrate.mjs` now checks this **before applying anything** and refuses while
the database is still empty, printing the one-line fix:

```
ALTER DATABASE `ostech_flamespos` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

Once migrations have run it warns instead of refusing — by then the tables
carry their own collations, an `ALTER DATABASE` would not retrofit them, and
blocking a routine update over it would do more harm than the warning.

## Verified end to end, 18 Sep 2026

On a database created from nothing:

1. Wrong collation, empty database → **refused, 0 tables created.**
2. `ALTER DATABASE` as printed → all **52 migrations applied.**
3. `master-data.sql` loaded → **135 dishes, 20 categories, 125 recipes, 1,371
   recipe lines, 167 ingredients, 98 accounts, 12 customers.**
4. And the books: **0 orders, 0 payments, 0 journal lines, 0 stock ledger rows,
   0 audit log rows, 0 counters, 0 users.**

Which is exactly what a restaurant's first day should look like.

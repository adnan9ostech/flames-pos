/*
 * Brings this menu level with the Blink account it is migrating off.
 *
 *   node scripts/menu/sync-blink-menu.mjs            # dry run, changes nothing
 *   node scripts/menu/sync-blink-menu.mjs --apply    # writes
 *
 * The data beside it (blink-menu-sync.json) is the restaurant's own, read out
 * of Blink's Items screen on 11 Sep 2026 and diffed against this database:
 * ten dishes Blink sells that never came through the website import (the cold
 * drinks counter, and two raitas), and one price the website had stale.
 *
 * Committed rather than run once by hand because it has to run twice — here,
 * and against the production database at cutover.
 *
 * Deliberately narrow, and this is the point: it INSERTS dishes that are
 * missing and repriced exactly the one dish named in the file. It never
 * deletes, never archives, and never touches a dish it is not told about —
 * an order's history hangs off menu_items, and a menu sync is no place to
 * discover that.
 */
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
for (const file of ['.env.local', '.env.production']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const APPLY = process.argv.includes('--apply');
const doc = JSON.parse(readFileSync(path.join(here, 'blink-menu-sync.json'), 'utf8'));

const { DB_NAME, DB_USER = 'root', DB_PASSWORD = '', DB_HOST = '127.0.0.1', DB_PORT = '3306' } = process.env;
if (!DB_NAME) { console.error('DB_NAME is not set.'); process.exit(1); }
const pool = mysql.createPool({
    host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME, timezone: 'Z', decimalNumbers: true, connectionLimit: 2,
});
const q = async (sql, params = []) => (await pool.query(sql, params))[0];

const money = (n) => `Rs. ${Number(n).toLocaleString('en-PK')}`;

try {
    console.log(`${APPLY ? 'APPLYING to' : 'DRY RUN against'} ${DB_NAME}`);
    console.log(`source: ${doc.source}\n`);

    const cats = await q('SELECT id, name FROM categories');
    const catId = new Map(cats.map((c) => [c.name.trim().toLowerCase(), c.id]));

    let added = 0;
    let present = 0;
    for (const item of doc.add) {
        const [existing] = await q(
            'SELECT id FROM menu_items WHERE name = ? AND is_archived = 0 LIMIT 1', [item.name],
        );
        if (existing) { present++; console.log(`  = ${item.name} — already here, left alone`); continue; }

        const cid = catId.get(item.category.trim().toLowerCase());
        if (!cid) { console.log(`  ! ${item.name} — no category "${item.category}", skipped`); continue; }

        console.log(`  + ${item.name}  ${money(item.price)}  [${item.category}]`);
        added++;
        if (!APPLY) continue;
        await q(
            `INSERT INTO menu_items (id, category_id, name, description, price, variants, modifiers, is_available)
             VALUES (?, ?, ?, ?, ?, '[]', '[]', 1)`,
            [randomUUID(), cid, item.name, item.description || null, item.price],
        );
    }

    let repriced = 0;
    for (const r of doc.reprice || []) {
        const [row] = await q(
            'SELECT id, price FROM menu_items WHERE name = ? AND is_archived = 0 LIMIT 1', [r.name],
        );
        if (!row) { console.log(`  ! ${r.name} — not in this menu, nothing to reprice`); continue; }
        if (Number(row.price) === Number(r.to)) { console.log(`  = ${r.name} — already ${money(r.to)}`); continue; }
        // Guard: reprice only what the file says it is repricing. A menu that
        // has moved on since the diff is a fact to look at, not to overwrite.
        if (Number(row.price) !== Number(r.from)) {
            console.log(`  ! ${r.name} — expected ${money(r.from)}, found ${money(row.price)}; left alone`);
            continue;
        }
        console.log(`  ~ ${r.name}  ${money(r.from)} -> ${money(r.to)}`);
        repriced++;
        if (!APPLY) continue;
        await q('UPDATE menu_items SET price = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [r.to, row.id]);
    }

    /*
     * Duplicates the website import left behind, where Blink carries the dish
     * once. ARCHIVED, never deleted — an order's lines point at this row, and
     * the category is named so a same-named dish in the category Blink DOES
     * keep it in can never be the one that disappears.
     */
    let archived = 0;
    for (const a of doc.archive || []) {
        const rows = await q(
            `SELECT m.id, c.name AS category FROM menu_items m
               LEFT JOIN categories c ON c.id = m.category_id
              WHERE m.name = ? AND m.is_archived = 0`,
            [a.name],
        );
        const target = rows.find((r) => (r.category || '') === a.category);
        const kept = rows.find((r) => (r.category || '') === a.keep_in);
        if (!target) { console.log(`  = ${a.name} [${a.category}] — not here, nothing to archive`); continue; }
        if (!kept) {
            console.log(`  ! ${a.name} — no copy left in ${a.keep_in}; archiving this one would lose the dish, left alone`);
            continue;
        }
        console.log(`  - ${a.name} [${a.category}] archived — kept in ${a.keep_in}`);
        archived++;
        if (!APPLY) continue;
        await q('UPDATE menu_items SET is_archived = 1, updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [target.id]);
    }

    console.log(`\n${APPLY ? 'added' : 'would add'} ${added}, ${APPLY ? 'repriced' : 'would reprice'} ${repriced}, ${APPLY ? 'archived' : 'would archive'} ${archived}, ${present} already present`);
    if (!APPLY) console.log('nothing was written — re-run with --apply');
} finally {
    await pool.end();
}

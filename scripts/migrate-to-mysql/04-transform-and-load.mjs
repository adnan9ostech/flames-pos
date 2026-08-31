/*
 * Step 4: merge the Supabase export with the Sanity snapshot (Sanity owns
 * name/description/price/variants — the mapping rules in _lib.mjs mirror
 * migrations 20 + 21 exactly) and load the six tables into MySQL in one
 * transaction.
 *
 *   node scripts/migrate-to-mysql/04-transform-and-load.mjs             # load
 *   node scripts/migrate-to-mysql/04-transform-and-load.mjs --dry-run   # transform + report only
 *
 * --dry-run touches no database and needs no DB env; when the real exports
 * are absent it falls back to the built-in fixtures so the transform can be
 * exercised on a machine with no Supabase access at all.
 *
 * Re-runnable: the six target tables are cleared first. They are pre-orders
 * tables — the script refuses outright if orders has rows, because clearing
 * menu_items under a live order history would sever every order_items FK.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
    FIXTURES_DIR, openDb, outPath, readJson, transformMenuRows, writeFixtures,
} from './_lib.mjs';

const DRY = process.argv.includes('--dry-run');

/* ---------- inputs ---------- */

const TABLES = ['branches', 'categories', 'menu_items', 'modifiers', 'waiters', 'store_settings'];
let dir = outPath('');
let fixtureMode = false;

if (DRY && !existsSync(outPath('menu_items.json'))) {
    writeFixtures();
    dir = FIXTURES_DIR;
    fixtureMode = true;
    console.log(`FIXTURE MODE — no export found, transforming ${FIXTURES_DIR}\n`);
}

const need = fixtureMode
    ? ['menu_items.json', 'sanity-dishes.json', 'image-map.json']
    : [...TABLES.map((t) => `${t}.json`), 'sanity-dishes.json', 'image-map.json'];
const missing = need.filter((f) => !existsSync(path.join(dir, f)));
if (missing.length > 0) {
    console.error(`Missing inputs in ${dir}: ${missing.join(', ')} — run steps 01–03 first.`);
    process.exit(1);
}

const load = (name) => readJson(path.join(dir, name));
const menuRows = load('menu_items.json');
const dishes = load('sanity-dishes.json');
const imageMap = load('image-map.json');

/* ---------- transform ---------- */

const { items, report } = transformMenuRows(menuRows, dishes, imageMap);

console.log(`menu transform: ${report.total} POS row(s), ${report.matched} took Sanity pricing, ${report.unmatched.length} kept Supabase values.`);
if (report.multiRow.length > 0) {
    console.log(`multi-row bindings (Sanity pricing, POS names kept):`);
    for (const m of report.multiRow) console.log(`  ${m.pos_name}  <-  ${m.sanity_name} (${m.sanity_id})`);
}
if (report.unmatched.length > 0) {
    console.log(`unmatched rows (no usable Sanity dish):`);
    for (const n of report.unmatched) console.log(`  ${n}`);
}
if (report.skippedDishes.length > 0) {
    console.log(`Sanity dishes skipped (empty name or invalid price):`);
    for (const d of report.skippedDishes) console.log(`  ${d.name ?? '(no name)'} price=${JSON.stringify(d.price)} (${d.sanity_id})`);
}
if (report.imageMisses.length > 0) {
    console.log(`images with no entry in image-map.json:`);
    for (const m of report.imageMisses) console.log(`  ${m.row}: ${m.image}`);
}

if (DRY) {
    console.log('\nDry run — nothing written. Sample of transformed rows:');
    for (const it of items) {
        console.log(`  ${it.name}: price ${it.price}, ${it.variants.length} variant(s)` +
            `${it.variants.length ? ` [${it.variants.map((v) => `${v.name} ${v.price}`).join(', ')}]` : ''}` +
            `${it.image ? `, image ${it.image}` : ''}`);
    }
    process.exit(0);
}

// An unmapped image would load a row pointing at a file that is not on disk;
// 05 would fail the cutover anyway, so refuse here where the fix is obvious.
if (report.imageMisses.length > 0) {
    console.error('\nRefusing to load: images above are missing from image-map.json — re-run 02-download-images.mjs.');
    process.exit(1);
}

/* ---------- load ---------- */

const toDate = (v) => {
    if (!v) return new Date();
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`Unparseable timestamp: ${v}`);
    return d;
};
const flag = (v, dflt) => ((v ?? dflt) ? 1 : 0);
const json = (v) => JSON.stringify(Array.isArray(v) || (v && typeof v === 'object') ? v : []);

const conn = await openDb();
try {
    const [[{ n: orderCount }]] = await conn.query('SELECT COUNT(*) AS n FROM orders');
    if (orderCount > 0) {
        console.error(`orders has ${orderCount} row(s) — this importer only runs on a pre-orders database.`);
        process.exit(1);
    }

    await conn.beginTransaction();

    // DELETE, not TRUNCATE: TRUNCATE commits implicitly and refuses parents
    // of FK children, which defeats the one-transaction guarantee. Children
    // first, so the FK order holds in reverse.
    for (const t of [...TABLES].reverse()) await conn.query(`DELETE FROM ${t}`);

    const insert = async (table, cols, rows, toParams) => {
        const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        for (const r of rows) await conn.execute(sql, toParams(r).map((v) => v ?? null));
        console.log(`${table}: ${rows.length} row(s)`);
    };

    await insert('branches', ['id', 'name', 'created_at'], load('branches.json'),
        (r) => [r.id, r.name, toDate(r.created_at)]);

    await insert('categories', ['id', 'name', 'icon', 'sort_order', 'sanity_id', 'created_at', 'updated_at'],
        load('categories.json'),
        (r) => [r.id, r.name, r.icon ?? 'Utensils', r.sort_order ?? 0, r.sanity_id, toDate(r.created_at), toDate(r.updated_at)]);

    await insert('menu_items',
        ['id', 'category_id', 'name', 'description', 'price', 'unit', 'image', 'variants', 'modifiers', 'is_available', 'sanity_id', 'created_at', 'updated_at'],
        items,
        (r) => [r.id, r.category_id, r.name, r.description, r.price, r.unit, r.image,
            json(r.variants), json(r.modifiers), flag(r.is_available, true), r.sanity_id,
            toDate(r.created_at), toDate(r.updated_at)]);

    await insert('modifiers', ['id', '`key`', 'name', 'type', 'options', 'created_at'],
        load('modifiers.json'),
        (r) => [r.id, r.key, r.name, r.type ?? 'select', json(r.options), toDate(r.created_at)]);

    await insert('waiters', ['id', 'name', 'code', 'is_active', 'created_at'],
        load('waiters.json'),
        (r) => [r.id, r.name, r.code, flag(r.is_active, true), toDate(r.created_at)]);

    // Supabase had one tax_rate; MySQL taxes by payment method. Both start at
    // the old rate — the card rate diverges later when ICT confirms it.
    await insert('store_settings',
        ['id', 'merchant_name', 'merchant_city', 'raast_id', 'jazzcash_id', 'qr_enabled', 'tax_rate_cash', 'tax_rate_card', 'tax_label', 'auto_print', 'updated_at'],
        load('store_settings.json'),
        (r) => [r.id, r.merchant_name, r.merchant_city, r.raast_id, r.jazzcash_id,
            flag(r.qr_enabled, true), r.tax_rate ?? 0.16, r.tax_rate ?? 0.16,
            r.tax_label ?? 'GST', flag(r.auto_print, true), toDate(r.updated_at)]);

    await conn.commit();
    console.log(`\nLoaded into ${process.env.DB_NAME}. Run 05-verify.mjs before cutover.`);
} catch (e) {
    await conn.rollback().catch(() => {});
    console.error(`\nLoad FAILED, transaction rolled back: ${e.message}`);
    process.exitCode = 1;
} finally {
    await conn.end();
}

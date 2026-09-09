/*
 * Imports the ingredient master and the recipes read out of Blink POS on
 * 3 Sep 2026 (scripts/menu/blink-recipes.json) into this database.
 *
 *   node scripts/menu/import-blink-recipes.mjs            # dry run, changes nothing
 *   node scripts/menu/import-blink-recipes.mjs --apply    # writes
 *   node scripts/menu/import-blink-recipes.mjs --apply --replace
 *                                                         # also rewrites dishes
 *                                                         # that already have a recipe
 *
 * Why this exists as a committed script rather than a one-off: it has to run
 * twice — once on this laptop, and once on the production database at cutover,
 * where nobody will want to re-do the extraction. The JSON beside it IS the
 * restaurant's own data, read out of its own Blink account.
 *
 * What it does NOT do: set a cost. Blink carries the quantities but no
 * ingredient prices (its Ideal Food Cost reads Rs 0), so every ingredient
 * lands at cost 0 and the Ingredients screen flags it as unpriced. Recipes
 * cost nothing until the owner prices what the kitchen buys.
 *
 * Every recipe lands as the dish's BASE recipe (variant_name = ''), because
 * every line in Blink is tagged "All Order Types" and Blink's own Half/Full
 * items carry no lines of their own. A size that genuinely differs gets its
 * own lines later, on the Recipes screen.
 *
 * Re-runnable: ingredients upsert on their unique name, and a dish's lines are
 * replaced wholesale inside one transaction. Without --replace, a dish that
 * already has any recipe line is left alone, so a hand-built recipe can never
 * be flattened by a re-run.
 */
import { readFileSync, existsSync } from 'node:fs';
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
const REPLACE = process.argv.includes('--replace');
const {
    DB_NAME, DB_USER = 'root', DB_PASSWORD = '',
    DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET,
} = process.env;
if (!DB_NAME) {
    console.error('DB_NAME is not set — refusing to guess which database to import into.');
    process.exit(1);
}

const data = JSON.parse(readFileSync(path.join(here, 'blink-recipes.json'), 'utf8'));
const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER, password: DB_PASSWORD, database: DB_NAME, timezone: 'Z',
});
await conn.query("SET time_zone = '+00:00'");

const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const say = (...a) => console.log(...a);

say(`${APPLY ? 'IMPORT' : 'DRY RUN'} → ${DB_NAME}`);
say(`source: ${data.source}`);

/* ---- 1. units the data needs must already exist ---- */
const units = new Map((await q('SELECT id, name FROM units')).map((u) => [u.name, u.id]));
const needed = [...new Set(data.ingredients.map((i) => i.unit))];
const missingUnits = needed.filter((u) => !units.has(u));
if (missingUnits.length) {
    console.error(`These units are missing from the units table: ${missingUnits.join(', ')}`);
    process.exit(1);
}

/* ---- 2. ingredients ---- */
const existingIng = new Map((await q('SELECT id, name FROM inventory_items')).map((r) => [r.name, r.id]));
const newIng = data.ingredients.filter((i) => !existingIng.has(i.name));
say(`\ningredients: ${data.ingredients.length} in the file, ${existingIng.size} already here, ${newIng.length} to add`);

if (APPLY) {
    for (const i of data.ingredients) {
        // Name is UNIQUE. An ingredient already here keeps its cost, its
        // reorder level and its active flag — this import must never undo a
        // price somebody has typed. Only a blank category is filled in.
        await q(
            `INSERT INTO inventory_items (name, unit_id, category)
             VALUES (?, ?, ?) AS new_row
             ON DUPLICATE KEY UPDATE category = COALESCE(inventory_items.category, new_row.category)`,
            [i.name, units.get(i.unit), i.category],
        );
    }
    say(`ingredients written`);
}

const ingIds = new Map((await q('SELECT id, name FROM inventory_items')).map((r) => [r.name, r.id]));

/* ---- 3. recipes ---- */
const dishes = new Map();
for (const m of await q('SELECT id, name FROM menu_items WHERE is_archived = 0')) {
    const k = m.name.trim().toLowerCase();
    if (!dishes.has(k)) dishes.set(k, []);
    dishes.get(k).push(m.id);   // one name may be two rows; both get the recipe
}
const alreadyCosted = new Set((await q(
    "SELECT DISTINCT menu_item_id FROM recipe_lines WHERE variant_name = ''")).map((r) => r.menu_item_id));

let planned = 0, skipped = 0, missing = 0, rows = 0;
const plan = [];
for (const r of data.recipes) {
    const ids = dishes.get(r.dish.trim().toLowerCase());
    if (!ids) { missing++; say(`  no such dish here: ${r.dish}`); continue; }
    for (const id of ids) {
        if (alreadyCosted.has(id) && !REPLACE) { skipped++; continue; }
        plan.push({ id, dish: r.dish, lines: r.lines });
        planned++; rows += r.lines.length;
    }
}
say(`\nrecipes: ${planned} dishes to write (${rows} lines), ${skipped} left alone (already costed), ${missing} not on this menu`);
if (skipped && !REPLACE) say('  → pass --replace to rewrite the ones already costed');

if (APPLY && plan.length) {
    await conn.beginTransaction();
    try {
        for (const p of plan) {
            await q('INSERT INTO recipes (menu_item_id) VALUES (?) ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3)', [p.id]);
            await q("DELETE FROM recipe_lines WHERE menu_item_id = ? AND variant_name = ''", [p.id]);
            await q(
                'INSERT INTO recipe_lines (menu_item_id, variant_name, inventory_item_id, qty) VALUES ?',
                [p.lines.map((l) => [p.id, '', ingIds.get(l.ingredient), l.qty])],
            );
        }
        // One audit row for the whole import: it is one act, run by a person
        // at a terminal, not 124 separate edits.
        const [[day]] = await conn.query(
            `SELECT COALESCE(
               (SELECT business_date FROM business_days WHERE branch_id = 1 AND closed_at IS NULL
                 ORDER BY business_date DESC LIMIT 1),
               CURRENT_DATE()) AS d`);
        await q(
            `INSERT INTO audit_log (branch_id, business_date, action, details)
             VALUES (1, ?, 'recipe_import_blink', ?)`,
            [day.d instanceof Date ? day.d.toISOString().slice(0, 10) : String(day.d),
                JSON.stringify({ source: data.source, dishes: plan.length, lines: rows, replaced: REPLACE })],
        );
        await conn.commit();
        say('recipes written');
    } catch (e) {
        await conn.rollback();
        throw e;
    }
}

/* ---- 4. what the owner still has to do ---- */
const unpriced = await q('SELECT COUNT(*) AS n FROM inventory_items WHERE avg_cost = 0');
const uncosted = await q(
    `SELECT COUNT(*) AS n FROM menu_items m
      WHERE m.is_archived = 0
        AND NOT EXISTS (SELECT 1 FROM recipe_lines rl WHERE rl.menu_item_id = m.id)`);
say(`\nafter this run: ${uncosted[0].n} dishes have no recipe, ${unpriced[0].n} ingredients have no price`);
say('Prices are the owner\'s to set — Blink holds none. Menu → Ingredients.');
await conn.end();

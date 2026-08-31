/*
 * Step 5: the cutover gate. Exits nonzero on any failure.
 *
 *   node scripts/migrate-to-mysql/05-verify.mjs              # verify MySQL against export + fresh Sanity
 *   node scripts/migrate-to-mysql/05-verify.mjs --self-test  # prove the mapping rules on fixtures, no DB/network
 *
 * The Sanity comparison re-fetches the live menu and recomputes every
 * expected value with the same rules 04 used (_lib.mjs) — a stale snapshot
 * would happily verify a load that is already wrong on the website.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
    FIXTURE_DISHES, FIXTURE_IMAGE_MAP, FIXTURE_MENU_ROWS, ROOT,
    dishIncoming, openDb, outPath, readJson, transformMenuRows, validPrice,
} from './_lib.mjs';

let failures = 0;
let warnings = 0;
const fail = (msg) => { failures += 1; console.error(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`ok    ${msg}`);
const warn = (msg) => { warnings += 1; console.log(`warn  ${msg}`); };
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const finish = () => {
    console.log(`\n${failures === 0 ? 'VERIFIED' : 'NOT VERIFIED'} — ${failures} failure(s), ${warnings} warning(s).`);
    process.exit(failures === 0 ? 0 : 1);
};

// Prices round-trip through DECIMAL(10,2); compare at that precision.
const money = (v) => Math.round(Number(v) * 100);
const sameVariants = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && a.every((v, i) => v.name === b[i].name && money(v.price) === money(b[i].price));

/* ==================== --self-test: the three dish shapes ==================== */

if (process.argv.includes('--self-test')) {
    const [unsized, sized, nullSizes] = FIXTURE_DISHES.map(dishIncoming);

    check(unsized && money(unsized.price) === 45000 && unsized.variants.length === 0,
        'unsized dish: price is Sanity\'s own price, no variants');

    check(sized && sameVariants(sized.variants, [{ name: 'Half', price: 1200 }, { name: 'Full', price: 2200 }]),
        'sized dish: variants sorted ascending by price');
    check(sized && money(sized.price) === 220000,
        'sized dish: POS price is the LARGEST variant, never Sanity\'s smallest-size price');

    check(nullSizes && money(nullSizes.price) === 15000 && nullSizes.variants.length === 0,
        'JSON-null sizes: treated as unsized without crashing (the _jsonb_array lesson)');

    check(validPrice('450') && validPrice('12.5') && validPrice(1200)
        && !validPrice('1,200') && !validPrice('-5') && !validPrice(null) && !validPrice('Rs 200'),
        'price validation: /^[0-9]+(\\.[0-9]+)?$/ on String(price)');

    const { items, report } = transformMenuRows(FIXTURE_MENU_ROWS, FIXTURE_DISHES, FIXTURE_IMAGE_MAP);
    const byId = new Map(items.map((i) => [i.id, i]));
    const kabuli = byId.get('fx-row-1');
    const lahori = byId.get('fx-row-2');
    const seekh = byId.get('fx-row-3');
    const special = byId.get('fx-row-5');

    check(kabuli.name === 'Channay (Kabuli)' && lahori.name === 'Channay (Lahori)'
        && money(kabuli.price) === 220000 && money(lahori.price) === 220000
        && sameVariants(kabuli.variants, lahori.variants),
        'multi-row binding: both rows take Sanity pricing but keep their distinct POS names');
    check(kabuli.description === 'Slow-cooked chickpeas.',
        'description: Sanity\'s wins when non-empty');
    check(seekh.name === 'Seekh Kebab' && seekh.description === 'Minced beef skewers.',
        'single-row binding: Sanity name wins; empty Sanity description keeps Supabase\'s');
    check(special.name === 'Chef Special' && money(special.price) === 99900
        && report.unmatched.includes('Chef Special'),
        'unbound row: keeps Supabase values and is reported, not dropped');
    check(items.every((i) => !i.image || i.image.startsWith('/menu-images/')),
        'images: every non-null image rewritten root-relative');

    finish();
}

/* ==================== real verification ==================== */

const TABLES = ['branches', 'categories', 'menu_items', 'modifiers', 'waiters', 'store_settings'];
const missing = TABLES.map((t) => `${t}.json`).filter((f) => !existsSync(outPath(f)));
if (missing.length > 0) {
    console.error(`Missing exports in ${outPath('')}: ${missing.join(', ')} — run 01 first.`);
    process.exit(1);
}

const conn = await openDb();
try {
    // 1. Row counts against the export.
    for (const t of TABLES) {
        const expected = readJson(outPath(`${t}.json`)).length;
        const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t}`);
        check(n === expected, `${t}: ${n} row(s) in MySQL, export has ${expected}`);
    }

    const [rows] = await conn.query(
        'SELECT id, name, description, price, image, variants, sanity_id FROM menu_items');
    // mysql2 usually parses JSON columns; be indifferent to driver behaviour.
    for (const r of rows) {
        if (typeof r.variants === 'string') r.variants = JSON.parse(r.variants);
    }

    // 2. Fresh Sanity fetch, re-diffed with the same rules — expecting zero
    // price/variant/name mismatches on every bound row.
    const { fetchSanityDishes } = await import('../../src/lib/sanityMenu.js');
    const dishes = await fetchSanityDishes();
    const incoming = new Map();
    for (const d of dishes) {
        const inc = dishIncoming(d);
        if (inc) incoming.set(d._id, inc);
    }
    const rowsPerDish = new Map();
    for (const r of rows) {
        if (r.sanity_id) rowsPerDish.set(r.sanity_id, (rowsPerDish.get(r.sanity_id) || 0) + 1);
    }

    let mismatches = 0;
    let unbound = 0;
    for (const r of rows) {
        const inc = r.sanity_id ? incoming.get(r.sanity_id) : null;
        if (!inc) {
            unbound += 1;
            continue;
        }
        const multi = rowsPerDish.get(r.sanity_id) > 1;
        if (money(r.price) !== money(inc.price)) {
            mismatches += 1;
            fail(`price: "${r.name}" is ${r.price}, Sanity says ${inc.price}`);
        }
        if (!sameVariants(Array.isArray(r.variants) ? r.variants : [], inc.variants)) {
            mismatches += 1;
            fail(`variants: "${r.name}" has ${JSON.stringify(r.variants)}, expected ${JSON.stringify(inc.variants)}`);
        }
        if (!multi && r.name !== inc.name) {
            mismatches += 1;
            fail(`name: "${r.name}" should be "${inc.name}" (${r.sanity_id})`);
        }
    }
    check(mismatches === 0, `Sanity re-diff: ${mismatches} mismatch(es) across ${rows.length} row(s) against a fresh fetch`);
    if (unbound > 0) warn(`${unbound} menu row(s) have no usable Sanity dish and kept Supabase values`);

    // 3. Every image root-relative and actually on disk.
    let badImages = 0;
    for (const r of rows) {
        if (!r.image) continue;
        const onDisk = r.image.startsWith('/menu-images/')
            && existsSync(path.join(ROOT, 'public', r.image.slice(1)))
            && statSync(path.join(ROOT, 'public', r.image.slice(1))).size > 0;
        if (!onDisk) {
            badImages += 1;
            fail(`image: "${r.name}" -> ${r.image} (not /menu-images/ or file missing/empty)`);
        }
    }
    check(badImages === 0, `images: ${rows.filter((r) => r.image).length} set, all root-relative and present on disk`);

    // 4. Tax rates sane — a rate of 16 instead of 0.16 would charge 1600%.
    const [settings] = await conn.query('SELECT tax_rate_cash, tax_rate_card FROM store_settings');
    check(settings.length === 1, `store_settings: ${settings.length} row(s), expected the singleton`);
    for (const s of settings) {
        check(s.tax_rate_cash > 0 && s.tax_rate_cash < 1, `tax_rate_cash ${s.tax_rate_cash} within (0, 1)`);
        check(s.tax_rate_card > 0 && s.tax_rate_card < 1, `tax_rate_card ${s.tax_rate_card} within (0, 1)`);
    }

    // 5. The role accounts are seeded separately — absence is a warning, not
    // a gate, but nobody can sign in without them.
    try {
        const [users] = await conn.query('SELECT role FROM users');
        const roles = new Set(users.map((u) => u.role));
        for (const role of ['admin', 'staff']) {
            if (!roles.has(role)) warn(`users has no '${role}' row — seed it before anyone tries to sign in`);
        }
        if (roles.has('admin') && roles.has('staff')) pass('users: both role accounts present');
    } catch (e) {
        warn(`users table could not be read (${e.message}) — seed the role accounts before cutover`);
    }
} catch (e) {
    fail(e.message);
} finally {
    await conn.end();
}

finish();

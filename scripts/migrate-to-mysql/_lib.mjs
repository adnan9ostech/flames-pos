/*
 * Shared plumbing for the one-time Supabase -> MySQL import
 * (scripts/migrate-to-mysql/01..05).
 *
 * The transform rules live here, not in 04, because 05 must recompute the
 * expected values independently of what 04 loaded — one definition of the
 * mapping means the self-test in 05 exercises exactly the code that writes
 * the database.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = path.join(ROOT, 'scripts', 'migrate-to-mysql', 'out');
export const FIXTURES_DIR = path.join(OUT_DIR, 'fixtures');

// .env loading, same contract as scripts/db/migrate.mjs: first file that
// defines a key wins, the real environment wins over both. Runs at import
// time so a module that reads process.env at its own top level (sanityMenu.js
// does) sees the values as long as it is imported after this one — the
// scripts dynamic-import it to make that ordering unconditional.
for (const file of ['.env.local', '.env.production']) {
    let text;
    try { text = readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

export const outPath = (...parts) => path.join(OUT_DIR, ...parts);

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export const writeJson = (file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

// One connection, not the app pool: these scripts run against whichever DB_*
// the operator points them at, and must not inherit the app's pool sizing.
export const openDb = async () => {
    const mysql = (await import('mysql2/promise')).default;
    const {
        DB_NAME, DB_USER = 'root', DB_PASSWORD = '',
        DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET,
    } = process.env;
    if (!DB_NAME) throw new Error('DB_NAME is not set — refusing to guess which database to load.');
    const conn = await mysql.createConnection({
        ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        timezone: 'Z',
        decimalNumbers: true,
    });
    await conn.query("SET time_zone = '+00:00'");
    return conn;
};

/* ==================== The mapping rules (migrations 20 + 21) ==================== */

// The exact filter the sync's _incoming table applies to every price.
export const PRICE_RE = /^[0-9]+(\.[0-9]+)?$/;
export const validPrice = (p) => p !== null && p !== undefined && PRICE_RE.test(String(p));

/*
 * One Sanity dish -> the values the POS row should carry. Mirrors _incoming
 * in migration 21:
 *   - a dish with an empty name or an invalid price is dropped entirely;
 *   - sizes must be a real array (Sanity sends JSON null for an unsized dish
 *     — the _jsonb_array lesson: type-check, never null-check);
 *   - sizes with a missing label or invalid price are dropped per-size;
 *   - variants sort ASCENDING by price;
 *   - for a sized dish the POS price is the LARGEST variant, because the grid
 *     shows menu_items.price and Sanity's own price field is the smallest
 *     size — writing it through would reprice every karahi to its half price.
 * Returns null when the dish fails validation (the skip-and-report case).
 */
export const dishIncoming = (dish) => {
    if (!dish || typeof dish.name !== 'string' || dish.name === '') return null;
    if (!validPrice(dish.price)) return null;
    const sizes = Array.isArray(dish.sizes) ? dish.sizes : [];
    const variants = sizes
        .filter((s) => s && s.label !== null && s.label !== undefined && validPrice(s.price))
        .map((s) => ({ name: s.label, price: Number(s.price) }))
        .sort((a, b) => a.price - b.price);
    return {
        sanityId: dish._id,
        name: dish.name,
        description: typeof dish.description === 'string' && dish.description !== '' ? dish.description : null,
        price: variants.length > 0 ? variants[variants.length - 1].price : Number(dish.price),
        variants,
    };
};

/*
 * Merge the Supabase menu_items export with the Sanity dishes.
 *
 * Sanity owns name/description/price/variants; Supabase keeps row identity
 * (id, category_id, unit, modifiers, is_available, sanity_id) and the
 * availability flag the floor toggles mid-service. Two exceptions:
 *   - name: when one dish binds MULTIPLE POS rows (Channay), both rows take
 *     Sanity's pricing but keep their distinct POS names — collapsing them
 *     to one name would leave two identical tiles on the grid;
 *   - description: Sanity's only when non-empty, else the Supabase one stays.
 * Unmatched rows (no binding, binding not in the fetch, or a dish that failed
 * validation) keep their Supabase values and are reported, never dropped.
 */
export const transformMenuRows = (rows, dishes, imageMap) => {
    const bySanityId = new Map();
    for (const d of dishes) {
        const inc = dishIncoming(d);
        if (inc) bySanityId.set(d._id, inc);
    }
    const skippedDishes = dishes.filter((d) => d && d._id && !bySanityId.has(d._id))
        .map((d) => ({ sanity_id: d._id, name: d.name ?? null, price: d.price ?? null }));

    const rowsPerDish = new Map();
    for (const r of rows) {
        if (r.sanity_id) rowsPerDish.set(r.sanity_id, (rowsPerDish.get(r.sanity_id) || 0) + 1);
    }

    const items = [];
    const unmatched = [];
    const multiRow = [];
    const imageMisses = [];

    for (const row of rows) {
        const inc = row.sanity_id ? bySanityId.get(row.sanity_id) : null;
        const multi = row.sanity_id ? rowsPerDish.get(row.sanity_id) > 1 : false;

        let image = row.image || null;
        if (image && !image.startsWith('/menu-images/')) {
            const mapped = imageMap[image];
            if (mapped) image = mapped;
            else imageMisses.push({ row: row.name, image });
        }

        if (!inc) {
            unmatched.push(row.name);
            items.push({
                ...row,
                image,
                variants: Array.isArray(row.variants) ? row.variants : [],
                modifiers: Array.isArray(row.modifiers) ? row.modifiers : [],
            });
            continue;
        }

        if (multi) multiRow.push({ sanity_id: row.sanity_id, pos_name: row.name, sanity_name: inc.name });
        items.push({
            ...row,
            name: multi ? row.name : inc.name,
            description: inc.description ?? row.description ?? null,
            price: inc.price,
            variants: inc.variants,
            modifiers: Array.isArray(row.modifiers) ? row.modifiers : [],
            image,
        });
    }

    return { items, report: { total: rows.length, matched: rows.length - unmatched.length, unmatched, multiRow, skippedDishes, imageMisses } };
};

/* ==================== Fixtures (04 --dry-run without env, 05 --self-test) ==================== */

const FIX_URL = 'https://fixture.supabase.co/storage/v1/object/public/menu-images/menu-v3';
const FIX_TS = '2026-08-01T12:00:00+00:00';

// Exactly the three shapes that have bitten: unsized (sizes coalesced to []),
// sized (unsorted, to prove the ascending sort and largest-price rule), and
// the JSON-null sizes that crashed migration 20.
export const FIXTURE_DISHES = [
    { _id: 'fx-unsized', name: 'Seekh Kebab', description: '', price: 450, sizes: [] },
    {
        _id: 'fx-sized', name: 'Channay', description: 'Slow-cooked chickpeas.', price: 1200,
        sizes: [{ label: 'Full', price: 2200 }, { label: 'Half', price: 1200 }],
    },
    { _id: 'fx-null', name: 'Raita', description: null, price: 150, sizes: null },
];

const fixRow = (over) => ({
    category_id: null, description: null, unit: null, variants: [], modifiers: [],
    is_available: true, sanity_id: null, created_at: FIX_TS, updated_at: FIX_TS, ...over,
});

// Two rows on fx-sized are the Channay case: one dish, two POS tiles.
export const FIXTURE_MENU_ROWS = [
    fixRow({
        id: 'fx-row-1', name: 'Channay (Kabuli)', price: 900, sanity_id: 'fx-sized',
        variants: [{ name: 'Half', price: 600 }, { name: 'Full', price: 900 }],
        image: `${FIX_URL}/channay.webp`, description: 'Old Kabuli copy.',
    }),
    fixRow({
        id: 'fx-row-2', name: 'Channay (Lahori)', price: 900, sanity_id: 'fx-sized',
        variants: [{ name: 'Half', price: 600 }, { name: 'Full', price: 900 }],
        image: `${FIX_URL}/channay.webp`,
    }),
    fixRow({
        id: 'fx-row-3', name: 'Seekh Kebab (Beef)', price: 400, sanity_id: 'fx-unsized',
        image: `${FIX_URL}/seekh-kebab.webp`, description: 'Minced beef skewers.',
    }),
    fixRow({ id: 'fx-row-4', name: 'Raita', price: 120, sanity_id: 'fx-null', image: `${FIX_URL}/raita.webp` }),
    fixRow({ id: 'fx-row-5', name: 'Chef Special', price: 999, image: null }),
];

export const FIXTURE_IMAGE_MAP = {
    [`${FIX_URL}/channay.webp`]: '/menu-images/menu-v3/channay.webp',
    [`${FIX_URL}/seekh-kebab.webp`]: '/menu-images/menu-v3/seekh-kebab.webp',
    [`${FIX_URL}/raita.webp`]: '/menu-images/menu-v3/raita.webp',
};

export const writeFixtures = () => {
    writeJson(path.join(FIXTURES_DIR, 'sanity-dishes.json'), FIXTURE_DISHES);
    writeJson(path.join(FIXTURES_DIR, 'menu_items.json'), FIXTURE_MENU_ROWS);
    writeJson(path.join(FIXTURES_DIR, 'image-map.json'), FIXTURE_IMAGE_MAP);
    return FIXTURES_DIR;
};

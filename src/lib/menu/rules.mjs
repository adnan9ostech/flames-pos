/*
 * The menu's rules, as pure functions: what a dish, a size list, a modifier
 * key and a photo name must look like. No Node imports, so the browser can
 * pre-validate a form with the same code the server enforces, and
 * `node --test` can assert the rules without a database.
 *
 * kit.mjs adds the server-only pieces (audit, business date, upload paths)
 * on top of these.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const requireUuid = (id, what = 'dish') => {
    const v = String(id ?? '').trim().toLowerCase();
    if (!UUID_RE.test(v)) throw new Error(`Pick a ${what} first`);
    return v;
};

/* A trimmed, non-empty name inside the column width. */
export const cleanName = (value, label = 'It', max = 191) => {
    const name = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error(`${label} needs a name`);
    if (name.length > max) throw new Error(`${label} name is too long (${max} characters max)`);
    return name;
};

/* Rupees, whole or with paise, never negative and never NaN. */
export const cleanPrice = (value, label = 'Price') => {
    const raw = String(value ?? '').trim();
    // An empty box is a missing answer, not a free dish. Number('') is 0, so
    // without this line a size left blank would ring up at nothing.
    if (raw === '') throw new Error(`${label} must be a number`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
    if (n < 0) throw new Error(`${label} cannot be negative`);
    if (n > 9_999_999) throw new Error(`${label} is implausibly large`);
    return Math.round(n * 100) / 100;
};

/* Sizes — the largest can be the same as the base, never absent. */
export const VARIANT_NAME_MAX = 64;
export const MAX_VARIANTS = 8;

/*
 * The size list a dish stores: [{name, price}] ascending by price. The till
 * shows the LARGEST price on the tile (menu_items.price) and the modifier
 * modal defaults to the FIRST (smallest) entry, so the ascending order is not
 * cosmetic — it is what keeps a Half karahi from ringing up as a Full.
 *
 * One size is refused: a dish with a single size is a dish with a price.
 */
export const cleanVariants = (input) => {
    const raw = Array.isArray(input) ? input : [];
    const out = [];
    const seen = new Set();
    for (const v of raw) {
        const name = String(v?.name ?? '').trim().replace(/\s+/g, ' ');
        const priceStr = String(v?.price ?? '').trim();
        if (!name && !priceStr) continue; // an empty editor row
        if (!name) throw new Error('Every size needs a name (Half, Full, 8 pieces…)');
        if (name.length > VARIANT_NAME_MAX) throw new Error(`Size name "${name}" is too long`);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error(`Size "${name}" is listed twice`);
        seen.add(key);
        out.push({ name, price: cleanPrice(priceStr, `The price for ${name}`) });
    }
    if (out.length === 1) throw new Error('A dish with one size is a dish with a price. Remove the size or add a second');
    if (out.length > MAX_VARIANTS) throw new Error(`At most ${MAX_VARIANTS} sizes per dish`);
    out.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
    return out;
};

/* What menu_items.price must be for a dish with these sizes. */
export const listPrice = (price, variants) =>
    (Array.isArray(variants) && variants.length > 0)
        ? variants[variants.length - 1].price
        : price;

/* Modifier keys: lower-case slugs, the same shape the seed used ('raita'). */
export const MODIFIER_KEY_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const slugKey = (name) => String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

/* The modifier keys a dish links, restricted to keys that exist. */
export const cleanModifierKeys = (input, knownKeys) => {
    /*
     * ABSENT IS NOT THE SAME AS NONE, and reading them as the same cost this
     * menu its add-ons.
     *
     * The dish editor's payload omitted `modifiers` entirely, so this received
     * `undefined`, answered `[]`, and the UPDATE wrote an empty list — every
     * save silently unhooked whatever the dish had. An empty ARRAY is a real
     * answer ("this dish has no add-ons") and stays legal; a missing field is
     * a caller that forgot, and refusing it means the next one finds out at
     * once instead of after the data is gone.
     */
    if (input === undefined || input === null) {
        throw new Error('The modifier list is missing — reload the dish and save again');
    }
    const known = new Set(knownKeys ?? []);
    const out = [];
    for (const k of Array.isArray(input) ? input : []) {
        const key = String(k ?? '').trim();
        if (!key) continue;
        if (!known.has(key)) throw new Error(`Modifier "${key}" no longer exists`);
        if (!out.includes(key)) out.push(key);
    }
    return out;
};

/*
 * A modifier's option list: [{name, price}], names unique, price ≥ 0. A
 * 'select' modifier needs at least two options or it is not a choice; a
 * 'multiselect' needs one or it offers nothing.
 */
export const MODIFIER_TYPES = ['select', 'multiselect'];
export const MAX_OPTIONS = 20;

export const cleanOptions = (input, type) => {
    const raw = Array.isArray(input) ? input : [];
    const out = [];
    const seen = new Set();
    for (const o of raw) {
        const name = String(o?.name ?? '').trim().replace(/\s+/g, ' ');
        const priceStr = String(o?.price ?? '').trim();
        if (!name && !priceStr) continue;
        if (!name) throw new Error('Every option needs a name');
        if (name.length > 64) throw new Error(`Option "${name}" is too long`);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error(`Option "${name}" is listed twice`);
        seen.add(key);
        out.push({ name, price: priceStr === '' ? 0 : cleanPrice(priceStr, `The price for ${name}`) });
    }
    if (type === 'select' && out.length < 2) throw new Error('A pick-one modifier needs at least two options');
    if (type === 'multiselect' && out.length < 1) throw new Error('An add-ons modifier needs at least one option');
    if (out.length > MAX_OPTIONS) throw new Error(`At most ${MAX_OPTIONS} options per modifier`);
    return out;
};

/*
 * The category glyphs the till and the customer menu know how to draw
 * (their CategoryIcon maps exactly these names; anything else falls back to
 * Utensils). Extend all three together.
 */
export const CATEGORY_ICONS = [
    { name: 'Utensils', label: 'Plate' },
    { name: 'Flame', label: 'Grill' },
    { name: 'Soup', label: 'Bowl' },
    { name: 'Cookie', label: 'Dessert' },
    { name: 'GlassWater', label: 'Drink' },
    { name: 'Plus', label: 'Extras' },
];
export const CATEGORY_ICON_NAMES = CATEGORY_ICONS.map((i) => i.name);

/* ---- Photos ---- */

export const MENU_IMAGE_URL_PREFIX = '/api/uploads/menu-images/';
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_FILE_RE = /^[0-9a-f-]{36}\.(webp|jpg|jpeg|png)$/;
export const IMAGE_TYPES = {
    webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};

/*
 * A stored image path must be one of ours: a photo that shipped with the
 * code under /menu-images/, or one uploaded through the Menu screen. Never a
 * remote URL — the till is offline-tolerant and the customer menu is public.
 */
export const cleanImagePath = (value) => {
    const v = String(value ?? '').trim();
    if (!v) return null;
    if (v.startsWith(MENU_IMAGE_URL_PREFIX) && IMAGE_FILE_RE.test(v.slice(MENU_IMAGE_URL_PREFIX.length))) return v;
    if (/^\/menu-images\/[\w./-]+\.(webp|jpg|jpeg|png)$/i.test(v) && !v.includes('..')) return v;
    throw new Error('That photo is not one the menu can use. Upload it from this screen');
};

/* ---- Recipe SQL shared by consumption, costing and the reports ---- */

/*
 * Which recipe a sold line consumes: its size's own lines when the size has
 * any, else the dish's base ('') lines. `oi` is the order_items alias.
 */
export const RECIPE_VARIANT_FOR_LINE = `CASE WHEN EXISTS (
    SELECT 1 FROM recipe_lines x
     WHERE x.menu_item_id = oi.menu_item_id AND x.variant_name = COALESCE(oi.variant, '')
) THEN COALESCE(oi.variant, '') ELSE '' END`;

/*
 * Unit cost per (dish, size) at today's moving-average ingredient cost —
 * the derived table every costing query joins. Alias it `rc`.
 */
export const RECIPE_COST_TABLE = `SELECT rl.menu_item_id, rl.variant_name,
           SUM(rl.qty * ii.avg_cost) AS unit_cost, COUNT(*) AS line_count
      FROM recipe_lines rl
      JOIN inventory_items ii ON ii.id = rl.inventory_item_id
     GROUP BY rl.menu_item_id, rl.variant_name`;

/*
 * What a branch's exception to the menu actually amounts to.
 *
 * `branch_menu_items` stores only DEPARTURES, and this is the one decision
 * that keeps it that way. It lives here rather than in the server action
 * because the rule is what matters and the suite cannot load a 'use server'
 * file — the action calls this, the tests call this, and there is no second
 * copy of the judgement to drift.
 *
 * Returns { price, isAvailable, isOverride }. `isOverride` false means the
 * branch agrees with the menu in both respects and the row should be DELETED,
 * not written as a pair of defaults.
 *
 * The subtle half is the price. A branch price EQUAL to the menu's is
 * agreement, not an exception, and storing it would freeze that outlet at
 * today's number: raise the menu next month and the branch silently keeps the
 * old price, having recorded a difference nobody ever meant. So it collapses
 * to null.
 */
export const branchMenuOverride = (submittedPrice, submittedAvailable, menuPrice) => {
    const isAvailable = submittedAvailable !== false;

    const raw = String(submittedPrice ?? '').trim();
    if (raw === '') return { price: null, isAvailable, isOverride: !isAvailable };

    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error('A branch price must be a number');
    if (n < 0) throw new Error('A branch price must be zero or more');
    if (n > 9_999_999) throw new Error('That price is implausibly large');

    const rounded = Math.round(n * 100) / 100;
    const price = rounded === Math.round(Number(menuPrice) * 100) / 100 ? null : rounded;
    return { price, isAvailable, isOverride: price !== null || !isAvailable };
};

/*
 * Which menu price a branch cell is an exception TO.
 *
 * For a dish priced whole that is the dish's price. For a SIZE it is that
 * size's own price — and getting this wrong is not academic: comparing a
 * Full-portion override against the dish's base price would either store an
 * "override" that merely restates the base, or discard a real one that
 * happens to equal it. The Half of a Rs 1,000 karahi costs Rs 600, so every
 * Half override would have been judged against the wrong number.
 *
 * Lives here, with branchMenuOverride, because the suite cannot load a
 * 'use server' file and this is the half of the decision that is easy to get
 * subtly wrong.
 */
export const branchCellMenuPrice = (dish, variantName) => {
    const size = String(variantName || '');
    if (size === '') return Number(dish?.price);
    const sizes = Array.isArray(dish?.variants) ? dish.variants : [];
    const found = sizes.find((v) => String(v?.name) === size);
    if (!found) throw new Error(`"${size}" is no longer a size of ${dish?.name}`);
    return Number(found.price);
};

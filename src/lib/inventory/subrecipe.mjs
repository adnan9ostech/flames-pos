/*
 * Sub-recipes: an ingredient that is itself made of ingredients.
 *
 * A kitchen makes a karahi masala in a twenty-kilo batch and twenty dishes
 * then call for "80g of masala". This module is what turns those 80g back into
 * the spices that leave the shelf, and what prices the masala from its parts.
 *
 * PHANTOM, not stock: a sub-recipe is never held or counted. Selling a dish
 * consumes the raw components, however many layers down. See migration 029 for
 * why that shape was chosen over a produced batch with a yield.
 *
 * Plain functions over plain data — the caller does the querying, so the same
 * expansion serves the consumption engine (inside its transaction), the recipe
 * costing screen, and a test, without any of them sharing a connection.
 */

// How deep a chain may go before we call it a mistake. A stock inside a masala
// inside a marinade is three; anything past six is either a loop the visited
// set has somehow missed or a modelling error worth surfacing as one.
export const MAX_DEPTH = 6;

/*
 * Build the lookup the expander walks: parent item id -> its component lines.
 * `rows` is whatever `SELECT parent_item_id, component_item_id, qty FROM
 * sub_recipe_lines` returned.
 */
export const indexSubRecipes = (rows = []) => {
    const map = new Map();
    for (const r of rows) {
        const parent = Number(r.parent_item_id);
        if (!map.has(parent)) map.set(parent, []);
        map.get(parent).push({
            itemId: Number(r.component_item_id),
            qty: Number(r.qty),
        });
    }
    return map;
};

/*
 * The usable fraction of an item, as a divisor. `yields` maps item id -> the
 * percentage column; anything absent, zero or nonsensical is 1, meaning no
 * loss — so an ingredient nobody has thought about behaves exactly as it did
 * before this column existed, and a fat-fingered 0 cannot divide by zero and
 * consume the entire shelf.
 */
const yieldOf = (itemId, yields) => {
    const pct = Number(yields?.get?.(Number(itemId)));
    return Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct / 100 : 1;
};

/*
 * Explode one quantity of one item into raw quantities, summed per item.
 *
 * `visited` is the cycle guard and it is per-branch, not global: the same
 * ingredient may legitimately appear in two different sub-recipes of the same
 * dish (salt in the masala AND salt in the marinade), and a global set would
 * silently drop the second. What must never happen is an item appearing inside
 * its own expansion, which is what this catches.
 */
const explodeInto = (out, itemId, qty, map, visited, depth, yields) => {
    const parts = map.get(itemId);
    if (!parts || depth >= MAX_DEPTH || visited.has(itemId)) {
        /*
         * A leaf — or a loop we refuse to follow, in which case the item is
         * treated as raw. Consuming the masala itself is wrong, but it is far
         * less wrong than never returning.
         *
         * AND THIS IS WHERE YIELD APPLIES, on the leaf and nowhere else,
         * because the leaf is the only thing anybody ever bought. A recipe
         * line is written in what the chef puts on the plate; the shelf holds
         * what the restaurant carried in through the door. At 70% yield,
         * plating 200 g of chicken takes 286 g of whole chicken, and the
         * division happens once, here, so cost follows without a second rule.
         *
         * A phantom never reaches this line with a yield of its own: it is
         * never bought and never trimmed, and its parts carry theirs.
         */
        out.set(itemId, (out.get(itemId) ?? 0) + qty / yieldOf(itemId, yields));
        return;
    }
    const deeper = new Set(visited).add(itemId);
    for (const part of parts) {
        explodeInto(out, part.itemId, qty * part.qty, map, deeper, depth + 1, yields);
    }
};

/*
 * Explode a list of {itemId, qty} into raw {itemId, qty}, summed.
 * An item with no sub-recipe passes through untouched, which is every
 * ingredient in a kitchen that has not defined one — so this is safe to run
 * over everything.
 */
export const expandToRaw = (lines = [], map = new Map(), yields = new Map()) => {
    const out = new Map();
    for (const l of lines) {
        explodeInto(out, Number(l.itemId), Number(l.qty), map, new Set(), 0, yields);
    }
    return [...out.entries()].map(([itemId, qty]) => ({ itemId, qty }));
};

/*
 * What one unit of an item costs, following sub-recipes down.
 *
 * A sub-recipe's own avg_cost is meaningless — nothing is ever bought or
 * received as "masala" — so its cost is the sum of its parts. `costs` is a
 * Map of item id -> avg_cost for the raw ones.
 */
export const effectiveCost = (itemId, map, costs, yields = new Map(), visited = new Set(), depth = 0) => {
    const id = Number(itemId);
    const parts = map.get(id);
    // A leaf costs what it cost to buy, divided by how much of it is usable:
    // chicken at Rs 500/kg and 70% yield means usable chicken costs Rs 714/kg,
    // and that is the number a recipe should be priced at.
    if (!parts || depth >= MAX_DEPTH || visited.has(id)) {
        return Number(costs.get(id) ?? 0) / yieldOf(id, yields);
    }
    const deeper = new Set(visited).add(id);
    return parts.reduce(
        (sum, p) => sum + p.qty * effectiveCost(p.itemId, map, costs, yields, deeper, depth + 1),
        0,
    );
};

/* The ids that have a recipe of their own — the phantoms. */
export const subRecipeIds = (map) => new Set(map.keys());

/*
 * Push every sub-recipe's cost back onto its own `avg_cost`.
 *
 * A phantom is never bought, so the column would otherwise sit at whatever it
 * was seeded with — and every screen in the app already reads `avg_cost` to
 * price a recipe. Rather than teach each of them about expansion, the roll-up
 * is cached here and they all become right at once.
 *
 * Called after a sub-recipe is edited AND after a receiving, because a change
 * in what chilli costs changes what the masala costs. Both are rare and the
 * table is small; correctness is worth the handful of updates.
 *
 * Deepest-last: parents are written in dependency order, so a masala made of a
 * paste is costed after the paste has its own number.
 */
export const recomputeSubRecipeCosts = async (conn) => {
    const [rows] = await conn.query(
        'SELECT parent_item_id, component_item_id, qty FROM sub_recipe_lines',
    );
    if (!rows.length) return 0;
    const map = indexSubRecipes(rows);

    const [items] = await conn.query('SELECT id, avg_cost, yield_pct FROM inventory_items');
    const costs = new Map(items.map((i) => [Number(i.id), Number(i.avg_cost)]));
    // A phantom's cost is the cost of its USABLE parts: if the masala calls
    // for 200 g of onion and onion yields 80%, the masala carries the price of
    // the 250 g that had to be peeled.
    const yields = new Map(items.map((i) => [Number(i.id), Number(i.yield_pct)]));

    // Cost every phantom from the RAW costs — effectiveCost walks the tree
    // itself, so the order rows are written in does not matter.
    let written = 0;
    for (const parent of map.keys()) {
        const cost = Math.round(effectiveCost(parent, map, costs, yields) * 10000) / 10000;
        if (cost === costs.get(parent)) continue;
        await conn.query(
            'UPDATE inventory_items SET avg_cost = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
            [cost, parent],
        );
        written += 1;
    }
    return written;
};

/*
 * item id -> yield percentage, for the callers above. One query, kept here so
 * the four places that expand a recipe cannot disagree about which column it
 * is or what shape the Map should be.
 */
export const loadYields = async (conn = null) => {
    const sql = 'SELECT id, yield_pct FROM inventory_items WHERE yield_pct <> 100';
    const rows = conn ? (await conn.query(sql))[0] : await (await import('../db/pool.mjs')).query(sql);
    return new Map(rows.map((r) => [Number(r.id), Number(r.yield_pct)]));
};

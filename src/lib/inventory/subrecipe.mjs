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
 * Explode one quantity of one item into raw quantities, summed per item.
 *
 * `visited` is the cycle guard and it is per-branch, not global: the same
 * ingredient may legitimately appear in two different sub-recipes of the same
 * dish (salt in the masala AND salt in the marinade), and a global set would
 * silently drop the second. What must never happen is an item appearing inside
 * its own expansion, which is what this catches.
 */
const explodeInto = (out, itemId, qty, map, visited, depth) => {
    const parts = map.get(itemId);
    if (!parts || depth >= MAX_DEPTH || visited.has(itemId)) {
        // A leaf — or a loop we refuse to follow, in which case the item is
        // treated as raw. Consuming the masala itself is wrong, but it is far
        // less wrong than never returning.
        out.set(itemId, (out.get(itemId) ?? 0) + qty);
        return;
    }
    const deeper = new Set(visited).add(itemId);
    for (const part of parts) {
        explodeInto(out, part.itemId, qty * part.qty, map, deeper, depth + 1);
    }
};

/*
 * Explode a list of {itemId, qty} into raw {itemId, qty}, summed.
 * An item with no sub-recipe passes through untouched, which is every
 * ingredient in a kitchen that has not defined one — so this is safe to run
 * over everything.
 */
export const expandToRaw = (lines = [], map = new Map()) => {
    const out = new Map();
    for (const l of lines) {
        explodeInto(out, Number(l.itemId), Number(l.qty), map, new Set(), 0);
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
export const effectiveCost = (itemId, map, costs, visited = new Set(), depth = 0) => {
    const id = Number(itemId);
    const parts = map.get(id);
    if (!parts || depth >= MAX_DEPTH || visited.has(id)) return Number(costs.get(id) ?? 0);
    const deeper = new Set(visited).add(id);
    return parts.reduce(
        (sum, p) => sum + p.qty * effectiveCost(p.itemId, map, costs, deeper, depth + 1),
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

    const [items] = await conn.query('SELECT id, avg_cost FROM inventory_items');
    const costs = new Map(items.map((i) => [Number(i.id), Number(i.avg_cost)]));

    // Cost every phantom from the RAW costs — effectiveCost walks the tree
    // itself, so the order rows are written in does not matter.
    let written = 0;
    for (const parent of map.keys()) {
        const cost = Math.round(effectiveCost(parent, map, costs) * 10000) / 10000;
        if (cost === costs.get(parent)) continue;
        await conn.query(
            'UPDATE inventory_items SET avg_cost = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
            [cost, parent],
        );
        written += 1;
    }
    return written;
};

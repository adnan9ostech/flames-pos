/*
 * Dish waste: food that was cooked and then thrown away.
 *
 * The stock room already had ingredient waste (Misc consumption). This is the
 * thing that actually happens on a service — a dropped plate, a dish sent back,
 * a takeaway never collected — where nobody knows the recipe and everybody
 * knows the dish.
 *
 * It explodes the dish's recipe exactly as a sale does, sub-recipes included,
 * because the food really was cooked. It is neither a sale (no money) nor a
 * void (a void un-rings something that was never made), and the reason is
 * compulsory: stock leaving with nothing against it is the one movement that
 * has to be explained.
 */
import { withTransaction } from '../db/pool.mjs';
import { postLedger } from '../db/inventory.mjs';
import { indexSubRecipes, expandToRaw } from './subrecipe.mjs';
import { karachiDay } from '../day/karachi.mjs';
import { openBusinessDate } from '../day/openDay.mjs';;

const MAIN_WAREHOUSE_ID = 1;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export const postDishWaste = async ({ reason, lines = [], userId = null } = {}) =>
    withTransaction(async (conn) => {
        const why = String(reason ?? '').trim().slice(0, 191);
        if (!why) throw new Error('Waste needs a reason');

        const clean = lines
            .map((l) => ({
                menuItemId: String(l.menuItemId || ''),
                variantName: String(l.variantName || '').slice(0, 64),
                qty: Math.round(Number(l.qty) * 1000) / 1000,
            }))
            .filter((l) => l.menuItemId && l.qty > 0);
        if (clean.length === 0) throw new Error('Waste needs at least one dish');

        // The open trading day, or today's Karachi date when none is open —
        // the same fallback the orders kernel uses, so waste and sales land in
        // the same day-close.
        const businessDate = await openBusinessDate(null, conn);

        const [doc] = await conn.query(
            'INSERT INTO waste_docs (branch_id, business_date, reason, posted_by) VALUES (1, ?, ?, ?)',
            [businessDate, why, userId],
        );
        const docId = doc.insertId;

        // The recipes behind the wasted dishes, at the size wasted — falling
        // back to the dish's base recipe when the size has none of its own,
        // which is the same rule consumption follows.
        const [recipeRows] = await conn.query(
            `SELECT rl.menu_item_id, rl.variant_name, rl.inventory_item_id, rl.qty
               FROM recipe_lines rl WHERE rl.menu_item_id IN (?)`,
            [[...new Set(clean.map((l) => l.menuItemId))]],
        );
        const [subLines] = await conn.query(
            'SELECT parent_item_id, component_item_id, qty FROM sub_recipe_lines',
        );
        const [costRows] = await conn.query('SELECT id, avg_cost FROM inventory_items');
        const costs = new Map(costRows.map((c) => [Number(c.id), Number(c.avg_cost)]));
        const subMap = indexSubRecipes(subLines);

        const used = [];
        const lineCosts = [];
        for (const l of clean) {
            const own = recipeRows.filter(
                (r) => r.menu_item_id === l.menuItemId && r.variant_name === l.variantName,
            );
            const base = recipeRows.filter(
                (r) => r.menu_item_id === l.menuItemId && r.variant_name === '',
            );
            const recipe = own.length ? own : base;
            // A dish with no recipe wastes nothing off the shelf. Recorded all
            // the same: the document is also the record that it happened, and a
            // half-mapped menu is the normal state.
            const raw = expandToRaw(
                recipe.map((r) => ({ itemId: Number(r.inventory_item_id), qty: Number(r.qty) * l.qty })),
                subMap,
            );
            used.push(...raw);
            lineCosts.push(round2(raw.reduce((sum, r) => sum + r.qty * (costs.get(r.itemId) ?? 0), 0)));
        }

        await conn.query(
            'INSERT INTO waste_lines (waste_doc_id, menu_item_id, variant_name, qty, cost) VALUES ?',
            [clean.map((l, i) => [docId, l.menuItemId, l.variantName, l.qty, lineCosts[i]])],
        );

        // Summed per ingredient: two wasted dishes sharing an ingredient are
        // one movement, the same way a sale's lines are.
        const perItem = new Map();
        for (const u of used) perItem.set(u.itemId, (perItem.get(u.itemId) ?? 0) + u.qty);
        const movements = [...perItem.entries()]
            .map(([itemId, qty]) => ({
                itemId,
                warehouseId: MAIN_WAREHOUSE_ID,
                delta: -round4(qty),
                sourceType: 'waste',
                sourceId: String(docId),
                businessDate,
            }))
            .filter((m) => m.delta !== 0);
        if (movements.length) await postLedger(conn, movements);

        await conn.query(
            `INSERT INTO audit_log (branch_id, business_date, action, details)
             VALUES (1, ?, 'dish_waste', ?)`,
            [businessDate, JSON.stringify({
                waste_doc_id: docId,
                reason: why,
                dishes: clean.length,
                cost: round2(lineCosts.reduce((a, b) => a + b, 0)),
                by: userId,
            })],
        );

        return { id: docId, businessDate, cost: round2(lineCosts.reduce((a, b) => a + b, 0)) };
    });

/*
 * Post it, then book it: Dr Wastage, Cr Inventory. Separate from the verb and
 * fire-and-forget, like every other ledger hook — food that has been binned
 * cannot be un-binned because the books were busy.
 */
export const recordDishWaste = async (args) => {
    const doc = await postDishWaste(args);
    const { afterWasteGl } = await import('../accounts/stockPost.mjs');
    await afterWasteGl(doc.id, { userId: args?.userId ?? null });
    return doc;
};

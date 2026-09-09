/*
 * The consumption engine: a settled order becomes ingredient movements by
 * exploding its stored lines through the recipes. Called AFTER the settle
 * transaction commits, fire-and-forget — the money is already taken, and a
 * stock hiccup must never un-take it or crash the till, so nothing in this
 * module throws. It runs its own transaction on the pool, never the settle's.
 *
 * Idempotency is the ledger itself: an order that already has 'sale' rows
 * (or 'void' rows, for a reversal) is done, however many times the caller
 * fires. Dishes without a recipe consume nothing, silently — recipes are
 * built out dish by dish, and a half-mapped menu is the normal state, not
 * an error.
 */
import { withTransaction } from '../db/pool.mjs';
import { postLedger } from '../db/inventory.mjs';
import { RECIPE_VARIANT_FOR_LINE } from '../menu/rules.mjs';

// 'Main Store', seeded by migration 002. The till has no warehouse concept,
// so everything a sale consumes comes out of the main store until it does.
const MAIN_WAREHOUSE_ID = 1;

const round4 = (n) => Math.round(n * 10000) / 10000;

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

/*
 * The order row arrives serialized ('YYYY-MM-DD') from a server action or
 * raw (a Date) from a test poking the kernel directly; both mean the same
 * calendar day.
 */
const asDay = (value) => {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return null;
};

/* A void books its stock return to the day it happens, like its payment row. */
const currentBusinessDate = async (conn) => {
    const [rows] = await conn.query(
        `SELECT business_date FROM business_days
         WHERE branch_id = 1 AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
    );
    if (rows.length === 0) return karachiDay();
    const d = rows[0].business_date;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
};

export const consumeForOrder = async (order) => {
    try {
        if (!order?.id) return;
        await withTransaction(async (conn) => {
            // Already consumed — a replayed settle changes nothing twice.
            const [seen] = await conn.query(
                "SELECT 1 FROM stock_ledger WHERE source_type = 'sale' AND source_id = ? LIMIT 1",
                [order.id],
            );
            if (seen.length > 0) return;

            // Explode lines through recipes in one pass: each sold portion
            // consumes its recipe quantities, summed per ingredient. Lines
            // whose dish lost its menu link (or has no recipe) fall out of
            // the join, which is the "skip silently" the menu build-out needs.
            //
            // The join is on the RESOLVED size: a Full portion takes the Full
            // recipe's chicken when Full has its own lines, and the dish's
            // base recipe when it does not. Without that, a Full karahi
            // consumed a Half's quantities and the shelf count drifted every
            // service.
            const [used] = await conn.query(
                `SELECT rl.inventory_item_id AS item_id, SUM(oi.qty * rl.qty) AS qty
                 FROM order_items oi
                 JOIN recipe_lines rl
                   ON rl.menu_item_id = oi.menu_item_id
                  AND rl.variant_name = (${RECIPE_VARIANT_FOR_LINE})
                 WHERE oi.order_id = ?
                 GROUP BY rl.inventory_item_id`,
                [order.id],
            );
            if (used.length === 0) return;

            // The order's own trading day, so a 1 a.m. sale's consumption
            // sits in the same day-close as its revenue. unit_cost stays
            // NULL — consumption prices at avg_cost read at report time.
            const businessDate = asDay(order.business_date) ?? await currentBusinessDate(conn);
            await postLedger(conn, used.map((u) => ({
                itemId: u.item_id,
                warehouseId: MAIN_WAREHOUSE_ID,
                delta: -round4(Number(u.qty)),
                sourceType: 'sale',
                sourceId: order.id,
                businessDate,
            })));
        });
    } catch (e) {
        // Logged, never thrown: the sale already happened. A missed
        // consumption surfaces at the next count as variance, which is
        // recoverable; a crashed settle response is not.
        console.error(`[inventory] consume for order ${order?.id} failed:`, e?.message ?? e);
    }
};

export const reverseForOrder = async (order) => {
    try {
        if (!order?.id) return;
        await withTransaction(async (conn) => {
            // Already reversed — voiding a void moves nothing.
            const [seen] = await conn.query(
                "SELECT 1 FROM stock_ledger WHERE source_type = 'void' AND source_id = ? LIMIT 1",
                [order.id],
            );
            if (seen.length > 0) return;

            // Mirror what the sale actually posted rather than re-exploding
            // the recipes: a recipe edited since the sale must not put back
            // different quantities than came out.
            const [sold] = await conn.query(
                `SELECT inventory_item_id AS item_id, warehouse_id, SUM(delta) AS moved
                 FROM stock_ledger
                 WHERE source_type = 'sale' AND source_id = ?
                 GROUP BY inventory_item_id, warehouse_id`,
                [order.id],
            );
            if (sold.length === 0) return; // never consumed, nothing to put back

            const businessDate = await currentBusinessDate(conn);
            await postLedger(conn, sold.map((s) => ({
                itemId: s.item_id,
                warehouseId: s.warehouse_id,
                delta: -Number(s.moved), // sale rows are negative; this returns them
                sourceType: 'void',
                sourceId: order.id,
                businessDate,
            })));
        });
    } catch (e) {
        console.error(`[inventory] reverse for order ${order?.id} failed:`, e?.message ?? e);
    }
};

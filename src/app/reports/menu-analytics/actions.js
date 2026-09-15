'use server';

import { query } from '@/lib/db/pool.mjs';
import { requirePermission } from '@/lib/db/auth.mjs';
import { currentBranchId } from '@/lib/db/branch.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/*
 * "Sold" means settled: an open tab is food fired, not money taken, and a
 * mix report that counted it would shrink when the tab voids. Partial
 * payments count — money has changed hands. Cancelled orders are excluded
 * here and get their own tab, where the reasons live.
 */
/*
 * The branch leads, deliberately: put it in the shared fragment and every
 * query built from it is scoped by construction rather than by remembering.
 * Without it the product mix and the modifier counts were both outlets' food
 * added together, so "which categories carry the menu" was largely a
 * different restaurant's answer.
 */
const SOLD = `o.branch_id = ?
       AND o.business_date BETWEEN ? AND ?
       AND o.status <> 'cancelled'
       AND o.payment_status <> 'unpaid'`;

/*
 * order_items.modifiers has worn two shapes over its life: the POS cart's
 * keyed object — { groupKey: [{name, price}, …] }, where a 'select' group
 * may hold a single object rather than an array — and a plain array on
 * older lines ([{name, price}] or just ["Extra Raita"]). Same information
 * either way, so both funnel into one flat list of {name, price} entries
 * here instead of forcing a backfill of history.
 */
const modifierEntries = (raw) => {
    let mods = raw;
    // Belt and braces: a line written before the column was JSON-typed
    // could hand us a string instead of a parsed value.
    if (typeof mods === 'string') {
        try { mods = JSON.parse(mods); } catch { return []; }
    }
    if (!mods || typeof mods !== 'object') return [];
    const flat = Array.isArray(mods) ? mods : Object.values(mods).flat();
    return flat
        .map((m) => (typeof m === 'string' ? { name: m } : m))
        .filter((m) => m && typeof m === 'object' && m.name)
        .map((m) => ({ name: String(m.name), price: Number(m.price) || 0 }));
};

/*
 * Everything the four tabs need in one call, so switching tabs never
 * refetches and all four agree on the same range. from/to are business
 * dates ('YYYY-MM-DD'): the trading day the order belongs to, not the UTC
 * calendar day it happened to be stored under.
 */
export async function productMix(from, to) {
    // Out here for the same reason the other report actions declare it out
     // here: a const scoped to the authenticating try is invisible to the
     // queries after it, and the build cannot see the difference.
    let branchId;
    try {
        const user = await requirePermission('reports');
        branchId = await currentBranchId(user);
    } catch (e) {
        return { error: e.message };
    }

    if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
        return { error: 'Pick a valid date range' };
    }
    // A reversed range is a typo, not a request for zero rows.
    if (from > to) [from, to] = [to, from];

    try {
        const [mixRows, modifierLines, voidedRows] = await Promise.all([
            // Variants stay separate rows: a Full and a Half karahi sell at
            // different prices and the owner reads them as different products.
            query(
                `SELECT oi.name, oi.variant,
                        COALESCE(c.name, 'Uncategorised') AS category,
                        SUM(oi.qty) AS qty,
                        SUM(oi.line_total) AS revenue
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
                 LEFT JOIN categories c ON c.id = mi.category_id
                 WHERE ${SOLD}
                 GROUP BY oi.name, oi.variant, category
                 ORDER BY qty DESC, revenue DESC`,
                [branchId, from, to],
            ),
            // The JSON shapes vary (see modifierEntries), so the unnesting
            // happens in JS on the fetched lines rather than in SQL.
            query(
                `SELECT oi.modifiers, oi.qty
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 WHERE ${SOLD} AND oi.modifiers IS NOT NULL`,
                [branchId, from, to],
            ),
            // Voids carry their reasons: the point of this tab is not the
            // quantity, it is the "wrong table" vs "walk-out" pattern.
            query(
                `SELECT oi.name, oi.variant,
                        SUM(oi.qty) AS qty,
                        SUM(oi.line_total) AS voided_value,
                        GROUP_CONCAT(DISTINCT NULLIF(TRIM(o.cancel_reason), '')
                                     SEPARATOR ' | ') AS reasons
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 WHERE o.branch_id = ? AND o.business_date BETWEEN ? AND ? AND o.status = 'cancelled'
                 GROUP BY oi.name, oi.variant
                 ORDER BY qty DESC, voided_value DESC
                 LIMIT 20`,
                [branchId, from, to],
            ),
        ]);

        const totalQty = mixRows.reduce((s, r) => s + Number(r.qty), 0);
        const totalRevenue = mixRows.reduce((s, r) => s + Number(r.revenue), 0);

        const mix = mixRows.map((r) => ({
            name: r.name,
            variant: r.variant,
            category: r.category,
            qty: Number(r.qty),
            revenue: Number(r.revenue),
            qtyPct: totalQty > 0 ? (Number(r.qty) / totalQty) * 100 : 0,
            revenuePct: totalRevenue > 0 ? (Number(r.revenue) / totalRevenue) * 100 : 0,
        }));

        // A modifier's count weights by line qty — "Extra Raita" on a line of
        // three karahis was chosen three times. Revenue is only what the
        // modifier itself priced at; free ones rank by count alone.
        const modTotals = {};
        for (const line of modifierLines) {
            for (const m of modifierEntries(line.modifiers)) {
                if (!modTotals[m.name]) modTotals[m.name] = { name: m.name, count: 0, revenue: 0 };
                modTotals[m.name].count += Number(line.qty) || 0;
                modTotals[m.name].revenue += m.price * (Number(line.qty) || 0);
            }
        }
        const topModifiers = Object.values(modTotals)
            .sort((a, b) => b.count - a.count || b.revenue - a.revenue)
            .slice(0, 20);

        const topVoided = voidedRows.map((r) => ({
            name: r.name,
            variant: r.variant,
            qty: Number(r.qty),
            value: Number(r.voided_value),
            reasons: r.reasons || '',
        }));

        return {
            data: {
                range: { from, to },
                totals: { qty: totalQty, revenue: totalRevenue },
                mix,
                topItems: mix.slice(0, 20),
                topModifiers,
                topVoided,
            },
        };
    } catch (e) {
        console.error('Menu analytics failed', e);
        return { error: 'Could not load menu analytics' };
    }
}

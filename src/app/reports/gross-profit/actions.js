'use server';

import { query } from '@/lib/db/pool.mjs';
import { requirePermission } from '@/lib/db/auth.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/*
 * Gross profit per dish over a business-date range: what it sold for
 * against what its recipe says it costs to make.
 *
 * Cost comes from the recipe (Σ line qty × ingredient avg_cost) at today's
 * moving-average prices — a report of what the menu earns now, not a
 * ledger of what each historical plate cost. Grouping is by menu item, not
 * by variant: one recipe covers the dish, so Half and Full price together
 * against the same cost.
 *
 * COGS in the footer is Σ(recipe cost × qty sold) over settled orders —
 * the same figure the handover's COGS line reports, so the two can be laid
 * side by side without reconciliation.
 */
export async function grossProfit(from, to) {
    try {
        await requirePermission('reports');
    } catch (e) {
        return { error: e.message };
    }

    if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
        return { error: 'Pick a valid date range' };
    }
    // A reversed range is a typo, not a request for zero rows.
    if (from > to) [from, to] = [to, from];

    try {
        // LEFT JOIN onto the recipe roll-up: a dish with no recipe keeps its
        // sales but comes back with unit_cost NULL — flagged, never treated
        // as free to make. Lines whose menu item was deleted group by name.
        const rows = await query(
            `SELECT oi.menu_item_id,
                    COALESCE(mi.name, oi.name) AS name,
                    SUM(oi.qty) AS qty_sold,
                    SUM(oi.line_total) AS revenue,
                    rc.unit_cost
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
             LEFT JOIN (
                 SELECT rl.menu_item_id, SUM(rl.qty * ii.avg_cost) AS unit_cost
                 FROM recipe_lines rl
                 JOIN inventory_items ii ON ii.id = rl.inventory_item_id
                 GROUP BY rl.menu_item_id
             ) rc ON rc.menu_item_id = oi.menu_item_id
             WHERE o.business_date BETWEEN ? AND ?
               AND o.status <> 'cancelled'
               AND o.payment_status <> 'unpaid'
             GROUP BY oi.menu_item_id, name, rc.unit_cost`,
            [from, to],
        );

        const items = rows.map((r) => {
            const qtySold = Number(r.qty_sold);
            const revenue = Number(r.revenue);
            const hasRecipe = r.unit_cost !== null;
            const unitCost = hasRecipe ? Number(r.unit_cost) : null;
            const totalCost = hasRecipe ? unitCost * qtySold : null;
            const margin = hasRecipe ? revenue - totalCost : null;
            return {
                name: r.name,
                qtySold,
                revenue,
                unitCost,
                totalCost,
                margin,
                marginPct: hasRecipe && revenue > 0 ? (margin / revenue) * 100 : null,
                hasRecipe,
            };
        });

        // Worst margin first — that is the row the owner scans for. Dishes
        // with no recipe can't claim a margin at all, so they sit below the
        // costed ones, biggest blind spot (most revenue uncosted) first.
        items.sort((a, b) => {
            if (a.hasRecipe && b.hasRecipe) return (a.marginPct ?? 0) - (b.marginPct ?? 0);
            if (a.hasRecipe !== b.hasRecipe) return a.hasRecipe ? -1 : 1;
            return b.revenue - a.revenue;
        });

        const costed = items.filter((i) => i.hasRecipe);
        const cogs = costed.reduce((s, i) => s + i.totalCost, 0);
        const costedRevenue = costed.reduce((s, i) => s + i.revenue, 0);
        const uncosted = items.filter((i) => !i.hasRecipe);

        return {
            data: {
                range: { from, to },
                items,
                totals: {
                    qtySold: items.reduce((s, i) => s + i.qtySold, 0),
                    revenue: items.reduce((s, i) => s + i.revenue, 0),
                    cogs,
                    // Margin only over what has a cost: folding uncosted
                    // revenue in would inflate the percentage.
                    margin: costedRevenue - cogs,
                    marginPct: costedRevenue > 0 ? ((costedRevenue - cogs) / costedRevenue) * 100 : null,
                    uncostedCount: uncosted.length,
                    uncostedRevenue: uncosted.reduce((s, i) => s + i.revenue, 0),
                },
            },
        };
    } catch (e) {
        console.error('Gross profit report failed', e);
        return { error: 'Could not load the gross profit report' };
    }
}

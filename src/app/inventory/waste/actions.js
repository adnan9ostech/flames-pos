'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { recordDishWaste } from '@/lib/inventory/waste.mjs'

/*
 * Dish waste. The verb does the work — recipes, sub-recipes, the ledger, the
 * audit row — and this is the `inventory` gate and the envelope.
 */

export async function getWasteBoard() {
    try {
        await requirePermission('inventory')
        const [items, docs] = await Promise.all([
            query('SELECT id, name, variants FROM menu_items WHERE is_archived = 0 ORDER BY name'),
            query(
                `SELECT d.id, d.business_date, d.reason, d.created_at,
                        u.full_name, u.username,
                        COALESCE(SUM(l.cost), 0) AS cost, COUNT(l.id) AS line_count
                   FROM waste_docs d
                   LEFT JOIN waste_lines l ON l.waste_doc_id = d.id
                   LEFT JOIN users u ON u.id = d.posted_by
                  GROUP BY d.id, d.business_date, d.reason, d.created_at, u.full_name, u.username
                  ORDER BY d.id DESC LIMIT 50`,
            ),
        ])
        const lines = docs.length
            ? await query(
                `SELECT l.waste_doc_id, l.qty, l.variant_name, l.cost, m.name
                   FROM waste_lines l JOIN menu_items m ON m.id = l.menu_item_id
                  WHERE l.waste_doc_id IN (?) ORDER BY l.id`,
                [docs.map((d) => d.id)],
            )
            : []
        return {
            data: {
                items,
                docs: docs.map((d) => ({
                    ...d,
                    by: d.full_name || d.username || null,
                    lines: lines.filter((l) => l.waste_doc_id === d.id),
                })),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function recordWaste({ reason, lines } = {}) {
    try {
        const user = await requirePermission('inventory')
        return { data: await recordDishWaste({ reason, lines, userId: user.id }) }
    } catch (e) {
        return { error: e.message }
    }
}

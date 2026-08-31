'use server'

import { query } from '@/lib/db/pool.mjs'
import { requireUser } from '@/lib/db/auth.mjs'

/*
 * The three numbers the dashboard leads with. Read-only, so staff can see
 * them too — the admin gate sits on the pages that change things.
 */
export async function getInventoryOverview() {
    try {
        await requireUser()

        const [valueRows, reorderRows, balanceRows] = await Promise.all([
            // Stock on hand priced at moving-average cost. Inactive items are
            // included on purpose: stock already on the shelf is still money,
            // whatever the item's ordering status.
            query(
                `SELECT COALESCE(SUM(q.qty * i.avg_cost), 0) AS stock_value
                 FROM inventory_items i
                 JOIN (SELECT inventory_item_id, SUM(delta) AS qty
                       FROM stock_ledger GROUP BY inventory_item_id) q
                   ON q.inventory_item_id = i.id`,
            ),
            // Only items that have a reorder level set — a level of 0 means
            // "not tracked", and counting those would flag the whole catalog.
            query(
                `SELECT COUNT(*) AS n
                 FROM inventory_items i
                 LEFT JOIN (SELECT inventory_item_id, SUM(delta) AS qty
                            FROM stock_ledger GROUP BY inventory_item_id) q
                   ON q.inventory_item_id = i.id
                 WHERE i.is_active = 1
                   AND i.reorder_level > 0
                   AND COALESCE(q.qty, 0) < i.reorder_level`,
            ),
            query(
                `SELECT s.id, COALESCE(r.t, 0) - COALESCE(p.t, 0) AS balance
                 FROM suppliers s
                 LEFT JOIN (SELECT supplier_id, SUM(total) AS t
                            FROM stock_receivings GROUP BY supplier_id) r
                   ON r.supplier_id = s.id
                 LEFT JOIN (SELECT supplier_id, SUM(amount) AS t
                            FROM supplier_payments GROUP BY supplier_id) p
                   ON p.supplier_id = s.id`,
            ),
        ])

        // Summed over positive balances only: an advance paid to one supplier
        // must not quietly shrink what is owed to the others.
        const supplierPayables = balanceRows
            .filter((row) => Number(row.balance) > 0)
            .reduce((sum, row) => sum + Number(row.balance), 0)

        return {
            data: {
                stockValue: Number(valueRows[0]?.stock_value ?? 0),
                belowReorder: Number(reorderRows[0]?.n ?? 0),
                supplierPayables,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

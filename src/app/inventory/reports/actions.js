'use server'

/*
 * Read-side intelligence over the stock ledger. Every figure here is a
 * restatement of ledger rows at the moment of the query — nothing cached,
 * nothing written — so a report can never disagree with the documents
 * that feed it.
 */

import { query } from '@/lib/db/pool.mjs'
import { requireAdmin } from '@/lib/db/auth.mjs'

/*
 * How far back consumption is averaged. Business days track the Karachi
 * calendar until day-close writes real rows, so a calendar window is the
 * honest version of "the last 14 business days".
 */
const CONSUMPTION_DAYS = 14

/* Newest movements a single item-ledger fetch returns. */
const LEDGER_LIMIT = 300

const karachiDay = (date = new Date()) =>
    date.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

const karachiDaysAgo = (n) => karachiDay(new Date(Date.now() - n * 86_400_000))

const iso = (v) => (v instanceof Date ? v.toISOString() : v)
/* A DATE column parses to midnight UTC; the calendar day is the value. */
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)

/*
 * One round trip feeds four of the five tabs — the item ledger is fetched
 * per item on demand — so switching tabs is instant and every tab reads
 * the ledger at the same moment.
 */
export async function getInventoryReports() {
    try {
        await requireAdmin()
        const windowFrom = karachiDaysAgo(CONSUMPTION_DAYS - 1)

        const [stock, variance, consumption, items] = await Promise.all([
            // Current stock is the ledger sum per item per warehouse. Rows
            // that sum to zero stay: stock that came and went entirely is a
            // fact worth seeing, not an absence.
            query(
                `SELECT i.id AS item_id, i.name, u.abbrev AS unit_abbrev,
                        i.avg_cost, i.reorder_level,
                        w.id AS warehouse_id, w.name AS warehouse_name,
                        SUM(l.delta) AS qty
                 FROM stock_ledger l
                 JOIN inventory_items i ON i.id = l.inventory_item_id
                 JOIN units u ON u.id = i.unit_id
                 JOIN warehouses w ON w.id = l.warehouse_id
                 GROUP BY i.id, i.name, u.abbrev, i.avg_cost, i.reorder_level, w.id, w.name
                 ORDER BY i.name, w.name`,
            ),

            // A count doc's line holds what was COUNTED; its ledger row holds
            // counted − system, written at posting time. System-at-count is
            // reconstructed as counted − delta rather than re-summed, so a
            // movement booked after the count can't rewrite history. The CAST
            // is deliberate: source_id is VARCHAR, and comparing it to a
            // BIGINT would coerce the column instead of the constant.
            query(
                `SELECT d.id AS doc_id, d.business_date, d.reason,
                        w.name AS warehouse_name,
                        i.id AS item_id, i.name AS item_name,
                        u.abbrev AS unit_abbrev, i.avg_cost,
                        dl.qty AS counted,
                        COALESCE(sl.delta, 0) AS variance_qty
                 FROM stock_docs d
                 JOIN warehouses w ON w.id = d.warehouse_id
                 JOIN stock_doc_lines dl ON dl.doc_id = d.id
                 JOIN inventory_items i ON i.id = dl.inventory_item_id
                 JOIN units u ON u.id = i.unit_id
                 LEFT JOIN stock_ledger sl
                   ON sl.source_type = 'count'
                  AND sl.source_id = CAST(d.id AS CHAR)
                  AND sl.inventory_item_id = dl.inventory_item_id
                  AND sl.warehouse_id = d.warehouse_id
                 WHERE d.doc_type = 'count' AND d.posted = 1
                 ORDER BY d.business_date DESC, d.id DESC, i.name`,
            ),

            // Consumption is what left the building as food — 'sale' and
            // 'misc' rows only. Voids and adjustments are corrections, not
            // demand, so they stay out of the average on purpose.
            query(
                `SELECT i.id, i.name, u.abbrev AS unit_abbrev,
                        i.avg_cost, i.reorder_level,
                        COALESCE(q.qty, 0) AS current_qty,
                        COALESCE(c.consumed, 0) AS consumed
                 FROM inventory_items i
                 JOIN units u ON u.id = i.unit_id
                 LEFT JOIN (SELECT inventory_item_id, SUM(delta) AS qty
                            FROM stock_ledger GROUP BY inventory_item_id) q
                   ON q.inventory_item_id = i.id
                 LEFT JOIN (SELECT inventory_item_id, SUM(-delta) AS consumed
                            FROM stock_ledger
                            WHERE source_type IN ('sale', 'misc')
                              AND business_date >= ?
                            GROUP BY inventory_item_id) c
                   ON c.inventory_item_id = i.id
                 WHERE i.is_active = 1
                 ORDER BY i.name`,
                [windowFrom],
            ),

            // The ledger picker offers every item, retired ones included —
            // an inactive item's history is exactly what an audit wants.
            query(
                `SELECT i.id, i.name, u.abbrev AS unit_abbrev
                 FROM inventory_items i
                 JOIN units u ON u.id = i.unit_id
                 ORDER BY i.name`,
            ),
        ])

        return {
            data: {
                asOf: karachiDay(),
                window: { from: windowFrom, days: CONSUMPTION_DAYS },
                stock,
                variance: variance.map((r) => ({ ...r, business_date: day(r.business_date) })),
                consumption,
                items,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Every movement of one item, newest first, with a running balance. The
 * window sums the FULL history oldest-first before the newest rows are
 * kept, so the top row always shows today's true on-hand across all
 * warehouses even when old rows fall off the end.
 */
export async function getItemLedger(itemId) {
    try {
        await requireAdmin()
        const id = Number(itemId)
        if (!Number.isInteger(id) || id <= 0) return { error: 'Pick an item' }

        const itemRows = await query(
            `SELECT i.id, i.name, u.abbrev AS unit_abbrev, i.avg_cost
             FROM inventory_items i
             JOIN units u ON u.id = i.unit_id
             WHERE i.id = ?`,
            [id],
        )
        if (itemRows.length === 0) return { error: 'That item no longer exists' }

        const rows = await query(
            `SELECT l.id, l.business_date, l.at, l.delta, l.unit_cost,
                    l.source_type, l.source_id, w.name AS warehouse_name,
                    SUM(l.delta) OVER (ORDER BY l.at, l.id) AS running
             FROM stock_ledger l
             JOIN warehouses w ON w.id = l.warehouse_id
             WHERE l.inventory_item_id = ?
             ORDER BY l.at DESC, l.id DESC
             LIMIT ${LEDGER_LIMIT}`,
            [id],
        )

        return {
            data: {
                item: itemRows[0],
                truncated: rows.length === LEDGER_LIMIT,
                rows: rows.map((r) => ({
                    ...r,
                    business_date: day(r.business_date),
                    at: iso(r.at),
                })),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

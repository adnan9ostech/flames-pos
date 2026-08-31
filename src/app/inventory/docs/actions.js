'use server'

import { query } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { transferStock, adjustStock, miscConsumption, postCount } from '@/lib/db/inventory.mjs'

const DOC_TYPES = ['transfer', 'adjustment', 'misc', 'count']

/*
 * Everything the four tabs show, one round trip: the pick-lists, on-hand
 * per item per warehouse (the Count tab's "system" column and the variance
 * preview come straight from this), and the recent documents of each type.
 * Any signed-in user can look; the write actions below want `inventory`.
 */
export async function getDocsData() {
    try {
        await requireUser()
        const [items, warehouses, stock, ...recent] = await Promise.all([
            query(
                `SELECT i.id, i.name, u.abbrev AS unit_abbrev
                 FROM inventory_items i
                 JOIN units u ON u.id = i.unit_id
                 WHERE i.is_active = 1
                 ORDER BY i.name`,
            ),
            query('SELECT id, name FROM warehouses ORDER BY name'),
            query(
                `SELECT inventory_item_id, warehouse_id, SUM(delta) AS qty
                 FROM stock_ledger
                 GROUP BY inventory_item_id, warehouse_id`,
            ),
            // A busy type must not push the others out of view, so each tab
            // gets its own recency window.
            ...DOC_TYPES.map((type) => query(
                `SELECT d.id, d.doc_type, d.warehouse_id, d.to_warehouse_id,
                        d.business_date, d.reason, d.created_at,
                        w.name AS warehouse_name, tw.name AS to_warehouse_name
                 FROM stock_docs d
                 JOIN warehouses w ON w.id = d.warehouse_id
                 LEFT JOIN warehouses tw ON tw.id = d.to_warehouse_id
                 WHERE d.doc_type = ?
                 ORDER BY d.id DESC LIMIT 10`,
                [type],
            )),
        ])

        const allDocs = recent.flat()
        const lines = allDocs.length === 0 ? [] : await query(
            `SELECT l.doc_id, l.inventory_item_id, l.qty,
                    i.name AS item_name, u.abbrev AS unit_abbrev
             FROM stock_doc_lines l
             JOIN inventory_items i ON i.id = l.inventory_item_id
             JOIN units u ON u.id = i.unit_id
             WHERE l.doc_id IN (?)
             ORDER BY l.id`,
            [allDocs.map((d) => d.id)],
        )
        const byDoc = new Map()
        for (const line of lines) {
            const list = byDoc.get(line.doc_id) ?? []
            list.push(line)
            byDoc.set(line.doc_id, list)
        }

        const docs = {}
        DOC_TYPES.forEach((type, i) => {
            docs[type] = serializeRows('stock_docs', recent[i])
                .map((d) => ({ ...d, lines: byDoc.get(d.id) ?? [] }))
        })

        return {
            data: {
                items,
                warehouses,
                stock: stock.map((s) => ({ ...s, qty: Number(s.qty) })),
                docs,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Thin envelopes: validation, ledger rows and the audit trail live in the
 * kernel verbs — these hold the `inventory` gate and translate throws for the
 * screen.
 */

export async function createTransfer({ fromWarehouseId, toWarehouseId, lines, reason } = {}) {
    try {
        await requirePermission('inventory')
        return { data: await transferStock({ fromWarehouseId, toWarehouseId, lines, reason }) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function createAdjustment({ warehouseId, lines, reason } = {}) {
    try {
        await requirePermission('inventory')
        return { data: await adjustStock({ warehouseId, lines, reason }) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function createMisc({ warehouseId, lines, reason } = {}) {
    try {
        await requirePermission('inventory')
        return { data: await miscConsumption({ warehouseId, lines, reason }) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function createCount({ warehouseId, lines } = {}) {
    try {
        await requirePermission('inventory')
        return { data: await postCount({ warehouseId, lines }) }
    } catch (e) {
        return { error: e.message }
    }
}

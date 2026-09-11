'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { karachiDay } from '@/lib/day/karachi.mjs'

/*
 * Purchase orders: what was ordered from a supplier, at what price, for when.
 *
 * The stock room already had the two ends — the kitchen's demand draft and the
 * receiving that costs goods in — and nothing in between. This is the middle:
 * the thing a supplier is held to when the delivery turns up short or dearer
 * than agreed.
 *
 * Receiving one is NOT done here. It goes through the same `receiveStock`
 * kernel verb every other delivery uses, with the order's id attached; that
 * verb closes the order inside the same transaction as the ledger rows. One
 * path into stock, whatever paperwork it started from.
 */

const round3 = (n) => Math.round(Number(n) * 1000) / 1000
const round4 = (n) => Math.round(Number(n) * 10000) / 10000

export async function getPurchaseOrders() {
    try {
        await requirePermission('inventory')
        const [orders, suppliers, warehouses, items] = await Promise.all([
            query(
                `SELECT po.id, po.po_number, po.status, po.expected_on, po.notes, po.total,
                        po.created_at, po.closed_at,
                        s.name AS supplier_name, w.name AS warehouse_name,
                        po.supplier_id, po.warehouse_id
                   FROM purchase_orders po
                   JOIN suppliers s ON s.id = po.supplier_id
                   JOIN warehouses w ON w.id = po.warehouse_id
                  ORDER BY FIELD(po.status, 'open', 'received', 'cancelled'), po.created_at DESC
                  LIMIT 100`,
            ),
            query('SELECT id, name FROM suppliers WHERE is_active = 1 ORDER BY name'),
            query('SELECT id, name FROM warehouses ORDER BY name'),
            query(
                `SELECT i.id, i.name, i.avg_cost, u.abbrev AS unit_abbrev
                   FROM inventory_items i JOIN units u ON u.id = i.unit_id
                  WHERE i.is_active = 1 ORDER BY i.name`,
            ),
        ])

        const lines = orders.length
            ? await query(
                `SELECT l.purchase_order_id, l.qty, l.unit_cost, i.name, u.abbrev AS unit_abbrev
                   FROM purchase_order_lines l
                   JOIN inventory_items i ON i.id = l.inventory_item_id
                   JOIN units u ON u.id = i.unit_id
                  WHERE l.purchase_order_id IN (?)
                  ORDER BY l.id`,
                [orders.map((o) => o.id)],
            )
            : []

        return {
            data: {
                suppliers,
                warehouses,
                items,
                orders: orders.map((o) => ({
                    ...o,
                    lines: lines.filter((l) => l.purchase_order_id === o.id),
                })),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Raise one. The number is minted inside the transaction from the count of
 * orders in the same business day — PO-260911-03 — so two people raising one
 * at once cannot mint the same number: the insert would collide on the unique
 * key rather than quietly duplicating it.
 */
export async function createPurchaseOrder({ supplierId, warehouseId, expectedOn, notes, lines } = {}) {
    try {
        const user = await requirePermission('inventory')
        const supplier = Number(supplierId)
        const warehouse = Number(warehouseId)
        if (!Number.isInteger(supplier) || supplier <= 0) throw new Error('Pick a supplier')
        if (!Number.isInteger(warehouse) || warehouse <= 0) throw new Error('Pick a warehouse')
        if (!Array.isArray(lines) || lines.length === 0) throw new Error('An order needs at least one line')

        const clean = lines.map((l) => {
            const itemId = Number(l.itemId)
            const qty = round3(l.qty)
            const unitCost = round4(l.unitCost)
            if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('A line is missing its item')
            if (!(qty > 0)) throw new Error('Every line needs a quantity above zero')
            if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error('Every line needs an agreed price of zero or more')
            return { itemId, qty, unitCost }
        })
        const total = Math.round(clean.reduce((sum, l) => sum + l.qty * l.unitCost, 0) * 100) / 100

        const id = await withTransaction(async (conn) => {
            const day = karachiDay()
            const [[seq] = []] = await conn.query(
                'SELECT COUNT(*) AS n FROM purchase_orders WHERE DATE(created_at) = ?', [day],
            )
            const poNumber = `PO-${day.slice(2).replaceAll('-', '')}-${String(Number(seq.n) + 1).padStart(2, '0')}`

            const [res] = await conn.query(
                `INSERT INTO purchase_orders
                   (po_number, supplier_id, warehouse_id, expected_on, notes, total, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [poNumber, supplier, warehouse,
                    expectedOn || null,
                    String(notes ?? '').trim().slice(0, 191) || null,
                    total, user.id],
            )
            const poId = res.insertId
            await conn.query(
                'INSERT INTO purchase_order_lines (purchase_order_id, inventory_item_id, qty, unit_cost) VALUES ?',
                [clean.map((l) => [poId, l.itemId, l.qty, l.unitCost])],
            )
            return poId
        })

        return { data: { id } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Cancel one. One way, and only from open: an order that could be reopened is
 * an order whose history cannot be trusted, and the receiving verb refuses a
 * closed one anyway.
 */
export async function cancelPurchaseOrder(id) {
    try {
        await requirePermission('inventory')
        const rows = await query('SELECT status FROM purchase_orders WHERE id = ?', [Number(id)])
        if (!rows.length) return { error: 'That purchase order no longer exists' }
        if (rows[0].status !== 'open') return { error: 'Only an open order can be cancelled' }
        await query(
            "UPDATE purchase_orders SET status = 'cancelled', closed_at = UTC_TIMESTAMP(3) WHERE id = ?",
            [Number(id)],
        )
        return { data: { cancelled: true } }
    } catch (e) {
        return { error: e.message }
    }
}

/* The order's lines, shaped the way the receiving screen wants them. */
export async function getPurchaseOrderForReceiving(id) {
    try {
        await requirePermission('inventory')
        const [po] = await query(
            'SELECT id, po_number, supplier_id, warehouse_id, status FROM purchase_orders WHERE id = ?',
            [Number(id)],
        )
        if (!po) return { error: 'That purchase order no longer exists' }
        if (po.status !== 'open') return { error: 'That purchase order is already closed' }
        const lines = await query(
            `SELECT l.inventory_item_id AS itemId, l.qty, l.unit_cost AS unitCost, i.name,
                    u.abbrev AS unit_abbrev
               FROM purchase_order_lines l
               JOIN inventory_items i ON i.id = l.inventory_item_id
               JOIN units u ON u.id = i.unit_id
              WHERE l.purchase_order_id = ? ORDER BY l.id`,
            [po.id],
        )
        return { data: { ...serializeRows('purchase_orders', [po])[0], lines } }
    } catch (e) {
        return { error: e.message }
    }
}

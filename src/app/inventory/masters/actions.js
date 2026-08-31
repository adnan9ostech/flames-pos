'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/*
 * The trading day the audit row belongs to: the open business day once
 * day-close is in use, else the Karachi calendar day — the same resolution
 * the money verbs apply, restated here because the kernel keeps its copy
 * private.
 */
const auditLog = async (conn, action, details) => {
    const [rows] = await conn.query(
        `SELECT business_date FROM business_days
         WHERE branch_id = 1 AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
    )
    const d = rows[0]?.business_date
    const businessDate = d
        ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d))
        : karachiDay()
    await conn.query(
        `INSERT INTO audit_log (branch_id, business_date, action, details)
         VALUES (1, ?, ?, ?)`,
        [businessDate, action, JSON.stringify(details)],
    )
}

/* MySQL's duplicate-key error, translated for the person at the screen. */
const friendly = (e, what) =>
    e.code === 'ER_DUP_ENTRY' ? `A ${what} with that name already exists` : e.message

const cleanName = (value, label, max = 191) => {
    const name = String(value ?? '').trim()
    if (!name) throw new Error(`${label} needs a name`)
    if (name.length > max) throw new Error(`${label} name is too long`)
    return name
}

/*
 * Everything the four tabs show, in one round trip. Staff can look; only the
 * write actions below want `inventory`.
 */
export async function getMasters() {
    try {
        await requireUser()
        const [items, units, suppliers, warehouses] = await Promise.all([
            // On-hand is the ledger sum across all warehouses — the ledger is
            // the single version of the truth, so there is nothing to cache.
            query(
                `SELECT i.id, i.name, i.unit_id, i.avg_cost, i.reorder_level, i.is_active,
                        u.abbrev AS unit_abbrev,
                        COALESCE(q.qty, 0) AS current_qty
                 FROM inventory_items i
                 JOIN units u ON u.id = i.unit_id
                 LEFT JOIN (SELECT inventory_item_id, SUM(delta) AS qty
                            FROM stock_ledger GROUP BY inventory_item_id) q
                   ON q.inventory_item_id = i.id
                 ORDER BY i.name`,
            ),
            query('SELECT id, name, abbrev FROM units ORDER BY name'),
            query(
                `SELECT id, name, phone, ntn, address, is_active
                 FROM suppliers ORDER BY name`,
            ),
            query('SELECT id, name FROM warehouses ORDER BY name'),
        ])
        return {
            data: {
                items: items.map((r) => ({ ...r, is_active: Boolean(r.is_active) })),
                units,
                suppliers: suppliers.map((r) => ({ ...r, is_active: Boolean(r.is_active) })),
                warehouses,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * avg_cost is deliberately not writable here: it is a computed fact of
 * receivings, and a hand-edited cost would silently reprice every recipe.
 */
export async function saveItem({ id = null, name, unit_id, reorder_level, is_active = true }) {
    try {
        await requirePermission('inventory')
        const itemName = cleanName(name, 'An item')
        const unitId = Number(unit_id)
        if (!Number.isInteger(unitId) || unitId <= 0) throw new Error('Pick a unit')
        const reorder = Number(reorder_level)
        if (!Number.isFinite(reorder) || reorder < 0) throw new Error('Reorder level must be zero or more')

        const savedId = await withTransaction(async (conn) => {
            if (id) {
                const [res] = await conn.query(
                    `UPDATE inventory_items
                     SET name = ?, unit_id = ?, reorder_level = ?, is_active = ?,
                         updated_at = UTC_TIMESTAMP(3)
                     WHERE id = ?`,
                    [itemName, unitId, reorder, is_active ? 1 : 0, id],
                )
                if (res.affectedRows === 0) throw new Error('That item no longer exists')
                await auditLog(conn, 'inventory_item_update', {
                    id, name: itemName, unit_id: unitId, reorder_level: reorder,
                    is_active: Boolean(is_active),
                })
                return id
            }
            const [res] = await conn.query(
                `INSERT INTO inventory_items (name, unit_id, reorder_level, is_active)
                 VALUES (?, ?, ?, ?)`,
                [itemName, unitId, reorder, is_active ? 1 : 0],
            )
            await auditLog(conn, 'inventory_item_create', {
                id: res.insertId, name: itemName, unit_id: unitId, reorder_level: reorder,
            })
            return res.insertId
        })
        return { data: { id: savedId } }
    } catch (e) {
        return { error: friendly(e, 'stock item') }
    }
}

export async function saveUnit({ id = null, name, abbrev }) {
    try {
        await requirePermission('inventory')
        const unitName = cleanName(name, 'A unit', 32)
        const short = String(abbrev ?? '').trim()
        if (!short) throw new Error('A unit needs an abbreviation')
        if (short.length > 8) throw new Error('Abbreviation is too long')

        const savedId = await withTransaction(async (conn) => {
            if (id) {
                const [res] = await conn.query(
                    'UPDATE units SET name = ?, abbrev = ? WHERE id = ?',
                    [unitName, short, id],
                )
                if (res.affectedRows === 0) throw new Error('That unit no longer exists')
                await auditLog(conn, 'unit_update', { id, name: unitName, abbrev: short })
                return id
            }
            const [res] = await conn.query(
                'INSERT INTO units (name, abbrev) VALUES (?, ?)',
                [unitName, short],
            )
            await auditLog(conn, 'unit_create', { id: res.insertId, name: unitName, abbrev: short })
            return res.insertId
        })
        return { data: { id: savedId } }
    } catch (e) {
        return { error: friendly(e, 'unit') }
    }
}

export async function saveSupplier({ id = null, name, phone, ntn, address, is_active = true }) {
    try {
        await requirePermission('inventory')
        const supplierName = cleanName(name, 'A supplier')
        const clean = (v, max) => String(v ?? '').trim().slice(0, max) || null

        const savedId = await withTransaction(async (conn) => {
            if (id) {
                const [res] = await conn.query(
                    `UPDATE suppliers SET name = ?, phone = ?, ntn = ?, address = ?, is_active = ?
                     WHERE id = ?`,
                    [supplierName, clean(phone, 32), clean(ntn, 16), clean(address, 500),
                        is_active ? 1 : 0, id],
                )
                if (res.affectedRows === 0) throw new Error('That supplier no longer exists')
                await auditLog(conn, 'supplier_update', {
                    id, name: supplierName, is_active: Boolean(is_active),
                })
                return id
            }
            const [res] = await conn.query(
                `INSERT INTO suppliers (name, phone, ntn, address, is_active)
                 VALUES (?, ?, ?, ?, ?)`,
                [supplierName, clean(phone, 32), clean(ntn, 16), clean(address, 500),
                    is_active ? 1 : 0],
            )
            await auditLog(conn, 'supplier_create', { id: res.insertId, name: supplierName })
            return res.insertId
        })
        return { data: { id: savedId } }
    } catch (e) {
        return { error: friendly(e, 'supplier') }
    }
}

export async function saveWarehouse({ id = null, name }) {
    try {
        await requirePermission('inventory')
        const warehouseName = cleanName(name, 'A warehouse', 64)

        const savedId = await withTransaction(async (conn) => {
            if (id) {
                const [res] = await conn.query(
                    'UPDATE warehouses SET name = ? WHERE id = ?',
                    [warehouseName, id],
                )
                if (res.affectedRows === 0) throw new Error('That warehouse no longer exists')
                await auditLog(conn, 'warehouse_update', { id, name: warehouseName })
                return id
            }
            const [res] = await conn.query(
                'INSERT INTO warehouses (name) VALUES (?)',
                [warehouseName],
            )
            await auditLog(conn, 'warehouse_create', { id: res.insertId, name: warehouseName })
            return res.insertId
        })
        return { data: { id: savedId } }
    } catch (e) {
        return { error: friendly(e, 'warehouse') }
    }
}

'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { receiveStock } from '@/lib/db/inventory.mjs'

/*
 * The general ledger, after the GRN has committed — the same posture as the
 * order hooks in orderActions.js: the stock is already in and the payable
 * already owed, so a ledger fault logs inside the poster and stops there.
 * Idempotent on (source_type, source_id) in the database.
 */
const fireGlAfterReceiving = (receivingId, userId) => {
    import('@/lib/accounts/otherPost.mjs')
        .then((m) => m.afterReceivingGl(receivingId, { userId }))
        .catch(() => {})
}

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/*
 * The trading day the audit row belongs to — the same resolution the money
 * verbs apply, restated here because the kernel keeps its copy private.
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

/* Hangs each parent's lines off it in one grouped pass. */
const attachLines = (parents, lines, key) => {
    const byParent = new Map()
    for (const line of lines) {
        const list = byParent.get(line[key]) ?? []
        list.push(line)
        byParent.set(line[key], list)
    }
    return parents.map((p) => ({ ...p, lines: byParent.get(p.id) ?? [] }))
}

/*
 * Everything the receiving screen shows, one round trip. Staff can look;
 * the write actions below want `inventory`.
 */
export async function getReceivingData() {
    try {
        await requireUser()
        const [suppliers, warehouses, items, drafts, receivings] = await Promise.all([
            query('SELECT id, name FROM suppliers WHERE is_active = 1 ORDER BY name'),
            query('SELECT id, name FROM warehouses ORDER BY name'),
            query(
                `SELECT i.id, i.name, i.avg_cost, u.abbrev AS unit_abbrev
                 FROM inventory_items i
                 JOIN units u ON u.id = i.unit_id
                 WHERE i.is_active = 1
                 ORDER BY i.name`,
            ),
            query('SELECT id, status, notes, created_at FROM demand_drafts ORDER BY id DESC LIMIT 20'),
            query(
                `SELECT r.id, r.supplier_id, r.warehouse_id, r.draft_id, r.supplier_invoice,
                        r.business_date, r.total, r.notes, r.created_at,
                        s.name AS supplier_name, w.name AS warehouse_name
                 FROM stock_receivings r
                 JOIN suppliers s ON s.id = r.supplier_id
                 JOIN warehouses w ON w.id = r.warehouse_id
                 ORDER BY r.id DESC LIMIT 20`,
            ),
        ])

        const [draftLines, receivingLines] = await Promise.all([
            drafts.length === 0 ? [] : query(
                `SELECT l.draft_id, l.inventory_item_id, l.qty, i.name AS item_name, u.abbrev AS unit_abbrev
                 FROM demand_draft_lines l
                 JOIN inventory_items i ON i.id = l.inventory_item_id
                 JOIN units u ON u.id = i.unit_id
                 WHERE l.draft_id IN (?)
                 ORDER BY l.id`,
                [drafts.map((d) => d.id)],
            ),
            receivings.length === 0 ? [] : query(
                `SELECT l.receiving_id, l.inventory_item_id, l.qty, l.unit_cost,
                        i.name AS item_name, u.abbrev AS unit_abbrev
                 FROM stock_receiving_lines l
                 JOIN inventory_items i ON i.id = l.inventory_item_id
                 JOIN units u ON u.id = i.unit_id
                 WHERE l.receiving_id IN (?)
                 ORDER BY l.id`,
                [receivings.map((r) => r.id)],
            ),
        ])

        return {
            data: {
                suppliers,
                warehouses,
                items,
                drafts: attachLines(serializeRows('demand_drafts', drafts), draftLines, 'draft_id'),
                receivings: attachLines(serializeRows('stock_receivings', receivings), receivingLines, 'receiving_id'),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Post a GRN. Validation, the ledger rows, the moving-average update and
 * the audit trail all live in the kernel verb — this is the `inventory` gate and
 * the envelope.
 */
export async function createReceiving({ supplierId, warehouseId, draftId, supplierInvoice, lines, notes } = {}) {
    try {
        const user = await requirePermission('inventory')
        const data = await receiveStock({ supplierId, warehouseId, draftId, supplierInvoice, lines, notes })
        fireGlAfterReceiving(data.id, user.id)
        return { data }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * A demand draft is the kitchen's shopping list, before money moves. It
 * still audits: what was asked for matters when the GRN arrives short.
 */
export async function createDraft({ lines, notes } = {}) {
    try {
        await requirePermission('inventory')
        if (!Array.isArray(lines) || lines.length === 0) {
            return { error: 'A draft needs at least one line' }
        }
        const clean = lines.map((l) => {
            const itemId = Number(l.itemId)
            const qty = Math.round(Number(l.qty) * 1000) / 1000
            if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('A line is missing its item')
            if (!(qty > 0)) throw new Error('Every line needs a quantity above zero')
            return { itemId, qty }
        })
        const note = String(notes ?? '').trim().slice(0, 191) || null

        const draftId = await withTransaction(async (conn) => {
            const [items] = await conn.query(
                'SELECT id FROM inventory_items WHERE id IN (?)',
                [[...new Set(clean.map((l) => l.itemId))]],
            )
            if (items.length !== new Set(clean.map((l) => l.itemId)).size) {
                throw new Error('A line points at a stock item that no longer exists')
            }
            const [res] = await conn.query(
                'INSERT INTO demand_drafts (notes) VALUES (?)', [note],
            )
            await conn.query(
                'INSERT INTO demand_draft_lines (draft_id, inventory_item_id, qty) VALUES ?',
                [clean.map((l) => [res.insertId, l.itemId, l.qty])],
            )
            await auditLog(conn, 'demand_draft_create', {
                draft_id: res.insertId, lines: clean.length,
            })
            return res.insertId
        })
        return { data: { id: draftId } }
    } catch (e) {
        return { error: e.message }
    }
}

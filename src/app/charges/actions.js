'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requireAdmin } from '@/lib/db/auth.mjs'

const ORDER_TYPES = ['dine-in', 'takeaway', 'delivery']

/*
 * The trading day this write belongs to — the open business day once day
 * close exists, the Karachi calendar day until then. Same resolution the
 * money verbs use, restated here because the kernel keeps its copy private.
 */
const businessDate = async () => {
    const rows = await query(
        `SELECT business_date FROM business_days
         WHERE branch_id = 1 AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
    )
    if (rows.length === 0) {
        return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })
    }
    const d = rows[0].business_date
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d)
}

const audit = (conn, bd, action, details) =>
    conn.query(
        `INSERT INTO audit_log (branch_id, business_date, action, details)
         VALUES (1, ?, ?, ?)`,
        [bd, action, JSON.stringify(details)],
    )

/*
 * What the page consumes. Flags come back from MySQL as 0/1 and the toggle
 * renders from truthiness, so they are made real booleans here rather than
 * trusting every call site to coerce.
 */
const toRow = (r) => ({
    id: r.id,
    name: r.name,
    value_type: r.value_type,
    value: Number(r.value),
    order_types: Array.isArray(r.order_types) ? r.order_types : [],
    before_tax: Boolean(r.before_tax),
    auto_apply: Boolean(r.auto_apply),
    is_active: Boolean(r.is_active),
})

/*
 * Validation lives server-side because the form is a hint, not a guarantee —
 * a 200% service charge typed into devtools would otherwise ride onto every
 * dine-in bill at the next recompute.
 */
const cleanCharge = (input) => {
    const name = String(input?.name ?? '').trim()
    if (!name) throw new Error('A charge needs a name')
    if (name.length > 64) throw new Error('Charge name is too long (64 characters max)')

    const value_type = ['percent', 'fixed'].includes(input?.value_type) ? input.value_type : null
    if (!value_type) throw new Error('Value type must be percent or fixed')

    const value = Number(input?.value)
    if (!Number.isFinite(value) || value < 0) throw new Error('Value must be zero or more')
    if (value_type === 'percent' && value > 100) throw new Error('A percent charge cannot exceed 100')

    // Unknown types are dropped rather than stored: the kernel matches these
    // strings verbatim against order_type, so a typo would silently never apply.
    const order_types = [...new Set(
        (Array.isArray(input?.order_types) ? input.order_types : [])
            .filter((t) => ORDER_TYPES.includes(t)),
    )]

    return {
        name,
        value_type,
        value: Math.round(value * 100) / 100,
        order_types,
        before_tax: Boolean(input?.before_tax),
        auto_apply: Boolean(input?.auto_apply),
        is_active: input?.is_active === undefined ? true : Boolean(input.is_active),
    }
}

const requireId = (id) => {
    const n = Number(id)
    if (!Number.isInteger(n) || n <= 0) throw new Error('That charge no longer exists')
    return n
}

export async function listCharges() {
    try {
        await requireAdmin()
        const rows = await query('SELECT * FROM charges ORDER BY is_active DESC, name')
        return { data: rows.map(toRow) }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * The list the till prices its cart against — the SAME filter the kernel's
 * recompute uses, so what the cart shows is what settle will charge.
 * Any signed-in role: staff ring bills too.
 */
export async function listActiveCharges() {
    try {
        await requireUser()
        const rows = await query(
            `SELECT name, value_type, value, order_types, before_tax
             FROM charges WHERE is_active = 1 AND auto_apply = 1`,
        )
        return {
            data: rows.map((r) => ({
                name: r.name,
                value_type: r.value_type,
                value: Number(r.value),
                order_types: Array.isArray(r.order_types) ? r.order_types : [],
                before_tax: Boolean(r.before_tax),
            })),
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveCharge(input) {
    try {
        await requireAdmin()
        const clean = cleanCharge(input)
        const id = input?.id ? requireId(input.id) : null
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            let chargeId = id
            if (id) {
                const [result] = await conn.query(
                    `UPDATE charges SET
                       name = ?, value_type = ?, value = ?, order_types = ?,
                       before_tax = ?, auto_apply = ?, is_active = ?,
                       updated_at = UTC_TIMESTAMP(3)
                     WHERE id = ?`,
                    [clean.name, clean.value_type, clean.value, JSON.stringify(clean.order_types),
                        clean.before_tax ? 1 : 0, clean.auto_apply ? 1 : 0, clean.is_active ? 1 : 0, id],
                )
                if (result.affectedRows === 0) throw new Error('That charge no longer exists')
            } else {
                const [result] = await conn.query(
                    `INSERT INTO charges (name, value_type, value, order_types, before_tax, auto_apply, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [clean.name, clean.value_type, clean.value, JSON.stringify(clean.order_types),
                        clean.before_tax ? 1 : 0, clean.auto_apply ? 1 : 0, clean.is_active ? 1 : 0],
                )
                chargeId = result.insertId
            }

            // Audited because this reshapes every future bill it applies to.
            await audit(conn, bd, 'save_charge', {
                charge_id: chargeId, mode: id ? 'update' : 'create', ...clean,
            })

            const [rows] = await conn.query('SELECT * FROM charges WHERE id = ?', [chargeId])
            return rows[0]
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function toggleCharge(id) {
    try {
        await requireAdmin()
        const chargeId = requireId(id)
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            const [result] = await conn.query(
                `UPDATE charges SET is_active = 1 - is_active, updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [chargeId],
            )
            if (result.affectedRows === 0) throw new Error('That charge no longer exists')
            const [rows] = await conn.query('SELECT * FROM charges WHERE id = ?', [chargeId])
            await audit(conn, bd, 'toggle_charge', {
                charge_id: chargeId, name: rows[0].name, is_active: Boolean(rows[0].is_active),
            })
            return rows[0]
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function deleteCharge(id) {
    try {
        await requireAdmin()
        const chargeId = requireId(id)
        const bd = await businessDate()

        await withTransaction(async (conn) => {
            // Safe to hard-delete: settled orders keep their own snapshot in
            // orders.charges, so history never points back at this row.
            const [rows] = await conn.query('SELECT name, value_type, value FROM charges WHERE id = ?', [chargeId])
            if (rows.length === 0) throw new Error('That charge no longer exists')
            await conn.query('DELETE FROM charges WHERE id = ?', [chargeId])
            await audit(conn, bd, 'delete_charge', { charge_id: chargeId, ...rows[0] })
        })
        return { data: { id: chargeId } }
    } catch (e) {
        return { error: e.message }
    }
}

'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { requirePermission, requireUser } from '@/lib/db/auth.mjs'

/*
 * The floor: who serves and where they serve. Both lists are small, both are
 * picked from at the till, and neither is ever deleted once used — a waiter
 * or table that has bills against it is retired (is_active = 0) so the
 * history keeps its names. `orders` stores waiter_name and table_number as
 * text beside the ids for exactly that reason.
 */

const audit = (action, details) =>
    query(
        `INSERT INTO audit_log (branch_id, business_date, action, details)
         VALUES (1, CURRENT_DATE, ?, ?)`,
        [action, JSON.stringify(details)],
    )

// ==================== WAITERS ====================

export async function listWaiters() {
    try {
        await requirePermission('setup')
        return {
            data: serializeRows('waiters', await query(
                'SELECT * FROM waiters ORDER BY is_active DESC, name',
            )),
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveWaiter({ id = null, name, code }) {
    try {
        await requirePermission('setup')
        const cleanName = (name || '').trim()
        const cleanCode = (code || '').trim() || null
        if (!cleanName) return { error: 'A waiter needs a name' }

        if (id) {
            await query(
                'UPDATE waiters SET name = ?, code = ? WHERE id = ?',
                [cleanName, cleanCode, id],
            )
            await audit('waiter_save', { id, name: cleanName, code: cleanCode })
        } else {
            const newId = randomUUID()
            await query(
                'INSERT INTO waiters (id, name, code, is_active) VALUES (?, ?, ?, 1)',
                [newId, cleanName, cleanCode],
            )
            await audit('waiter_save', { id: newId, name: cleanName, code: cleanCode, created: true })
        }
        revalidatePath('/floor')
        return { data: true }
    } catch (e) {
        // The code is unique so two waiters cannot share one; say so plainly
        // rather than surfacing the driver's constraint name.
        if (e.errno === 1062) return { error: `Code "${(code || '').trim()}" is already taken` }
        return { error: e.message }
    }
}

export async function toggleWaiter(id) {
    try {
        await requirePermission('setup')
        await query('UPDATE waiters SET is_active = NOT is_active WHERE id = ?', [id])
        const [row] = await query('SELECT name, is_active FROM waiters WHERE id = ?', [id])
        await audit('waiter_toggle', { id, name: row?.name, active: Boolean(row?.is_active) })
        revalidatePath('/floor')
        return { data: true }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * What deleting would actually cost, counted rather than guessed — the
 * dialog quotes these numbers back, and "12 orders" is a different decision
 * from "none".
 */
export async function waiterDeleteImpact(id) {
    try {
        await requirePermission('setup')
        const [w] = await query('SELECT name FROM waiters WHERE id = ?', [id])
        if (!w) return { error: 'That waiter is already gone' }
        const [{ n }] = await query('SELECT COUNT(*) AS n FROM orders WHERE waiter_id = ?', [id])
        return { data: { name: w.name, orders: Number(n) } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Hard delete. The bills keep the waiter's NAME (orders.waiter_name is
 * denormalised precisely so a departed waiter's receipts still read right);
 * what is lost is the link reports group by, so those orders stop counting
 * toward anyone. The whole row goes into the audit log first, which is what
 * makes this recoverable by hand.
 */
export async function deleteWaiter(id) {
    try {
        await requirePermission('setup')
        const [row] = await query('SELECT * FROM waiters WHERE id = ?', [id])
        if (!row) return { error: 'That waiter is already gone' }
        const [{ n }] = await query('SELECT COUNT(*) AS n FROM orders WHERE waiter_id = ?', [id])

        await audit('waiter_delete', { deleted: row, orders_unlinked: Number(n) })
        // orders.waiter_id is ON DELETE SET NULL, so the bills survive.
        await query('DELETE FROM waiters WHERE id = ?', [id])

        revalidatePath('/floor')
        return { data: { orders: Number(n) } }
    } catch (e) {
        return { error: e.message }
    }
}

// ==================== TABLES ====================

export async function listTables() {
    try {
        await requirePermission('setup')
        return {
            data: serializeRows('dining_tables', await query(
                'SELECT * FROM dining_tables ORDER BY is_active DESC, sort_order, name',
            )),
        }
    } catch (e) {
        return { error: e.message }
    }
}

/* What the till's table picker offers — active tables, in floor order. */
export async function listActiveTables() {
    try {
        await requireUser()
        const rows = await query(
            'SELECT name, area FROM dining_tables WHERE is_active = 1 ORDER BY sort_order, name',
        )
        return { data: rows }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveTable({ id = null, name, seats, area, sort_order }) {
    try {
        await requirePermission('setup')
        const cleanName = (name || '').trim()
        if (!cleanName) return { error: 'A table needs a name' }
        const seatCount = Number(seats) > 0 ? Math.floor(Number(seats)) : null
        const cleanArea = (area || '').trim() || null
        const order = Number.isFinite(Number(sort_order)) ? Math.floor(Number(sort_order)) : 0

        if (id) {
            await query(
                'UPDATE dining_tables SET name = ?, seats = ?, area = ?, sort_order = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [cleanName, seatCount, cleanArea, order, id],
            )
            await audit('table_save', { id, name: cleanName })
        } else {
            await query(
                'INSERT INTO dining_tables (name, seats, area, sort_order) VALUES (?, ?, ?, ?)',
                [cleanName, seatCount, cleanArea, order],
            )
            await audit('table_save', { name: cleanName, created: true })
        }
        revalidatePath('/floor')
        return { data: true }
    } catch (e) {
        if (e.errno === 1062) return { error: `Table "${(name || '').trim()}" already exists` }
        return { error: e.message }
    }
}

export async function tableDeleteImpact(id) {
    try {
        await requirePermission('setup')
        const [t] = await query('SELECT name FROM dining_tables WHERE id = ?', [id])
        if (!t) return { error: 'That table is already gone' }
        // Matched by name, because that is what an order stores.
        const [{ n }] = await query('SELECT COUNT(*) AS n FROM orders WHERE table_number = ?', [t.name])
        return { data: { name: t.name, orders: Number(n) } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Hard delete. Gentler than the waiter case: an order stores the table as
 * plain text with no foreign key, so past bills and reports are untouched —
 * the table simply stops being offered at the till.
 */
export async function deleteTable(id) {
    try {
        await requirePermission('setup')
        const [row] = await query('SELECT * FROM dining_tables WHERE id = ?', [id])
        if (!row) return { error: 'That table is already gone' }
        const [{ n }] = await query('SELECT COUNT(*) AS n FROM orders WHERE table_number = ?', [row.name])

        await audit('table_delete', { deleted: row, past_orders: Number(n) })
        await query('DELETE FROM dining_tables WHERE id = ?', [id])

        revalidatePath('/floor')
        return { data: { orders: Number(n) } }
    } catch (e) {
        return { error: e.message }
    }
}

export async function toggleTable(id) {
    try {
        await requirePermission('setup')
        await query('UPDATE dining_tables SET is_active = NOT is_active, updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [id])
        const [row] = await query('SELECT name, is_active FROM dining_tables WHERE id = ?', [id])
        await audit('table_toggle', { id, name: row?.name, active: Boolean(row?.is_active) })
        revalidatePath('/floor')
        return { data: true }
    } catch (e) {
        return { error: e.message }
    }
}

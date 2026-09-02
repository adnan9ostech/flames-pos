'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { serializeRow, serializeRows } from '@/lib/db/serialize.mjs'

const PAID_FROM = ['drawer', 'bank', 'other']
const STATUSES = ['paid', 'payable']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/*
 * The trading day a voucher books to: the open business day once day-close is
 * in use, else the Karachi calendar day — the same resolution the order verbs
 * apply, so a 1 a.m. vegetable run lands on the same day as the 1 a.m. sales.
 */
const openBusinessDate = async () => {
    const rows = await query(
        `SELECT business_date FROM business_days
         WHERE branch_id = 1 AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
    )
    if (rows.length === 0) return karachiDay()
    const d = rows[0].business_date
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d)
}

/*
 * Money leaving the till is corrected loudly, never silently: every write in
 * this file drops an audit row inside the same transaction, so the voucher
 * and its paper trail commit or roll back together.
 */
const audit = async (conn, businessDate, action, details) => {
    await conn.query(
        'INSERT INTO audit_log (branch_id, business_date, action, details) VALUES (1, ?, ?, ?)',
        [businessDate, action, JSON.stringify(details)],
    )
}

const fetchVoucher = async (conn, id) => {
    const [rows] = await conn.query(
        `SELECT e.*, c.name AS category_name
         FROM expenses e
         LEFT JOIN expense_categories c ON c.id = e.category_id
         WHERE e.id = ?`,
        [id],
    )
    return rows[0] ?? null
}

/*
 * A row a posted expense voucher projected here (voucher_line_id set) is a
 * PROJECTION of that document — 007_expense_links.sql promises it is never
 * marked paid or deleted from this screen on its own, or the drawer and the
 * ledger would tell two stories about the same money. It is paid or
 * reversed on the voucher, which rewrites the projection itself.
 */
const refuseProjected = async (conn, expense) => {
    if (!expense.voucher_line_id) return
    const [rows] = await conn.query(
        `SELECT v.id, v.voucher_no
           FROM expense_voucher_lines l
           JOIN expense_vouchers v ON v.id = l.voucher_id
          WHERE l.id = ?`,
        [expense.voucher_line_id],
    )
    const v = rows[0]
    throw new Error(
        `This expense comes from voucher ${v?.voucher_no ?? 'an expense voucher'} — pay or reverse it under `
        + `Accounts › Expense Vouchers${v ? ` (/accounts/expense-vouchers/${v.id})` : ''}`,
    )
}

/* The trading day this screen opens on: the open business day, which the
 * rows book to, rather than the calendar day. */
export async function getOpenBusinessDay() {
    try {
        await requirePermission('expenses')
        return { data: await openBusinessDate() }
    } catch (e) {
        return { error: e.message }
    }
}

export async function listExpenses({ from, to, status } = {}) {
    try {
        await requirePermission('expenses')
        const where = []
        const params = []
        if (from && DATE_RE.test(from)) { where.push('e.business_date >= ?'); params.push(from) }
        if (to && DATE_RE.test(to)) { where.push('e.business_date <= ?'); params.push(to) }
        if (status && STATUSES.includes(status)) { where.push('e.status = ?'); params.push(status) }
        // voucher_id / voucher_no name the document a projected row came
        // from, so the screen can send a person to it instead of offering
        // Mark paid / Delete on a row it must not change.
        const rows = await query(
            `SELECT e.*, c.name AS category_name, l.voucher_id, v.voucher_no
             FROM expenses e
             LEFT JOIN expense_categories c ON c.id = e.category_id
             LEFT JOIN expense_voucher_lines l ON l.id = e.voucher_line_id
             LEFT JOIN expense_vouchers v ON v.id = l.voucher_id
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY e.business_date DESC, e.id DESC`,
            params,
        )
        return { data: serializeRows('expenses', rows) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function addExpense({
    business_date, category_id, description, payee, amount,
    paid_from = 'drawer', status = 'paid',
} = {}) {
    try {
        const user = await requirePermission('expenses')

        const desc = String(description ?? '').trim().slice(0, 191)
        if (!desc) return { error: 'A voucher needs a description' }

        // Round before validating: "99.999" typed at the till must not slip
        // past the schema's two-decimal column as a third of a paisa.
        const value = Math.round(Number(amount) * 100) / 100
        if (!Number.isFinite(value) || value <= 0) return { error: 'Amount must be more than zero' }

        if (!PAID_FROM.includes(paid_from)) return { error: 'Paid from must be drawer, bank or other' }
        if (!STATUSES.includes(status)) return { error: 'Status must be paid or payable' }
        if (business_date && !DATE_RE.test(business_date)) return { error: 'Date must be YYYY-MM-DD' }

        const date = business_date || await openBusinessDate()
        const categoryId = category_id ? Number(category_id) : null
        const who = String(payee ?? '').trim().slice(0, 191) || null

        // Checked here for a readable message; the FK still backstops a race.
        if (categoryId) {
            const cat = await query('SELECT id FROM expense_categories WHERE id = ?', [categoryId])
            if (cat.length === 0) return { error: 'That category no longer exists' }
        }

        const row = await withTransaction(async (conn) => {
            // A payable has no paid_at until the day it's actually cleared.
            const [result] = await conn.query(
                `INSERT INTO expenses
                   (business_date, category_id, description, payee, amount,
                    paid_from, status, created_by, paid_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${status === 'paid' ? 'UTC_TIMESTAMP(3)' : 'NULL'})`,
                [date, categoryId, desc, who, value, paid_from, status, user.role],
            )
            await audit(conn, date, 'expense_add', {
                expense_id: result.insertId,
                amount: value,
                category_id: categoryId,
                description: desc,
                payee: who,
                paid_from,
                status,
            })
            return fetchVoucher(conn, result.insertId)
        })
        return { data: serializeRow('expenses', row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function markPaid(id) {
    try {
        await requirePermission('expenses')
        const expenseId = Number(id)
        if (!Number.isInteger(expenseId) || expenseId <= 0) return { error: 'Expense not found' }

        // The audit books to the day the cash actually left, which for an old
        // payable is not the day the debt was incurred.
        const businessDate = await openBusinessDate()

        const row = await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM expenses WHERE id = ? FOR UPDATE', [expenseId])
            const expense = rows[0]
            if (!expense) throw new Error('Expense not found')
            await refuseProjected(conn, expense)
            if (expense.status === 'paid') throw new Error('This voucher is already marked paid')

            await conn.query(
                "UPDATE expenses SET status = 'paid', paid_at = UTC_TIMESTAMP(3) WHERE id = ?",
                [expenseId],
            )
            const booked = serializeRow('expenses', expense)
            await audit(conn, businessDate, 'expense_mark_paid', {
                expense_id: expenseId,
                amount: Number(expense.amount),
                description: expense.description,
                payee: expense.payee,
                booked_on: booked.business_date,
            })
            return fetchVoucher(conn, expenseId)
        })
        return { data: serializeRow('expenses', row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function deleteExpense(id) {
    try {
        await requirePermission('expenses')
        const expenseId = Number(id)
        if (!Number.isInteger(expenseId) || expenseId <= 0) return { error: 'Expense not found' }

        const businessDate = await openBusinessDate()

        await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM expenses WHERE id = ? FOR UPDATE', [expenseId])
            const expense = rows[0]
            if (!expense) throw new Error('Expense not found')
            await refuseProjected(conn, expense)

            let categoryName = null
            if (expense.category_id) {
                const [cats] = await conn.query(
                    'SELECT name FROM expense_categories WHERE id = ?', [expense.category_id],
                )
                categoryName = cats[0]?.name ?? null
            }

            await conn.query('DELETE FROM expenses WHERE id = ?', [expenseId])

            // The whole voucher goes into the log: the row is gone, so the
            // audit entry is the only place the deletion can be reconstructed.
            const gone = serializeRow('expenses', expense)
            await audit(conn, businessDate, 'expense_delete', {
                expense_id: expenseId,
                business_date: gone.business_date,
                category: categoryName,
                description: expense.description,
                payee: expense.payee,
                amount: Number(expense.amount),
                paid_from: expense.paid_from,
                status: expense.status,
                created_at: gone.created_at,
                paid_at: gone.paid_at,
            })
        })
        return { data: { deleted: expenseId } }
    } catch (e) {
        return { error: e.message }
    }
}

export async function listCategories() {
    try {
        await requirePermission('expenses')
        const rows = await query(
            'SELECT id, name, is_active FROM expense_categories ORDER BY name',
        )
        return { data: rows.map((r) => ({ ...r, is_active: Boolean(r.is_active) })) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function addCategory(name) {
    try {
        await requirePermission('expenses')
        const clean = String(name ?? '').trim().slice(0, 64)
        if (!clean) return { error: 'A category needs a name' }

        const businessDate = await openBusinessDate()

        const row = await withTransaction(async (conn) => {
            // Names are unique for life. Re-adding a retired name revives the
            // old row instead of erroring, so its history and its future sit
            // under one id.
            const [existing] = await conn.query(
                'SELECT id, is_active FROM expense_categories WHERE name = ? FOR UPDATE', [clean],
            )
            if (existing[0]) {
                if (existing[0].is_active) throw new Error(`"${clean}" already exists`)
                await conn.query('UPDATE expense_categories SET is_active = 1 WHERE id = ?', [existing[0].id])
                await audit(conn, businessDate, 'expense_category_add', {
                    category_id: existing[0].id, name: clean, revived: true,
                })
                return { id: existing[0].id, name: clean, is_active: true }
            }
            const [result] = await conn.query(
                'INSERT INTO expense_categories (name) VALUES (?)', [clean],
            )
            await audit(conn, businessDate, 'expense_category_add', {
                category_id: result.insertId, name: clean,
            })
            return { id: result.insertId, name: clean, is_active: true }
        })
        return { data: row }
    } catch (e) {
        return { error: e.message }
    }
}

export async function toggleCategory(id) {
    try {
        await requirePermission('expenses')
        const categoryId = Number(id)
        if (!Number.isInteger(categoryId) || categoryId <= 0) return { error: 'Category not found' }

        const businessDate = await openBusinessDate()

        const row = await withTransaction(async (conn) => {
            const [rows] = await conn.query(
                'SELECT id, name, is_active FROM expense_categories WHERE id = ? FOR UPDATE', [categoryId],
            )
            const cat = rows[0]
            if (!cat) throw new Error('Category not found')

            // Retiring only hides it from the entry form; existing vouchers
            // keep pointing at it, which is why there is no delete.
            const next = cat.is_active ? 0 : 1
            await conn.query('UPDATE expense_categories SET is_active = ? WHERE id = ?', [next, categoryId])
            await audit(conn, businessDate, 'expense_category_toggle', {
                category_id: categoryId, name: cat.name, is_active: Boolean(next),
            })
            return { id: cat.id, name: cat.name, is_active: Boolean(next) }
        })
        return { data: row }
    } catch (e) {
        return { error: e.message }
    }
}

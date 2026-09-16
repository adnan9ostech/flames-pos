'use server'

import { pool, query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { currentBranchId } from '@/lib/db/branch.mjs'
import { businessDate, money, ymd, requireId, requireDate } from '@/lib/accounts/helpers.mjs'
import {
    saveDraft as saveDraftTx,
    postVoucher as postVoucherTx,
    addPayment as addPaymentTx,
    reverseVoucher as reverseVoucherTx,
    deleteDraft as deleteDraftTx,
    loadVoucher,
} from '@/lib/accounts/expensePost.mjs'
import { listActiveExpenseCodes } from '../expense-codes/actions'

/*
 * Expense vouchers: the thin permission-and-envelope layer over
 * src/lib/accounts/expensePost.mjs, which owns every rule. Reading, saving,
 * posting and paying a voucher is the `accounts` right — recording spending
 * is the bookkeeper's daily work. Reversing one rewrites what the P&L says
 * about a day already closed, so it is `accounts_admin`, like the chart.
 *
 * Every export returns { data } or { error }; nothing throws to the client.
 */

const STATUSES = ['all', 'draft', 'posted', 'owed', 'void']

const toListRow = (r) => ({
    id: r.id,
    voucher_no: r.voucher_no,
    business_date: ymd(r.business_date),
    status: r.status,
    remarks: r.remarks,
    total: money(r.total),
    paid_total: money(r.paid_total),
    owed: money(r.total - r.paid_total),
    line_count: Number(r.line_count),
    lines_summary: r.lines_summary || '',
    posted_at: r.posted_at ? r.posted_at.toISOString() : null,
})

/*
 * What the document form needs before it can render: the codes a line may
 * pick (from the Expense Setup screen's own action), the accounts a payment
 * may come from (active, carrying AP_PAID — ChowPOS's "Expense Payment
 * Accounts"), and the day a new voucher defaults to.
 */
export async function getVoucherFormData() {
    try {
        await requirePermission('accounts')
        const [codesRes, accounts, today] = await Promise.all([
            listActiveExpenseCodes(),
            query(
                `SELECT id, account_number, name FROM accounts
                  WHERE is_active = 1 AND JSON_CONTAINS(link_codes, '"AP_PAID"')
                  ORDER BY account_number`,
            ),
            businessDate(),
        ])
        if (codesRes.error) throw new Error(codesRes.error)
        return {
            data: {
                codes: codesRes.data,
                payAccounts: accounts.map((a) => ({ id: Number(a.id), account_number: a.account_number, name: a.name })),
                today,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function listVouchers({ status = 'all', from, to } = {}) {
    try {
        const user = await requirePermission('accounts')
        const where = ['v.branch_id = ?']
        const params = [await currentBranchId(user)]
        const s = STATUSES.includes(status) ? status : 'all'
        if (s === 'owed') where.push("v.status = 'posted' AND v.paid_total < v.total")
        else if (s !== 'all') { where.push('v.status = ?'); params.push(s) }
        if (from) { where.push('v.business_date >= ?'); params.push(requireDate(from, 'from date')) }
        if (to) { where.push('v.business_date <= ?'); params.push(requireDate(to, 'to date')) }

        const rows = await query(
            `SELECT v.*,
                    (SELECT COUNT(*) FROM expense_voucher_lines l WHERE l.voucher_id = v.id) AS line_count,
                    (SELECT GROUP_CONCAT(
                        CONCAT(c.code, IF(l.description IS NULL OR l.description = '', '', CONCAT(' ', l.description)))
                        ORDER BY l.id SEPARATOR ' · ')
                       FROM expense_voucher_lines l JOIN expense_codes c ON c.id = l.expense_code_id
                      WHERE l.voucher_id = v.id) AS lines_summary
               FROM expense_vouchers v
              WHERE ${where.join(' AND ')}
              ORDER BY v.business_date DESC, v.id DESC
              LIMIT 500`,
            params,
        )
        return { data: rows.map(toListRow) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function getVoucher(id) {
    try {
        await requirePermission('accounts')
        const doc = await loadVoucher(pool, requireId(id, 'voucher'))
        return { data: doc }
    } catch (e) {
        return { error: e.message }
    }
}

/* Save stays a draft: nothing reaches the ledger or the drawer. */
export async function saveDraft(input) {
    try {
        const user = await requirePermission('accounts')
        const branchId = await currentBranchId(user)
        const id = await withTransaction((conn) => saveDraftTx(conn, input, user.id, branchId))
        return { data: await loadVoucher(pool, id) }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Save & Post: the draft is written (or rewritten) and posted in ONE
 * transaction, so what was on screen is exactly what reached the books —
 * a draft edited in another tab cannot slip in between.
 */
export async function postVoucher(input) {
    try {
        const user = await requirePermission('accounts')
        const branchId = await currentBranchId(user)
        const id = await withTransaction(async (conn) => {
            const voucherId = await saveDraftTx(conn, input, user.id, branchId)
            await postVoucherTx(conn, voucherId, user.id)
            return voucherId
        })
        return { data: await loadVoucher(pool, id) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function deleteDraft(id) {
    try {
        const user = await requirePermission('accounts')
        const result = await withTransaction((conn) => deleteDraftTx(conn, requireId(id, 'voucher'), user.id))
        return { data: result }
    } catch (e) {
        return { error: e.message }
    }
}

/* A payment against what a posted voucher still owes. */
export async function addPayment(id, payment) {
    try {
        const user = await requirePermission('accounts')
        const voucherId = requireId(id, 'voucher')
        const result = await withTransaction((conn) => addPaymentTx(conn, voucherId, payment ?? {}, user.id))
        return { data: { ...(await loadVoucher(pool, voucherId)), journal: result.journal } }
    } catch (e) {
        return { error: e.message }
    }
}

export async function reverseVoucher(id, reason) {
    try {
        const user = await requirePermission('accounts_admin')
        const voucherId = requireId(id, 'voucher')
        const result = await withTransaction((conn) => reverseVoucherTx(conn, voucherId, user.id, reason))
        return { data: { ...(await loadVoucher(pool, voucherId)), reversal: result.journals } }
    } catch (e) {
        return { error: e.message }
    }
}

/* ---------------------------------------------------------------- reports */

const merchantName = async () =>
    (await query('SELECT merchant_name FROM store_settings LIMIT 1'))[0]?.merchant_name ?? null

/*
 * Expense Report: every expense in the range, from the one expense ledger
 * (`expenses`) — so a voucher's lines and a cash chit typed on the Expenses
 * screen sit in the same list, the voucher ones carrying their number.
 * Reversed vouchers have no rows here at all: their projection is deleted.
 * The summary groups by code + category; the total is the same money.
 */
export async function getExpenseReport({ from, to } = {}) {
    try {
        await requirePermission('accounts')
        const today = await businessDate()
        const f = from ? requireDate(from, 'from date') : `${today.slice(0, 7)}-01`
        const t = to ? requireDate(to, 'to date') : today
        if (f > t) throw new Error('The from date is after the to date')

        const [rows, merchant] = await Promise.all([
            query(
                `SELECT e.id, e.business_date, e.description, e.amount, e.status, e.paid_from,
                        v.id AS voucher_id, v.voucher_no, l.description AS line_description,
                        c.code, c.name AS code_name,
                        COALESCE(cat.name, 'Uncategorised') AS category
                   FROM expenses e
                   LEFT JOIN expense_voucher_lines l ON l.id = e.voucher_line_id
                   LEFT JOIN expense_vouchers v ON v.id = l.voucher_id
                   LEFT JOIN expense_codes c ON c.id = e.expense_code_id
                   LEFT JOIN expense_categories cat ON cat.id = e.category_id
                  WHERE e.business_date BETWEEN ? AND ?
                  ORDER BY e.business_date, v.voucher_no, e.id`,
                [f, t],
            ),
            merchantName(),
        ])

        // A voucher line's projected row carries "CODE · description" for the
        // Expenses screen, which has no code column; this report has one, so
        // the line's own words are shown, the code name standing in when the
        // line has none.
        const lines = rows.map((r) => ({
            id: r.id,
            business_date: ymd(r.business_date),
            voucher_id: r.voucher_id ?? null,
            voucher_no: r.voucher_no ?? null,
            code: r.code ?? null,
            code_name: r.code_name ?? null,
            category: r.category,
            description: r.voucher_id ? (r.line_description || r.code_name || r.description) : r.description,
            status: r.status,
            paid_from: r.paid_from,
            amount: money(r.amount),
        }))

        const groups = new Map()
        for (const l of lines) {
            const key = `${l.code ?? ''}|${l.category}`
            const g = groups.get(key) || { code: l.code, code_name: l.code_name, category: l.category, lines: 0, amount: 0 }
            g.lines += 1
            g.amount = money(g.amount + l.amount)
            groups.set(key, g)
        }
        const summary = [...groups.values()].sort((a, b) =>
            a.category.localeCompare(b.category) || String(a.code ?? '').localeCompare(String(b.code ?? '')))

        return {
            data: {
                from: f,
                to: t,
                merchantName: merchant,
                lines,
                summary,
                total: money(lines.reduce((s, l) => s + l.amount, 0)),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Expense Payables Report: posted vouchers not yet paid in full, oldest
 * first, with how long each has been outstanding as of the open day.
 */
export async function getPayablesReport() {
    try {
        await requirePermission('accounts')
        const asOf = await businessDate()
        const [rows, merchant] = await Promise.all([
            query(
                `SELECT v.id, v.voucher_no, v.business_date, v.remarks, v.total, v.paid_total,
                        DATEDIFF(?, v.business_date) AS days_outstanding,
                        (SELECT GROUP_CONCAT(c.code ORDER BY l.id SEPARATOR ', ')
                           FROM expense_voucher_lines l JOIN expense_codes c ON c.id = l.expense_code_id
                          WHERE l.voucher_id = v.id) AS codes
                   FROM expense_vouchers v
                  WHERE v.status = 'posted' AND v.paid_total < v.total
                  ORDER BY v.business_date, v.id`,
                [asOf],
            ),
            merchantName(),
        ])
        const list = rows.map((r) => ({
            id: r.id,
            voucher_no: r.voucher_no,
            business_date: ymd(r.business_date),
            remarks: r.remarks,
            codes: r.codes || '',
            total: money(r.total),
            paid_total: money(r.paid_total),
            owed: money(r.total - r.paid_total),
            days_outstanding: Number(r.days_outstanding),
        }))
        return {
            data: {
                asOf,
                merchantName: merchant,
                rows: list,
                totals: {
                    total: money(list.reduce((s, r) => s + r.total, 0)),
                    paid: money(list.reduce((s, r) => s + r.paid_total, 0)),
                    owed: money(list.reduce((s, r) => s + r.owed, 0)),
                },
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

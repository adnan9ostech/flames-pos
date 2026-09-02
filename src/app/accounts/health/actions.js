'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { money, ymd } from '@/lib/accounts/helpers.mjs'
import { unpostedOrders, unpostedPayments, brokenJournals, legacyExpenses } from './gaps.mjs'

/*
 * Posting Health: the safety net under a posting engine that never blocks a
 * settle. There is no failure queue on purpose — every input is local, so a
 * gap is always re-derivable — and this screen IS the queue: four derived
 * lists (gaps.mjs), and a Repost that runs the same reconciler the hook
 * runs, awaited this time so the button can say what happened. The fourth
 * list (expenses typed outside the voucher screen) has no Repost: those
 * rows carry no account, so they are named for a person to re-enter.
 */

const orderRow = (o) => ({
    id: o.id,
    invoice_number: o.invoice_number,
    order_number: o.order_number,
    order_type: o.order_type,
    table_number: o.table_number,
    business_date: ymd(o.business_date),
    total: money(o.total),
    payment_mode: o.payment_mode,
    status: o.status,
    paid_at: o.paid_at ? o.paid_at.toISOString() : null,
    gap: o.gap,
})

const paymentRow = (p) => ({
    id: p.id,
    order_id: p.order_id,
    invoice_number: p.invoice_number,
    method: p.method,
    amount: money(p.amount),
    paid_at: p.paid_at ? p.paid_at.toISOString() : null,
    business_date: ymd(p.business_date),
    status: p.status,
})

const journalRow = (j) => ({
    id: Number(j.id),
    voucher_no: j.voucher_no,
    voucher_type: j.voucher_type,
    business_date: ymd(j.business_date),
    description: j.description,
    reference: j.reference,
    debit_total: money(j.debit_total),
    credit_total: money(j.credit_total),
    line_debit: money(j.line_debit),
    line_credit: money(j.line_credit),
    line_count: Number(j.line_count),
})

const expenseRow = (e) => ({
    id: Number(e.id),
    business_date: ymd(e.business_date),
    category: e.category ?? null,
    description: e.description,
    payee: e.payee ?? null,
    amount: money(e.amount),
    paid_from: e.paid_from,
    status: e.status,
    created_at: e.created_at ? e.created_at.toISOString() : null,
})

export async function getPostingHealth() {
    try {
        await requirePermission('accounts')
        const [settings, orders, payments, journals, expenses] = await Promise.all([
            query('SELECT start_date, posting_enabled FROM gl_settings WHERE id = 1'),
            unpostedOrders(),
            unpostedPayments(),
            brokenJournals(),
            legacyExpenses(),
        ])
        return {
            data: {
                startDate: settings[0] ? ymd(settings[0].start_date) : null,
                postingEnabled: Boolean(settings[0]?.posting_enabled),
                orders: orders.map(orderRow),
                payments: payments.map(paymentRow),
                journals: journals.map(journalRow),
                expenses: expenses.map(expenseRow),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/*
 * Run the reconciler for one order and WAIT for it — unlike the hook, this
 * caller wants the answer. Safe to press twice: the unique key makes a
 * re-post of something already posted a no-op.
 */
export async function repostOrder(orderId) {
    try {
        const user = await requirePermission('accounts_admin')
        const id = String(orderId ?? '').trim()
        if (!UUID.test(id)) throw new Error('That order no longer exists')

        const { syncOrderJournals } = await import('@/lib/accounts/post.mjs')
        const result = await syncOrderJournals(id, { userId: user.id })
        if (result.status === 'failed') return { error: result.reason }
        return { data: result }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Every order the two gap lists name, reposted one after another (the pool
 * is small and the counter rows serialize anyway). Returns the tally and
 * the per-order outcomes, so a stubborn bill is named, not hidden in a count.
 */
export async function repostAll() {
    try {
        const user = await requirePermission('accounts_admin')
        const [orders, payments] = await Promise.all([unpostedOrders(), unpostedPayments()])
        const ids = [...new Set([...orders.map((o) => o.id), ...payments.map((p) => p.order_id)])]

        const { syncOrderJournals } = await import('@/lib/accounts/post.mjs')
        const invoiceOf = new Map([
            ...orders.map((o) => [o.id, o.invoice_number]),
            ...payments.map((p) => [p.order_id, p.invoice_number]),
        ])
        const tally = { posted: 0, skipped: 0, failed: 0, vouchers: 0 }
        const outcomes = []
        for (const id of ids) {
            const r = await syncOrderJournals(id, { userId: user.id })
            tally[r.status] += 1
            tally.vouchers += r.vouchers.length
            outcomes.push({
                order_id: id, invoice_number: invoiceOf.get(id),
                status: r.status, reason: r.reason, vouchers: r.vouchers.length,
            })
        }
        return { data: { attempted: ids.length, ...tally, outcomes } }
    } catch (e) {
        return { error: e.message }
    }
}

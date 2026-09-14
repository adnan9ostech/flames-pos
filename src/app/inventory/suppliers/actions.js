'use server'

/*
 * The supplier side of inventory money. Receivings create the payable when
 * goods land (the receiving page writes those); this file reads the account
 * back — receivings against payments, per supplier — and records the money
 * going out. Nothing here touches stock or the till.
 */

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { openBusinessDate } from '@/lib/day/openDay.mjs'
import { writeAudit } from '@/lib/db/audit.mjs'

/* Matches the CHECK on supplier_payments.method. */
const PAYMENT_METHODS = ['cash', 'bank', 'cheque']

/*
 * The general ledger, after the payment has committed — the same posture as
 * the order hooks in orderActions.js: the money has left, so a ledger fault
 * logs inside the poster and stops there. Idempotent on (source_type,
 * source_id) in the database, so a repeat is harmless.
 */
const fireGlAfterSupplierPayment = (paymentId, userId) => {
    import('@/lib/accounts/otherPost.mjs')
        .then((m) => m.afterSupplierPaymentGl(paymentId, { userId }))
        .catch(() => {})
}

/* Sums of DECIMAL(12,2) arrive as JS numbers; pin every derived figure back
 * to paise so a long receiving/payment chain can't accumulate float dust. */
const money = (n) => Math.round(Number(n || 0) * 100) / 100

const iso = (v) => (v instanceof Date ? v.toISOString() : v)
/* A DATE column parses to midnight UTC; the calendar day is the value. */
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)

const karachiDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/* The trading day an audit row belongs to — the open business day once
 * day-close is live, else the Karachi calendar day, matching orders.mjs. */
const resolveBusinessDate = async (conn) => {
    // The open day for the branch this request is acting on.
    return openBusinessDate(null, conn)
}

const auditTx = async (conn, action, details) =>
    writeAudit(conn, { businessDate: await resolveBusinessDate(conn), action, details })

/*
 * Every supplier with what receivings have booked against them, what has
 * been paid off, and the balance still owed. One list serves both the
 * payables summary (the page keeps rows with balance > 0) and the ledger
 * picker — the numbers can never disagree between the two.
 */
export async function listSupplierBalances() {
    try {
        await requirePermission('inventory')
        const rows = await query(
            `SELECT s.id, s.name, s.phone, s.is_active,
                    COALESCE(r.received, 0) AS received,
                    COALESCE(p.paid, 0) AS paid,
                    r.last_receiving, p.last_payment
             FROM suppliers s
             LEFT JOIN (SELECT supplier_id, SUM(total) AS received,
                               MAX(created_at) AS last_receiving
                        FROM stock_receivings GROUP BY supplier_id) r
               ON r.supplier_id = s.id
             LEFT JOIN (SELECT supplier_id, SUM(amount) AS paid,
                               MAX(paid_at) AS last_payment
                        FROM supplier_payments GROUP BY supplier_id) p
               ON p.supplier_id = s.id
             ORDER BY s.name`,
        )
        return {
            data: rows.map((r) => ({
                ...r,
                is_active: Boolean(r.is_active),
                received: money(r.received),
                paid: money(r.paid),
                balance: money(Number(r.received) - Number(r.paid)),
                last_receiving: iso(r.last_receiving),
                last_payment: iso(r.last_payment),
            })),
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * One supplier's statement: receivings as debits, payments as credits, a
 * running balance through both. Built oldest-first so the balance is real,
 * returned newest-first so it reads like a bank statement.
 */
export async function getSupplierLedger(supplierId) {
    try {
        await requirePermission('inventory')
        const id = Number(supplierId)
        if (!Number.isInteger(id) || id <= 0) return { error: 'Pick a supplier' }

        const [suppliers, receivings, payments] = await Promise.all([
            query('SELECT id, name, is_active FROM suppliers WHERE id = ?', [id]),
            query(
                `SELECT id, supplier_invoice, business_date, total, notes, created_at
                 FROM stock_receivings WHERE supplier_id = ?`,
                [id],
            ),
            query(
                `SELECT id, amount, method, reference, paid_at
                 FROM supplier_payments WHERE supplier_id = ?`,
                [id],
            ),
        ])
        if (suppliers.length === 0) return { error: 'That supplier no longer exists' }

        // Interleaved on entry timestamps: the order money was actually
        // booked in, which is the only order a running balance makes sense in.
        const entries = [
            ...receivings.map((r) => ({
                kind: 'receiving',
                id: r.id,
                at: iso(r.created_at),
                business_date: day(r.business_date),
                invoice: r.supplier_invoice,
                notes: r.notes,
                debit: money(r.total),
                credit: 0,
            })),
            ...payments.map((p) => ({
                kind: 'payment',
                id: p.id,
                at: iso(p.paid_at),
                method: p.method,
                reference: p.reference,
                debit: 0,
                credit: money(p.amount),
            })),
        ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

        let balance = 0
        for (const e of entries) {
            balance = money(balance + e.debit - e.credit)
            e.balance = balance
        }

        return {
            data: {
                supplier: { ...suppliers[0], is_active: Boolean(suppliers[0].is_active) },
                balance,
                entries: entries.reverse(),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Money out to a supplier. Deliberately allowed to exceed the balance — an
 * advance against tomorrow's delivery is normal trade, and the ledger shows
 * it as a negative balance rather than pretending it didn't happen.
 */
export async function recordSupplierPayment({ supplierId, amount, method = 'cash', reference = '' } = {}) {
    try {
        const user = await requirePermission('inventory')
        const id = Number(supplierId)
        if (!Number.isInteger(id) || id <= 0) return { error: 'Pick a supplier' }
        const amt = Number(amount)
        if (!Number.isFinite(amt) || amt <= 0) return { error: 'The amount must be more than zero' }
        if (!PAYMENT_METHODS.includes(method)) return { error: `Unknown payment method: ${method}` }
        const ref = String(reference ?? '').trim().slice(0, 64) || null

        const payment = await withTransaction(async (conn) => {
            const [suppliers] = await conn.query(
                'SELECT id, name FROM suppliers WHERE id = ?', [id],
            )
            if (suppliers.length === 0) throw new Error('That supplier no longer exists')

            const [result] = await conn.query(
                `INSERT INTO supplier_payments (supplier_id, amount, method, reference)
                 VALUES (?, ?, ?, ?)`,
                [id, money(amt), method, ref],
            )

            await auditTx(conn, 'supplier_payment', {
                payment_id: result.insertId, supplier_id: id, supplier: suppliers[0].name,
                amount: money(amt), method, reference: ref,
            })

            return { id: result.insertId, amount: money(amt), method }
        })
        fireGlAfterSupplierPayment(payment.id, user.id)
        return { data: payment }
    } catch (e) {
        return { error: e.message }
    }
}

'use server'

/*
 * The billing half of City Ledger: fold a company's loose charges into a
 * monthly invoice, record the money when it arrives, and show how old the
 * unpaid paper is. The charges themselves are payments rows the till wrote
 * at settle time — nothing here creates or edits a charge.
 */

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { openBusinessDate } from '@/lib/day/openDay.mjs'
import { writeAudit } from '@/lib/db/audit.mjs'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const RECEIPT_METHODS = ['cash', 'card', 'bank', 'cheque']

/*
 * The general ledger, after the receipt has committed. Same posture as the
 * order hooks in orderActions.js: the money is already in, so a ledger
 * fault logs inside the poster and stops there. Idempotent on
 * (source_type, source_id) in the database, so a repeat is harmless.
 */
const fireGlAfterReceipt = (receiptId, userId) => {
    import('@/lib/accounts/otherPost.mjs')
        .then((m) => m.afterReceiptGl(receiptId, { userId }))
        .catch(() => {})
}

/* Sums of DECIMAL(12,2) arrive as JS numbers; pin every derived figure back
 * to paise so a long charge/receipt chain can't accumulate float dust. */
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
 * Bill a company for its uninvoiced charges in a business-date window.
 *
 * Only POSITIVE unstamped payments are picked up: a void that lands after
 * its charge was invoiced stays a loose credit on the account rather than
 * silently shrinking a document that may already have been posted.
 */
export async function generateInvoice({ companyId, from, to } = {}) {
    try {
        await requirePermission('cityledger')
        if (!companyId) return { error: 'Pick a company' }
        if (!DAY_RE.test(from || '') || !DAY_RE.test(to || '')) return { error: 'Pick the period dates' }
        if (from > to) return { error: 'The period ends before it starts' }

        const invoice = await withTransaction(async (conn) => {
            // The company lock serializes two same-moment generates for one
            // account — the loser sees the winner's stamps, not a double bill.
            const [companies] = await conn.query(
                'SELECT id, name FROM companies WHERE id = ? FOR UPDATE', [companyId],
            )
            if (companies.length === 0) throw new Error('That company no longer exists')

            const [charges] = await conn.query(
                `SELECT p.id, p.amount
                 FROM payments p
                 JOIN orders o ON o.id = p.order_id
                 WHERE p.method = 'city_ledger' AND p.company_id = ?
                   AND p.invoice_id IS NULL AND p.amount > 0
                   AND o.business_date BETWEEN ? AND ?
                 FOR UPDATE`,
                [companyId, from, to],
            )
            if (charges.length === 0) {
                throw new Error('No uninvoiced charges for this company in that period')
            }

            const total = money(charges.reduce((sum, c) => sum + Number(c.amount), 0))

            // Sequence by count-of-the-month: fine at this scale, and the
            // UNIQUE on invoice_no catches the rare same-moment collision.
            const prefix = `CL-${karachiDay().slice(2, 7).replace('-', '')}-`
            const [[{ n }]] = await conn.query(
                'SELECT COUNT(*) AS n FROM company_invoices WHERE invoice_no LIKE ?',
                [`${prefix}%`],
            )
            const invoiceNo = `${prefix}${String(n + 1).padStart(3, '0')}`

            let result
            try {
                const inserted = await conn.query(
                    `INSERT INTO company_invoices (invoice_no, company_id, period_from, period_to, total)
                     VALUES (?, ?, ?, ?, ?)`,
                    [invoiceNo, companyId, from, to, total],
                )
                result = inserted[0]
            } catch (e) {
                if (e && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY')) {
                    throw new Error('Two invoices were being numbered at once. Try again')
                }
                throw e
            }

            await conn.query(
                'UPDATE payments SET invoice_id = ? WHERE id IN (?)',
                [result.insertId, charges.map((c) => c.id)],
            )

            await auditTx(conn, 'cl_invoice', {
                invoice_no: invoiceNo, company_id: companyId, company: companies[0].name,
                total, charges: charges.length, from, to,
            })

            return { id: result.insertId, invoice_no: invoiceNo, total, charges: charges.length }
        })
        return { data: invoice }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Money arriving against the account — wired against a specific invoice, or
 * on account when the cheque doesn't say. Never touches the payments table:
 * a receipt is office money, not till money.
 */
export async function recordReceipt({
    companyId, invoiceId = null, amount, method = 'bank', reference = '', memo = '',
} = {}) {
    try {
        const user = await requirePermission('cityledger')
        if (!companyId) return { error: 'Pick a company' }
        const amt = Number(amount)
        if (!Number.isFinite(amt) || amt <= 0) return { error: 'The amount must be more than zero' }
        if (!RECEIPT_METHODS.includes(method)) return { error: `Unknown receipt method: ${method}` }

        const receipt = await withTransaction(async (conn) => {
            const [companies] = await conn.query(
                'SELECT id, name FROM companies WHERE id = ?', [companyId],
            )
            if (companies.length === 0) throw new Error('That company no longer exists')

            let invoice = null
            if (invoiceId) {
                const [invoices] = await conn.query(
                    'SELECT id, invoice_no, company_id FROM company_invoices WHERE id = ?', [invoiceId],
                )
                if (invoices.length === 0) throw new Error('That invoice no longer exists')
                if (invoices[0].company_id !== companyId) {
                    throw new Error('That invoice belongs to a different company')
                }
                invoice = invoices[0]
            }

            const [result] = await conn.query(
                `INSERT INTO company_receipts (company_id, invoice_id, amount, method, reference, memo)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [companyId, invoice ? invoice.id : null, money(amt), method,
                    String(reference).trim() || null, String(memo).trim() || null],
            )

            await auditTx(conn, 'cl_receipt', {
                receipt_id: result.insertId, company_id: companyId, company: companies[0].name,
                invoice_no: invoice ? invoice.invoice_no : null, amount: money(amt), method,
            })

            return { id: result.insertId, amount: money(amt), method }
        })
        fireGlAfterReceipt(receipt.id, user.id)
        return { data: receipt }
    } catch (e) {
        return { error: e.message }
    }
}

export async function listInvoices() {
    try {
        await requirePermission('cityledger')
        const rows = await query(
            `SELECT i.id, i.invoice_no, i.company_id, c.name AS company_name,
                    i.period_from, i.period_to, i.total, i.created_at,
                    COALESCE(r.received, 0) AS paid
             FROM company_invoices i
             JOIN companies c ON c.id = i.company_id
             LEFT JOIN (
                 SELECT invoice_id, SUM(amount) AS received
                 FROM company_receipts WHERE invoice_id IS NOT NULL
                 GROUP BY invoice_id
             ) r ON r.invoice_id = i.id
             ORDER BY i.created_at DESC`,
        )
        return {
            data: rows.map((r) => ({
                ...r,
                period_from: day(r.period_from),
                period_to: day(r.period_to),
                created_at: iso(r.created_at),
                total: money(r.total),
                paid: money(r.paid),
                due: money(Number(r.total) - Number(r.paid)),
            })),
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function listReceipts() {
    try {
        await requirePermission('cityledger')
        const rows = await query(
            `SELECT r.id, r.company_id, c.name AS company_name, r.invoice_id, i.invoice_no,
                    r.amount, r.method, r.reference, r.memo, r.received_at
             FROM company_receipts r
             JOIN companies c ON c.id = r.company_id
             LEFT JOIN company_invoices i ON i.id = r.invoice_id
             ORDER BY r.received_at DESC`,
        )
        return {
            data: rows.map((r) => ({
                ...r, amount: money(r.amount), received_at: iso(r.received_at),
            })),
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * The Companies Balance Sheet: per account, the charges not yet billed, the
 * open invoice balances bucketed by how long the paper has been out, and the
 * bottom line. Buckets age by invoice created_at — the day it was RAISED is
 * when the clock starts, whatever period it covered.
 */
export async function agingReport() {
    try {
        await requirePermission('cityledger')

        const [companies, uninvoiced, charged, receipts, invoices] = await Promise.all([
            query('SELECT id, name, is_active FROM companies ORDER BY name'),
            query(
                `SELECT company_id, SUM(amount) AS amt
                 FROM payments WHERE method = 'city_ledger' AND invoice_id IS NULL
                 GROUP BY company_id`,
            ),
            query(
                `SELECT company_id, SUM(amount) AS amt
                 FROM payments WHERE method = 'city_ledger'
                 GROUP BY company_id`,
            ),
            query(
                `SELECT company_id, SUM(amount) AS amt, MAX(received_at) AS last_at
                 FROM company_receipts
                 GROUP BY company_id`,
            ),
            query(
                `SELECT i.id, i.company_id, i.total, i.created_at,
                        COALESCE(SUM(r.amount), 0) AS received
                 FROM company_invoices i
                 LEFT JOIN company_receipts r ON r.invoice_id = i.id
                 GROUP BY i.id, i.company_id, i.total, i.created_at`,
            ),
        ])

        const byCompany = new Map(companies.map((c) => [c.id, {
            company_id: c.id,
            name: c.name,
            is_active: Boolean(c.is_active),
            uninvoiced: 0,
            b0_30: 0, b31_60: 0, b61_90: 0, b90_plus: 0,
            last_invoice: null,
            last_receipt: null,
            balance: 0,
        }]))

        for (const u of uninvoiced) {
            const row = byCompany.get(u.company_id)
            if (row) row.uninvoiced = money(u.amt)
        }
        for (const c of charged) {
            const row = byCompany.get(c.company_id)
            if (row) row.balance = money(c.amt)
        }
        for (const r of receipts) {
            const row = byCompany.get(r.company_id)
            if (!row) continue
            row.balance = money(row.balance - Number(r.amt))
            row.last_receipt = iso(r.last_at)
        }

        const now = Date.now()
        for (const inv of invoices) {
            const row = byCompany.get(inv.company_id)
            if (!row) continue
            const createdIso = iso(inv.created_at)
            if (!row.last_invoice || createdIso > row.last_invoice) row.last_invoice = createdIso
            const due = money(Number(inv.total) - Number(inv.received))
            if (due === 0) continue
            const age = Math.floor((now - new Date(createdIso).getTime()) / 86_400_000)
            const bucket = age <= 30 ? 'b0_30' : age <= 60 ? 'b31_60' : age <= 90 ? 'b61_90' : 'b90_plus'
            row[bucket] = money(row[bucket] + due)
        }

        // Inactive companies stay on the sheet only while they still owe (or
        // are owed) something — a settled, closed account is done reporting.
        const rows = [...byCompany.values()].filter(
            (r) => r.is_active || r.balance !== 0 || r.uninvoiced !== 0,
        )
        return { data: rows }
    } catch (e) {
        return { error: e.message }
    }
}

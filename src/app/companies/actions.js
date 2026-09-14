'use server'

/*
 * The account book behind City Ledger: which companies may charge meals to
 * an account, and what each one owes. Charges are never written here — a
 * city-ledger settle at the till writes the payments row (orders.mjs) and a
 * void reverses it with a negative row — so this file only reads them, and
 * keeps the directory of accounts around them.
 */

import { randomUUID } from 'node:crypto'
import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
import { openBusinessDate } from '@/lib/day/openDay.mjs'

/* Sums of DECIMAL(12,2) arrive as JS numbers; pin every derived figure back
 * to paise so a long charge/receipt chain can't accumulate float dust. */
const money = (n) => Math.round(Number(n || 0) * 100) / 100

const iso = (v) => (v instanceof Date ? v.toISOString() : v)
/* A DATE column parses to midnight UTC; the calendar day is the value. */
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)

/* The trading day an audit row belongs to — the open business day once
 * day-close is live, else the Karachi calendar day, matching orders.mjs. */
const resolveBusinessDate = async (conn) => {
    // The open day for the branch this request is acting on.
    return openBusinessDate(null, conn)
}

const auditTx = async (conn, action, details) => {
    await conn.query(
        'INSERT INTO audit_log (branch_id, business_date, action, details) VALUES (1, ?, ?, ?)',
        [await resolveBusinessDate(conn), action, JSON.stringify(details)],
    )
}

const companyRow = (row) => ({
    ...row,
    is_active: Boolean(row.is_active),
    credit_limit: row.credit_limit == null ? null : Number(row.credit_limit),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
})

/*
 * The admin list, each company with what it currently owes: everything the
 * till has charged to the account minus everything the office has received.
 * Void reversals are negative payments rows, so the same SUM nets them out.
 */
export async function listCompanies({ activeOnly = false } = {}) {
    try {
        await requirePermission('cityledger')
        const rows = await query(
            `SELECT c.id, c.name, c.contact, c.phone, c.ntn, c.address,
                    c.credit_limit, c.is_active, c.created_at, c.updated_at,
                    COALESCE(p.charged, 0) - COALESCE(r.received, 0) AS balance
             FROM companies c
             LEFT JOIN (
                 SELECT company_id, SUM(amount) AS charged
                 FROM payments WHERE method = 'city_ledger'
                 GROUP BY company_id
             ) p ON p.company_id = c.id
             LEFT JOIN (
                 SELECT company_id, SUM(amount) AS received
                 FROM company_receipts
                 GROUP BY company_id
             ) r ON r.company_id = c.id
             ${activeOnly ? 'WHERE c.is_active = 1' : ''}
             ORDER BY c.name`,
        )
        return { data: rows.map((r) => ({ ...companyRow(r), balance: money(r.balance) })) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveCompany(input = {}) {
    try {
        await requirePermission('cityledger')

        const name = String(input.name || '').trim()
        if (!name) return { error: 'A company needs a name' }
        const contact = String(input.contact || '').trim() || null
        const phone = String(input.phone || '').trim() || null
        const ntn = String(input.ntn || '').trim() || null
        const address = String(input.address || '').trim() || null

        // Blank means no cap — NULL, not zero: a zero limit would read as
        // "this account may charge nothing" once limits are enforced.
        let creditLimit = null
        if (input.credit_limit !== null && input.credit_limit !== undefined
            && String(input.credit_limit).trim() !== '') {
            creditLimit = Number(input.credit_limit)
            if (!Number.isFinite(creditLimit) || creditLimit < 0) {
                return { error: 'Credit limit must be zero or a positive amount' }
            }
        }

        const id = input.id || null
        const row = await withTransaction(async (conn) => {
            let companyId = id
            if (id) {
                const [result] = await conn.query(
                    `UPDATE companies SET
                       name = ?, contact = ?, phone = ?, ntn = ?, address = ?,
                       credit_limit = ?, updated_at = UTC_TIMESTAMP(3)
                     WHERE id = ?`,
                    [name, contact, phone, ntn, address, creditLimit, id],
                )
                if (result.affectedRows === 0) throw new Error('That company no longer exists')
            } else {
                companyId = randomUUID()
                await conn.query(
                    `INSERT INTO companies (id, name, contact, phone, ntn, address, credit_limit)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [companyId, name, contact, phone, ntn, address, creditLimit],
                )
            }
            await auditTx(conn, 'company_save', {
                company_id: companyId, name, created: !id, credit_limit: creditLimit,
            })
            const [rows] = await conn.query('SELECT * FROM companies WHERE id = ?', [companyId])
            return rows[0]
        })
        return { data: companyRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function toggleCompany(id) {
    try {
        await requirePermission('cityledger')
        if (!id) return { error: 'Which company?' }

        const row = await withTransaction(async (conn) => {
            // Deactivation stops NEW charges at the till; the balance stays
            // collectable, which is why this is a toggle and not a delete.
            const [result] = await conn.query(
                'UPDATE companies SET is_active = 1 - is_active, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [id],
            )
            if (result.affectedRows === 0) throw new Error('That company no longer exists')
            const [rows] = await conn.query('SELECT id, name, is_active FROM companies WHERE id = ?', [id])
            await auditTx(conn, 'company_toggle', {
                company_id: id, name: rows[0].name, active: Boolean(rows[0].is_active),
            })
            return rows[0]
        })
        return { data: { id: row.id, is_active: Boolean(row.is_active) } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * One company's full ledger: every charge (the till's city_ledger payments
 * rows joined to their orders), every receipt, merged in time order with a
 * running balance. A voided charge appears as its negative reversal row, so
 * the statement tells the whole story rather than quietly rewriting it.
 */
export async function getCompanyStatement(companyId) {
    try {
        await requirePermission('cityledger')
        if (!companyId) return { error: 'Which company?' }

        const companies = await query('SELECT * FROM companies WHERE id = ?', [companyId])
        if (companies.length === 0) return { error: 'That company no longer exists' }

        const [charges, receipts] = await Promise.all([
            query(
                `SELECT p.amount, p.paid_at, p.invoice_id, i.invoice_no,
                        o.order_number, o.invoice_number, o.business_date, o.total
                 FROM payments p
                 JOIN orders o ON o.id = p.order_id
                 LEFT JOIN company_invoices i ON i.id = p.invoice_id
                 WHERE p.method = 'city_ledger' AND p.company_id = ?
                 ORDER BY p.paid_at`,
                [companyId],
            ),
            query(
                `SELECT r.amount, r.method, r.reference, r.memo, r.received_at, i.invoice_no
                 FROM company_receipts r
                 LEFT JOIN company_invoices i ON i.id = r.invoice_id
                 WHERE r.company_id = ?
                 ORDER BY r.received_at`,
                [companyId],
            ),
        ])

        const entries = [
            ...charges.map((c) => ({
                kind: 'charge',
                at: iso(c.paid_at),
                business_date: day(c.business_date),
                order_number: c.order_number,
                invoice_number: c.invoice_number,
                cl_invoice_no: c.invoice_no ?? null,
                invoiced: c.invoice_id != null,
                order_total: money(c.total),
                amount: money(c.amount),
            })),
            ...receipts.map((r) => ({
                kind: 'receipt',
                at: iso(r.received_at),
                method: r.method,
                reference: r.reference,
                memo: r.memo,
                cl_invoice_no: r.invoice_no ?? null,
                amount: money(r.amount),
            })),
        ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

        let running = 0
        for (const entry of entries) {
            running = money(running + (entry.kind === 'charge' ? entry.amount : -entry.amount))
            entry.running = running
        }

        return { data: { company: companyRow(companies[0]), entries, balance: running } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * requireUser, not the `cityledger` right: the TILL calls this at settle
 * time when the operator picks City Ledger, and staff must be able to reach
 * it. It hands out only what the picker needs — no balances, no limits.
 */
export async function listCompaniesForPicker() {
    try {
        await requireUser()
        const rows = await query(
            'SELECT id, name, contact FROM companies WHERE is_active = 1 ORDER BY name',
        )
        return { data: rows }
    } catch (e) {
        return { error: e.message }
    }
}

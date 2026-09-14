'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { businessDate, audit, requireId } from '@/lib/accounts/helpers.mjs'

/*
 * Expense codes: ChowPOS's posting pivot. A voucher line picks a CODE, and
 * both sides of the entry come from it — the expense account it debits and
 * the payable account it credits while the voucher is unpaid. Read by anyone
 * with `accounts`; written only with `accounts_admin`, because re-pointing a
 * code moves where every future rupee spent under it lands on the P&L.
 *
 * Once a code has been used on a voucher line its accounts are frozen: the
 * lines already posted carry the expense account, and a code whose meaning
 * changed halfway through the year would make its own history unreadable;
 * the payable account is what a later payment debits, so moving it would
 * clear a different account than the one the voucher credited and leave
 * both wrong for good. Deactivate the code and add a new one instead. There
 * is no delete — voucher lines FK it.
 */

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,15}$/

/* The link code an account must carry to be offered on each side. */
const EXPENSE_LINK = 'IC_SERVICE_EXPENSE'
const PAYABLE_LINKS = ['PAYABLE_NT', 'PAYABLE_T']

const SELECT_CODE = `
    SELECT ec.*,
           c.name AS category_name, c.code AS category_code,
           a.account_number, a.name AS account_name, a.is_active AS account_active,
           p.account_number AS payable_number, p.name AS payable_name,
           (EXISTS (SELECT 1 FROM expense_voucher_lines l WHERE l.expense_code_id = ec.id)
            OR EXISTS (SELECT 1 FROM expenses x WHERE x.expense_code_id = ec.id)) AS has_lines,
           (SELECT COUNT(*) FROM expense_voucher_lines l WHERE l.expense_code_id = ec.id) AS line_count
      FROM expense_codes ec
      LEFT JOIN expense_categories c ON c.id = ec.category_id
      JOIN accounts a ON a.id = ec.account_id
      LEFT JOIN accounts p ON p.id = ec.payable_account_id`

const toRow = (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    category_id: r.category_id == null ? null : Number(r.category_id),
    category_name: r.category_name ?? null,
    category_code: r.category_code ?? null,
    account_id: Number(r.account_id),
    account_number: r.account_number,
    account_name: r.account_name,
    account_active: Boolean(r.account_active),
    payable_account_id: r.payable_account_id == null ? null : Number(r.payable_account_id),
    payable_number: r.payable_number ?? null,
    payable_name: r.payable_name ?? null,
    is_active: Boolean(r.is_active),
    // Whether any voucher line (or an /expenses row) has ever picked it.
    has_lines: Boolean(Number(r.has_lines)),
    line_count: Number(r.line_count || 0),
})

const fetchCode = async (conn, id) => {
    const [rows] = await conn.query(`${SELECT_CODE} WHERE ec.id = ?`, [id])
    return rows[0] ?? null
}

/*
 * Validation is server-side because the form is a hint. The code is stored
 * upper-case so 'elec' and 'ELEC' are one code, and the UNIQUE index is the
 * final word on that either way.
 */
const cleanCode = (input) => {
    const code = String(input?.code ?? '').trim().toUpperCase()
    if (!code) throw new Error('An expense code needs a code (e.g. ELEC)')
    if (!CODE_RE.test(code)) {
        throw new Error('Code must be 2 to 16 characters: letters, digits, - or _ (e.g. ELEC, RENT-2)')
    }

    const name = String(input?.name ?? '').trim()
    if (!name) throw new Error('An expense code needs a name')
    if (name.length > 96) throw new Error('Name is too long (96 characters max)')

    const category_id = input?.category_id ? requireId(input.category_id, 'category') : null
    const account_id = input?.account_id ? requireId(input.account_id, 'account') : null
    if (!account_id) throw new Error('Choose the expense account this code debits')
    const payable_account_id = input?.payable_account_id ? requireId(input.payable_account_id, 'payable account') : null

    return {
        code, name, category_id, account_id, payable_account_id,
        is_active: input?.is_active === undefined ? true : Boolean(input.is_active),
    }
}

/* An account row, or the reason it cannot be used on that side. */
const checkAccount = async (conn, id, links, what) => {
    const [rows] = await conn.query(
        'SELECT id, account_number, name, link_codes, is_active FROM accounts WHERE id = ?',
        [id],
    )
    const a = rows[0]
    if (!a) throw new Error(`That ${what} account no longer exists`)
    const codes = Array.isArray(a.link_codes) ? a.link_codes : []
    if (!links.some((l) => codes.includes(l))) {
        throw new Error(`${a.account_number} ${a.name} is not marked for use as ${what === 'expense' ? 'an expense' : 'a payable'} account: set that on the chart first`)
    }
    return a
}

export async function listExpenseCodes() {
    try {
        await requirePermission('accounts')
        const rows = await query(`${SELECT_CODE} ORDER BY ec.code`)
        return { data: rows.map(toRow) }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * The accounts the two pickers may offer: expense accounts (what a code
 * debits) and payable accounts (what it credits while unpaid). Active only —
 * a code already pointing at a deactivated account keeps showing it, but
 * nobody can pick it afresh.
 */
export async function listExpenseAccountOptions() {
    try {
        await requirePermission('accounts')
        const rows = await query(
            `SELECT id, account_number, name, link_codes
               FROM accounts
              WHERE is_active = 1
                AND (JSON_CONTAINS(link_codes, ?) OR JSON_CONTAINS(link_codes, ?) OR JSON_CONTAINS(link_codes, ?))
              ORDER BY account_number`,
            [JSON.stringify(EXPENSE_LINK), ...PAYABLE_LINKS.map((l) => JSON.stringify(l))],
        )
        const pick = (r) => ({ id: Number(r.id), account_number: r.account_number, name: r.name })
        const has = (r, l) => Array.isArray(r.link_codes) && r.link_codes.includes(l)
        return {
            data: {
                expense: rows.filter((r) => has(r, EXPENSE_LINK)).map(pick),
                payable: rows.filter((r) => PAYABLE_LINKS.some((l) => has(r, l))).map(pick),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * What the voucher screen's line picker calls: every active code with the
 * two accounts it carries, so a line can be priced and posted without a
 * second lookup. `category` is the category's name.
 */
export async function listActiveExpenseCodes() {
    try {
        await requirePermission('accounts')
        const rows = await query(
            `SELECT ec.id, ec.code, ec.name, c.name AS category,
                    ec.account_id, a.name AS account_name, ec.payable_account_id
               FROM expense_codes ec
               LEFT JOIN expense_categories c ON c.id = ec.category_id
               JOIN accounts a ON a.id = ec.account_id
              WHERE ec.is_active = 1
              ORDER BY ec.code`,
        )
        return {
            data: rows.map((r) => ({
                id: Number(r.id),
                code: r.code,
                name: r.name,
                category: r.category ?? null,
                account_id: Number(r.account_id),
                account_name: r.account_name,
                payable_account_id: r.payable_account_id == null ? null : Number(r.payable_account_id),
            })),
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveExpenseCode(input) {
    try {
        const user = await requirePermission('accounts_admin')
        const clean = cleanCode(input)
        const id = input?.id ? requireId(input.id, 'expense code') : null
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            let codeId = id
            let existing = null
            if (id) {
                existing = await fetchCode(conn, id)
                if (!existing) throw new Error('That expense code no longer exists')
                // Lock it for the duration so two edits cannot interleave.
                await conn.query('SELECT id FROM expense_codes WHERE id = ? FOR UPDATE', [id])
            }

            if (clean.category_id) {
                const [cat] = await conn.query('SELECT id FROM expense_categories WHERE id = ?', [clean.category_id])
                if (cat.length === 0) throw new Error('That category no longer exists')
            }

            // The account is checked against the chart only when it is being
            // set or changed: a code that already points at an account since
            // deactivated keeps pointing there until someone moves it.
            const accountChanged = !existing || Number(existing.account_id) !== clean.account_id
            if (accountChanged) {
                if (existing && Number(existing.has_lines)) {
                    throw new Error(
                        `${existing.code} has ${Number(existing.line_count) || 'voucher'} line(s) posted against `
                        + `${existing.account_number} ${existing.account_name}: its account cannot change. `
                        + 'Deactivate this code and add a new one for the new account.',
                    )
                }
                const a = await checkAccount(conn, clean.account_id, [EXPENSE_LINK], 'expense')
                if (!a.is_active) throw new Error(`${a.account_number} ${a.name} is switched off on the chart`)
            }
            const payableChanged = !existing || Number(existing.payable_account_id ?? 0) !== (clean.payable_account_id ?? 0)
            // Setting a payable account where there was none cannot hurt a
            // posted line (one with money still owed could not have posted
            // without one); moving or removing one can, so that is frozen.
            if (payableChanged && existing && Number(existing.has_lines) && existing.payable_account_id != null) {
                throw new Error(
                    `${existing.code} has ${Number(existing.line_count) || 'voucher'} line(s) booked with `
                    + `${existing.payable_number} ${existing.payable_name} as the payable, and its payable account cannot change, `
                    + 'or a later payment would clear a different account than the one the voucher credited. '
                    + 'Deactivate this code and add a new one.',
                )
            }
            if (clean.payable_account_id && payableChanged) {
                const p = await checkAccount(conn, clean.payable_account_id, PAYABLE_LINKS, 'payable')
                if (!p.is_active) throw new Error(`${p.account_number} ${p.name} is switched off on the chart`)
            }

            try {
                if (id) {
                    await conn.query(
                        `UPDATE expense_codes SET
                           code = ?, name = ?, category_id = ?, account_id = ?,
                           payable_account_id = ?, is_active = ?, updated_at = UTC_TIMESTAMP(3)
                         WHERE id = ?`,
                        [clean.code, clean.name, clean.category_id, clean.account_id,
                            clean.payable_account_id, clean.is_active ? 1 : 0, id],
                    )
                } else {
                    const [result] = await conn.query(
                        `INSERT INTO expense_codes (code, name, category_id, account_id, payable_account_id, is_active)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [clean.code, clean.name, clean.category_id, clean.account_id,
                            clean.payable_account_id, clean.is_active ? 1 : 0],
                    )
                    codeId = result.insertId
                }
            } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') throw new Error(`Code ${clean.code} is already in use`)
                throw e
            }

            await audit(conn, bd, 'save_expense_code', {
                expense_code_id: codeId, mode: id ? 'update' : 'create', ...clean,
            }, user.id)

            return fetchCode(conn, codeId)
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function toggleExpenseCode(id) {
    try {
        const user = await requirePermission('accounts_admin')
        const codeId = requireId(id, 'expense code')
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT id FROM expense_codes WHERE id = ? FOR UPDATE', [codeId])
            if (rows.length === 0) throw new Error('That expense code no longer exists')
            await conn.query(
                'UPDATE expense_codes SET is_active = 1 - is_active, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [codeId],
            )
            const after = await fetchCode(conn, codeId)
            await audit(conn, bd, 'toggle_expense_code', {
                expense_code_id: codeId, code: after.code, name: after.name, is_active: Boolean(after.is_active),
            }, user.id)
            return after
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

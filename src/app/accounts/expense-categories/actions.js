'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { businessDate, audit, requireId } from '@/lib/accounts/helpers.mjs'

/*
 * Expense categories: the headings expense codes are filed under, and the
 * GROUP BY the handover report and the Expense Report already use. This is
 * the same `expense_categories` table the /expenses screen has managed since
 * phase F — 007 gave it a code and an optional default GL account, and this
 * screen is where those get set. Read with `accounts`, written with
 * `accounts_admin`. Deactivate only: expenses and codes FK it, and a heading
 * with history is history.
 */

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,15}$/
const EXPENSE_LINK = 'IC_SERVICE_EXPENSE'

const SELECT_CATEGORY = `
    SELECT c.*,
           a.account_number, a.name AS account_name,
           (SELECT COUNT(*) FROM expense_codes ec WHERE ec.category_id = c.id) AS code_count,
           (SELECT COUNT(*) FROM expense_codes ec WHERE ec.category_id = c.id AND ec.is_active = 1) AS active_code_count
      FROM expense_categories c
      LEFT JOIN accounts a ON a.id = c.gl_account_id`

const toRow = (r) => ({
    id: Number(r.id),
    code: r.code ?? '',
    name: r.name,
    gl_account_id: r.gl_account_id == null ? null : Number(r.gl_account_id),
    account_number: r.account_number ?? null,
    account_name: r.account_name ?? null,
    is_active: Boolean(r.is_active),
    code_count: Number(r.code_count || 0),
    active_code_count: Number(r.active_code_count || 0),
})

const fetchCategory = async (conn, id) => {
    const [rows] = await conn.query(`${SELECT_CATEGORY} WHERE c.id = ?`, [id])
    return rows[0] ?? null
}

const cleanCategory = (input) => {
    const name = String(input?.name ?? '').trim()
    if (!name) throw new Error('A category needs a name')
    if (name.length > 64) throw new Error('Category name is too long (64 characters max)')

    const code = String(input?.code ?? '').trim().toUpperCase()
    if (code && !CODE_RE.test(code)) {
        throw new Error('Code must be 2 to 16 characters: letters, digits, - or _ (e.g. UTIL)')
    }

    const gl_account_id = input?.gl_account_id ? requireId(input.gl_account_id, 'account') : null

    return {
        name, code: code || null, gl_account_id,
        is_active: input?.is_active === undefined ? true : Boolean(input.is_active),
    }
}

export async function listExpenseCategories() {
    try {
        await requirePermission('accounts')
        const rows = await query(`${SELECT_CATEGORY} ORDER BY c.name`)
        return { data: rows.map(toRow) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveExpenseCategory(input) {
    try {
        const user = await requirePermission('accounts_admin')
        const clean = cleanCategory(input)
        const id = input?.id ? requireId(input.id, 'category') : null
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            let categoryId = id
            if (id) {
                const [existing] = await conn.query('SELECT id FROM expense_categories WHERE id = ? FOR UPDATE', [id])
                if (existing.length === 0) throw new Error('That category no longer exists')
            }

            // The column carries no UNIQUE index (it arrived in 007 on rows
            // that had none), so the code's uniqueness is checked here.
            if (clean.code) {
                const [dup] = await conn.query(
                    'SELECT name FROM expense_categories WHERE code = ? AND id <> ?',
                    [clean.code, id ?? 0],
                )
                if (dup.length) throw new Error(`Code ${clean.code} is already used by ${dup[0].name}`)
            }

            if (clean.gl_account_id) {
                const [acc] = await conn.query(
                    'SELECT account_number, name, link_codes, is_active FROM accounts WHERE id = ?',
                    [clean.gl_account_id],
                )
                const a = acc[0]
                if (!a) throw new Error('That account no longer exists')
                const codes = Array.isArray(a.link_codes) ? a.link_codes : []
                if (!codes.includes(EXPENSE_LINK)) {
                    throw new Error(`${a.account_number} ${a.name} is not marked for use as an expense account — set that on the chart first`)
                }
                if (!a.is_active) throw new Error(`${a.account_number} ${a.name} is switched off on the chart`)
            }

            try {
                if (id) {
                    await conn.query(
                        `UPDATE expense_categories SET name = ?, code = ?, gl_account_id = ?, is_active = ?
                         WHERE id = ?`,
                        [clean.name, clean.code, clean.gl_account_id, clean.is_active ? 1 : 0, id],
                    )
                } else {
                    const [result] = await conn.query(
                        `INSERT INTO expense_categories (name, code, gl_account_id, is_active)
                         VALUES (?, ?, ?, ?)`,
                        [clean.name, clean.code, clean.gl_account_id, clean.is_active ? 1 : 0],
                    )
                    categoryId = result.insertId
                }
            } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') throw new Error(`A category named "${clean.name}" already exists`)
                throw e
            }

            await audit(conn, bd, 'save_expense_category', {
                category_id: categoryId, mode: id ? 'update' : 'create', ...clean,
            }, user.id)

            return fetchCategory(conn, categoryId)
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function toggleExpenseCategory(id) {
    try {
        const user = await requirePermission('accounts_admin')
        const categoryId = requireId(id, 'category')
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT id FROM expense_categories WHERE id = ? FOR UPDATE', [categoryId])
            if (rows.length === 0) throw new Error('That category no longer exists')
            await conn.query('UPDATE expense_categories SET is_active = 1 - is_active WHERE id = ?', [categoryId])
            const after = await fetchCategory(conn, categoryId)
            await audit(conn, bd, 'toggle_expense_category', {
                category_id: categoryId, name: after.name, is_active: Boolean(after.is_active),
            }, user.id)
            return after
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

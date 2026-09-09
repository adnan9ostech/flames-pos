'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { businessDate, audit, requireId } from '@/lib/accounts/helpers.mjs'
import {
    GROUP_KEYS, groupOf, LINK_CODES, ACCOUNT_NUMBER_RE, digitsLabel,
} from '@/lib/accounts/constants.mjs'

/*
 * The chart of accounts. Read by anyone with `accounts`; written only with
 * `accounts_admin`, because a renumbered revenue account or a re-linked cash
 * account changes what every statement below it says.
 *
 * There is no delete. An account that has ever been posted to is history, and
 * one that has not is cheaper to deactivate than to argue about. Deactivated
 * accounts drop out of every picker and stay on every report that already
 * carries them.
 */

const toRow = (r) => ({
    id: r.id,
    account_number: r.account_number,
    name: r.name,
    account_group: r.account_group,
    category: r.category,
    link_codes: Array.isArray(r.link_codes) ? r.link_codes : [],
    is_system: Boolean(r.is_system),
    is_active: Boolean(r.is_active),
})

/*
 * Validation lives server-side because the form is a hint, not a guarantee.
 * The numbering rule is enforced, not suggested: an income account numbered
 * in the 5000s would file itself under cost of sales on every report that
 * groups by the leading digit, and nobody would notice until the P&L was
 * wrong. Four digits, standard series — see GROUPS in constants.mjs.
 */
const cleanAccount = (input) => {
    const account_group = GROUP_KEYS.includes(input?.account_group) ? input.account_group : null
    if (!account_group) throw new Error('Choose a group: asset, liability, income, expense or equity')
    const group = groupOf(account_group)

    const account_number = String(input?.account_number ?? '').trim()
    if (!ACCOUNT_NUMBER_RE.test(account_number)) {
        throw new Error('Account number must be exactly four digits')
    }
    if (!group.digits.includes(account_number[0])) {
        const article = group.key === 'liability' ? 'A' : 'An'
        throw new Error(`${article} ${group.label.toLowerCase()} account is numbered ${digitsLabel(group)}`)
    }

    const name = String(input?.name ?? '').trim()
    if (!name) throw new Error('An account needs a name')
    if (name.length > 96) throw new Error('Account name is too long (96 characters max)')

    const category = String(input?.category ?? '').trim().toUpperCase()
    if (!category) throw new Error('An account needs a category (e.g. CURRENT ASSET)')
    if (category.length > 48) throw new Error('Category is too long (48 characters max)')

    // Unknown codes are dropped rather than stored: the poster and the
    // pickers match these strings verbatim, so a typo would silently never link.
    const link_codes = [...new Set(
        (Array.isArray(input?.link_codes) ? input.link_codes : [])
            .map((c) => String(c).trim().toUpperCase())
            .filter((c) => LINK_CODES.includes(c)),
    )]

    return {
        account_number, name, account_group, category, link_codes,
        is_active: input?.is_active === undefined ? true : Boolean(input.is_active),
    }
}

export async function listAccounts() {
    try {
        await requirePermission('accounts')
        const rows = await query(
            'SELECT * FROM accounts ORDER BY account_number',
        )
        return { data: rows.map(toRow) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveAccount(input) {
    try {
        const user = await requirePermission('accounts_admin')
        const clean = cleanAccount(input)
        const id = input?.id ? requireId(input.id, 'account') : null
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            let accountId = id
            try {
                if (id) {
                    // A system account may be renamed and renumbered, never
                    // switched off — the poster names it in gl_settings.
                    const [existing] = await conn.query('SELECT is_system FROM accounts WHERE id = ? FOR UPDATE', [id])
                    if (existing.length === 0) throw new Error('That account no longer exists')
                    const isActive = existing[0].is_system ? 1 : (clean.is_active ? 1 : 0)
                    await conn.query(
                        `UPDATE accounts SET
                           account_number = ?, name = ?, account_group = ?, category = ?,
                           link_codes = ?, is_active = ?, updated_at = UTC_TIMESTAMP(3)
                         WHERE id = ?`,
                        [clean.account_number, clean.name, clean.account_group, clean.category,
                            JSON.stringify(clean.link_codes), isActive, id],
                    )
                } else {
                    const [result] = await conn.query(
                        `INSERT INTO accounts (account_number, name, account_group, category, link_codes, is_active)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [clean.account_number, clean.name, clean.account_group, clean.category,
                            JSON.stringify(clean.link_codes), clean.is_active ? 1 : 0],
                    )
                    accountId = result.insertId
                }
            } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') {
                    throw new Error(`Account number ${clean.account_number} is already in use`)
                }
                throw e
            }

            await audit(conn, bd, 'save_account', {
                account_id: accountId, mode: id ? 'update' : 'create', ...clean,
            }, user.id)

            const [rows] = await conn.query('SELECT * FROM accounts WHERE id = ?', [accountId])
            return rows[0]
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function toggleAccount(id) {
    try {
        const user = await requirePermission('accounts_admin')
        const accountId = requireId(id, 'account')
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM accounts WHERE id = ? FOR UPDATE', [accountId])
            if (rows.length === 0) throw new Error('That account no longer exists')
            if (rows[0].is_system) {
                throw new Error(`${rows[0].name} is a system account the ledger posts to — it cannot be switched off`)
            }
            await conn.query(
                'UPDATE accounts SET is_active = 1 - is_active, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [accountId],
            )
            const [after] = await conn.query('SELECT * FROM accounts WHERE id = ?', [accountId])
            await audit(conn, bd, 'toggle_account', {
                account_id: accountId, account_number: after[0].account_number,
                name: after[0].name, is_active: Boolean(after[0].is_active),
            }, user.id)
            return after[0]
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

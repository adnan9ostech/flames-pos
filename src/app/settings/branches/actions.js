'use server'

import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { cookies } from 'next/headers'
import { BRANCH_COOKIE, currentBranchId, branchesFor } from '@/lib/db/branch.mjs'
import { OVERRIDABLE } from '@/lib/db/branchSettings.mjs'

/* The authorities a Pakistani restaurant can be registered with. FBR covers
 * Islamabad and the federal capital territory; the four provinces each run
 * their own. The list is closed so a typo cannot become a fifth authority. */
const AUTHORITIES = ['FBR', 'PRA', 'SRB', 'KPRA', 'BRA']

const clean = (fd, key) => String(fd.get(key) ?? '').trim()

/*
 * A submitted override, or null meaning "no override — use the company's".
 * An EMPTY BOX IS HOW AN OVERRIDE IS REMOVED, which is the whole grammar of
 * this screen: every field shows the company's answer as its placeholder, and
 * clearing the box hands the question back to the company.
 */
const orNull = (text) => (text === '' ? null : text)

const pctOrNull = (text) => {
    if (text === '') return null
    const n = Number(text)
    if (!Number.isFinite(n) || n < 0 || n > 100) return null
    return n / 100
}

const moneyOrNull = (text) => {
    if (text === '') return null
    const n = Number(text)
    return Number.isFinite(n) && n >= 0 ? n : null
}

const timeOrNull = (text) => (/^\d{2}:\d{2}$/.test(text) ? `${text}:00` : null)

export async function listBranches() {
    try {
        const user = await requirePermission('settings')
        const rows = await query(
            `SELECT b.id, b.name, b.code, b.address, b.phone, b.is_active, b.sort_order,
                    s.tax_rate_cash, s.tax_rate_card, s.tax_label, s.tax_authority,
                    s.fbr_pos_id,
                    (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id) AS staff_count,
                    (SELECT COUNT(*) FROM orders o WHERE o.branch_id = b.id) AS order_count
               FROM branches b
               LEFT JOIN branch_settings s ON s.branch_id = b.id
              ORDER BY b.sort_order, b.id`,
        )
        return {
            data: {
                branches: rows.map((b) => ({
                    ...b,
                    id: Number(b.id),
                    is_active: b.is_active === 1 || b.is_active === true,
                    // Percentages for display; NULL stays NULL so the screen can
                    // show the company's rate greyed out instead of a false 0.
                    tax_rate_cash: b.tax_rate_cash == null ? null : Number(b.tax_rate_cash),
                    tax_rate_card: b.tax_rate_card == null ? null : Number(b.tax_rate_card),
                    staff_count: Number(b.staff_count),
                    order_count: Number(b.order_count),
                })),
                currentBranchId: await currentBranchId(user),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/* One branch with the company's answers alongside, so the form can show what
 * each field WOULD be if the override were cleared. */
export async function getBranch(branchId) {
    try {
        await requirePermission('settings')
        const id = Number(branchId)
        const [branch] = await query('SELECT * FROM branches WHERE id = ?', [id])
        if (!branch) return { error: 'That branch no longer exists.' }

        const [over] = await query('SELECT * FROM branch_settings WHERE branch_id = ?', [id])
        const [company] = await query('SELECT * FROM store_settings LIMIT 1')

        const num = (v) => (v == null ? null : Number(v))
        const hhmm = (v) => (v == null ? null : String(v).slice(0, 5))

        return {
            data: {
                branch: {
                    id: Number(branch.id),
                    name: branch.name,
                    code: branch.code,
                    address: branch.address,
                    phone: branch.phone,
                    is_active: branch.is_active === 1,
                    sort_order: Number(branch.sort_order),
                },
                override: {
                    tax_rate_cash: num(over?.tax_rate_cash),
                    tax_rate_card: num(over?.tax_rate_card),
                    tax_label: over?.tax_label ?? null,
                    tax_authority: over?.tax_authority ?? null,
                    fbr_pos_id: over?.fbr_pos_id ?? null,
                    fbr_ntn: over?.fbr_ntn ?? null,
                    receipt_footer: over?.receipt_footer ?? null,
                    day_start_time: hhmm(over?.day_start_time),
                    day_end_time: hhmm(over?.day_end_time),
                    opening_float: num(over?.opening_float),
                    variance_tolerance: num(over?.variance_tolerance),
                },
                company: {
                    name: company?.merchant_name || '',
                    address: company?.merchant_address || '',
                    phone: company?.merchant_phone || '',
                    tax_rate_cash: num(company?.tax_rate_cash) ?? 0.16,
                    tax_rate_card: num(company?.tax_rate_card) ?? 0.16,
                    tax_label: company?.tax_label || 'GST',
                    day_start_time: hhmm(company?.day_start_time),
                    day_end_time: hhmm(company?.day_end_time),
                    opening_float: num(company?.default_opening_float) ?? 0,
                    variance_tolerance: num(company?.cash_variance_tolerance) ?? 0,
                },
                authorities: AUTHORITIES,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveBranch(formData) {
    try {
        await requirePermission('settings')

        const id = Number(formData.get('id')) || null
        const name = clean(formData, 'name')
        if (!name) return { error: 'A branch needs a name.' }

        const code = clean(formData, 'code').toUpperCase().slice(0, 16)
        const address = clean(formData, 'address')
        const phone = clean(formData, 'phone')
        const sortOrder = Number(formData.get('sort_order')) || 0
        // An outlet is active unless deliberately switched off; an absent
        // checkbox submits nothing and must not close a branch by accident.
        const isActive = formData.get('is_active') !== 'false'

        let branchId = id
        if (id) {
            await query(
                `UPDATE branches SET name = ?, code = ?, address = ?, phone = ?,
                        is_active = ?, sort_order = ? WHERE id = ?`,
                [name, code, address, phone, isActive ? 1 : 0, sortOrder, id],
            )
        } else {
            const res = await query(
                `INSERT INTO branches (name, code, address, phone, is_active, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [name, code, address, phone, isActive ? 1 : 0, sortOrder],
            )
            branchId = Number(res.insertId)
        }

        /*
         * The overrides, as one row of mostly-NULLs. Written with a full
         * REPLACE rather than a patch because an emptied box has to be able to
         * clear an override, and a patch that skipped empty fields could never
         * express "go back to the company's answer".
         */
        const row = {
            tax_rate_cash: pctOrNull(clean(formData, 'tax_rate_cash')),
            tax_rate_card: pctOrNull(clean(formData, 'tax_rate_card')),
            tax_label: orNull(clean(formData, 'tax_label').slice(0, 32)),
            tax_authority: AUTHORITIES.includes(clean(formData, 'tax_authority'))
                ? clean(formData, 'tax_authority') : null,
            fbr_pos_id: orNull(clean(formData, 'fbr_pos_id').slice(0, 32)),
            fbr_ntn: orNull(clean(formData, 'fbr_ntn').slice(0, 32)),
            receipt_footer: orNull(clean(formData, 'receipt_footer').slice(0, 255)),
            day_start_time: timeOrNull(clean(formData, 'day_start_time')),
            day_end_time: timeOrNull(clean(formData, 'day_end_time')),
            opening_float: moneyOrNull(clean(formData, 'opening_float')),
            variance_tolerance: moneyOrNull(clean(formData, 'variance_tolerance')),
        }

        const cols = OVERRIDABLE
        const anySet = cols.some((c) => row[c] != null)
        if (anySet) {
            await query(
                `INSERT INTO branch_settings (branch_id, ${cols.join(', ')})
                 VALUES (?, ${cols.map(() => '?').join(', ')}) AS new_row
                 ON DUPLICATE KEY UPDATE
                 ${cols.map((c) => `${c} = new_row.${c}`).join(', ')}`,
                [branchId, ...cols.map((c) => row[c])],
            )
        } else {
            // Nothing departs from the company any more, so the row itself
            // goes: an all-NULL override is noise that reads as a difference.
            await query('DELETE FROM branch_settings WHERE branch_id = ?', [branchId])
        }

        revalidatePath('/settings/branches')
        return { data: { id: branchId }, success: id ? 'Branch saved.' : 'Branch added.' }
    } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') return { error: 'Another branch already uses that code.' }
        return { error: e.message }
    }
}

/*
 * Switch which outlet this session is looking at. A PREFERENCE, never a
 * permission: the cookie is re-validated against the branches table on every
 * read, and a user tied to a branch cannot move off it however the cookie is
 * set. Refused here too so the switcher does not offer what the reader will
 * ignore.
 */
export async function switchBranch(branchId) {
    try {
        const user = await requirePermission('pos')
        const id = Number(branchId)
        const allowed = await branchesFor(user)
        if (!allowed.some((b) => Number(b.id) === id)) {
            return { error: 'You do not work at that branch.' }
        }
        const jar = await cookies()
        jar.set(BRANCH_COOKIE, String(id), {
            httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365,
        })
        return { data: { id } }
    } catch (e) {
        return { error: e.message }
    }
}

/* What the rail needs: the outlets this person may act on, and where they are. */
export async function branchPicker() {
    try {
        const user = await requirePermission('pos')
        const rows = await branchesFor(user)
        return {
            data: {
                branches: rows.map((b) => ({ id: Number(b.id), name: b.name, code: b.code })),
                current: await currentBranchId(user),
                // A person tied to a branch is told where they are, not offered
                // a choice they do not have.
                canSwitch: user?.branchId == null && rows.length > 1,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

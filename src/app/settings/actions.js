
'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { getStoreSettings } from '@/lib/db/reads.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'

export async function getSettings() {
    // Returns null on any failure, auth included — the page already treats
    // null as "no settings yet", and a thrown error would reach the client
    // redacted into something unreadable.
    try {
        await requireUser()
        return await getStoreSettings()
    } catch (e) {
        console.error('Error fetching settings:', e.message)
        return null
    }
}

/*
 * The settings AS THEY APPLY WHERE YOU ARE STANDING.
 *
 * getSettings above returns the company row, which is right for the Settings
 * screens — that is the row they edit. It is wrong for the till, the kitchen
 * display and the receipt, which need the outlet's own answers: its tax rate,
 * its authority, its bill footer, its float.
 *
 * Getting this wrong had a hard consequence. The till priced tax from the
 * company row while the server priced it from the branch row, so at an outlet
 * with its own rate the two numbers disagreed and the expected-total check
 * refused the settle — "Total mismatch … reload before settling", which
 * reloading could never fix, because the till would compute the company rate
 * again. A second branch could not take a single cash sale. On the pay-now
 * path it was quieter and no better: the screen showed one total and the bill
 * printed another.
 */
export async function getEffectiveSettings() {
    try {
        const user = await requireUser()
        const { settingsFor } = await import('@/lib/db/branchSettings.mjs')
        const { currentBranchId } = await import('@/lib/db/branch.mjs')
        return await settingsFor(await currentBranchId(user))
    } catch (e) {
        // Same contract as getSettings: null rather than a thrown error, which
        // production would redact into something unreadable.
        console.error('Error fetching effective settings:', e.message)
        return null
    }
}

export async function updateSettings(formData) {
    try {
        await requirePermission('settings')

        // Trim before storing: a stray space in raast_id rides straight into the
        // EMVCo payload and produces a QR the bank app rejects.
        const clean = (key) => (formData.get(key) || '').trim()

        const merchant_name = clean('merchant_name')
        const merchant_city = clean('merchant_city')
        const merchant_address = clean('merchant_address')
        const merchant_phone = clean('merchant_phone')
        // The company's tax registration, printed on the bill. Blank stays
        // blank and the receipt then omits the line — a made-up tax number on
        // a customer's bill is worse than no line at all.
        const merchant_ntn = clean('merchant_ntn')
        const merchant_strn = clean('merchant_strn')
        const raast_id = clean('raast_id')

        // Sent as an explicit "true"/"false" string rather than a bare checkbox:
        // an unchecked checkbox submits nothing at all, which is indistinguishable
        // from the field not being on the form.
        const qr_enabled = formData.get('qr_enabled') !== 'false'
        const void_requires_pin = formData.get('void_requires_pin') === 'true'
        // Default ON: an unchecked box submits nothing, and this restaurant is
        // cash-first, so absence must not quietly switch the change maths off.
        const cash_change = formData.get('cash_change') !== 'false'
        // Off unless asked for: a box nobody fills that blocks the checkout is
        // worse than no box at all.
        const card_ref_required = formData.get('card_ref_required') === 'true'
        // Off unless asked for: a token nobody shouts is worse than none.
        const token_mode = formData.get('token_mode') === 'auto' ? 'auto' : 'off'
        // Anything unrecognised falls to 'off': a typo must never empty the menu.
        const submittedGate = String(formData.get('stock_gate') || '')
        const stock_gate = ['flag', 'hide'].includes(submittedGate) ? submittedGate : 'off'
        // Anything unrecognised is off: nobody should start giving money away
        // because a form posted a typo.
        const submittedRound = String(formData.get('round_total') || '')
        const round_total = ['1', '5'].includes(submittedRound) ? submittedRound : 'off'

        /*
         * Cash policy. The standing float is what a drawer close proposes to
         * leave in the till for the morning; the tolerance is how far a count
         * may miss before the close demands a written reason. A blank box
         * means zero here, unlike a price — "we keep nothing overnight" and
         * "explain every rupee" are both real answers, and both are the
         * safer reading of an empty field.
         */
        const cashNumber = (key) => {
            const n = Number(String(formData.get(key) ?? '').trim() || 0)
            return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0
        }
        const default_opening_float = cashNumber('default_opening_float')
        const cash_variance_tolerance = cashNumber('cash_variance_tolerance')

        // Tax rates, the tax label, the service charge, and FBR status all
        // live on their own tab now (settings/tax) with their own action —
        // this one writes only the merchant/receipt columns, so the two
        // forms can never blank each other's fields.
        const existing = await getStoreSettings()
        if (existing) {
            await query(
                `UPDATE store_settings SET
                   merchant_name = ?, merchant_city = ?, merchant_address = ?, merchant_phone = ?,
                   merchant_ntn = ?, merchant_strn = ?, raast_id = ?,
                   qr_enabled = ?, void_requires_pin = ?, cash_change = ?, card_ref_required = ?, token_mode = ?, stock_gate = ?, round_total = ?,
                   default_opening_float = ?, cash_variance_tolerance = ?,
                   updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [merchant_name, merchant_city, merchant_address, merchant_phone,
                    merchant_ntn, merchant_strn, raast_id,
                    qr_enabled ? 1 : 0, void_requires_pin ? 1 : 0, cash_change ? 1 : 0, card_ref_required ? 1 : 0, token_mode, stock_gate, round_total,
                    default_opening_float, cash_variance_tolerance, existing.id],
            )
        } else {
            await query(
                `INSERT INTO store_settings
                   (id, merchant_name, merchant_city, merchant_address, merchant_phone,
                    merchant_ntn, merchant_strn, raast_id,
                    qr_enabled, void_requires_pin, cash_change, card_ref_required, token_mode, stock_gate, round_total,
                    default_opening_float, cash_variance_tolerance)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [randomUUID(), merchant_name, merchant_city, merchant_address, merchant_phone,
                    merchant_ntn, merchant_strn, raast_id,
                    qr_enabled ? 1 : 0, void_requires_pin ? 1 : 0, cash_change ? 1 : 0, card_ref_required ? 1 : 0, token_mode, stock_gate, round_total,
                    default_opening_float, cash_variance_tolerance],
            )
        }

        revalidatePath('/settings')
        return { success: 'Settings updated successfully' }
    } catch (e) {
        return { error: e.message }
    }
}

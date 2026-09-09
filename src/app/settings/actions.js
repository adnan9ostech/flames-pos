
'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { getStoreSettings } from '@/lib/db/reads.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
// The mode names live with the code that prints slips, so the form, the till
// and the KDS can never drift onto different spellings of the same setting.
import { KOT_MODES, DEFAULT_KOT_MODE } from '@/lib/kotPrint'

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

export async function updateSettings(formData) {
    try {
        await requirePermission('settings')

        // Trim before storing: a stray space in raast_id rides straight into the
        // EMVCo payload and produces a QR the bank app rejects.
        const clean = (key) => (formData.get(key) || '').trim()

        const merchant_name = clean('merchant_name')
        const merchant_city = clean('merchant_city')
        const raast_id = clean('raast_id')

        // Sent as an explicit "true"/"false" string rather than a bare checkbox:
        // an unchecked checkbox submits nothing at all, which is indistinguishable
        // from the field not being on the form.
        const qr_enabled = formData.get('qr_enabled') !== 'false'
        const auto_print = formData.get('auto_print') !== 'false'

        // Millimetres of paper. Only the two widths that are actually sold are
        // accepted — anything else is a typo, and a receipt laid out at a width
        // the printer does not have is one that comes out clipped.
        const width = Number(formData.get('receipt_width_mm'))
        const receipt_width_mm = width === 58 ? 58 : 80

        // How a round is cut into kitchen tickets. Anything the printer code
        // does not recognise falls back rather than storing a mode that would
        // print nothing.
        const submittedMode = String(formData.get('kot_mode') || '')
        const kot_mode = KOT_MODES.includes(submittedMode) ? submittedMode : DEFAULT_KOT_MODE

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
                   merchant_name = ?, merchant_city = ?, raast_id = ?,
                   qr_enabled = ?, auto_print = ?, receipt_width_mm = ?,
                   kot_mode = ?, default_opening_float = ?, cash_variance_tolerance = ?,
                   updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [merchant_name, merchant_city, raast_id,
                    qr_enabled ? 1 : 0, auto_print ? 1 : 0, receipt_width_mm,
                    kot_mode, default_opening_float, cash_variance_tolerance, existing.id],
            )
        } else {
            await query(
                `INSERT INTO store_settings
                   (id, merchant_name, merchant_city, raast_id, qr_enabled, auto_print,
                    receipt_width_mm, kot_mode, default_opening_float, cash_variance_tolerance)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [randomUUID(), merchant_name, merchant_city, raast_id,
                    qr_enabled ? 1 : 0, auto_print ? 1 : 0, receipt_width_mm, kot_mode,
                    default_opening_float, cash_variance_tolerance],
            )
        }

        revalidatePath('/settings')
        return { success: 'Settings updated successfully' }
    } catch (e) {
        return { error: e.message }
    }
}

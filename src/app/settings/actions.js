
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

        // Tax rates, the tax label, the service charge, and FBR status all
        // live on their own tab now (settings/tax) with their own action —
        // this one writes only the merchant/receipt columns, so the two
        // forms can never blank each other's fields.
        const existing = await getStoreSettings()
        if (existing) {
            await query(
                `UPDATE store_settings SET
                   merchant_name = ?, merchant_city = ?, raast_id = ?,
                   qr_enabled = ?, auto_print = ?,
                   updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [merchant_name, merchant_city, raast_id,
                    qr_enabled ? 1 : 0, auto_print ? 1 : 0, existing.id],
            )
        } else {
            await query(
                `INSERT INTO store_settings
                   (id, merchant_name, merchant_city, raast_id, qr_enabled, auto_print)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [randomUUID(), merchant_name, merchant_city, raast_id,
                    qr_enabled ? 1 : 0, auto_print ? 1 : 0],
            )
        }

        revalidatePath('/settings')
        return { success: 'Settings updated successfully' }
    } catch (e) {
        return { error: e.message }
    }
}


'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { getStoreSettings } from '@/lib/db/reads.mjs'
import { requireUser, requireAdmin } from '@/lib/db/auth.mjs'

export async function getSettings() {
    // Returns null on any failure, auth included — the page already treats
    // null as "no settings yet", and a thrown error would reach the client
    // redacted into something unreadable.
    try {
        await requireUser()
        const settings = await getStoreSettings()
        if (!settings) return null
        // The standing service charge lives in the charges engine (one row,
        // by name); Settings offers its percentage as a quick edit beside
        // the tax rates. 0 means switched off.
        const rows = await query(
            "SELECT value, is_active FROM charges WHERE name = 'Service Charge' LIMIT 1",
        )
        settings.service_charge_percent = rows.length && rows[0].is_active
            ? Number(rows[0].value) : 0
        return settings
    } catch (e) {
        console.error('Error fetching settings:', e.message)
        return null
    }
}

export async function updateSettings(formData) {
    try {
        await requireAdmin()

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

        // Clamped server-side too: the number input is a hint, not a guarantee,
        // and a rate above 1 would silently multiply every bill. Two rates
        // because ICT taxes cash and card sales differently; settle resolves
        // which one a bill pays.
        const rate = (key) => {
            const raw = Number(formData.get(key))
            return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.16
        }
        const tax_rate_cash = rate('tax_rate_cash')
        const tax_rate_card = rate('tax_rate_card')
        const tax_label = clean('tax_label') || 'GST'

        const existing = await getStoreSettings()
        if (existing) {
            await query(
                `UPDATE store_settings SET
                   merchant_name = ?, merchant_city = ?, raast_id = ?,
                   qr_enabled = ?, auto_print = ?,
                   tax_rate_cash = ?, tax_rate_card = ?, tax_label = ?,
                   updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [merchant_name, merchant_city, raast_id,
                    qr_enabled ? 1 : 0, auto_print ? 1 : 0,
                    tax_rate_cash, tax_rate_card, tax_label, existing.id],
            )
        } else {
            await query(
                `INSERT INTO store_settings
                   (id, merchant_name, merchant_city, raast_id,
                    qr_enabled, auto_print, tax_rate_cash, tax_rate_card, tax_label)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [randomUUID(), merchant_name, merchant_city, raast_id,
                    qr_enabled ? 1 : 0, auto_print ? 1 : 0,
                    tax_rate_cash, tax_rate_card, tax_label],
            )
        }

        // Service charge rides the charges engine, keyed by name: the quick
        // field edits the percentage, 0 switches the charge off, and the
        // Charges screen keeps full control of its shape.
        const scRaw = Number(formData.get('service_charge_percent'))
        if (Number.isFinite(scRaw)) {
            const pct = Math.min(Math.max(scRaw, 0), 100)
            await query(
                `UPDATE charges SET value = ?, is_active = ?, updated_at = UTC_TIMESTAMP(3)
                 WHERE name = 'Service Charge'`,
                [pct, pct > 0 ? 1 : 0],
            )
        }

        revalidatePath('/settings')
        return { success: 'Settings updated successfully' }
    } catch (e) {
        return { error: e.message }
    }
}

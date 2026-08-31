'use server'

import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

/*
 * The tax side of Settings, on its own tab: the two GST rates, the tax
 * label, the standing service charge — and the FBR Digital Invoicing
 * status. Split from updateSettings so each form writes only its own
 * columns; a partial form posting through a do-everything action is how
 * merchant details get silently blanked.
 */
export async function updateTaxSettings(formData) {
    try {
        await requirePermission('settings')

        // Clamped server-side too: the number input is a hint, not a
        // guarantee, and a rate above 1 would multiply every bill.
        const rate = (key, fallback) => {
            const raw = Number(formData.get(key))
            return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : fallback
        }
        const tax_rate_cash = rate('tax_rate_cash', 0.16)
        const tax_rate_card = rate('tax_rate_card', 0.05)
        const tax_label = (formData.get('tax_label') || '').trim() || 'GST'

        await query(
            `UPDATE store_settings SET
               tax_rate_cash = ?, tax_rate_card = ?, tax_label = ?,
               updated_at = UTC_TIMESTAMP(3)`,
            [tax_rate_cash, tax_rate_card, tax_label],
        )

        // Charges are NOT written here. The Charges screen is their one
        // editor — it owns name, scope, and tax placement, and a second
        // form that could only reach `value` (matched by a name the other
        // screen lets you change) is how two screens start disagreeing.
        revalidatePath('/settings/tax')
        return { success: 'Tax settings updated' }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Read-only FBR panel data. Credentials live in the server environment on
 * purpose — a token that can file invoices with the tax authority does not
 * belong in a database row an admin screen can edit — so this reports
 * presence and health, never values.
 */
export async function getFbrStatus() {
    try {
        await requirePermission('settings')

        const enabled = process.env.FBR_ENABLED === 'true'
        const queue = await query(
            `SELECT status, COUNT(*) AS n FROM fbr_invoices GROUP BY status`,
        )
        const counts = { pending: 0, sent: 0, failed: 0 }
        for (const row of queue) counts[row.status] = Number(row.n)

        const [last] = await query(
            `SELECT fbr_invoice_number, sent_at FROM fbr_invoices
             WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
        )

        return {
            data: {
                enabled,
                mode: process.env.FBR_MODE || 'sandbox',
                bposid_set: Boolean(process.env.FBR_BPOSID),
                token_set: Boolean(process.env.FBR_TOKEN),
                seller_ntn_set: Boolean(process.env.FBR_SELLER_NTN),
                queue: counts,
                last_sent: last ? { number: last.fbr_invoice_number, at: last.sent_at?.toISOString?.() ?? String(last.sent_at) } : null,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

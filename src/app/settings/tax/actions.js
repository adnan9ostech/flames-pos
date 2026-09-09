'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { getStoreSettings } from '@/lib/db/reads.mjs'
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
        //
        // An EMPTY field is missing, not zero — the opposite of the cash
        // fields on the General tab, where blank deliberately means zero.
        // Number('') is 0 and 0 is finite, so testing the parsed value alone
        // let a cleared box set the store's tax rate to 0% and made the
        // fallbacks below unreachable. Test the raw string first.
        const rate = (key, fallback) => {
            const raw = String(formData.get(key) ?? '').trim()
            if (raw === '') return fallback
            const n = Number(raw)
            return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : fallback
        }
        const tax_rate_cash = rate('tax_rate_cash', 0.16)
        const tax_rate_card = rate('tax_rate_card', 0.05)
        const tax_label = (formData.get('tax_label') || '').trim() || 'GST'

        // Same read-then-branch as updateSettings. The UPDATE used to carry no
        // WHERE and no INSERT branch, so on a store with no settings row yet it
        // matched nothing and still reported success — the two rates every bill
        // is taxed at, silently not saved.
        const existing = await getStoreSettings()
        if (existing) {
            await query(
                `UPDATE store_settings SET
                   tax_rate_cash = ?, tax_rate_card = ?, tax_label = ?,
                   updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [tax_rate_cash, tax_rate_card, tax_label, existing.id],
            )
        } else {
            // Only the tax columns are named; everything else on the row keeps
            // its schema default, so this cannot blank a merchant detail the
            // General tab owns.
            await query(
                `INSERT INTO store_settings (id, tax_rate_cash, tax_rate_card, tax_label)
                 VALUES (?, ?, ?, ?)`,
                [randomUUID(), tax_rate_cash, tax_rate_card, tax_label],
            )
        }

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

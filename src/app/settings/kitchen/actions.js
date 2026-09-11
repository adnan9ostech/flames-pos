'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { query } from '@/lib/db/pool.mjs'
import { getStoreSettings } from '@/lib/db/reads.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { KOT_MODES, DEFAULT_KOT_MODE } from '@/lib/kotPrint'

/*
 * The kitchen and printing side of Settings, on its own tab: whether the
 * receipt auto-prints, the paper width, where kitchen tickets print (the till
 * or the kitchen screen), whether the kitchen screen auto-prints, and how a
 * round is cut into slips. Split from updateSettings so each form writes only
 * its own columns — a partial form posting through a do-everything action is
 * how the merchant details or the tax rates get silently blanked.
 */
export async function updateKitchenSettings(formData) {
    try {
        await requirePermission('settings')

        // Explicit "true"/"false": an unchecked box submits nothing, which the
        // action cannot tell from a missing field.
        const auto_print = formData.get('auto_print') !== 'false'
        const kds_auto_print = formData.get('kds_auto_print') !== 'false'

        // Only the two widths that are sold; anything else is a typo that would
        // lay a receipt out for paper the printer does not have.
        const width = Number(formData.get('receipt_width_mm'))
        const receipt_width_mm = width === 58 ? 58 : 80

        const submittedMode = String(formData.get('kot_mode') || '')
        const kot_mode = KOT_MODES.includes(submittedMode) ? submittedMode : DEFAULT_KOT_MODE

        // Anything but an explicit 'till' means the kitchen screen prints.
        const kot_route = formData.get('kot_route') === 'till' ? 'till' : 'kds'

        // Anything but an explicit 'browser' means the local print agent, and
        // browser printing is then never used as a fallback — see migration 020.
        const print_transport = formData.get('print_transport') === 'browser' ? 'browser' : 'agent'

        // Two copies (customer + restaurant) unless explicitly set to one.
        const receipt_copies = Number(formData.get('receipt_copies')) === 1 ? 1 : 2

        // When the cash drawer opens by itself. Anything unrecognised falls to
        // 'cash' — the safe reading, since a drawer that opens on cash sales
        // only is the one behaviour no cashier is surprised by.
        const submittedKick = String(formData.get('drawer_kick') || '')
        const drawer_kick = ['always', 'never'].includes(submittedKick) ? submittedKick : 'cash'

        // Which RJ11 pin carries the pulse. Pin 2 on nearly every drawer sold.
        const drawer_pin = Number(formData.get('drawer_pin')) === 5 ? 5 : 2

        // Off unless explicitly asked for: it costs roll on every ticket and
        // earns nothing until somebody is actually scanning them.
        const kot_qr = formData.get('kot_qr') === 'true'

        const existing = await getStoreSettings()
        if (existing) {
            await query(
                `UPDATE store_settings SET
                   auto_print = ?, receipt_width_mm = ?, kot_mode = ?,
                   kot_route = ?, kds_auto_print = ?, print_transport = ?, receipt_copies = ?,
                   drawer_kick = ?, drawer_pin = ?, kot_qr = ?,
                   updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [auto_print ? 1 : 0, receipt_width_mm, kot_mode,
                    kot_route, kds_auto_print ? 1 : 0, print_transport, receipt_copies,
                    drawer_kick, drawer_pin, kot_qr ? 1 : 0, existing.id],
            )
        } else {
            // Only the kitchen/printer columns are named; everything else keeps
            // its schema default, so this cannot blank a merchant or tax field.
            await query(
                `INSERT INTO store_settings
                   (id, auto_print, receipt_width_mm, kot_mode, kot_route, kds_auto_print,
                    print_transport, receipt_copies, drawer_kick, drawer_pin, kot_qr)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [randomUUID(), auto_print ? 1 : 0, receipt_width_mm, kot_mode,
                    kot_route, kds_auto_print ? 1 : 0, print_transport, receipt_copies,
                    drawer_kick, drawer_pin, kot_qr ? 1 : 0],
            )
        }

        revalidatePath('/settings/kitchen')
        return { success: 'Kitchen & printer settings updated' }
    } catch (e) {
        return { error: e.message }
    }
}

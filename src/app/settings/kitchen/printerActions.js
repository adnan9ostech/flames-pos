'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

/*
 * Printers as rows, so a printer is chosen on a screen rather than typed into
 * a launchd plist. See migration 038 for why, and for what each profile column
 * is actually compensating for.
 *
 * The agent discovers what a MACHINE can see — only it can, the queue list
 * belongs to the machine the browser is on. This file only stores the choice.
 */

const ROLES = ['receipt', 'kitchen']
const CUTS = ['full', 'partial', 'none']

export async function listPrinters() {
    try {
        await requirePermission('settings')
        return {
            data: await query(
                `SELECT id, role, label, transport, target, width_mm, cut_mode,
                        feed_lines, codepage, drawer_pin, is_active, updated_at
                   FROM printers ORDER BY FIELD(role, 'receipt', 'kitchen'), id`,
            ),
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * One printer per role, replaced wholesale. Upsert rather than insert-or-edit
 * because "which printer prints the receipts" has exactly one answer and the
 * screen should not be able to create a second.
 */
export async function savePrinter({
    role, label, transport, target,
    widthMm, cutMode, feedLines, codepage, drawerPin,
} = {}) {
    try {
        await requirePermission('settings')
        if (!ROLES.includes(role)) throw new Error('A printer is either the receipt printer or the kitchen printer')
        const t = String(target ?? '').trim().slice(0, 191)
        if (!t) throw new Error('Pick a printer from the list, or type its queue name')

        const row = {
            role,
            label: String(label ?? '').trim().slice(0, 96) || t,
            transport: transport === 'device' ? 'device' : 'cups',
            target: t,
            width_mm: Number(widthMm) === 58 ? 58 : 80,
            cut_mode: CUTS.includes(cutMode) ? cutMode : 'full',
            // Zero is legal — a printer whose head sits at the cutter.
            feed_lines: Math.max(0, Math.min(30, Math.round(Number(feedLines) || 0))),
            codepage: Math.max(0, Math.min(255, Math.round(Number(codepage) || 0))),
            drawer_pin: Number(drawerPin) === 5 ? 5 : 2,
        }

        await query(
            `INSERT INTO printers
               (role, label, transport, target, width_mm, cut_mode, feed_lines, codepage, drawer_pin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               label = VALUES(label), transport = VALUES(transport), target = VALUES(target),
               width_mm = VALUES(width_mm), cut_mode = VALUES(cut_mode),
               feed_lines = VALUES(feed_lines), codepage = VALUES(codepage),
               drawer_pin = VALUES(drawer_pin), is_active = 1, updated_at = UTC_TIMESTAMP(3)`,
            [row.role, row.label, row.transport, row.target, row.width_mm,
                row.cut_mode, row.feed_lines, row.codepage, row.drawer_pin],
        )
        return { success: `${row.label} saved: the next print goes to it, with nothing restarted` }
    } catch (e) {
        return { error: e.message }
    }
}

/* Unset a role, which sends the agent back to finding a printer itself. */
export async function forgetPrinter(role) {
    try {
        await requirePermission('settings')
        if (!ROLES.includes(role)) return { error: 'Unknown printer role' }
        await query('DELETE FROM printers WHERE role = ?', [role])
        return { success: 'Forgotten: the agent will look for a printer on its own' }
    } catch (e) {
        return { error: e.message }
    }
}

'use server'

import bcrypt from 'bcryptjs'
import { query } from '@/lib/db/pool.mjs'
import { requireUser } from '@/lib/db/auth.mjs'
import { effectivePermissions } from '@/lib/auth/permissions.mjs'

// The trading day a removal belongs to: the open business day if day-close is
// in use, else the Karachi calendar day. Mirrors resolveBusinessDate in
// orders.mjs (not exported) — kept small and local so this action stays
// self-contained. Never null.
const karachiDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })
const resolveBusinessDate = async (branchId = 1) => {
    const rows = await query(
        `SELECT business_date FROM business_days
         WHERE branch_id = ? AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
        [branchId],
    )
    if (rows.length === 0) return karachiDay()
    const d = rows[0].business_date
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d)
}

/*
 * Approve removing a line from the cart with a manager PIN, and record it.
 *
 * Gated by store_settings.void_requires_pin. The PIN is a person's login
 * password (the till has no separate PIN column), and it counts only if that
 * person may actually void — the `void` permission, which admin and manager
 * carry by default and which can be granted to anyone as an override. A
 * cashier's own password will not clear the dialog: the point is that the
 * cashier can't quietly drop items off a bill.
 *
 * Every approved removal is written to audit_log with a REASON: who was on the
 * till (requireUser), who authorised it (the PIN's owner, in staff_id), the
 * line taken off, and why. A removal nobody can account for later is exactly
 * what this feature exists to prevent, so the reason is required, not optional.
 *
 * Returns { data: { approvedBy } } on success, { error } otherwise.
 */
export async function approveVoid({ pin, reason, item = null, orderId = null } = {}) {
    try {
        const operator = await requireUser()

        const entered = String(pin || '')
        if (!entered) return { error: 'Enter a manager PIN to remove this item.' }

        const why = String(reason || '').trim()
        if (!why) return { error: 'Enter a reason for removing this item.' }

        // Only the accounts that could hold `void`: admins and managers by
        // role, plus anyone whose overrides grant it. The cashier's own hash is
        // never in this set, so a cashier PIN can never approve a removal.
        const rows = await query(
            `SELECT id, full_name, username, role, password_hash, permissions
             FROM users
             WHERE is_active = 1 AND (role IN ('admin', 'manager') OR permissions IS NOT NULL)`,
        )

        let approver = null
        for (const u of rows) {
            if (!effectivePermissions(u.role, u.permissions).void) continue
            if (await bcrypt.compare(entered, u.password_hash || '')) { approver = u; break }
        }

        if (!approver) return { error: 'That PIN is not a manager who can remove items.' }

        const approvedBy = approver.full_name || approver.username || 'Manager'
        const businessDate = await resolveBusinessDate(1)

        // staff_id is WHO AUTHORISED; the operator (who was signed in and asked
        // for the removal) is kept in details, so a later read shows both hands.
        await query(
            `INSERT INTO audit_log (branch_id, business_date, action, order_id, staff_id, details)
             VALUES (1, ?, 'remove_item', ?, ?, ?)`,
            [
                businessDate,
                orderId || null,
                approver.id,
                JSON.stringify({
                    reason: why,
                    item: item ? {
                        name: item.name ?? null,
                        qty: item.qty ?? null,
                        price: item.price ?? null,
                        variant: item.variant ?? item.selectedVariant?.name ?? null,
                    } : null,
                    approved_by: { id: approver.id, name: approvedBy, role: approver.role },
                    removed_by: { id: operator.id, name: operator.name, role: operator.role },
                }),
            ],
        )

        return { data: { approvedBy } }
    } catch (e) {
        return { error: e.message }
    }
}

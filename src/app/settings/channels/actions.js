'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

/*
 * Sales channels: where an order came from. One row exists until the
 * restaurant lists itself somewhere — see migration 037, including what this
 * deliberately does not yet do (commission, and the receivable behind it).
 */

export async function listChannels() {
    try {
        await requirePermission('settings')
        return {
            data: await query(
                `SELECT c.id, c.name, c.is_default, c.is_active, c.sort_order,
                        (SELECT COUNT(*) FROM orders o WHERE o.channel_id = c.id) AS orders
                   FROM sales_channels c ORDER BY c.sort_order, c.id`,
            ),
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveChannel({ id, name, isActive, isDefault } = {}) {
    try {
        await requirePermission('settings')
        const clean = String(name ?? '').trim().slice(0, 64)
        if (!clean) throw new Error('A channel needs a name')

        await withTransaction(async (conn) => {
            if (id) {
                await conn.query(
                    'UPDATE sales_channels SET name = ?, is_active = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                    [clean, isActive ? 1 : 0, id],
                )
            } else {
                await conn.query(
                    'INSERT INTO sales_channels (name, is_active, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(s.sort_order), 0) + 1 FROM sales_channels s))',
                    [clean, isActive === false ? 0 : 1],
                )
            }
            if (isDefault && id) {
                // Exactly one default, always: the till reads the first it
                // finds, and two would make which one it lands on a matter of
                // row order.
                await conn.query('UPDATE sales_channels SET is_default = 0')
                await conn.query('UPDATE sales_channels SET is_default = 1, is_active = 1 WHERE id = ?', [id])
            }
        })
        return { success: id ? 'Channel updated' : 'Channel added' }
    } catch (e) {
        return { error: /Duplicate entry/.test(e.message) ? 'A channel with that name already exists' : e.message }
    }
}

/*
 * Switched off rather than deleted once orders point at it — the same rule a
 * dish follows, and for the same reason: history has to keep saying where
 * those bills came from.
 */
export async function removeChannel(id) {
    try {
        await requirePermission('settings')
        const [row] = await query(
            'SELECT is_default, (SELECT COUNT(*) FROM orders o WHERE o.channel_id = ?) AS orders FROM sales_channels WHERE id = ?',
            [id, id],
        )
        if (!row) return { error: 'That channel no longer exists' }
        if (row.is_default) return { error: 'Make another channel the default first' }
        if (Number(row.orders) > 0) {
            await query('UPDATE sales_channels SET is_active = 0 WHERE id = ?', [id])
            return { success: 'Channel switched off — its orders still name it' }
        }
        await query('DELETE FROM sales_channels WHERE id = ?', [id])
        return { success: 'Channel removed' }
    } catch (e) {
        return { error: e.message }
    }
}

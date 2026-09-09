'use server'

import { query } from '@/lib/db/pool.mjs'
import { serializeRow, serializeRows } from '@/lib/db/serialize.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

/*
 * The read behind the order detail panel.
 *
 * The list gives a floor manager a row; this gives them the bill. Everything
 * that is true about one order in one place: the two independent states
 * (kitchen and money), the lines AS RUNG round by round, what was charged and
 * what was taken, and the trail of who did what to it.
 *
 * `orders` is the only source for status — the panel is refetched whenever the
 * 4s version poll moves, so a KDS bump shows up here without a reload.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/*
 * Enough trail for the longest tab anyone will open — create, a round per
 * course, settle, the ledger postings and a void is nowhere near this. Capped
 * all the same, because the panel refetches on every version change.
 */
const TRAIL_LIMIT = 60

export async function getOrderDetail(orderId) {
    try {
        await requirePermission('orders')

        const id = String(orderId ?? '')
        // The id comes off a row the caller just rendered, but it still rides
        // into five queries — refuse anything that isn't the shape of an id.
        if (!UUID_RE.test(id)) return { error: 'That order no longer exists' }

        const [row] = await query('SELECT * FROM orders WHERE id = ?', [id])
        if (!row) return { error: 'That order no longer exists' }
        const order = serializeRow('orders', row)

        /*
         * Sequential, not Promise.all: the pool holds five connections for the
         * whole box and an open panel re-runs this every time the version moves.
         * Five indexed lookups on one order cost less than the contention would.
         */
        const lines = serializeRows('order_items', await query(
            `SELECT id, round_no, seq, name, variant, modifiers, qty,
                    unit_price, line_total, notes, created_at
               FROM order_items WHERE order_id = ? ORDER BY round_no, seq`,
            [id],
        ))

        const roundRows = serializeRows('order_rounds', await query(
            'SELECT round_no, fired_at FROM order_rounds WHERE order_id = ? ORDER BY round_no',
            [id],
        ))

        const payments = serializeRows('payments', await query(
            `SELECT id, method, amount, paid_at
               FROM payments WHERE order_id = ? ORDER BY paid_at, id`,
            [id],
        ))

        // staff_id is NULL on a machine posting (the GL hooks) and on writes
        // that predate per-person identity; the void carries its actor in
        // details.by instead. The component decides what to say for each.
        const trail = serializeRows('audit_log', await query(
            `SELECT a.id, a.at, a.action, a.details, a.staff_id,
                    u.full_name, u.username
               FROM audit_log a
               LEFT JOIN users u ON u.id = a.staff_id
              WHERE a.order_id = ?
              ORDER BY a.at DESC, a.id DESC
              LIMIT ?`,
            [id, TRAIL_LIMIT],
        ))

        /*
         * Grouped by round because that is the question the floor asks — "what
         * went to the kitchen at 8:20" — not "what is on this bill". Rounds are
         * keyed off the LINES, so a round whose order_rounds row is missing
         * (an import, a hand-repaired order) still shows its food; fired_at is
         * simply unknown then.
         */
        const byRound = new Map()
        const roundFor = (no) => {
            if (!byRound.has(no)) {
                byRound.set(no, { round_no: no, fired_at: null, items: [], subtotal: 0 })
            }
            return byRound.get(no)
        }
        for (const r of roundRows) roundFor(r.round_no).fired_at = r.fired_at
        for (const line of lines) {
            const round = roundFor(line.round_no)
            round.items.push({
                ...line,
                qty: Number(line.qty),
                unit_price: Number(line.unit_price),
                line_total: Number(line.line_total),
            })
            round.subtotal += Number(line.line_total)
        }
        const rounds = [...byRound.values()].sort((a, b) => a.round_no - b.round_no)

        /*
         * What has actually been taken. A void writes a NEGATIVE payments row,
         * so the sum is the net position rather than the gross ever collected —
         * which is what "still owed" has to be worked out from.
         */
        const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0)

        return {
            data: {
                order,
                rounds,
                payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
                paid,
                balance: Number(order.total) - paid,
                trail: trail.map((t) => ({
                    id: t.id,
                    at: t.at,
                    action: t.action,
                    details: t.details ?? null,
                    // The signed-in account when there was one; the name the
                    // void recorded otherwise.
                    actor: t.full_name || t.username || t.details?.by || null,
                })),
            },
        }
    } catch (e) {
        // Same envelope as every other action: the panel shows this string, and
        // an auth failure must read as a sentence rather than a redacted throw.
        return { error: e.message }
    }
}

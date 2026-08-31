'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { requireAdmin } from '@/lib/db/auth.mjs'

const BRANCH_ID = 1

// The calendar day in Asia/Karachi (fixed UTC+5, no DST) — what acts as the
// business day until the first close creates real business_days rows.
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

// DATE columns come back as midnight-UTC Dates; the calendar day is the value.
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))

// The next calendar date after a 'YYYY-MM-DD'. UTC arithmetic on the string,
// so the box's own timezone can never shift the answer.
const nextCalendarDay = (day) => {
    const d = new Date(`${day}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
}

/* Orders still owed money — the gate a close has to pass or be forced through. */
const fetchPendingBills = async () =>
    serializeRows('orders', await query(
        `SELECT order_number, table_number, order_type, total, created_at
         FROM orders
         WHERE payment_status = 'unpaid' AND status <> 'cancelled'
         ORDER BY created_at`,
    ))

/*
 * The whole screen in one shape, shared by the read action and the close —
 * closing hands back the state it produced so the page never re-fetches into
 * a race with itself.
 */
const loadState = async () => {
    const openRows = await query(
        `SELECT business_date, opened_at FROM business_days
         WHERE branch_id = ? AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
        [BRANCH_ID],
    )

    // No open row means day-close has never run: the Karachi calendar day is
    // acting as the business day, and the payload says so rather than
    // pretending a row exists.
    const openDay = openRows.length > 0
        ? {
            state: 'open',
            business_date: ymd(openRows[0].business_date),
            opened_at: openRows[0].opened_at.toISOString(),
        }
        : { state: 'implicit', business_date: karachiDay(), opened_at: null }

    const history = (await query(
        `SELECT bd.business_date, bd.opened_at, bd.closed_at, u.role AS closed_by_role
         FROM business_days bd
         LEFT JOIN users u ON u.id = bd.closed_by
         WHERE bd.branch_id = ? AND bd.closed_at IS NOT NULL
         ORDER BY bd.business_date DESC LIMIT 30`,
        [BRANCH_ID],
    )).map((r) => ({
        business_date: ymd(r.business_date),
        opened_at: r.opened_at ? r.opened_at.toISOString() : null,
        closed_at: r.closed_at ? r.closed_at.toISOString() : null,
        closed_by_role: r.closed_by_role ?? null,
    }))

    return { openDay, history, pendingBills: await fetchPendingBills() }
}

export async function getDayCloseState() {
    try {
        await requireAdmin()
        return { data: await loadState() }
    } catch (e) {
        return { error: e.message }
    }
}

export async function closeBusinessDay({ force = false } = {}) {
    try {
        const user = await requireAdmin()

        // The gate. An unpaid bill left behind either settles onto the wrong
        // day's books or never settles at all, so the operator must settle or
        // void — force exists for a genuine end-of-night decision, and the
        // audit row says it was used.
        const pending = await fetchPendingBills()
        if (pending.length > 0 && !force) {
            return {
                error: `${pending.length} unpaid bill${pending.length === 1 ? ' is' : 's are'} still open — settle or void ${pending.length === 1 ? 'it' : 'them'} before closing the day.`,
            }
        }

        await withTransaction(async (conn) => {
            // The lock: two admins pressing Close at once produce one close —
            // the loser waits here, then trips the duplicate-day INSERT below
            // instead of silently advancing the calendar twice.
            const [openRows] = await conn.query(
                `SELECT business_date FROM business_days
                 WHERE branch_id = ? AND closed_at IS NULL
                 ORDER BY business_date DESC LIMIT 1 FOR UPDATE`,
                [BRANCH_ID],
            )

            let closedDate
            if (openRows.length > 0) {
                closedDate = ymd(openRows[0].business_date)
                await conn.query(
                    `UPDATE business_days
                     SET closed_at = UTC_TIMESTAMP(3), closed_by = ?
                     WHERE branch_id = ? AND business_date = ?`,
                    [user.id, BRANCH_ID, closedDate],
                )
            } else {
                // First ever close: the implicit Karachi day becomes a real
                // row, created already closed, so history starts tonight.
                closedDate = karachiDay()
                await conn.query(
                    `INSERT INTO business_days (branch_id, business_date, opened_at, closed_at, closed_by)
                     VALUES (?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?)`,
                    [BRANCH_ID, closedDate, user.id],
                )
            }

            // The next trading day is the next CALENDAR date after the one
            // just closed. A 01:30 close after a late service closes THAT
            // trading day, and the new row's date may already be "today" in
            // Karachi — that is correct, not a bug.
            const nextDate = nextCalendarDay(closedDate)
            await conn.query(
                `INSERT INTO business_days (branch_id, business_date, opened_at)
                 VALUES (?, ?, UTC_TIMESTAMP(3))`,
                [BRANCH_ID, nextDate],
            )

            await conn.query(
                `INSERT INTO audit_log (branch_id, business_date, action, details)
                 VALUES (?, ?, 'day_close', ?)`,
                [BRANCH_ID, closedDate, JSON.stringify({
                    closed: closedDate,
                    opened: nextDate,
                    pending_bills: pending.length,
                    forced: Boolean(force) && pending.length > 0,
                    // Which bills were knowingly carried past the close —
                    // tomorrow's "why is table 9 on yesterday's books" answer.
                    ...(force && pending.length > 0
                        ? { carried_orders: pending.map((b) => b.order_number) }
                        : {}),
                })],
            )
        })

        return { data: await loadState() }
    } catch (e) {
        return { error: e.message }
    }
}

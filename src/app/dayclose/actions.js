'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

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
    const today = karachiDay()
    const openDay = openRows.length > 0
        ? {
            state: 'open',
            business_date: ymd(openRows[0].business_date),
            opened_at: openRows[0].opened_at.toISOString(),
            // Shut for a day or two: the day the last close opened is behind
            // today, so tonight's orders would land on it unless it is moved.
            stale: ymd(openRows[0].business_date) < today,
        }
        : { state: 'implicit', business_date: today, opened_at: null, stale: false }

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
        await requirePermission('dayclose')
        return { data: await loadState() }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Start a trading day.
 *
 * Normally the close opens the next day, so this is needed twice: on the
 * very first day (before any close there is no row at all — orders fall back
 * to the Karachi calendar day), and after the restaurant is shut for a day
 * or two, when the day the last close opened has gone stale. In that second
 * case the stale row is re-dated rather than left behind, because closing
 * empty days one at a time to catch up is not a thing anyone should have to
 * do at 6pm.
 *
 * A stale day that already carries orders is never moved — those orders
 * belong to it — so the operator is told to close it instead.
 */
export async function startBusinessDay({ date = null } = {}) {
    try {
        const user = await requirePermission('dayclose')
        const target = date || karachiDay()

        return await withTransaction(async (conn) => {
            const [openRows] = await conn.query(
                `SELECT business_date, opened_at FROM business_days
                 WHERE branch_id = ? AND closed_at IS NULL
                 ORDER BY business_date DESC LIMIT 1 FOR UPDATE`,
                [BRANCH_ID],
            )

            if (openRows.length > 0) {
                const openDate = ymd(openRows[0].business_date)
                if (openDate === target) {
                    return { data: await loadState() }   // already trading; nothing to do
                }
                if (openDate > target) {
                    return { error: `The open day is ${openDate}, which is already ahead of ${target}.` };
                }

                const [[{ n }]] = await conn.query(
                    'SELECT COUNT(*) AS n FROM orders WHERE branch_id = ? AND business_date = ?',
                    [BRANCH_ID, openDate],
                );
                if (n > 0) {
                    return {
                        error: `${openDate} is still open with ${n} order${n === 1 ? '' : 's'} on it — close that day first.`,
                    };
                }

                const [existing] = await conn.query(
                    'SELECT 1 FROM business_days WHERE branch_id = ? AND business_date = ?',
                    [BRANCH_ID, target],
                );
                if (existing.length > 0) {
                    return { error: `${target} has already been closed.` };
                }

                // An empty day nobody traded on: move it forward to today.
                await conn.query(
                    `UPDATE business_days
                     SET business_date = ?, opened_at = UTC_TIMESTAMP(3)
                     WHERE branch_id = ? AND business_date = ?`,
                    [target, BRANCH_ID, openDate],
                );
                await conn.query(
                    `INSERT INTO audit_log (branch_id, business_date, action, details)
                     VALUES (?, ?, 'day_start', ?)`,
                    [BRANCH_ID, target, JSON.stringify({ opened: target, moved_from: openDate, by: user.role })],
                );
                return { data: await loadState() };
            }

            const [existing] = await conn.query(
                'SELECT closed_at FROM business_days WHERE branch_id = ? AND business_date = ?',
                [BRANCH_ID, target],
            );
            if (existing.length > 0) {
                return { error: `${target} has already been closed.` };
            }

            await conn.query(
                `INSERT INTO business_days (branch_id, business_date, opened_at)
                 VALUES (?, ?, UTC_TIMESTAMP(3))`,
                [BRANCH_ID, target],
            );
            await conn.query(
                `INSERT INTO audit_log (branch_id, business_date, action, details)
                 VALUES (?, ?, 'day_start', ?)`,
                [BRANCH_ID, target, JSON.stringify({ opened: target, first: true, by: user.role })],
            );
            return { data: await loadState() };
        })
    } catch (e) {
        return { error: e.message }
    }
}

export async function closeBusinessDay({ force = false } = {}) {
    try {
        const user = await requirePermission('dayclose')

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

        // The callback's refusals are returned, not thrown, so its result has
        // to be inspected — a discarded return here would commit the close
        // and report success.
        const refusal = await withTransaction(async (conn) => {
            // The lock: two people pressing Close at once produce one close —
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

                /*
                 * Closing a day that has not happened yet walks the calendar
                 * forward one press at a time — three stray clicks and the
                 * till is stamping orders a week out. A day ahead of today
                 * with nothing on it has not been traded, so there is
                 * nothing to close. (Tomorrow's row after tonight's close is
                 * normal; it just cannot be closed until it has run.)
                 */
                if (closedDate > karachiDay()) {
                    const [[{ n }]] = await conn.query(
                        'SELECT COUNT(*) AS n FROM orders WHERE branch_id = ? AND business_date = ?',
                        [BRANCH_ID, closedDate],
                    )
                    if (n === 0) {
                        return { error: `${closedDate} has not started yet — there is nothing to close.` }
                    }
                }
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
            return null
        })

        if (refusal?.error) return refusal
        return { data: await loadState() }
    } catch (e) {
        return { error: e.message }
    }
}

'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { round2 } from '@/lib/cash/drawer.mjs'
// The date arithmetic is shared with the screen and covered by
// tests/mysql/karachi.test.mjs. It used to be restated here, three helpers
// deep, beside a second copy in src/lib/day/rollover.mjs that only the tests
// imported.
import { karachiDay, ymd, nextCalendarDay } from '@/lib/day/karachi.mjs'

const BRANCH_ID = 1

/*
 * Orders still owed money ON A GIVEN DAY — the gate a close has to pass or be
 * forced through.
 *
 * The business date is not optional. This asked for every unpaid bill in the
 * table, with no branch and no date, so one forgotten tab from any past night
 * refused every close from then on: the operator could settle tonight's bills
 * in full and still be told to settle them. The only way out was to force every
 * close from that day forward, and each of those wrote a `carried_orders` audit
 * list naming bills that had nothing to do with the day being closed.
 *
 * Scoping it also lets the query use the business_date index instead of
 * scanning for unpaid rows across all of history.
 */
const pendingBillsOn = async (businessDate, conn = null) => {
    const sql = `SELECT order_number, table_number, order_type, total, created_at
                 FROM orders
                 WHERE branch_id = ? AND business_date = ?
                   AND payment_status = 'unpaid' AND status <> 'cancelled'
                 ORDER BY created_at`
    const params = [BRANCH_ID, businessDate]
    // Inside the close transaction the caller passes its connection, so the
    // gate and the audit row read the same list under the same lock.
    const rows = conn ? (await conn.query(sql, params))[0] : await query(sql, params)
    return serializeRows('orders', rows)
}

/*
 * The day's cash position: what the till opened on, what every drawer closed
 * on it counted, and what is being left for tomorrow. Read from the frozen
 * drawer rows rather than recomputed, so the screen shows what was signed off
 * and not what the numbers would say if they were summed again tonight.
 *
 * `open` is the drawer still unlocked, if any. A day closed over an open
 * drawer has no count for the cash in it, which is why the close asks about
 * it rather than quietly rolling past.
 */
const loadDayCash = async (businessDate) => {
    const sessions = await query(
        `SELECT id, cashier_role, opened_at, closed_at, opening_float,
                expected_amount, counted_amount, variance, carry_forward, handover_amount
         FROM drawer_sessions
         WHERE branch_id = ? AND business_date = ?
         ORDER BY opened_at`,
        [BRANCH_ID, businessDate],
    )
    const dayRow = await query(
        'SELECT opening_cash, closing_cash FROM business_days WHERE branch_id = ? AND business_date = ?',
        [BRANCH_ID, businessDate],
    )
    const closed = sessions.filter((s) => s.closed_at)
    const open = sessions.find((s) => !s.closed_at) ?? null
    const sum = (pick) => round2(closed.reduce((t, s) => t + Number(pick(s) ?? 0), 0))

    return {
        // The stamped figures win; the first session's float stands in before
        // the very first day-close has created a business_days row to stamp.
        opening: dayRow[0]?.opening_cash != null
            ? round2(dayRow[0].opening_cash)
            : (sessions[0] ? round2(sessions[0].opening_float) : null),
        closing: dayRow[0]?.closing_cash != null ? round2(dayRow[0].closing_cash) : null,
        sessions: sessions.length,
        closedSessions: closed.length,
        expected: sum((s) => s.expected_amount),
        counted: sum((s) => s.counted_amount),
        variance: sum((s) => s.variance),
        carryForward: closed.length ? round2(Number(closed[closed.length - 1].carry_forward ?? 0)) : null,
        handover: sum((s) => s.handover_amount),
        openSession: open
            ? {
                id: String(open.id),
                cashier_role: open.cashier_role,
                opened_at: open.opened_at.toISOString(),
                opening_float: round2(open.opening_float),
            }
            : null,
    }
}

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
        `SELECT bd.business_date, bd.opened_at, bd.closed_at, bd.opening_cash, bd.closing_cash,
                u.role AS closed_by_role
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
        opening_cash: r.opening_cash == null ? null : round2(r.opening_cash),
        closing_cash: r.closing_cash == null ? null : round2(r.closing_cash),
    }))

    return {
        openDay,
        history,
        pendingBills: await pendingBillsOn(openDay.business_date),
        ledgerGaps: await countLedgerGaps(openDay.business_date),
        cash: await loadDayCash(openDay.business_date),
    }
}

/*
 * Settled bills on the closing day the general ledger has no sale journal
 * for. A soft warning only: the ledger posts itself after the settle and
 * never holds up the till, so it must not hold up the close either — the
 * accountant reposts from /accounts/health. Zero when posting is off or the
 * day predates the ledger's start, because then nothing was ever expected.
 */
const countLedgerGaps = async (businessDate) => {
    const [{ n }] = await query(
        `SELECT COUNT(*) AS n
           FROM orders o
           LEFT JOIN gl_journals j ON j.source_type = 'order_sale' AND j.source_id = o.id
          WHERE o.branch_id = ? AND o.business_date = ?
            AND o.payment_status = 'paid' AND o.status <> 'cancelled'
            AND o.invoice_number IS NOT NULL
            AND j.id IS NULL
            AND EXISTS (SELECT 1 FROM gl_settings s
                         WHERE s.id = 1 AND s.posting_enabled = 1 AND o.business_date >= s.start_date)`,
        [BRANCH_ID, businessDate],
    )
    return Number(n)
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

        /*
         * The cash gate. Closing the day over an open drawer means the day's
         * takings were never counted and tomorrow opens on a float nobody
         * declared — the exact hole this screen exists to shut. A person
         * pressing Close is asked to count first; `force` is the same genuine
         * end-of-night override the unpaid-bills gate offers, and the audit
         * row records that it was used.
         *
         * The scheduled close is the deliberate exception: a machine must
         * never fabricate a count, and must never stall the calendar because
         * somebody left a till unlocked. It warns and rolls on.
         */
        const openDrawers = await query(
            `SELECT cashier_role FROM drawer_sessions
             WHERE branch_id = ? AND closed_at IS NULL`,
            [BRANCH_ID],
        )
        if (openDrawers.length > 0 && !force) {
            const which = openDrawers.map((d) => d.cashier_role).join(', ')
            return {
                error: `The ${which} drawer is still open — count and close it so the day's cash is recorded, then close the day.`,
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

            // Which day is being closed. Resolved before anything is written,
            // because the unpaid-bill gate below needs it and a gate that
            // refuses after the UPDATE has already refused too late.
            const hasOpenDay = openRows.length > 0
            const closedDate = hasOpenDay ? ymd(openRows[0].business_date) : karachiDay()

            /*
             * Closing a day that has not happened yet walks the calendar
             * forward one press at a time — three stray clicks and the till is
             * stamping orders a week out. A day ahead of today with nothing on
             * it has not been traded, so there is nothing to close. (Tomorrow's
             * row after tonight's close is normal; it just cannot be closed
             * until it has run.)
             */
            if (hasOpenDay && closedDate > karachiDay()) {
                const [[{ n }]] = await conn.query(
                    'SELECT COUNT(*) AS n FROM orders WHERE branch_id = ? AND business_date = ?',
                    [BRANCH_ID, closedDate],
                )
                if (n === 0) {
                    return { error: `${closedDate} has not started yet — there is nothing to close.` }
                }
            }

            /*
             * The unpaid-bill gate, read ONCE, inside the transaction, under
             * the FOR UPDATE above — so the list that refuses the close and the
             * list the audit row records as carried are the same list, and a
             * bill settled while the operator was reading the screen cannot
             * still block it. An unpaid bill left behind either settles onto
             * the wrong day's books or never settles at all; `force` is the
             * genuine end-of-night override and the audit row says it was used.
             */
            const pending = await pendingBillsOn(closedDate, conn)
            if (pending.length > 0 && !force) {
                return {
                    error: `${pending.length} unpaid bill${pending.length === 1 ? ' is' : 's are'} still open on ${closedDate} — settle or void ${pending.length === 1 ? 'it' : 'them'} before closing the day.`,
                }
            }

            if (hasOpenDay) {
                await conn.query(
                    `UPDATE business_days
                     SET closed_at = UTC_TIMESTAMP(3), closed_by = ?
                     WHERE branch_id = ? AND business_date = ?`,
                    [user.id, BRANCH_ID, closedDate],
                )
            } else {
                // First ever close: the implicit Karachi day becomes a real
                // row, created already closed, so history starts tonight.
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
                    open_drawers: openDrawers.length,
                    forced: Boolean(force) && (pending.length > 0 || openDrawers.length > 0),
                    ...(force && openDrawers.length > 0
                        ? { uncounted_drawers: openDrawers.map((d) => d.cashier_role) }
                        : {}),
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

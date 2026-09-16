'use server'

/*
 * Drawer sessions — one cashier's cash custody for one stretch of service.
 *
 * Staff-facing on purpose: the cashier owns their drawer, so every verb here
 * gates on requireUser alone (history is the one gated read — variance
 * across roles is a management question). Sessions key on the shared
 * login's role: one drawer per role at a time, which is exactly one per
 * physical till today.
 *
 * The money rule, stated once: at close,
 *   expected = opening_float
 *            + cash payments taken while the drawer was open (voids included —
 *              a reversal row is negative and the refund left this drawer)
 *            + paid-ins − paid-outs
 *            − drawer expenses paid in the window.
 * The same sums feed the live screen, so the number the cashier watched all
 * shift is the number that freezes on the row.
 *
 * And the count splits: counted = carry_forward + handover. What stays in the
 * till is proposed back as the next session's opening float, so the chain
 * close → open runs on a declared figure instead of somebody's memory. The
 * arithmetic itself lives in src/lib/cash/drawer.mjs, shared with the screen
 * and the tests.
 */

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
import { currentBranchId } from '@/lib/db/branch.mjs'
import { serializeRow, serializeRows } from '@/lib/db/serialize.mjs'
import {
    round2, expectedCash, varianceOf, needsReason, cleanAmount,
    splitCount, cleanDenominations, countFromDenominations, suggestedFloat,
} from '@/lib/cash/drawer.mjs'


/*
 * The general ledger, after the close has committed: a short or an over is
 * booked against Cash Over and Short; a drawer that counted right posts
 * nothing. Same posture as the order hooks in orderActions.js — the count
 * is frozen on the row, so a ledger fault logs inside the poster and stops
 * there. Idempotent on (source_type, source_id) in the database.
 */
const fireGlAfterDrawerClose = (sessionId, userId) => {
    import('@/lib/accounts/otherPost.mjs')
        .then((m) => m.afterDrawerCloseGl(sessionId, { userId }))
        .catch(() => {})
}

const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d))

// One shape for "run SQL, give me rows" whether we're inside a transaction
// (raw connection, tuple result) or on the pool (rows already unwrapped).
const runner = (conn) => async (sql, params = []) =>
    conn ? (await conn.query(sql, params))[0] : query(sql, params)

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/*
 * Same resolution the order verbs use (orders.mjs keeps its copy private):
 * the open business day once day-close is live, else the Karachi calendar day.
 */
const resolveBusinessDate = async (run, branchId) => {
    const rows = await run(
        `SELECT business_date FROM business_days
         WHERE branch_id = ? AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
        [branchId],
    )
    return rows.length === 0 ? karachiDay() : dateOnly(rows[0].business_date)
}

const auditLog = async (run, branchId, businessDate, action, details) => {
    await run(
        `INSERT INTO audit_log (branch_id, business_date, action, details)
         VALUES (?, ?, ?, ?)`,
        [branchId, businessDate, action, JSON.stringify(details)],
    )
}

/*
 * The caller's open session, if any. FOR UPDATE when a verb is about to write
 * against it: close and record-movement serialize on this row, so a paid-out
 * can't slip in between the close's sums and its freeze.
 */
const findOpenSession = async (run, branchId, role, { forUpdate = false } = {}) => {
    const rows = await run(
        `SELECT * FROM drawer_sessions
         WHERE branch_id = ? AND cashier_role = ? AND closed_at IS NULL
         ORDER BY opened_at DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [branchId, role],
    )
    return rows[0] ?? null
}

/*
 * The three cash flows a session accumulates. Shared by the live screen and
 * the close so the two cannot drift. Windows run from opened_at to the DB's
 * now — paid_at/created_at are UTC DATETIMEs and the pool pins the session
 * time zone, so UTC_TIMESTAMP(3) is the matching clock.
 *
 * Cash payments sum positives AND negatives: a void writes a negative
 * reversal row, and that refund left this drawer. Expenses count only when
 * they actually took cash out of it (paid_from 'drawer', status 'paid').
 */
const sessionFlows = async (run, branchId, session) => {
    /*
     * THIS TILL'S cash, by session rather than by time window.
     *
     * The window summed every cash payment the branch took since this drawer
     * opened, with no link to which till took it. Two drawers open at once —
     * and `cashier` and `frontdesk` both hold `pos` and `drawer`, so two is
     * the normal shape — both claimed the same notes, so the first to count
     * came out level and every other reported a short made of the other
     * till's takings.
     *
     * Payments now carry drawer_session_id (migration 051). Closed sessions
     * froze their expected figure at close and do not recompute, so their
     * history is untouched by the change of method.
     */
    const cashRows = await run(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
         WHERE drawer_session_id = ? AND method = 'cash'`,
        [session.id],
    )

    /*
     * And the cash that belongs to no till: rung while every drawer was
     * closed, so nobody's count includes it. Reported rather than folded into
     * this session — it is real money, and the person counting needs to know
     * it is not theirs to explain.
     */
    const orphanRows = await run(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
         WHERE branch_id = ? AND method = 'cash' AND drawer_session_id IS NULL
           AND paid_at >= ? AND paid_at <= UTC_TIMESTAMP(3)`,
        [branchId, session.opened_at],
    )
    const moveRows = await run(
        `SELECT
            COALESCE(SUM(CASE WHEN type = 'paid_in'  THEN amount ELSE 0 END), 0) AS paid_in,
            COALESCE(SUM(CASE WHEN type = 'paid_out' THEN amount ELSE 0 END), 0) AS paid_out
         FROM drawer_movements WHERE session_id = ?`,
        [session.id],
    )
    const expenseRows = await run(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
         WHERE paid_from = 'drawer' AND status = 'paid'
           AND created_at >= ? AND created_at <= UTC_TIMESTAMP(3)`,
        [session.opened_at],
    )
    return {
        cashSales: round2(cashRows[0].total),
        unattributedCash: round2(orphanRows[0].total),
        paidIn: round2(moveRows[0].paid_in),
        paidOut: round2(moveRows[0].paid_out),
        drawerExpenses: round2(expenseRows[0].total),
    }
}

const expectedFrom = (session, flows) =>
    expectedCash({ openingFloat: session.opening_float, ...flows })

/*
 * The two numbers the admin sets once: the standing change float the close
 * proposes to leave behind, and how far a count may miss before a reason is
 * demanded. Read fresh rather than cached — an owner who changes the policy
 * at 9pm means it from the next close, not the next deploy.
 */
const cashPolicy = async (run) => {
    const rows = await run(
        'SELECT default_opening_float, cash_variance_tolerance FROM store_settings LIMIT 1',
    )
    return {
        defaultFloat: round2(rows[0]?.default_opening_float ?? 0),
        tolerance: round2(rows[0]?.cash_variance_tolerance ?? 0),
    }
}

/*
 * The last drawer closed anywhere on this till, for the float it left behind.
 * Deliberately not scoped to the role or the business day: the cash sitting in
 * the physical drawer this morning is the cash the last person to shut it left
 * there, whoever they were and whichever day that was.
 */
const lastClosedSession = async (run, branchId) => {
    const rows = await run(
        `SELECT id, business_date, closed_at, counted_amount, carry_forward, handover_amount
         FROM drawer_sessions
         WHERE branch_id = ? AND closed_at IS NOT NULL
         ORDER BY closed_at DESC LIMIT 1`,
        [branchId],
    )
    return rows[0] ?? null
}

/*
 * The open session with its running numbers — or, when the drawer is shut,
 * what it should open on and where that figure came from. A cashier who is
 * told "Rs. 5,000 was left here last night" can check the till against it in
 * ten seconds; one handed an empty box types whatever sounds right.
 */
export async function getDrawerState() {
    try {
        const user = await requireUser()
        const branchId = await currentBranchId(user)
        const run = runner(null)
        const session = await findOpenSession(run, branchId, user.role)
        if (!session) {
            const [policy, last] = await Promise.all([cashPolicy(run), lastClosedSession(run, branchId)])
            return {
                data: {
                    session: null,
                    suggestedFloat: suggestedFloat({
                        lastCarryForward: last?.carry_forward ?? null,
                        defaultFloat: policy.defaultFloat,
                    }),
                    lastClose: last
                        ? {
                            business_date: dateOnly(last.business_date),
                            closed_at: last.closed_at.toISOString(),
                            counted: round2(last.counted_amount ?? 0),
                            carry_forward: last.carry_forward === null
                                ? null : round2(last.carry_forward),
                            handover: last.handover_amount === null
                                ? null : round2(last.handover_amount),
                        }
                        : null,
                },
            }
        }

        const flows = await sessionFlows(run, branchId, session)
        const movements = await run(
            'SELECT * FROM drawer_movements WHERE session_id = ? ORDER BY at DESC',
            [session.id],
        )
        const policy = await cashPolicy(run)
        return {
            data: {
                session: serializeRow('drawer_sessions', session),
                movements: serializeRows('drawer_movements', movements),
                ...flows,
                expected: expectedFrom(session, flows),
                // What the close panel proposes to leave behind, and how far a
                // count may miss before it asks why.
                defaultFloat: policy.defaultFloat,
                tolerance: policy.tolerance,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function openDrawer({ opening_float } = {}) {
    try {
        const user = await requireUser()
        const branchId = await currentBranchId(user)
        const float = cleanAmount(opening_float, 'Opening float')

        const session = await withTransaction(async (conn) => {
            const run = runner(conn)
            // The FOR UPDATE means two devices on the same shared login racing
            // to open wait on each other instead of both slipping past this check.
            if (await findOpenSession(run, branchId, user.role, { forUpdate: true })) {
                throw new Error('Close the open drawer first')
            }
            const businessDate = await resolveBusinessDate(run, branchId)

            // What the till SHOULD have opened on, so a float typed over the
            // carried-forward figure is a recorded correction rather than a
            // silent one. This is the line that turns "the drawer was short
            // this morning" into a question with an answer.
            const [policy, last] = await Promise.all([cashPolicy(run), lastClosedSession(run, branchId)])
            const suggested = suggestedFloat({
                lastCarryForward: last?.carry_forward ?? null,
                defaultFloat: policy.defaultFloat,
            })

            const [result] = await conn.query(
                `INSERT INTO drawer_sessions (branch_id, business_date, cashier_role, opening_float)
                 VALUES (?, ?, ?, ?)`,
                [branchId, businessDate, user.role, float],
            )

            /*
             * The day's opening cash, stamped by the first drawer to open on
             * it and never overwritten — a second till opening at noon does
             * not restate what the day started with. Silently does nothing
             * before the first day-close, when there is no business_days row
             * yet and the Karachi calendar day is standing in.
             */
            await run(
                `UPDATE business_days SET opening_cash = ?
                 WHERE branch_id = ? AND business_date = ? AND opening_cash IS NULL`,
                [float, branchId, businessDate],
            )

            await auditLog(run, branchId, businessDate, 'drawer_open', {
                session_id: result.insertId,
                cashier_role: user.role,
                opening_float: float,
                suggested_float: suggested,
                ...(round2(float) === suggested
                    ? {}
                    : { float_differs_by: round2(float - suggested) }),
                carried_from_session: last?.id ?? null,
            })
            const rows = await run('SELECT * FROM drawer_sessions WHERE id = ?', [result.insertId])
            return rows[0]
        })
        return { data: serializeRow('drawer_sessions', session) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function recordMovement({ type, amount, reason } = {}) {
    try {
        const user = await requireUser()
        const branchId = await currentBranchId(user)
        if (type !== 'paid_in' && type !== 'paid_out') {
            return { error: 'Movement must be a paid-in or a paid-out' }
        }
        const value = round2(amount)
        if (!Number.isFinite(value) || value <= 0) {
            return { error: 'Amount must be more than zero' }
        }
        // A cash movement with no reason tells nobody anything when the count
        // is short — same rule as voids.
        const why = String(reason ?? '').trim()
        if (!why) return { error: 'Give a reason for the movement' }

        const movement = await withTransaction(async (conn) => {
            const run = runner(conn)
            const session = await findOpenSession(run, branchId, user.role, { forUpdate: true })
            if (!session) throw new Error('Open a drawer before recording cash movements')

            const [result] = await conn.query(
                'INSERT INTO drawer_movements (session_id, type, amount, reason) VALUES (?, ?, ?, ?)',
                [session.id, type, value, why.slice(0, 191)],
            )
            await auditLog(run, branchId, dateOnly(session.business_date), `drawer_${type}`, {
                session_id: session.id, cashier_role: user.role, amount: value, reason: why,
            })
            const rows = await run('SELECT * FROM drawer_movements WHERE id = ?', [result.insertId])
            return rows[0]
        })
        return { data: serializeRow('drawer_movements', movement) }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Close the drawer.
 *
 * `counted_amount` is the whole till, float included. `denominations` is the
 * optional note-by-note breakdown behind it — when it is given it must agree
 * with the total, because a breakdown that disagrees with its own sum is
 * worse than no breakdown at all. `carry_forward` is what stays in the till
 * for tomorrow; the rest is handed over, and the pair is stored rather than
 * inferred.
 */
export async function closeDrawer({
    counted_amount, carry_forward, notes, denominations,
} = {}) {
    try {
        const user = await requireUser()
        const branchId = await currentBranchId(user)

        const breakdown = cleanDenominations(denominations)
        if (breakdown) {
            const fromNotes = countFromDenominations(breakdown)
            const typed = cleanAmount(counted_amount, 'Counted amount')
            if (fromNotes !== typed) {
                return {
                    error: `The notes add up to Rs. ${fromNotes.toLocaleString('en-PK')}, but the total says Rs. ${typed.toLocaleString('en-PK')}: recount or clear the breakdown.`,
                }
            }
        }

        // Nothing carried forward is a legitimate answer (the owner empties
        // the till), so the field is required to be a number, not required to
        // be positive — and it defaults to nothing rather than to the float,
        // because the app must not decide how much of the owner's cash stays
        // on the premises overnight.
        const { counted, carry, handover } = splitCount({
            counted: counted_amount,
            carryForward: carry_forward ?? 0,
        })
        const why = String(notes ?? '').trim().slice(0, 191)

        const closed = await withTransaction(async (conn) => {
            const run = runner(conn)
            const session = await findOpenSession(run, branchId, user.role, { forUpdate: true })
            if (!session) throw new Error('No open drawer to close')

            // Summed under the session row's lock, so nothing moves between
            // the computation and the freeze below.
            const flows = await sessionFlows(run, branchId, session)
            const expected = expectedFrom(session, flows)
            const variance = varianceOf(counted, expected)

            /*
             * A miss past the tolerance has to be explained in writing before
             * it is allowed to freeze. The check is here rather than in the
             * browser because the browser is where it would be skipped: this
             * is the one moment in the day when the difference is still fresh
             * enough for anybody to know the answer.
             */
            const { tolerance } = await cashPolicy(run)
            if (needsReason(variance, tolerance) && !why) {
                throw new Error(
                    variance < 0
                        ? `The drawer is short by Rs. ${Math.abs(variance).toLocaleString('en-PK')}: write why before closing.`
                        : `The drawer is over by Rs. ${variance.toLocaleString('en-PK')}: write why before closing.`,
                )
            }

            await run(
                `UPDATE drawer_sessions
                 SET closed_at = UTC_TIMESTAMP(3), expected_amount = ?, counted_amount = ?,
                     variance = ?, carry_forward = ?, handover_amount = ?,
                     notes = ?, denominations = ?
                 WHERE id = ?`,
                [expected, counted, variance, carry, handover,
                    why || null, breakdown ? JSON.stringify(breakdown) : null, session.id],
            )

            /*
             * The day's closing cash is whatever the LAST drawer shut on it
             * left behind, so this overwrites rather than filling a blank —
             * a second till closing at midnight restates the figure, which is
             * correct: the day ends with what is in the till when the last
             * one is locked.
             */
            await run(
                `UPDATE business_days SET closing_cash = ?
                 WHERE branch_id = ? AND business_date = ?`,
                [carry, branchId, dateOnly(session.business_date)],
            )

            // The close belongs to the session's own trading day, however late
            // past midnight the count happens.
            await auditLog(run, branchId, dateOnly(session.business_date), 'drawer_close', {
                session_id: session.id, cashier_role: user.role,
                expected, counted, variance,
                carry_forward: carry, handover,
                ...(breakdown ? { denominations: breakdown } : {}),
                ...(why ? { reason: why } : {}),
            })
            const rows = await run('SELECT * FROM drawer_sessions WHERE id = ?', [session.id])
            return rows[0]
        })
        fireGlAfterDrawerClose(closed.id, user.id)
        return { data: serializeRow('drawer_sessions', closed) }
    } catch (e) {
        return { error: e.message }
    }
}

/* Session history across all roles — a management read, so it wants `drawer`. */
export async function listSessions({ from, to } = {}) {
    try {
        const user = await requirePermission('drawer')
        const branchId = await currentBranchId(user)
        const where = ['branch_id = ?']
        const params = [branchId]
        if (from) { where.push('business_date >= ?'); params.push(from) }
        if (to) { where.push('business_date <= ?'); params.push(to) }

        const rows = await query(
            `SELECT * FROM drawer_sessions
             WHERE ${where.join(' AND ')}
             ORDER BY opened_at DESC LIMIT 200`,
            params,
        )
        return { data: serializeRows('drawer_sessions', rows) }
    } catch (e) {
        return { error: e.message }
    }
}

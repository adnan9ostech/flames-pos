/*
 * The trading day's transitions, as plain functions.
 *
 * These used to live inside `src/app/dayclose/actions.js`, which is fine while a
 * human presses Close — but a scheduled roll has no session cookie, so
 * `requirePermission('dayclose')` cannot run and the whole file is unreachable
 * from a worker. Same problem the accounts engine had, same answer: plain Node,
 * relative imports, no `server-only`, so the server action and
 * `scripts/day-worker.mjs` share one definition of what closing a day means.
 * (`src/lib/accounts/kit.mjs` is the precedent.)
 *
 * Nothing here reads a cookie, checks a permission or opens a transaction of its
 * own. The caller supplies the connection and has already decided the actor is
 * allowed — exactly the posture `src/lib/db/orders.mjs` takes.
 */

export const BRANCH_ID = 1;

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
export const karachiDay = (at = new Date()) =>
    at.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

/* The wall-clock time in Asia/Karachi, as 'HH:MM'. */
export const karachiTime = (at = new Date()) =>
    at.toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false,
    });

/* A DATE column arrives as a midnight-UTC Date; the calendar day is the value. */
export const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/* The next calendar date after a 'YYYY-MM-DD'. UTC arithmetic on the string, so
 * the box's own timezone can never shift the answer. */
export const nextCalendarDay = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
};

/* 'HH:MM' or 'HH:MM:SS' → minutes past midnight, or null for anything else.
 * MySQL hands a TIME column back as 'HH:MM:SS'. */
export const minutesOfDay = (t) => {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
};

/*
 * Is the open day due to be closed?
 *
 * The subtlety this exists for: a restaurant day normally SPANS MIDNIGHT. Open
 * at 11:00, close at 05:00 — so for most of the trading day the clock reads a
 * time that is *before* the end time, and on the far side of midnight the
 * calendar date has already moved on while the business date has not. Comparing
 * times alone gets this wrong twice a night.
 *
 * So the test is on the DATE the day should have ended, not on the clock alone:
 *   - end time AFTER start time  → an ordinary daytime shift; it ends on its own
 *     business date.
 *   - end time BEFORE start time → the day runs past midnight; it ends on the
 *     following calendar date.
 * A day is due when that moment has passed. With no start time configured the
 * end time is read as belonging to the next calendar day, which is the
 * conservative reading — it never closes a day early.
 *
 * Pure, so it can be tested without a database or a clock.
 */
export const dueToClose = ({ dayStartTime, dayEndTime, openDate, now = new Date() }) => {
    const end = minutesOfDay(dayEndTime);
    if (end === null || !openDate) return false;

    const start = minutesOfDay(dayStartTime);
    const spansMidnight = start === null || end <= start;
    const endsOn = spansMidnight ? nextCalendarDay(ymd(openDate)) : ymd(openDate);

    const today = karachiDay(now);
    if (today > endsOn) return true;          // the moment is long past
    if (today < endsOn) return false;         // not there yet
    return minutesOfDay(karachiTime(now)) >= end;
};

/* The open trading day, or null. */
export const openDayTx = async (conn, { branchId = BRANCH_ID, forUpdate = false } = {}) => {
    const [rows] = await conn.query(
        `SELECT business_date, opened_at FROM business_days
          WHERE branch_id = ? AND closed_at IS NULL
          ORDER BY business_date DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [branchId],
    );
    if (rows.length === 0) return null;
    return { businessDate: ymd(rows[0].business_date), openedAt: rows[0].opened_at };
};

/*
 * Bills still owed money ON A GIVEN DAY.
 *
 * The screen's original gate asked for every unpaid bill in the branch with no
 * date at all, so one forgotten tab from any past night blocked every close
 * forever — the operator could settle tonight's bills and still be refused.
 * Scoping it to the day being closed is what makes an automatic roll possible
 * at all, and it fixes that on the manual path too.
 */
export const pendingBillsTx = async (conn, businessDate, { branchId = BRANCH_ID } = {}) => {
    const [rows] = await conn.query(
        `SELECT order_number, table_number, order_type, total, created_at
           FROM orders
          WHERE branch_id = ? AND business_date = ?
            AND payment_status = 'unpaid' AND status <> 'cancelled'
          ORDER BY created_at`,
        [branchId, businessDate],
    );
    return rows;
};

/*
 * Close the open day and open the next.
 *
 * Returns { closed, opened } or { error }. Refusals are RETURNED, never thrown:
 * the caller runs this inside a transaction and a thrown refusal would look
 * identical to a failure worth rolling back and retrying, which is how an
 * automatic roll turns into a loop.
 *
 * `mode` is 'manual' or 'auto'. `closedBy` is a user id for a manual close and
 * NULL for a machine one — which is why close_mode exists, since a NULL actor
 * would otherwise be indistinguishable from a deleted user.
 */
export const closeDayTx = async (conn, { closedBy = null, mode = 'manual', force = false, branchId = BRANCH_ID } = {}) => {
    const open = await openDayTx(conn, { branchId, forUpdate: true });
    const today = karachiDay();

    let closedDate;
    if (open) {
        closedDate = open.businessDate;

        /*
         * Closing a day that has not happened yet walks the calendar forward one
         * press at a time — three stray clicks and the till stamps orders a week
         * out. A future day with nothing on it has not been traded.
         */
        if (closedDate > today) {
            const [[{ n }]] = await conn.query(
                'SELECT COUNT(*) AS n FROM orders WHERE branch_id = ? AND business_date = ?',
                [branchId, closedDate],
            );
            if (n === 0) {
                return { error: `${closedDate} has not started yet — there is nothing to close.` };
            }
        }

        const pending = await pendingBillsTx(conn, closedDate, { branchId });
        if (pending.length > 0 && !force) {
            return {
                error: `${pending.length} unpaid bill${pending.length === 1 ? ' is' : 's are'} still open on ${closedDate} — settle or void ${pending.length === 1 ? 'it' : 'them'} before closing the day.`,
                pending,
            };
        }

        await conn.query(
            `UPDATE business_days
                SET closed_at = UTC_TIMESTAMP(3), closed_by = ?, close_mode = ?
              WHERE branch_id = ? AND business_date = ?`,
            [closedBy, mode, branchId, closedDate],
        );
    } else {
        // First ever close: the implicit Karachi day becomes a real row, created
        // already closed, so history starts tonight.
        closedDate = today;
        await conn.query(
            `INSERT INTO business_days (branch_id, business_date, closed_at, closed_by, close_mode)
             VALUES (?, ?, UTC_TIMESTAMP(3), ?, ?)
             ON DUPLICATE KEY UPDATE closed_at = UTC_TIMESTAMP(3), closed_by = VALUES(closed_by),
                                     close_mode = VALUES(close_mode)`,
            [branchId, closedDate, closedBy, mode],
        );
    }

    const openedDate = nextCalendarDay(closedDate);
    await conn.query(
        `INSERT INTO business_days (branch_id, business_date) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE opened_at = opened_at`,
        [branchId, openedDate],
    );

    return { closed: closedDate, opened: openedDate };
};

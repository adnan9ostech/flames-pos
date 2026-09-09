/*
 * The trading day's date arithmetic, as plain functions.
 *
 * These used to live inside `src/app/dayclose/actions.js`. They were lifted out
 * on 3 Sep for a scheduled close — a worker has no session cookie, so
 * `requirePermission('dayclose')` cannot run and that whole file is unreachable
 * from one. The worker was never written, and on 9 Sep the owner settled the
 * question: **the day closes when someone presses the button, never on a
 * schedule.** So the transitions themselves (openDayTx, pendingBillsTx,
 * closeDayTx) and the `dueToClose` predicate went with that decision — they had
 * no caller, and eleven tests were passing against a copy of the logic the
 * application does not run.
 *
 * What survives is what both halves genuinely shared: the date arithmetic. It
 * is imported by the day-close action and its screen, so these tests now guard
 * production rather than a fork of it.
 *
 * Pure, dependency-free and free of `server-only`, so a server action, a
 * `'use client'` screen and a bare `node --test` can each load it. When the
 * Karachi-day family in docs/CLEANUP-AUDIT.md §2.12 is finally consolidated
 * (26 copies under six names), this is the module it should consolidate into.
 */

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
export const karachiDay = (at = new Date()) =>
    at.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

/* The wall-clock time in Asia/Karachi, as 'HH:MM'. */
export const karachiTime = (at = new Date()) =>
    at.toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false,
    });

/* A DATE column arrives as a midnight-UTC Date; the calendar day is the value.
 * The string branch truncates: a DATETIME that arrives as text still yields a
 * date, which the hand-written copies of this helper mostly forget to do. */
export const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/* The next calendar date after a 'YYYY-MM-DD'. UTC arithmetic on the string, so
 * the box's own timezone can never shift the answer. */
export const nextCalendarDay = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
};

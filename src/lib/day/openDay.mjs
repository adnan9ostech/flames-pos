/*
 * Which trading day is open, for a branch.
 *
 * Twenty-four copies of this query were scattered across the app — every
 * screen that stamps a document needed the answer, and each wrote it out
 * again. That was survivable while the answer was always "branch 1", and it
 * stopped being survivable the moment a branch became a variable: twenty-four
 * places to remember, and the one that is forgotten silently files a second
 * outlet's paperwork under the first one's day.
 *
 * So it lives here once. Takes a connection when the caller is inside a
 * transaction (a document must be dated by the day that was open when it was
 * written, not a moment later), and the pool when it is not.
 */
import { query } from '../db/pool.mjs';

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
export const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

const asDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/*
 * The branch this request is acting on, asked for LAZILY.
 *
 * Working it out means reading a cookie, which means `next/headers`, which
 * does not exist outside Next — and this module is reached from the
 * consumption engine and the waste verb, which the suite drives in plain Node
 * and a worker runs with no request at all. A static import would break both.
 *
 * So the import happens inside the call and a failure means "there is no
 * request here", which answers 1: the single outlet, and exactly what every
 * row in this database already carries.
 */
const requestBranch = async () => {
    try {
        const { currentBranchId } = await import('../db/branch.mjs');
        return await currentBranchId();
    } catch {
        return 1;
    }
};

/*
 * The open business day, or the Karachi calendar day when none is open.
 *
 * The fallback is not a shortcut: this restaurant can trade without anybody
 * having pressed "start the day", and a sale rung then still has to be dated
 * something true rather than refused. Day Close is what turns the fallback
 * into a real day.
 */
export const openBusinessDate = async (branchId = null, conn = null) => {
    /*
     * Resolved here when the caller does not say, which is the point: every
     * one of the two dozen screens that stamps a document becomes branch-aware
     * by calling this, with nothing threaded through it. A caller that DOES
     * know better — the consumption engine, which must date a movement by the
     * order's own branch rather than by whoever is looking — passes it in.
     */
    const id = branchId ?? await requestBranch();
    const sql = `SELECT business_date FROM business_days
                  WHERE branch_id = ? AND closed_at IS NULL
                  ORDER BY business_date DESC LIMIT 1`;
    const rows = conn ? (await conn.query(sql, [id]))[0] : await query(sql, [id]);
    return rows.length ? asDay(rows[0].business_date) : karachiDay();
};

/*
 * The Accounts kit: the handful of helpers every writer to the books needs.
 *
 * Plain Node, relative imports, no `server-only` — that is the whole reason
 * this file exists. helpers.mjs carries `server-only` and `@/` aliases so it
 * cannot load outside Next, while the posting engines must be importable by
 * a bare `node --test`; the first cut of the module answered that by
 * restating money/ymd/nextVoucherNo/audit in seven files. Seven copies of a
 * counter is seven places for a numbering bug to hide. helpers.mjs now
 * re-exports from here, so the Next-side actions and the engines share one
 * definition of each.
 */
import { query } from '../db/pool.mjs';

export const BRANCH_ID = 1;

/* Paise-exact. DECIMAL comes back as a JS number (pool sets decimalNumbers),
 * and a sum of those can carry float dust; every figure that reaches a
 * journal line or an equality check goes through here first. */
export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* A DATE column arrives as a midnight-UTC Date; a serialized row carries
 * 'YYYY-MM-DD'. Both mean the same calendar day. */
export const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
export const todayKarachi = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

/* The Karachi calendar day a UTC instant falls on. */
export const karachiDayOf = (at) => {
    const d = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(d.getTime())) return todayKarachi();
    return new Date(d.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);
};

/* VARCHAR(191) columns; a long company name or charge list must not fail
 * the whole journal. */
export const clip = (s, n = 191) => {
    const str = String(s ?? '');
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/*
 * The current open business day, read on the caller's connection — where a
 * correction lands, so a closed day never gains a journal after its close.
 * Falls back to the Karachi calendar day if no day has been started.
 */
export const currentBusinessDate = async (conn, branchId = BRANCH_ID) => {
    const [rows] = await conn.query(
        `SELECT business_date FROM business_days
         WHERE branch_id = ? AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
        [branchId],
    );
    return rows.length ? ymd(rows[0].business_date) : todayKarachi();
};

/* The same, off the pool, for an action that has no transaction open yet. */
export const businessDate = async (branchId = BRANCH_ID) => {
    const rows = await query(
        `SELECT business_date FROM business_days
         WHERE branch_id = ? AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
        [branchId],
    );
    return rows.length ? ymd(rows[0].business_date) : todayKarachi();
};

/*
 * The next voucher number for a type on a day, minted under the counter
 * row's own lock — the same idiom the invoice counter uses, so two vouchers
 * posted in the same instant cannot share a number. Call inside a
 * transaction. SV-260902-0007.
 */
export const nextVoucherNo = async (conn, voucherType, bd, branchId = BRANCH_ID) => {
    await conn.query(
        `INSERT INTO gl_voucher_counters (branch_id, day, voucher_type, last_no)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE last_no = last_no + 1`,
        [branchId, bd, voucherType],
    );
    const [rows] = await conn.query(
        'SELECT last_no FROM gl_voucher_counters WHERE branch_id = ? AND day = ? AND voucher_type = ?',
        [branchId, bd, voucherType],
    );
    const yymmdd = bd.slice(2).replace(/-/g, '');
    return `${voucherType}-${yymmdd}-${String(rows[0].last_no).padStart(4, '0')}`;
};

/*
 * Every write to the books leaves a row here, inside the same transaction.
 * audit_log has staff_id for the actor (NULL for a machine posting) and
 * order_id for the bill a posting belongs to, when there is one.
 */
export const audit = (conn, { branchId = BRANCH_ID, bd, action, orderId = null, details, userId = null }) =>
    conn.query(
        `INSERT INTO audit_log (branch_id, business_date, action, order_id, staff_id, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [branchId, bd, action, orderId, userId ?? null, JSON.stringify(details)],
    );

/* A strictly-positive integer id, or the error the caller wants to show. */
export const requireId = (id, what = 'record') => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`That ${what} no longer exists`);
    return n;
};

/* 'YYYY-MM-DD' or nothing. Dates arrive from a browser form and must never
 * reach a DATE column as free text. */
export const requireDate = (s, what = 'date') => {
    const v = String(s || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        throw new Error(`A valid ${what} is needed`);
    }
    return v;
};

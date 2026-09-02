import 'server-only';
import { query } from '@/lib/db/pool.mjs';

/*
 * The small server-side kit every Accounts action shares. Kept in one file so
 * sixteen screens do not each carry their own copy of "what day is it" — the
 * charges and expenses actions do, and the copies have already drifted once.
 */

/* Paise-exact. DECIMAL comes back as a JS number (pool sets decimalNumbers),
 * and a sum of those can carry float dust; every figure that reaches a
 * journal line or an equality check goes through here first. */
export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* A DATE column arrives as a midnight-UTC Date; the calendar day is the
 * whole of the value. */
export const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export const todayKarachi = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

/*
 * The trading day a write belongs to: the open business day, or the Karachi
 * calendar day if none has been started. The same resolution the money verbs
 * use, restated because the kernel keeps its copy private.
 */
export const businessDate = async () => {
    const rows = await query(
        `SELECT business_date FROM business_days
         WHERE branch_id = 1 AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
    );
    return rows.length ? ymd(rows[0].business_date) : todayKarachi();
};

/* Every write to the books leaves a row here, inside the same transaction. */
export const audit = (conn, bd, action, details, userId = null) =>
    conn.query(
        `INSERT INTO audit_log (branch_id, business_date, action, staff_id, details)
         VALUES (1, ?, ?, ?, ?)`,
        [bd, action, userId, JSON.stringify(details)],
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

/*
 * The next voucher number for a type on a day, minted under the counter
 * row's own lock — the same idiom the invoice counter uses, so two vouchers
 * posted in the same instant cannot share a number. Call inside a
 * transaction.
 */
export const nextVoucherNo = async (conn, voucherType, bd) => {
    await conn.query(
        `INSERT INTO gl_voucher_counters (branch_id, day, voucher_type, last_no)
         VALUES (1, ?, ?, 1)
         ON DUPLICATE KEY UPDATE last_no = last_no + 1`,
        [bd, voucherType],
    );
    const [rows] = await conn.query(
        'SELECT last_no FROM gl_voucher_counters WHERE branch_id = 1 AND day = ? AND voucher_type = ?',
        [bd, voucherType],
    );
    const yymmdd = bd.slice(2).replace(/-/g, '');
    return `${voucherType}-${yymmdd}-${String(rows[0].last_no).padStart(4, '0')}`;
};

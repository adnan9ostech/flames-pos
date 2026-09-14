/*
 * The company's settings, with one outlet's departures laid over them.
 *
 * store_settings is a single row and stays that way: it is what the company
 * IS. branch_settings holds only the fields where an outlet genuinely differs
 * — its tax rate and authority, its own FBR registration, the address on its
 * bill, its trading hours, its float — and every one of those columns is
 * NULLable. NULL is not "zero" and not "unset", it means THE COMPANY'S ANSWER,
 * which is why the merge below tests for null rather than for falsiness: a
 * deliberate 0% tax rate and an absent override are different facts and only
 * `== null` tells them apart.
 *
 * The consequence worth stating: raising the company's GST changes it at every
 * outlet that has not deliberately departed, without anyone visiting a branch
 * screen. That is the whole reason this holds differences rather than copies.
 *
 * No `next/headers` and no `@/` alias in this file. It is reached from
 * orders.mjs, which the suite loads directly in plain Node.
 */
import { query } from './pool.mjs';

/* The columns an outlet may answer for itself. Anything not here is company. */
export const OVERRIDABLE = [
    'tax_rate_cash', 'tax_rate_card', 'tax_label', 'tax_authority',
    'fbr_pos_id', 'fbr_ntn', 'receipt_footer',
    'day_start_time', 'day_end_time', 'opening_float', 'variance_tolerance',
];

/*
 * The store column each override stands in for. Most share a name; the till
 * ones do not, because store_settings named them before there were branches
 * and renaming a live column to tidy a mapping is not a trade worth making.
 */
const STORE_COLUMN = {
    opening_float: 'default_opening_float',
    variance_tolerance: 'cash_variance_tolerance',
};

/* Run a read on the caller's transaction when there is one, else the pool. */
const run = async (conn, sql, params) => (
    conn ? (await conn.query(sql, params))[0] : query(sql, params)
);

export const branchOverrides = async (branchId, conn = null) => {
    const rows = await run(conn, 'SELECT * FROM branch_settings WHERE branch_id = ?', [branchId]);
    return rows[0] || null;
};

/*
 * One settings object to read from, whichever outlet is asking. Also reports
 * WHICH fields the outlet answered for itself, because a screen that shows a
 * rate has to be able to say whether that rate is the company's or this
 * branch's — an operator who cannot tell will eventually change the wrong one.
 */
export const settingsFor = async (branchId, conn = null) => {
    const [store] = await run(conn, 'SELECT * FROM store_settings LIMIT 1', []);
    if (!store) return null;

    const over = await branchOverrides(branchId, conn);
    const merged = { ...store };
    const overridden = [];
    for (const col of OVERRIDABLE) {
        const value = over?.[col];
        if (value == null) continue;
        merged[STORE_COLUMN[col] || col] = value;
        overridden.push(col);
    }
    return { ...merged, branch_id: branchId, overridden };
};

/*
 * The two rates a bill can be taxed at, for one outlet. Its own signature
 * rather than a field off settingsFor because the settle path calls it inside
 * a transaction on the hot money route and has no use for the other forty
 * columns.
 */
export const taxRatesFor = async (conn, branchId) => {
    const [store] = await run(conn, 'SELECT tax_rate_cash, tax_rate_card FROM store_settings LIMIT 1', []);
    const [over] = await run(
        conn, 'SELECT tax_rate_cash, tax_rate_card FROM branch_settings WHERE branch_id = ?', [branchId],
    );
    return {
        cash: Number(over?.tax_rate_cash ?? store?.tax_rate_cash ?? 0.16),
        card: Number(over?.tax_rate_card ?? store?.tax_rate_card ?? 0.16),
    };
};

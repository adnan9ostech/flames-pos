/*
 * Makes a MySQL row look exactly like the Supabase row the pages already
 * consume: dates as ISO-8601 UTC strings, TINYINT(1) flags as booleans,
 * DATE columns as 'YYYY-MM-DD'. JSON and DECIMAL are already right (mysql2
 * parses JSON columns; the pool sets decimalNumbers).
 *
 * The page code was written against PostgREST responses; keeping the shape
 * identical here is what let the migration leave every screen untouched.
 */

const BOOL_COLUMNS = {
    orders: ['include_tax'],
    menu_items: ['is_available', 'is_archived'],
    waiters: ['is_active'],
    store_settings: ['qr_enabled', 'auto_print', 'kds_auto_print', 'void_requires_pin', 'cash_change', 'kot_qr'],
};

const DATE_ONLY = new Set(['business_date', 'day']);

export const serializeRow = (table, row) => {
    if (!row) return row;
    const out = { ...row };
    for (const [k, v] of Object.entries(out)) {
        if (v instanceof Date) {
            // A DATE column parses to midnight UTC; the calendar day is the value.
            out[k] = DATE_ONLY.has(k) ? v.toISOString().slice(0, 10) : v.toISOString();
        }
    }
    for (const col of BOOL_COLUMNS[table] ?? []) {
        if (out[col] !== null && out[col] !== undefined) out[col] = Boolean(out[col]);
    }
    return out;
};

export const serializeRows = (table, rows) => rows.map((r) => serializeRow(table, r));

/*
 * The rules of a manual journal voucher, with no database behind them, so
 * the browser can refuse an unbalanced voucher before the round trip and
 * the server can refuse it again with the very same code. Nothing in here
 * may import the pool: this file ships in the client bundle.
 */

/* The fixed vocabulary of a manual voucher, so the Health screen, the
 * voucher list and the tests never spell it two ways. */
export const MANUAL_SOURCE_TYPE = 'manual';
export const MANUAL_VOUCHER_TYPE = 'JV';

/* The opening-balance mode's fixed header, shared by the form and the test. */
export const OPENING_REFERENCE = 'OPENING';
export const OPENING_DESCRIPTION = 'Opening balances';

/* Paise-exact; every figure that reaches a line or an equality check. */
export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const clip = (s, n) => {
    const str = String(s ?? '').trim();
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/*
 * The lines as the form sends them → the lines the ledger accepts. Throws
 * the message the accountant should read.
 */
export const cleanLines = (input) => {
    const raw = Array.isArray(input) ? input : [];
    const lines = raw
        .map((l, i) => ({
            row: i + 1,
            account_id: Number(l?.account_id) || 0,
            debit: money(l?.debit),
            credit: money(l?.credit),
            memo: l?.memo == null || String(l.memo).trim() === '' ? null : clip(l.memo, 191),
        }))
        // A row nobody filled in is not an error, it is just empty.
        .filter((l) => l.account_id || l.debit !== 0 || l.credit !== 0);

    for (const l of lines) {
        if (!l.account_id) throw new Error(`Line ${l.row}: pick an account`);
        if (l.debit < 0 || l.credit < 0) throw new Error(`Line ${l.row}: an amount cannot be negative`);
        if (l.debit !== 0 && l.credit !== 0) throw new Error(`Line ${l.row}: a line carries a debit or a credit, never both`);
        if (l.debit === 0 && l.credit === 0) throw new Error(`Line ${l.row}: enter a debit or a credit`);
    }
    if (lines.length < 2) throw new Error('A journal needs at least two lines. One to debit and one to credit');

    const debitTotal = money(lines.reduce((s, l) => s + l.debit, 0));
    const creditTotal = money(lines.reduce((s, l) => s + l.credit, 0));
    if (debitTotal !== creditTotal) {
        const diff = money(Math.abs(debitTotal - creditTotal));
        throw new Error(`Out of balance by Rs ${diff.toLocaleString('en-PK', { maximumFractionDigits: 2 })}. Debits must equal credits`);
    }
    if (debitTotal === 0) throw new Error('A journal must move some money');

    return { lines, debitTotal, creditTotal };
};

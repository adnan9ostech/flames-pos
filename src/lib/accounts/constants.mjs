/*
 * The vocabulary of the chart of accounts. Pure data, importable by the
 * browser and by a plain Node test alike — no database, no React.
 */

/*
 * The five groups, in statement order, with the leading digits an account
 * number in each may carry.
 *
 * This is the standard accounting series — 1 asset, 2 liability, 3 equity,
 * 4 income, 5+ expense — which is what QuickBooks, Xero and Sage all use and
 * what the restaurant's accountant sent his chart in. It replaced ChowPOS's
 * 1/2/3/4/5 = asset/liability/income/expense/equity on 3 Sep 2026, because the
 * accountant keeps the statutory books and the till has to speak his codes,
 * not the other way round. Every account was renumbered with it
 * (mysql/migrations/018_chart_of_accounts_v2.sql).
 *
 * Expense spans five digits on purpose: cost of sales (5), labour (6), direct
 * operating (7), occupancy and administration (8) and non-operating (9) are
 * separate blocks of the P&L, and squeezing them into one leading digit is
 * what forces a restaurant to read its food cost out of a single lump.
 */
export const GROUPS = [
    { key: 'asset', label: 'Asset', digits: ['1'], normal: 'debit' },
    { key: 'liability', label: 'Liability', digits: ['2'], normal: 'credit' },
    { key: 'equity', label: 'Equity', digits: ['3'], normal: 'credit' },
    { key: 'income', label: 'Income', digits: ['4'], normal: 'credit' },
    { key: 'expense', label: 'Expense', digits: ['5', '6', '7', '8', '9'], normal: 'debit' },
];

export const GROUP_KEYS = GROUPS.map((g) => g.key);
export const groupOf = (key) => GROUPS.find((g) => g.key === key) || null;

/* Account numbers are four digits throughout, as the accountant's chart is. */
export const ACCOUNT_NUMBER_RE = /^\d{4}$/;

/* "5-9xxx" / "1xxx" — what the form shows beside a group. */
export const digitsLabel = (group) => {
    const d = group?.digits ?? [];
    if (d.length === 0) return '';
    return d.length === 1 ? `${d[0]}xxx` : `${d[0]}\u2013${d[d.length - 1]}xxx`;
};

/* The group an account number belongs to, read off its leading digit. */
export const groupForNumber = (number) => {
    const first = String(number ?? '')[0];
    return GROUPS.find((g) => g.digits.includes(first)) || null;
};

/*
 * ChowPOS's "Link" column, decoded from its Add Account form: an account
 * declares what it is ELIGIBLE for, and every picker in the app filters on
 * that. A cash account carries AR_PAID so the till may settle into it and
 * AP_PAID so an expense voucher may pay from it; a revenue account carries
 * IC_ITEM_INCOME so a menu category may map to it. Nothing is hard-coded to
 * an account number anywhere — the mapping is data.
 *
 * Grouped the way the form groups them, with the plain-English label an
 * accountant would give a manager. The code stays visible beside it because
 * the seed file and the poster speak in codes.
 */
export const LINK_GROUPS = [
    {
        title: 'Control account',
        hint: 'A summary account the system posts to on your behalf.',
        codes: [
            { code: 'AR', label: 'Receivables control (guest ledger, city ledger)' },
            { code: 'AP', label: 'Payables control (suppliers, sundry creditors)' },
            { code: 'INVENTORY', label: 'Stock control' },
        ],
    },
    {
        title: 'Receiving money',
        hint: 'Where a settlement or a receipt can land.',
        codes: [
            { code: 'AR_PAID', label: 'Can receive a payment (POS settle, city-ledger receipt)' },
            { code: 'AR_TAX', label: 'Sales tax collected on a sale' },
        ],
    },
    {
        title: 'Paying money out',
        hint: 'Where an expense or a supplier bill can be paid from.',
        codes: [
            { code: 'AP_PAID', label: 'Can pay an expense or a supplier' },
            { code: 'AP_TAX', label: 'Tax withheld or paid on a purchase' },
        ],
    },
    {
        title: 'Menu items (stock-tracked)',
        hint: 'What a dish with a recipe can post to.',
        codes: [
            { code: 'IC_ITEM_INCOME', label: 'Revenue from a menu item' },
            { code: 'COGS', label: 'Cost of goods sold' },
            { code: 'PAYABLE_T', label: 'Payable for taxable goods' },
        ],
    },
    {
        title: 'Services and charges',
        hint: 'What a service charge, delivery fee or an expense code can post to.',
        codes: [
            { code: 'IC_SERVICE_INCOME', label: 'Revenue from a charge or service' },
            { code: 'IC_SERVICE_EXPENSE', label: 'An expense code may debit this' },
            { code: 'PAYABLE_NT', label: 'Payable for services (non-taxable)' },
        ],
    },
    {
        title: 'Stock adjustments',
        hint: '',
        codes: [
            { code: 'INV_GAIN', label: 'Gain on a stock count' },
        ],
    },
];

export const LINK_CODES = LINK_GROUPS.flatMap((g) => g.codes.map((c) => c.code));

/* Voucher types the ledger writes, with the words a person sees. */
export const VOUCHER_TYPES = {
    SV: 'Sale',
    SM: 'Settlement',
    EV: 'Expense',
    RV: 'Receipt',
    PV: 'Payment',
    JV: 'Journal',
};

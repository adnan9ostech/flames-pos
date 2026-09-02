/*
 * The vocabulary of the chart of accounts. Pure data, importable by the
 * browser and by a plain Node test alike — no database, no React.
 */

/* The five groups, in statement order. `digit` is the leading digit every
 * account number in the group must carry: ChowPOS's convention, kept because
 * a number that says what it is beats one that has to be looked up. */
export const GROUPS = [
    { key: 'asset', label: 'Asset', digit: '1', normal: 'debit' },
    { key: 'liability', label: 'Liability', digit: '2', normal: 'credit' },
    { key: 'income', label: 'Income', digit: '3', normal: 'credit' },
    { key: 'expense', label: 'Expense', digit: '4', normal: 'debit' },
    { key: 'equity', label: 'Equity', digit: '5', normal: 'credit' },
];

export const GROUP_KEYS = GROUPS.map((g) => g.key);
export const groupOf = (key) => GROUPS.find((g) => g.key === key) || null;

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

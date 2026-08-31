// Money for an order, in one place. The POS cart, an appended round and the
// settled bill all price the same way, so they can never drift apart.

// Fallback only. The live rate lives in store_settings.tax_rate so it can change
// without a deploy — see getTaxRate() in supabaseDb.js. This is what applies
// when that value can't be read: offline, or the migration not yet run.
export const DEFAULT_TAX_RATE = 0.16;


/*
 * Discount comes off the subtotal and tax is charged on what remains. That
 * order matters: taxing the full amount and discounting afterwards would have
 * the customer paying tax on money they were never charged.
 *
 * `discount` is an amount in rupees even when the operator typed a percentage.
 * The percentage is an input; the money is the fact. Storing the percentage
 * would silently re-price a historical bill if anything else about it changed.
 */
export const calcTotals = (items, includeTax = true, { taxRate = DEFAULT_TAX_RATE, discount = 0 } = {}) => {
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);

    // Never negative, never more than the bill — an over-large discount would
    // otherwise produce a total the till would happily accept as money owed.
    const appliedDiscount = Math.min(Math.max(Number(discount) || 0, 0), subtotal);

    const taxable = subtotal - appliedDiscount;
    const tax = includeTax ? Math.round(taxable * taxRate) : 0;

    return { subtotal, discount: appliedDiscount, taxable, tax, total: taxable + tax };
};

// Rounds are stamped on each line as it is fired, so the kitchen can tell a
// freshly added course from food it has already cooked. Lines predating this
// (orders placed before tabs existed) read as round 1.
export const itemRound = (item) => item.round || 1;

export const isLatestRound = (item, order) =>
    (order?.round_count || 1) > 1 && itemRound(item) === order.round_count;

/*
 * The one rupee formatter.
 *
 * Every figure a person reads — a tile price, a receipt line, a report
 * total — comes through here, in the en-PK locale, so a bill prints the same
 * on every till. A bare toLocaleString() takes the device's locale, and the
 * same receipt came out "1,250" on one tablet and "1.250" on another.
 *
 * Plain JS with no imports: used by client components, server actions and
 * the receipt alike.
 */
const LOCALE = 'en-PK';

/* "1,250" — a whole-rupee figure, the default on tiles and totals. */
export const formatNumber = (n, digits = 0) =>
    (Number(n) || 0).toLocaleString(LOCALE, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });

/* "Rs. 1,250" — the same with the currency word. `digits: 2` for a cost
 * that is genuinely fractional (an ingredient priced per gram). */
export const formatRupees = (n, digits = 0) => `Rs. ${formatNumber(n, digits)}`;

/* "Rs. 2,595 – 4,895" for a sized dish, "Rs. 1,200" for a plain one. */
export const formatPriceRange = (price, variants = []) => {
    const prices = (Array.isArray(variants) ? variants : [])
        .map((v) => Number(v?.price))
        .filter((p) => Number.isFinite(p));
    if (prices.length < 2) return formatRupees(price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    return lo === hi ? formatRupees(hi) : `Rs. ${formatNumber(lo)} – ${formatNumber(hi)}`;
};

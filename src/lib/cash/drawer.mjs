/*
 * The cash drawer's arithmetic, as pure functions.
 *
 * The whole model in five lines, because every screen and every report has to
 * agree on it:
 *
 *   expected  = opening float
 *             + cash sales (a void writes a negative row; that refund left
 *               this drawer, so it belongs in the sum)
 *             + paid-ins − paid-outs − cash expenses
 *   counted   = what the notes and coins actually add up to
 *   variance  = counted − expected      (negative is SHORT, positive is OVER)
 *   counted   = carry forward + handover
 *   tomorrow's opening float = today's carry forward
 *
 * That last line is the chain the restaurant runs on: the money left in the
 * till at close is the money in the till at open, so it is declared once and
 * proposed back rather than retyped from memory every morning.
 *
 * No Node imports and no `server-only`, so the browser can preview a close
 * with the same code the server enforces and `node --test` can assert the
 * rules without a database — the precedent is src/lib/menu/rules.mjs.
 */

/*
 * Pakistan's circulating denominations, largest first. 10, 5, 2 and 1 exist as
 * both note and coin and are counted together — a cashier counts value, not
 * mint. Largest first because that is the order a drawer is physically
 * counted in, and a form that fights the hand gets filled in wrong.
 */
export const PKR_DENOMINATIONS = [5000, 1000, 500, 100, 50, 20, 10, 5, 2, 1];

/* Rupee sums at (12,2) survive JS doubles; the additions leave float dust. */
export const round2 = (n) => Math.round(Number(n) * 100) / 100;

/*
 * A denomination breakdown → its total. Keys are the note values, values are
 * how many of each. Anything not a known denomination is ignored rather than
 * silently added at face value: a typo'd key must not become money.
 */
export const countFromDenominations = (input) => {
    if (!input || typeof input !== 'object') return 0;
    let total = 0;
    for (const note of PKR_DENOMINATIONS) {
        const raw = input[note] ?? input[String(note)];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`Rs. ${note} count must be zero or more`);
        if (!Number.isInteger(n)) throw new Error(`Rs. ${note} count must be a whole number of notes`);
        total += note * n;
    }
    return round2(total);
};

/*
 * The breakdown as stored: only the denominations actually present, keys as
 * strings, so a drawer counted in five kinds of note is five keys and not ten
 * zeroes. Returns null when nothing was entered, which is what "counted as a
 * lump sum" looks like on the row.
 */
export const cleanDenominations = (input) => {
    if (!input || typeof input !== 'object') return null;
    const out = {};
    for (const note of PKR_DENOMINATIONS) {
        const raw = input[note] ?? input[String(note)];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
            throw new Error(`Rs. ${note} count must be a whole number, zero or more`);
        }
        if (n > 0) out[String(note)] = n;
    }
    return Object.keys(out).length === 0 ? null : out;
};

/* What the drawer should hold right now. */
export const expectedCash = ({
    openingFloat = 0, cashSales = 0, paidIn = 0, paidOut = 0, drawerExpenses = 0,
} = {}) => round2(
    Number(openingFloat) + Number(cashSales) + Number(paidIn)
    - Number(paidOut) - Number(drawerExpenses),
);

/* Negative is short, positive is over. The sign IS the finding. */
export const varianceOf = (counted, expected) => round2(Number(counted) - Number(expected));

/*
 * A written reason is demanded once the miss is bigger than the tolerance the
 * admin set. Tolerance is a REASON threshold and never a permission to hide:
 * the variance is recorded and posted to Cash Over and Short either way.
 */
export const needsReason = (variance, tolerance = 0) =>
    Math.abs(round2(variance)) > round2(Math.abs(Number(tolerance) || 0));

/* Rupees off a form: a real number, zero or more, rounded to paisa. */
export const cleanAmount = (value, label = 'Amount') => {
    const raw = String(value ?? '').trim();
    // An empty box is a missing answer, not zero rupees — Number('') is 0, and
    // a blank count would otherwise close the drawer at nothing and read as a
    // catastrophic short.
    if (raw === '') throw new Error(`${label} is required`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
    if (n < 0) throw new Error(`${label} cannot be negative`);
    if (n > 99_999_999) throw new Error(`${label} is implausibly large`);
    return round2(n);
};

/*
 * The count splits in two, and the split must be exact: what stays in the
 * till for tomorrow, and what physically leaves with whoever is carrying it.
 * More carried forward than was counted is not a rounding argument — it is
 * cash that does not exist.
 */
export const splitCount = ({ counted, carryForward }) => {
    const total = cleanAmount(counted, 'Counted amount');
    const carry = cleanAmount(carryForward, 'Amount left in the drawer');
    if (carry > total) {
        throw new Error('You cannot leave more in the drawer than you counted.');
    }
    return { counted: total, carry, handover: round2(total - carry) };
};

/*
 * What the next drawer should open on: last night's carry forward, or the
 * standing float when there is no previous close to chain from. Explicitly
 * NOT "whatever was counted" — the handover has already left the building.
 */
export const suggestedFloat = ({ lastCarryForward = null, defaultFloat = 0 } = {}) => {
    const carry = lastCarryForward === null || lastCarryForward === undefined
        ? null : Number(lastCarryForward);
    if (carry !== null && Number.isFinite(carry) && carry >= 0) return round2(carry);
    const fallback = Number(defaultFloat);
    return Number.isFinite(fallback) && fallback > 0 ? round2(fallback) : 0;
};

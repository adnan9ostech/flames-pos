/*
 * Deals: a set of dishes sold together for one price.
 *
 * The whole design is in one idea — a deal is NOT a line on the bill. Tapping
 * one puts its dishes into the cart at their ordinary prices and puts the
 * difference into the order's discount. See migration 030 for why: the kitchen
 * gets real tickets, the stock room consumes each dish's recipe, the money math
 * needs no new concept, and the customer sees what they saved.
 *
 * Plain functions over plain data, no imports: the till uses them, and a test
 * can too.
 */

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/*
 * A counter, not a timestamp. Two taps of the same deal inside one millisecond
 * produced identical line ids, and the cart keys off them — so the second set
 * rendered under the first set's keys. Rare by hand, certain under a test, and
 * exactly the kind of thing that shows up once on a busy Saturday.
 */
let ticket = 0;

/*
 * Does this deal apply to this kind of order? Empty means every type — the
 * same rule and the same JSON shape the charges engine uses, so an operator
 * who has set one up already knows how the other reads.
 */
export const dealAppliesTo = (deal, orderType) => {
    const types = Array.isArray(deal?.order_types)
        ? deal.order_types
        : JSON.parse(deal?.order_types || '[]');
    return types.length === 0 || types.includes(orderType);
};

/* What one unit of a dish costs at menu price, at the size the deal names. */
const listPriceOf = (item, variantName) => {
    if (!item) return 0;
    if (variantName) {
        const variants = Array.isArray(item.variants) ? item.variants : JSON.parse(item.variants || '[]');
        const hit = variants.find((v) => v.name === variantName);
        if (hit) return Number(hit.price);
    }
    return Number(item.price);
};

/*
 * Turn a deal into cart lines, plus the saving to put on the order.
 *
 * Every line carries `dealName`, which travels to the kitchen as the line's
 * note: a cook plating a Family Platter needs to know the four tickets belong
 * together, and the cashier needs to see why four dishes are on a bill nobody
 * ordered individually.
 *
 * A deal whose dishes have since been repriced ABOVE its own price yields a
 * saving of zero rather than a negative one — the deal is then simply a
 * shortcut for ringing four dishes, which is honest, and somebody repricing
 * the menu will see it on the Deals screen.
 */
export const explodeDeal = (deal, menuItems = []) => {
    const byId = new Map(menuItems.map((i) => [String(i.id), i]));
    const stamp = `d${++ticket}`;

    const lines = (deal.lines || []).map((l, index) => {
        const item = byId.get(String(l.menu_item_id));
        if (!item) return null;
        const variantName = l.variant_name || '';
        const price = listPriceOf(item, variantName);
        return {
            ...item,
            // Unique per tap AND per line, so two taps of the same deal are two
            // sets in the cart rather than one set at double quantity — and so
            // a deal's own lines never merge into each other.
            uniqueId: `${stamp}-${index}`,
            name: variantName ? `${item.name} (${variantName})` : item.name,
            price,
            qty: Number(l.qty) || 1,
            selectedVariant: variantName ? { name: variantName, price } : null,
            notes: deal.name,
            dealName: deal.name,
        };
    }).filter(Boolean);

    const listTotal = round2(lines.reduce((sum, l) => sum + l.price * l.qty, 0));
    const saving = round2(Math.max(0, listTotal - Number(deal.price)));

    return { lines, listTotal, saving };
};

/*
 * Builds the PRAL Digital Invoicing payload (spec v1.2) for one settled
 * order. Pure — no DB, no fetch — so the same function serves the live
 * after-settle post, the retry worker (which re-posts the stored payload,
 * never a rebuilt one), and the self-test below.
 *
 * The awkward part is allocation. FBR wants tax and discount PER ITEM; the
 * POS stores both at ORDER level. Both are spread across the lines in
 * proportion to line_total, each line rounded to 2dp, with the rounding
 * residue absorbed into the LAST line — so the item columns always sum back
 * to exactly the order's subtotal/discount/tax/total. An invoice whose items
 * don't add up to its totals is what FBR's validator rejects.
 *
 * Field names (bposid, ntN_CNIC, uoM, Items…) are the spec's, casing and
 * all — this JSON goes on the wire verbatim.
 */

import { pathToFileURL } from 'node:url';

const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const toCents = (x) => Math.round(Number(x) * 100);

/*
 * Splits `total` across `weights` proportionally, returning 2dp numbers that
 * sum to exactly round2(total). Works in integer cents so float noise cannot
 * leak into the residue; the last element absorbs the rounding remainder.
 * All-zero weights (a bill of free items) put the whole amount on the last
 * line rather than dividing by zero.
 */
export const allocate = (total, weights) => {
    if (weights.length === 0) return [];
    const totalC = toCents(total);
    const sum = weights.reduce((a, w) => a + Number(w), 0);
    const out = new Array(weights.length).fill(0);
    if (sum > 0) {
        let allocated = 0;
        for (let i = 0; i < weights.length - 1; i += 1) {
            const c = Math.round((totalC * Number(weights[i])) / sum);
            out[i] = c;
            allocated += c;
        }
        out[weights.length - 1] = totalC - allocated;
    } else {
        out[weights.length - 1] = totalC;
    }
    return out.map((c) => c / 100);
};

/*
 * invoiceDate is the sale's wall-clock moment in Asia/Karachi, formatted the
 * way the spec spells it ('YYYY-MM-DD HH:mm:ss.SSS'). Karachi is fixed UTC+5
 * with no DST (same assumption karachiDay makes), so shifting the UTC instant
 * five hours and reading the UTC getters is exact.
 */
const karachiStamp = (d) => {
    const t = new Date(d.getTime() + 5 * 3_600_000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
        `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${p(t.getUTCMilliseconds(), 3)}`;
};

const slugify = (name) =>
    String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/*
 * order: the orders row (raw or serialized — paid_at may be a Date or an ISO
 * string). lines: order_items rows (menu_item_id, name, variant, unit_price,
 * qty, line_total) in (round_no, seq) order. settings: store_settings row.
 * Merchant identity and the T-codes come from server-only env.
 */
export const buildFbrPayload = (order, lines, settings = {}) => {
    const env = process.env;
    const subtotal = Number(order.subtotal) || 0;
    const discount = Number(order.discount) || 0;
    const tax = Number(order.tax) || 0;
    const taxable = round2(subtotal - discount);

    // The percentage actually charged, not the configured one: settle resolved
    // the rate by payment method, and tax stores the outcome. 0 when the tax
    // toggle was off — the invoice then declares an untaxed sale, not a guess.
    const rate = taxable > 0 && tax > 0 ? round2((tax / taxable) * 100) : 0;

    const weights = lines.map((l) => Number(l.line_total));
    const values = allocate(taxable, weights);
    const taxes = allocate(tax, weights);
    const discounts = allocate(discount, weights);

    const items = lines.map((l, i) => ({
        hsCode: env.FBR_HS_CODE || '',
        // The menu FK when the dish still exists; a deleted dish's line keeps
        // a stable code derived from the name it was sold under.
        productCode: l.menu_item_id || slugify(l.name),
        productDescription: l.variant ? `${l.name} (${l.variant})` : l.name,
        rate,
        uoM: env.FBR_UOM || '',
        quantity: Number(l.qty),
        valueSalesExcludingST: values[i],
        salesTaxApplicable: taxes[i],
        discount: discounts[i],
        totalValues: round2(values[i] + taxes[i]),
    }));

    return {
        bposid: env.FBR_BPOSID || '',
        invoiceType: 2, // Sale
        invoiceDate: karachiStamp(order.paid_at ? new Date(order.paid_at) : new Date()),
        ntN_CNIC: env.FBR_SELLER_NTN || '', // seller NTN — walk-in retail
        buyerSellerName: order.customer_name || 'Walk-in Customer',
        destinationAddress: settings.merchant_address || settings.merchant_city || 'Islamabad',
        saleType: env.FBR_SALE_TYPE || '',
        totalSalesTaxApplicable: round2(tax),
        totalRetailPrice: round2(subtotal), // mandatory: the subtotal, pre-discount
        totalDiscount: round2(discount),
        Items: items,
    };
};

/*
 * node src/lib/fbr/payload.mjs --self-test
 *
 * Asserts, in cents so float noise can't false-pass, that the item columns
 * reconcile with the order totals on three carts: order-level discount split
 * across ragged lines, the tax toggle off, and a single line (residue
 * absorption degenerates to exact assignment).
 */
const runDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirect && process.argv.includes('--self-test')) {
    const sumC = (arr, key) => arr.reduce((a, it) => a + toCents(it[key]), 0);
    let failed = false;
    const assertEq = (label, got, want) => {
        if (got !== want) {
            failed = true;
            console.error(`FAIL ${label}: got ${got}, wanted ${want}`);
        }
    };

    const line = (name, variant, price, qty, id = null) =>
        ({ menu_item_id: id, name, variant, unit_price: price, qty, line_total: price * qty });

    const carts = [
        {
            label: 'with-discount',
            order: {
                subtotal: 3534, discount: 100, tax: 549.44, total: 3983.44,
                include_tax: 1, customer_name: null, paid_at: '2026-08-31T14:05:00.000Z',
            },
            lines: [
                line('Chicken Karahi', 'Full', 450, 2, '11111111-1111-4111-8111-111111111111'),
                line('Roghni Naan', null, 333, 1),
                line('Seekh Kebab', 'Beef', 767, 3),
            ],
        },
        {
            label: 'tax-off',
            order: {
                subtotal: 1750, discount: 0, tax: 0, total: 1750,
                include_tax: 0, customer_name: 'Ali Raza', paid_at: new Date('2026-08-31T09:00:00.000Z'),
            },
            lines: [line('Chapli Kebab', null, 425, 2), line('Kabuli Pulao', 'Half', 900, 1)],
        },
        {
            label: 'single-line',
            order: {
                subtotal: 1195, discount: 55, tax: 182.4, total: 1322.4,
                include_tax: 1, customer_name: null, paid_at: '2026-01-15T19:30:00.000Z',
            },
            lines: [line('Mutton Karahi', 'Full', 1195, 1)],
        },
    ];

    for (const { label, order, lines } of carts) {
        const p = buildFbrPayload(order, lines, { merchant_city: 'Islamabad' });
        assertEq(`${label} item count`, p.Items.length, lines.length);
        assertEq(`${label} valueSalesExcludingST sum`,
            sumC(p.Items, 'valueSalesExcludingST'), toCents(order.subtotal - order.discount));
        assertEq(`${label} salesTaxApplicable sum`, sumC(p.Items, 'salesTaxApplicable'), toCents(order.tax));
        assertEq(`${label} discount sum`, sumC(p.Items, 'discount'), toCents(order.discount));
        assertEq(`${label} totalValues sum`, sumC(p.Items, 'totalValues'), toCents(order.total));
        assertEq(`${label} totalRetailPrice`, p.totalRetailPrice, round2(order.subtotal));
        assertEq(`${label} totalSalesTaxApplicable`, p.totalSalesTaxApplicable, round2(order.tax));
        assertEq(`${label} totalDiscount`, p.totalDiscount, round2(order.discount));
        if (!order.include_tax) assertEq(`${label} rate`, p.Items[0].rate, 0);
    }

    // The spec's date shape, from a known instant: 14:05 UTC is 19:05 Karachi.
    const stamped = buildFbrPayload(carts[0].order, carts[0].lines, {}).invoiceDate;
    assertEq('invoiceDate', stamped, '2026-08-31 19:05:00.000');

    if (failed) process.exit(1);
    console.log('payload self-test passed (3 carts reconcile)');
}

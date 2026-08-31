/*
 * Property test: the till and the server import the SAME calcTotals, so for
 * any cart the number the till displayed and the number createOrder persists
 * must agree EXACTLY — not to a tolerance. Prices are integer rupees (as the
 * menu's are) and rates are 4-decimal (as DECIMAL(5,4) stores them), so every
 * value round-trips MySQL without float dust and equality is honest.
 *
 * Each cart randomizes prices, qtys, discount (including over-large and
 * negative, exercising the clamp), include_tax, and the live cash rate itself
 * via store_settings — the rate an unsettled order prices at.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q } from './helpers.mjs';
import { createOrder } from '../../src/lib/db/orders.mjs';
import { calcTotals } from '../../src/lib/orderTotals.mjs';

before(async () => {
    await acquireSuiteLock();
    await resetDb();
});
after(closeDb);

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

const randomDiscount = (subtotal) => {
    switch (randInt(0, 3)) {
        case 0: return 0;
        case 1: return randInt(0, Math.max(subtotal, 0));       // in range
        case 2: return subtotal + randInt(1, 500);              // over-large → clamps to subtotal
        default: return -randInt(1, 100);                       // negative → clamps to 0
    }
};

test('200 random carts: calcTotals and the persisted order agree exactly', async () => {
    for (let i = 0; i < 200; i++) {
        const rate = randInt(0, 3000) / 10000; // 0–30%, 4 decimals — DECIMAL(5,4)-exact
        await q('UPDATE store_settings SET tax_rate_cash = ?', [rate]);

        const items = Array.from({ length: randInt(1, 6) }, (_, j) => ({
            name: `Cart${i} line${j}`,
            price: randInt(0, 5000),
            qty: randInt(1, 5),
        }));
        const includeTax = Math.random() < 0.5;
        const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
        const discount = randomDiscount(subtotal);

        const expected = calcTotals(items, includeTax, { taxRate: rate, discount });
        const order = await createOrder(
            items,
            { payment_status: 'unpaid', include_tax: includeTax, discount },
            randomUUID(),
        );

        const label = `cart ${i}: rate=${rate} includeTax=${includeTax} discount=${discount} ` +
            `items=${JSON.stringify(items.map(({ price, qty }) => [price, qty]))}`;
        assert.equal(order.subtotal, expected.subtotal, `subtotal — ${label}`);
        assert.equal(order.discount, expected.discount, `discount — ${label}`);
        assert.equal(order.tax, expected.tax, `tax — ${label}`);
        assert.equal(order.total, expected.total, `total — ${label}`);
    }
});

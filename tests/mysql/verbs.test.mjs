/*
 * node:test port of supabase/tests/p1_rpc_tests.sql — the nine invariants the
 * plpgsql RPCs guaranteed, now asserted against the .mjs verbs on real MySQL.
 * The scenarios share state in sequence exactly as the SQL script did: o1 is
 * the pay-now sale, tab is the dine-in tab that lives through tests 3–8.
 *
 * Error strings are asserted EXACTLY where the till string-matches them —
 * a reworded message here is a silently broken screen there.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, count, TAX } from './helpers.mjs';
import {
    createOrder, appendRound, settleOrder, voidOrder, bumpOrder,
} from '../../src/lib/db/orders.mjs';

before(async () => {
    await acquireSuiteLock();
    await resetDb();
});
after(closeDb);

const kCreate = randomUUID();
const kRound = randomUUID();
const kSettle = randomUUID();
let o1;   // the pay-now takeaway sale
let tab;  // the dine-in tab

test('1. pay-now create: lines, totals, invoice, payment, snapshot — one call', async () => {
    o1 = await createOrder(
        [
            { name: 'Test Gulab Jamun', price: 835, qty: 2 },
            {
                name: 'Test Karak', price: 415, qty: 1,
                selectedVariant: { name: 'Full' },
                selectedModifiers: { m1: [{ name: 'Extra' }] },
            },
        ],
        { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
        kCreate,
    );

    const expected = 2085 + Math.round(2085 * TAX.cash);
    assert.equal(o1.total, expected);
    assert.equal(o1.payment_status, 'paid');
    assert.match(o1.invoice_number ?? '', /^FBR-\d{6}-\d{4}$/);

    assert.equal(await count('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [o1.id]), 2);
    assert.equal(
        await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND amount = ?', [o1.id, o1.total]),
        1,
    );

    assert.equal(o1.items.length, 2);
    const karak = o1.items.find((i) => i.name === 'Test Karak');
    assert.deepEqual(karak.selectedVariant, { name: 'Full' });
});

test('2. create replay: same client_request_id returns the same order', async () => {
    const replay = await createOrder([{ name: 'X', price: 1, qty: 1 }], {}, kCreate);
    assert.equal(replay.id, o1.id);
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [o1.id]), 1);
});

test('3. tab + round: opts correction lands, replay cannot double-fire', async () => {
    tab = await createOrder(
        [{ name: 'Round1', price: 500, qty: 1 }],
        { payment_status: 'unpaid', order_type: 'dine-in' },
    );
    tab = await appendRound(
        tab.id, [{ name: 'Round2 Naan', price: 100, qty: 2 }], kRound, null,
        { table_number: 'T7' },
    );
    assert.equal(tab.round_count, 2);
    assert.equal(tab.table_number, 'T7');

    tab = await appendRound(tab.id, [{ name: 'Round2 Naan', price: 100, qty: 2 }], kRound); // retry!
    assert.equal(tab.round_count, 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM order_rounds WHERE order_id = ?', [tab.id]), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [tab.id]), 2);
    assert.equal(tab.status, 'new');
});

test('4. expected-total mismatch aborts before money moves', async () => {
    // Settle path: tab is 700 gross, 812 at the cash rate.
    const serverTotal = 700 + Math.round(700 * TAX.cash);
    await assert.rejects(
        settleOrder(tab.id, { method: 'cash', expectedTotal: 1 }),
        (e) => {
            assert.equal(
                e.message,
                `Total mismatch: till shows 1, server computed ${serverTotal} — reload before settling`,
            );
            return true;
        },
    );
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [tab.id]), 0);
    const row = await one('SELECT payment_status, invoice_number FROM orders WHERE id = ?', [tab.id]);
    assert.equal(row.payment_status, 'unpaid');
    assert.equal(row.invoice_number, null);

    // Create path wears the other suffix — and leaves no order behind.
    const kBad = randomUUID();
    await assert.rejects(
        createOrder([{ name: 'Y', price: 100, qty: 1 }], { payment_status: 'unpaid' }, kBad, 1),
        (e) => {
            assert.equal(
                e.message,
                `Total mismatch: till shows 1, server computed ${100 + Math.round(100 * TAX.cash)} — reload and re-ring`,
            );
            return true;
        },
    );
    assert.equal(await count('SELECT COUNT(*) AS n FROM orders WHERE client_request_id = ?', [kBad]), 0);
});

test('5. settle with discount; replay is fine; a second distinct attempt is refused', async () => {
    tab = await settleOrder(tab.id, {
        method: 'card', discount: 100, discountReason: 'Regular', clientRequestId: kSettle,
    });
    const expected = (700 - 100) + Math.round((700 - 100) * TAX.card);
    assert.equal(tab.total, expected);
    assert.equal(tab.payment_mode, 'card');

    const replay = await settleOrder(tab.id, { method: 'card', clientRequestId: kSettle });
    assert.equal(replay.total, tab.total);
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [tab.id]), 1);

    await assert.rejects(
        settleOrder(tab.id, { method: 'cash' }),  // a different, second attempt
        (e) => {
            assert.equal(e.message, 'This bill has already been settled.');
            return true;
        },
    );
});

test('6. rounds cannot land on a settled bill', async () => {
    await assert.rejects(
        appendRound(tab.id, [{ name: 'Late food', price: 50, qty: 1 }]),
        (e) => {
            assert.equal(e.message, 'This bill has already been settled.');
            return true;
        },
    );
});

test('7. invoice numbers are sequential within the day', async () => {
    const seq = (inv) => Number(inv.slice(-4));
    assert.equal(seq(tab.invoice_number), seq(o1.invoice_number) + 1);
    // Same business day, same prefix.
    assert.equal(tab.invoice_number.slice(0, -4), o1.invoice_number.slice(0, -4));
});

test('8. void reverses the money; voiding a void is a quiet no-op', async () => {
    await assert.rejects(
        voidOrder(tab.id, '   '),
        (e) => {
            assert.equal(e.message, 'A void needs a reason');
            return true;
        },
    );

    let r = await voidOrder(tab.id, 'test void', 'admin');
    assert.equal(r.status, 'cancelled');
    const { net, n } = await one(
        'SELECT COALESCE(SUM(amount), -1) AS net, COUNT(*) AS n FROM payments WHERE order_id = ?',
        [tab.id],
    );
    assert.equal(Number(net), 0);
    assert.equal(Number(n), 2); // the charge and its reversal

    r = await voidOrder(tab.id, 'again'); // quiet no-op
    assert.equal(r.status, 'cancelled');
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [tab.id]), 2);
});

test('9. a stale KDS bump loses instead of overwriting', async () => {
    let r = await createOrder([{ name: 'Bump test', price: 10, qty: 1 }], { payment_status: 'unpaid' });
    r = await bumpOrder(r.id, 'new', 'preparing');
    assert.equal(r.status, 'preparing');

    r = await bumpOrder(r.id, 'new', 'preparing'); // stale: board thought it was still new
    assert.equal(r.status, 'preparing');

    await assert.rejects(
        bumpOrder(r.id, 'preparing', 'cooked'),
        (e) => {
            assert.equal(e.message, 'Not a kitchen transition: cooked');
            return true;
        },
    );
});

test('9b. a bump cannot bring a voided order back to life', async () => {
    /*
     * bumpOrder validated only the status it was moving TO, so a caller passing
     * from='cancelled' matched the voided row and silently revived it — the
     * order back on the board as live, with cancelled_at and cancel_reason still
     * set and its payments netted to zero. The action gates on requireUser()
     * alone, so any signed-in account could reach it.
     */
    let r = await createOrder([{ name: 'Un-void test', price: 10, qty: 1 }], { payment_status: 'unpaid' });
    r = await voidOrder(r.id, 'walked out', 'test');
    assert.equal(r.status, 'cancelled');

    for (const to of ['preparing', 'ready', 'completed']) {
        const after = await bumpOrder(r.id, 'cancelled', to);
        assert.equal(after.status, 'cancelled', `a bump to ${to} must not revive a void`);
    }

    // The void's own record is intact, not half-overwritten.
    const row = await one('SELECT status, cancelled_at, cancel_reason FROM orders WHERE id = ?', [r.id]);
    assert.equal(row.status, 'cancelled');
    assert.ok(row.cancelled_at, 'cancelled_at survives');
    assert.equal(row.cancel_reason, 'walked out');
});

test('10. line validation and method contract strings', async () => {
    const unpaid = { payment_status: 'unpaid' };
    await assert.rejects(createOrder([], unpaid),
        (e) => e.message === 'A round needs at least one item');
    await assert.rejects(createOrder([{ name: '  ', price: 5, qty: 1 }], unpaid),
        (e) => e.message === 'Every line needs an item name');
    await assert.rejects(createOrder([{ name: 'Naan', price: 5, qty: 0 }], unpaid),
        (e) => e.message === 'Quantity must be at least 1 on "Naan"');
    await assert.rejects(createOrder([{ name: 'Naan', price: -5, qty: 1 }], unpaid),
        (e) => e.message === 'Price missing or negative on "Naan"');

    const open = await createOrder([{ name: 'Naan', price: 5, qty: 1 }], unpaid);
    await assert.rejects(settleOrder(open.id, { method: 'crypto' }),
        (e) => e.message === 'Unknown payment method crypto');
});

test('11. an auto-applied service charge lands on scoped order types only', async () => {
    // 5% dine-in, before tax — the production seed's exact shape.
    await q(
        `INSERT INTO charges (name, value_type, value, order_types, before_tax, auto_apply, is_active)
         VALUES ('Service Charge', 'percent', 5.00, '["dine-in"]', 1, 1, 1)`,
    );

    // Dine-in: 1000 food → 50 service → tax on 1050 → total 1050 + tax.
    const dineIn = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'paid', payment_mode: 'cash', order_type: 'dine-in' },
    );
    const expectedTax = Math.round(1050 * TAX.cash);
    assert.equal(Number(dineIn.charges_total), 50);
    assert.equal(Number(dineIn.total), 1050 + expectedTax);
    assert.deepEqual(dineIn.charges, [{ name: 'Service Charge', amount: 50, before_tax: true }]);

    // Takeaway is outside the charge's scope: plain food + tax.
    const takeaway = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'paid', payment_mode: 'cash', order_type: 'takeaway' },
    );
    assert.equal(Number(takeaway.charges_total), 0);
    assert.equal(Number(takeaway.total), 1000 + Math.round(1000 * TAX.cash));

    // The charge is part of the server's own recompute, so an expected total
    // computed WITHOUT it must be refused, not silently overwritten.
    await assert.rejects(
        createOrder(
            [{ name: 'Karahi', price: 1000, qty: 1 }],
            { payment_status: 'paid', payment_mode: 'cash', order_type: 'dine-in' },
            null,
            1000 + Math.round(1000 * TAX.cash),
        ),
        (e) => /^Total mismatch/.test(e.message),
    );

    await q('DELETE FROM charges');
});

test('12. a cash tender stores both halves, refuses a short one, and never touches a card sale', async () => {
    // Pay-now, cash, over-tendered: the change is the server's arithmetic, not
    // the till's, so a mistyped bill cannot hand out the wrong money.
    const paid = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'paid', payment_mode: 'cash', cash_received: 2000 },
    );
    const total = Number(paid.total);
    assert.equal(Number(paid.cash_received), 2000);
    assert.equal(Number(paid.change_due), 2000 - total);

    // Exact money: a real tender, and a change of zero is a fact here — the
    // columns are filled, not left null.
    const exact = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'paid', payment_mode: 'cash', cash_received: null },
    );
    assert.equal(exact.cash_received, null, 'no tender typed means no claim about one');
    assert.equal(exact.change_due, null);

    // A card sale has neither fact, whatever the till sends.
    const card = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'paid', payment_mode: 'card', cash_received: 5000 },
    );
    assert.equal(card.cash_received, null);
    assert.equal(card.change_due, null);

    // Short: refused outright. Recording it as "no change" would leave the
    // drawer short at close with nothing in the record to explain it.
    await assert.rejects(
        createOrder(
            [{ name: 'Karahi', price: 1000, qty: 1 }],
            { payment_status: 'paid', payment_mode: 'cash', cash_received: 100 },
        ),
        (e) => /^Cash received 100 is less than the bill/.test(e.message),
    );

    // And the same on the settle path, where a tab is closed rather than rung.
    const openTab = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'unpaid', order_type: 'dine-in' },
    );
    const settled = await settleOrder(openTab.id, { method: 'cash', cashReceived: 5000 });
    assert.equal(Number(settled.cash_received), 5000);
    assert.equal(Number(settled.change_due), 5000 - Number(settled.total));
});

test('13. a card sale keeps its terminal reference, and can be made to insist on one', async () => {
    const o = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'paid', payment_mode: 'card', card_reference: ' 4821 ' },
    );
    const pay = await one('SELECT method, reference FROM payments WHERE order_id = ?', [o.id]);
    assert.equal(pay.method, 'card');
    assert.equal(pay.reference, '4821', 'trimmed, and kept on the payment rather than the order');

    // A cash sale has no slip, so nothing is stored even if one is sent.
    const cash = await createOrder(
        [{ name: 'Karahi', price: 1000, qty: 1 }],
        { payment_status: 'paid', payment_mode: 'cash', card_reference: '9999' },
    );
    assert.equal((await one('SELECT reference FROM payments WHERE order_id = ?', [cash.id])).reference, null);

    // With the store insisting, a card sale without one is refused outright.
    await q('UPDATE store_settings SET card_ref_required = 1');
    await assert.rejects(
        createOrder(
            [{ name: 'Karahi', price: 1000, qty: 1 }],
            { payment_status: 'paid', payment_mode: 'card' },
        ),
        (e) => /needs the reference from the terminal slip/.test(e.message),
    );
    await q('UPDATE store_settings SET card_ref_required = 0');
});

test('14. a purchase order is answered once, by the delivery that arrives', async () => {
    const { receiveStock } = await import('../../src/lib/db/inventory.mjs');
    // Unique per run: inventory names and PO numbers are unique keys, and the
    // suite is run against a database it does not empty of masters.
    const tag = randomUUID().slice(0, 8);
    const supplier = (await q('INSERT INTO suppliers (name, is_active) VALUES (?, 1)', [`PO Supplier ${tag}`])).insertId;
    const item = (await q(
        'INSERT INTO inventory_items (name, unit_id, reorder_level, is_active) VALUES (?, 1, 0, 1)',
        [`PO Flour ${tag}`],
    )).insertId;
    const po = (await q(
        `INSERT INTO purchase_orders (po_number, supplier_id, warehouse_id, total)
         VALUES (?, ?, 1, 1200)`, [`PO-${tag}`, supplier],
    )).insertId;
    await q(
        'INSERT INTO purchase_order_lines (purchase_order_id, inventory_item_id, qty, unit_cost) VALUES (?, ?, 10, 120)',
        [po, item],
    );

    // What actually arrived: short, and dearer. Both are the GRN's truth, and
    // the order keeps what was promised.
    const grn = await receiveStock({
        supplierId: supplier, warehouseId: 1, purchaseOrderId: po,
        lines: [{ itemId: item, qty: 8, unitCost: 130 }],
    });
    assert.equal(
        (await one('SELECT purchase_order_id FROM stock_receivings WHERE id = ?', [grn.id])).purchase_order_id,
        po,
    );
    const closed = await one('SELECT status, closed_at FROM purchase_orders WHERE id = ?', [po]);
    assert.equal(closed.status, 'received');
    assert.ok(closed.closed_at, 'closing stamps when');
    const line = await one('SELECT qty, unit_cost FROM purchase_order_lines WHERE purchase_order_id = ?', [po]);
    assert.equal(Number(line.qty), 10, 'the order still says what was ordered');
    assert.equal(Number(line.unit_cost), 120, 'and at the price agreed');

    // A second delivery against the same order is refused: either a duplicate
    // post or a delivery that needs its own order.
    await assert.rejects(
        receiveStock({
            supplierId: supplier, warehouseId: 1, purchaseOrderId: po,
            lines: [{ itemId: item, qty: 2, unitCost: 130 }],
        }),
        (e) => /already closed/.test(e.message),
    );
});

test('15. a sub-recipe is a phantom: the spices leave the shelf, not the masala', async () => {
    const { receiveStock } = await import('../../src/lib/db/inventory.mjs');
    const { consumeForOrder } = await import('../../src/lib/inventory/consume.mjs');

    const tag = randomUUID().slice(0, 8);
    const sup = (await q('INSERT INTO suppliers (name, is_active) VALUES (?, 1)', [`Sub Supplier ${tag}`])).insertId;
    const mk = async (name) => (await q(
        'INSERT INTO inventory_items (name, unit_id, is_active) VALUES (?, 1, 1)', [`${name} ${tag}`],
    )).insertId;
    const chilli = await mk('Sub Chilli');
    const salt = await mk('Sub Salt');
    const masala = await mk('Sub Masala');

    // 1kg of masala is 0.6kg chilli + 0.4kg salt.
    await q(
        'INSERT INTO sub_recipe_lines (parent_item_id, component_item_id, qty) VALUES (?, ?, 0.6), (?, ?, 0.4)',
        [masala, chilli, masala, salt],
    );

    // Buying the spices prices the masala from its parts, inside the same
    // transaction as the moving average.
    await receiveStock({
        supplierId: sup, warehouseId: 1,
        lines: [{ itemId: chilli, qty: 10, unitCost: 1000 }, { itemId: salt, qty: 10, unitCost: 50 }],
    });
    const priced = await one('SELECT avg_cost FROM inventory_items WHERE id = ?', [masala]);
    assert.equal(Number(priced.avg_cost), 0.6 * 1000 + 0.4 * 50, 'the phantom costs the sum of its parts');

    // A dish that calls for 0.05kg of masala.
    const dish = await one('SELECT id FROM menu_items LIMIT 1');
    await q('DELETE FROM recipe_lines WHERE menu_item_id = ?', [dish.id]);
    // recipe_lines hangs off a recipes header, so the dish needs one first.
    await q(
        'INSERT INTO recipes (menu_item_id, notes) VALUES (?, NULL) ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3)',
        [dish.id],
    );
    await q(
        "INSERT INTO recipe_lines (menu_item_id, variant_name, inventory_item_id, qty) VALUES (?, '', ?, 0.05)",
        [dish.id, masala],
    );
    const itemRow = await one('SELECT name, price FROM menu_items WHERE id = ?', [dish.id]);
    const order = await createOrder(
        [{ id: dish.id, name: itemRow.name, price: Number(itemRow.price), qty: 2 }],
        { payment_status: 'paid', payment_mode: 'cash' },
    );
    await consumeForOrder(order);

    const moved = await q(
        "SELECT inventory_item_id AS id, SUM(delta) AS d FROM stock_ledger WHERE source_type = 'sale' AND source_id = ? GROUP BY inventory_item_id",
        [order.id],
    );
    const byItem = new Map(moved.map((r) => [Number(r.id), Number(r.d)]));
    // 2 portions x 0.05kg masala = 0.1kg -> 0.06 chilli + 0.04 salt.
    assert.equal(byItem.get(chilli), -0.06);
    assert.equal(byItem.get(salt), -0.04);
    assert.equal(byItem.has(masala), false, 'nothing is taken from a tub that was never bought');
});

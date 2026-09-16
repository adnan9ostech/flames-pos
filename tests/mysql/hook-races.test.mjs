/*
 * A hook that fires twice must act once.
 *
 * The settle path fires three hooks — stock consumption, the GL journals and
 * the FBR queue — deliberately fire-and-forget, on the reasoning that the
 * money is already taken and a bookkeeping fault must never fail a sale. That
 * bargain only holds if each hook is idempotent, because the same hook CAN
 * fire more than once for one bill: a settle the till retried, a void racing a
 * settle, two devices finishing the same tab, or the FBR worker picking up a
 * row the request was already sending.
 *
 * Two of the three were not. Both were check-then-act — read whether the work
 * was done, then do it — with nothing serialising the gap.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, createOrder } from './helpers.mjs';

let dish;
let item;

before(async () => {
    await acquireSuiteLock();
    await resetDb();

    item = (await q(
        'INSERT INTO inventory_items (name, unit_id, avg_cost, is_active) VALUES (?, 1, 100, 1)',
        [`Hook Race Item ${randomUUID().slice(0, 8)}`],
    )).insertId;

    dish = await one('SELECT id, name, price FROM menu_items LIMIT 1');
    await q('DELETE FROM recipe_lines WHERE menu_item_id = ?', [dish.id]);
    await q(
        'INSERT INTO recipes (menu_item_id) VALUES (?) ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3)',
        [dish.id],
    );
    // One portion eats two units, so a doubled consumption is unmistakable.
    await q(
        "INSERT INTO recipe_lines (menu_item_id, variant_name, inventory_item_id, qty) VALUES (?, '', ?, 2)",
        [dish.id, item],
    );
});
after(closeDb);

const ring = () => createOrder(
    [{ id: dish.id, name: dish.name, price: Number(dish.price), qty: 1 }],
    { payment_status: 'paid', payment_mode: 'cash' },
    randomUUID(),
);

const ledger = (type, id) => one(
    'SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS total FROM stock_ledger WHERE source_type = ? AND source_id = ?',
    [type, id],
);

test('five concurrent consumptions take the recipe off the shelf ONCE', async () => {
    const { consumeForOrder } = await import('../../src/lib/inventory/consume.mjs');
    const order = await ring();

    await Promise.all([1, 2, 3, 4, 5].map(() => consumeForOrder(order)));

    const row = await ledger('sale', order.id);
    assert.equal(Number(row.n), 1, 'one movement per ingredient, not five');
    assert.equal(Number(row.total), -2, 'the shelf drops by the recipe, once');
});

test('five concurrent void reversals hand the stock back ONCE', async () => {
    const { consumeForOrder, reverseForOrder } = await import('../../src/lib/inventory/consume.mjs');
    const order = await ring();
    await consumeForOrder(order);

    await Promise.all([1, 2, 3, 4, 5].map(() => reverseForOrder({ ...order, status: 'cancelled' })));

    const row = await ledger('void', order.id);
    assert.equal(Number(row.n), 1);
    assert.equal(Number(row.total), 2, 'the stock comes back once, not five times');

    // And the two together net to nothing, which is the invariant that matters:
    // a sale that was voided consumed nothing.
    const net = await one(
        `SELECT COALESCE(SUM(delta), 0) AS total FROM stock_ledger
          WHERE source_id = ? AND source_type IN ('sale', 'void')`,
        [order.id],
    );
    assert.equal(Number(net.total), 0);
});

test('a consumption already done is not redone, however many times it is asked', async () => {
    const { consumeForOrder } = await import('../../src/lib/inventory/consume.mjs');
    const order = await ring();

    // Sequentially this time: a replayed settle minutes later, not a race.
    await consumeForOrder(order);
    await consumeForOrder(order);
    await consumeForOrder(order);

    const row = await ledger('sale', order.id);
    assert.equal(Number(row.total), -2);
});

test('the FBR queue is claimed by exactly one caller', async () => {
    /*
     * The claim itself, driven directly. afterSettle's own path needs FBR
     * switched on and a reachable endpoint, so what is asserted here is the
     * statement the fix turns on: an UPDATE that takes the row from
     * (pending, attempts 0) can only succeed once, so only one caller can
     * reach postInvoice and only one fiscal invoice number can be minted.
     */
    const order = await ring();
    await q(
        `INSERT INTO fbr_invoices (order_id, usin, payload) VALUES (?, ?, ?)`,
        [order.id, order.invoice_number, JSON.stringify({ probe: true })],
    );

    const claim = () => q(
        `UPDATE fbr_invoices SET attempts = attempts + 1
          WHERE order_id = ? AND status = 'pending' AND attempts = 0`,
        [order.id],
    );
    const results = await Promise.all([1, 2, 3, 4, 5].map(claim));
    const winners = results.filter((r) => r.affectedRows === 1).length;

    assert.equal(winners, 1, 'exactly one caller claims the row');

    const row = await one('SELECT status, attempts FROM fbr_invoices WHERE order_id = ?', [order.id]);
    assert.equal(Number(row.attempts), 1, 'and the attempt is counted exactly once');
    assert.equal(row.status, 'pending',
        'still pending, so a failed send is retried by the worker rather than stranded');
});

test('the queue row itself cannot be duplicated', async () => {
    // This half was always sound — order_id is UNIQUE and the insert uses
    // ON DUPLICATE KEY — and it is asserted so a schema change cannot quietly
    // remove the guard the claim above depends on.
    const order = await ring();
    const enqueue = () => q(
        `INSERT INTO fbr_invoices (order_id, usin, payload) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [order.id, order.invoice_number, JSON.stringify({ probe: true })],
    );
    await Promise.all([1, 2, 3, 4, 5].map(enqueue));
    const row = await one('SELECT COUNT(*) AS n FROM fbr_invoices WHERE order_id = ?', [order.id]);
    assert.equal(Number(row.n), 1);
});

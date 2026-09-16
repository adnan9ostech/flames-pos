/*
 * Two tills, two drawers, and each one counts only its own notes.
 *
 * A drawer's expected cash was the sum of EVERY cash payment the branch took
 * since that drawer opened, because a payment row said nothing about which
 * till it came through. On one till that is right by accident. On two — and
 * `cashier` and `frontdesk` both hold `pos` and `drawer`, so two is the normal
 * shape for a restaurant with a counter and a front desk — both drawers
 * claimed the same notes: the first to count came out level and every other
 * one reported a short it could not explain, made of the other till's takings.
 *
 * Payments now carry drawer_session_id. NULL has a precise meaning — nobody
 * had a drawer open when the money moved — and that case is reported at close
 * rather than folded into whichever session happened to be running.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, createOrder } from './helpers.mjs';
import { settleOrder, voidOrder } from '../../src/lib/db/orders.mjs';

let dish;

before(async () => {
    await acquireSuiteLock();
    await resetDb();
    dish = await one('SELECT id, name, price FROM menu_items LIMIT 1');
});
after(closeDb);

const openTill = async (role) => (await q(
    `INSERT INTO drawer_sessions (branch_id, business_date, cashier_role, opening_float, opened_at)
     VALUES (1, CURDATE(), ?, 0, UTC_TIMESTAMP(3))`,
    [role],
)).insertId;

const closeTill = (id) => q(
    'UPDATE drawer_sessions SET closed_at = UTC_TIMESTAMP(3), expected_amount = 0 WHERE id = ?', [id],
);

/* Ring and settle at one till. The menu prices the line, so the amount is the
 * dish's own price — that is the point of pricedLines, not a detail here. */
const sell = async (role) => {
    const order = await createOrder(
        [{ id: dish.id, name: dish.name, price: Number(dish.price), qty: 1 }],
        { order_type: 'takeaway', payment_status: 'unpaid', include_tax: false },
        randomUUID(),
    );
    await settleOrder(order.id, { method: 'cash', cashierRole: role, clientRequestId: randomUUID() });
    return order;
};

const tillCash = async (sessionId) => Number((await one(
    "SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE drawer_session_id = ? AND method = 'cash'",
    [sessionId],
)).t);

test('each till sees its own cash, and not the other till\'s', async () => {
    const counter = await openTill('cashier');
    const frontDesk = await openTill('frontdesk');
    const unit = Number(dish.price);

    await sell('cashier');
    await sell('cashier');
    await sell('frontdesk');

    assert.equal(await tillCash(counter), unit * 2, 'the counter sees its two sales');
    assert.equal(await tillCash(frontDesk), unit, 'the front desk sees its one');

    // The sum both drawers used to claim, and which neither should.
    const branch = Number((await one(
        "SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE branch_id = 1 AND method = 'cash'",
    )).t);
    assert.equal(branch, unit * 3);
    assert.notEqual(await tillCash(counter), branch);
    assert.notEqual(await tillCash(frontDesk), branch);

    await closeTill(counter);
    await closeTill(frontDesk);
});

test('a card sale puts nothing in any drawer', async () => {
    const counter = await openTill('cashier');
    const order = await createOrder(
        [{ id: dish.id, name: dish.name, price: Number(dish.price), qty: 1 }],
        { order_type: 'takeaway', payment_status: 'unpaid', include_tax: false },
        randomUUID(),
    );
    await settleOrder(order.id, { method: 'card', cashierRole: 'cashier', clientRequestId: randomUUID() });

    assert.equal(await tillCash(counter), 0);
    const row = await one('SELECT drawer_session_id, method FROM payments WHERE order_id = ?', [order.id]);
    assert.equal(row.method, 'card');
    assert.equal(row.drawer_session_id, null, 'a card sale belongs to no till');
    await closeTill(counter);
});

test('cash rung with every till closed belongs to nobody, and says so', async () => {
    // No open session at all — asserted, not assumed, because a session left
    // open by an earlier test would make this test pass for the wrong reason.
    const openNow = await q('SELECT id, cashier_role FROM drawer_sessions WHERE closed_at IS NULL');
    assert.deepEqual(openNow, [], `expected no open till, found ${JSON.stringify(openNow)}`);

    const order = await sell('cashier');
    const row = await one('SELECT drawer_session_id FROM payments WHERE order_id = ?', [order.id]);
    assert.equal(row.drawer_session_id, null,
        'not silently attached to a session that was not open');

    // A till opened afterwards must NOT absorb it as its own takings — that is
    // the old window behaviour, and it is how one till swallowed another's.
    const later = await openTill('cashier');
    assert.equal(await tillCash(later), 0);
    await closeTill(later);
});

test('a refund leaves the till that is open now, not the one that took it', async () => {
    const first = await openTill('cashier');
    const order = await sell('cashier');
    assert.equal(await tillCash(first), Number(dish.price));

    /*
     * The shift ends and the money is counted. The refund happens on the next
     * shift, so it has to come out of THAT till: the closed session's expected
     * figure was frozen at close and cannot change, and charging the refund
     * there would leave tonight's till short with nothing to explain it.
     */
    await closeTill(first);
    const second = await openTill('cashier');

    await voidOrder(order.id, 'customer left', 'Test Admin', null, 'cashier');

    assert.equal(await tillCash(first), Number(dish.price), 'the closed till is untouched');
    assert.equal(await tillCash(second), -Number(dish.price), 'the open till gives the money back');
    await closeTill(second);
});

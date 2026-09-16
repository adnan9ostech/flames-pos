/*
 * "Has anything changed?" — the cheapest question in the app, asked most often.
 *
 * Every screen polls this token every four seconds and only runs its expensive
 * read when the answer differs. It was `COUNT(*), MAX(updated_at)` over the
 * branch's whole history, which was wrong twice:
 *
 *   it grew forever   O(every order ever taken) on the query that runs most
 *                     often. Measured on 20,000 orders: 9,901 rows examined,
 *                     0.750 ms average, 13.3 ms at worst. Bounded to a recent
 *                     window: 110 rows, 0.015 ms.
 *
 *   it could be       MAX over the whole table means ONE row dated 2030 pins
 *   pinned            the maximum for four years. With such a row present,
 *                     moving a ticket from preparing to ready left the token
 *                     byte for byte identical — so every screen goes blind to
 *                     every status change until an INSERT moves the count.
 *
 * The window relies on `updated_at` carrying ON UPDATE CURRENT_TIMESTAMP, so
 * both halves of that are asserted here rather than assumed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, createOrder } from './helpers.mjs';
import { getOrdersVersion } from '../../src/lib/db/reads.mjs';

let dish;

before(async () => {
    await acquireSuiteLock();
    await resetDb();
    dish = await one('SELECT id, name, price FROM menu_items LIMIT 1');
});
after(closeDb);

const ring = () => createOrder(
    [{ id: dish.id, name: dish.name, price: Number(dish.price), qty: 1 }],
    { order_type: 'takeaway', payment_status: 'unpaid' },
    randomUUID(),
);

test('the column the token depends on really does move on every edit', async () => {
    // The whole design rests on this. If updated_at ever stops being
    // ON UPDATE CURRENT_TIMESTAMP, the window silently stops seeing changes.
    // Aliased, because information_schema hands the column back as EXTRA
    // whatever case it was asked for, and `col.extra` reads as undefined —
    // which would have made this assertion pass on nothing.
    const col = await one(
        `SELECT extra AS on_update FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'updated_at'`,
    );
    assert.match(String(col.on_update), /on update CURRENT_TIMESTAMP/i);
});

test('a new order moves the token', async () => {
    const before_ = await getOrdersVersion(1);
    await ring();
    assert.notEqual(await getOrdersVersion(1), before_);
});

test('an EDIT to an existing order moves the token', async () => {
    const order = await ring();
    const before_ = await getOrdersVersion(1);

    // A status change is the case that matters: it inserts nothing, so a token
    // that only counted rows would miss it entirely.
    await q(
        "UPDATE orders SET status = 'preparing', updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [order.id],
    );
    assert.notEqual(await getOrdersVersion(1), before_,
        'a status change must be visible, or the kitchen display never updates');
});

test('a row dated in the future cannot pin the token', async () => {
    const order = await ring();
    // A clock skew, a hand-edited row, a timezone slip.
    await q("UPDATE orders SET updated_at = '2030-01-01 00:00:00' WHERE id = ?", [order.id]);

    const pinned = await getOrdersVersion(1);
    const other = await ring();
    await q(
        "UPDATE orders SET status = 'ready', updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [other.id],
    );

    assert.notEqual(await getOrdersVersion(1), pinned,
        'the 2030 row must not hide later changes — it used to hide them for four years');
});

test('the token is scoped to one outlet', async () => {
    await q("INSERT INTO branches (id, name, code, is_active) VALUES (77, 'Version Branch', 'VER', 1)");
    const mine = await getOrdersVersion(1);
    const theirs = await getOrdersVersion(77);
    assert.notEqual(mine, theirs, 'a quiet outlet must not inherit a busy one');

    // And one outlet's trade must not move the other's token.
    const before_ = await getOrdersVersion(77);
    await ring();
    assert.equal(await getOrdersVersion(77), before_);
});

test('an order too old for the window does not keep the token alive', async () => {
    // Ageing out moves the token once — one spurious refetch on a quiet
    // morning — and then it stays still. What must not happen is a token that
    // keeps changing, or one that never settles.
    await q("UPDATE orders SET updated_at = UTC_TIMESTAMP(3) - INTERVAL 30 DAY WHERE branch_id = 1");
    const quiet = await getOrdersVersion(1);
    assert.equal(quiet, '0:0', 'nothing recent means nothing to report');
    assert.equal(await getOrdersVersion(1), quiet, 'and it is stable, not flapping');
});

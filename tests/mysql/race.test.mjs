/*
 * The races the SQL test file could not cover (it had one session; these need
 * two). Every scenario drives the SAME app functions the till calls, fired
 * concurrently through the pool — the point is that the row locks and unique
 * keys, not luck, decide who wins.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, count, TAX } from './helpers.mjs';
import { createOrder, appendRound, settleOrder, bumpOrder } from '../../src/lib/db/orders.mjs';

before(async () => {
    await acquireSuiteLock();
    await resetDb();
});
after(closeDb);

test('a. settle-vs-settle: one terminal wins, the other learns the truth', async () => {
    const order = await createOrder(
        [{ name: 'Race settle', price: 1000, qty: 1 }], { payment_status: 'unpaid' },
    );

    // Two terminals, two distinct attempts — NOT a replay.
    const results = await Promise.allSettled([
        settleOrder(order.id, { method: 'cash', clientRequestId: randomUUID() }),
        settleOrder(order.id, { method: 'cash', clientRequestId: randomUUID() }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason.message, 'This bill has already been settled.');
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [order.id]), 1);
});

test('b. append twins, same key, concurrent: one round lands, both calls succeed', async () => {
    const tab = await createOrder(
        [{ name: 'R1', price: 500, qty: 1 }], { payment_status: 'unpaid' },
    );
    const key = randomUUID();
    const round = [{ name: 'R2 Naan', price: 100, qty: 2 }];

    const results = await Promise.allSettled([
        appendRound(tab.id, round, key),
        appendRound(tab.id, round, key),
    ]);

    for (const r of results) {
        assert.equal(r.status, 'fulfilled', `append twin rejected: ${r.reason?.message}`);
    }
    assert.equal(await count('SELECT COUNT(*) AS n FROM order_rounds WHERE client_request_id = ?', [key]), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM order_rounds WHERE order_id = ?', [tab.id]), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [tab.id]), 2);
    assert.equal(Number((await one('SELECT round_count FROM orders WHERE id = ?', [tab.id])).round_count), 2);
});

test('c. create double-tap, same key, concurrent: one order, one payment', async () => {
    const key = randomUUID();
    const cart = [{ name: 'Double tap', price: 250, qty: 2 }];
    const opts = { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' };

    const results = await Promise.allSettled([
        createOrder(cart, opts, key),
        createOrder(cart, opts, key),
    ]);

    // Whatever each caller saw, the database holds exactly one order and one
    // payment for this key.
    const rows = await q('SELECT id FROM orders WHERE client_request_id = ?', [key]);
    assert.equal(rows.length, 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [rows[0].id]), 1);

    // And the idempotency contract: BOTH taps come back with the same order.
    // KNOWN RED (kernel bug, do not fix here): createOrder's duplicate-key
    // recovery SELECT runs inside a transaction whose REPEATABLE READ view
    // predates the winner's commit, sees no twin, and rethrows the raw
    // ER_DUP_ENTRY to the till. A locking read (FOR SHARE) would see it.
    for (const r of results) {
        assert.equal(r.status, 'fulfilled', `double-tap twin rejected: ${r.reason?.message}`);
        assert.equal(r.value.id, rows[0].id);
    }
});

test('d. invoice counter storm: ten concurrent settles, gapless and duplicate-free', async () => {
    const orders = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        createOrder(
            [{ name: `Storm ${i}`, price: 100, qty: 1 }],
            { payment_status: 'paid', payment_mode: 'cash' },
            randomUUID(),
        )));

    const seqs = orders.map((o) => {
        assert.match(o.invoice_number ?? '', /^FBR-\d{6}-\d{4}$/);
        return Number(o.invoice_number.slice(-4));
    }).sort((x, y) => x - y);

    assert.equal(new Set(seqs).size, 10, `duplicate invoice numbers: ${seqs}`);
    assert.equal(seqs[9] - seqs[0], 9, `gap in invoice numbers: ${seqs}`);
});

test('e. bump-vs-append: a stale bump from the old status loses and returns truth', async () => {
    let order = await createOrder(
        [{ name: 'KDS race', price: 50, qty: 1 }], { payment_status: 'unpaid' },
    );
    order = await bumpOrder(order.id, 'new', 'preparing');
    assert.equal(order.status, 'preparing');

    // The floor adds food: the round re-fires the ticket to 'new'.
    const refired = await appendRound(order.id, [{ name: 'More', price: 60, qty: 1 }], randomUUID());
    assert.equal(refired.status, 'new');

    // The board, still showing 'preparing', bumps to 'ready' — and loses.
    const truth = await bumpOrder(order.id, 'preparing', 'ready');
    assert.equal(truth.status, 'new');
});

test('f. the same cart settles to different totals cash vs card', async () => {
    const cart = [{ name: 'Tax check', price: 999, qty: 2 }]; // 1998 gross
    const a = await createOrder(cart, { payment_status: 'unpaid' });
    const b = await createOrder(cart, { payment_status: 'unpaid' });

    const cash = await settleOrder(a.id, { method: 'cash' });
    const card = await settleOrder(b.id, { method: 'card' });

    assert.equal(cash.total, 1998 + Math.round(1998 * TAX.cash));
    assert.equal(card.total, 1998 + Math.round(1998 * TAX.card));
    assert.notEqual(cash.total, card.total);
});

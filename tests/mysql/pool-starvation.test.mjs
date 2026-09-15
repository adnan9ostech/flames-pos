/*
 * A busy pool refuses. It does not hang.
 *
 * mysql2's pool is created with `waitForConnections: true` and has no acquire
 * timeout of its own, so a starved pool waits FOREVER — no error, no recovery
 * short of restarting the process. That is not theoretical: five concurrent
 * transactions that each ask the pool for one more connection while holding
 * one of its five wedged the entire application permanently. On a busy service
 * that means the restaurant stops being able to ring anything, with nothing on
 * screen to say why.
 *
 * Five such paths existed in this codebase — every one of them resolving the
 * branch from the pool inside a transaction — and all five now resolve it
 * before the transaction opens. These tests guard the backstop that catches
 * the sixth.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSuiteLock, resetDb, closeDb } from './helpers.mjs';
import { pool, query, withTransaction } from '../../src/lib/db/pool.mjs';

before(async () => {
    await acquireSuiteLock();
    await resetDb();
});
after(closeDb);

test('a transaction that asks the pool for a second connection is refused, not hung', async () => {
    const nested = (i) => withTransaction(async (conn) => {
        await conn.query('SELECT 1');
        await query('SELECT 2');   // a POOL read, while holding a pool connection
        return i;
    });

    const started = Date.now();
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(nested));
    const seconds = (Date.now() - started) / 1000;

    /*
     * THE INVARIANT IS THAT EVERY CALL ANSWERS, not that every call fails.
     * How five of them interleave against five connections is a race — one may
     * get its inner read in before the last one takes the fifth connection and
     * succeed. What must never happen is a call that neither succeeds nor
     * fails, because that is the app hanging with nothing on screen.
     */
    assert.equal(results.length, 5, 'every call settled — none is still waiting');
    assert.ok(seconds < 30, `answered in ${seconds}s rather than never`);

    const refused = results.filter((r) => r.status === 'rejected');
    assert.ok(refused.length > 0, 'a starved pool does refuse rather than queue forever');
    assert.ok(refused.every((r) => /database is busy/i.test(r.reason.message)),
        'and it says so in words a cashier can act on, not in silence');
});

test('the pool survives the squeeze — no connection is leaked', async () => {
    // The refusal above abandons a pending getConnection. If that connection
    // were not released when it finally arrives, every squeeze would shrink
    // the pool by one and a transient problem would become a permanent one.
    const [row] = await query('SELECT 42 AS ok');
    assert.equal(Number(row.ok), 42);

    // And a full pool's worth of ordinary work still goes through.
    const done = await Promise.all(
        [1, 2, 3, 4, 5, 6, 7].map((i) => withTransaction(async (conn) => {
            const [[r]] = await conn.query('SELECT ? AS n', [i]);
            return Number(r.n);
        })),
    );
    assert.deepEqual(done, [1, 2, 3, 4, 5, 6, 7]);
});

test('the branch-resolving write verbs no longer ask the pool mid-transaction', async () => {
    /*
     * The real paths, run at the pool's full width. Each of these used to
     * resolve the branch from the pool inside its own transaction; five at
     * once was enough to stop the app. If any of them still did, this would
     * time out rather than return.
     */
    const { postDishWaste } = await import('../../src/lib/inventory/waste.mjs');

    const results = await Promise.allSettled(
        [1, 2, 3, 4, 5, 6].map(() => postDishWaste({ reason: 'pool probe', lines: [] })),
    );
    // Every one refuses on its own business rule ('Waste needs at least one
    // dish') — which is the point: they got a connection, ran, and answered.
    assert.ok(
        results.every((r) => r.status === 'rejected' && /at least one dish/i.test(r.reason.message)),
        `expected six business-rule refusals, got: ${results.map((r) => r.status + ':' + (r.reason?.message || '').slice(0, 40)).join(' | ')}`,
    );
});

/*
 * The one MySQL pool. Server-side only — every importer is a server action,
 * route handler, worker, or test. (.mjs so plain Node — tests, the FBR
 * worker, scripts — can import it as ESM without the package flipping to
 * "type": "module", which would break the CJS config files.)
 *
 * Two options here are load-bearing, not preferences:
 *   decimalNumbers: DECIMAL comes back as a JS number. The callers do
 *     arithmetic on money (reports sum totals); a string would concatenate.
 *     Rupee amounts at (12,2) are exactly representable, so no precision
 *     loss is possible at this scale.
 *   timezone 'Z' + session time_zone '+00:00': DATETIME(3) columns hold UTC
 *     and must come back as UTC Dates regardless of the box's local zone.
 */
import mysql from 'mysql2/promise';

if (typeof window !== 'undefined') {
    throw new Error('src/lib/db must never reach the browser');
}

const {
    DB_NAME, DB_USER = 'root', DB_PASSWORD = '',
    DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET,
} = process.env;

export const pool = mysql.createPool({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    // Polite on the shared cPanel MySQL: a couple of tills polling every few
    // seconds never needs more than this.
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    decimalNumbers: true,
    timezone: 'Z',
    /*
     * The connection must speak the SCHEMA's collation.
     *
     * mysql2 picks its own default when none is given, and it chose
     * utf8mb4_unicode_ci while every table here is utf8mb4_0900_ai_ci. That is
     * invisible until a query CASTs — `CAST(d.id AS CHAR)` takes the
     * connection's collation — and then comparing it to a column is an
     * "Illegal mix of collations" and the whole statement fails.
     *
     * Two screens were dead of exactly that: /accounts/health, which is the
     * ONLY thing that reports a sale whose ledger posting silently failed, and
     * /inventory/reports, which is all of on-hand value, movement history,
     * count variance and the reorder list. Both showed the raw MySQL sentence.
     *
     * Fixed here rather than by adding COLLATE to the queries that happen to
     * cast today, because the next one to cast would be dead on arrival.
     */
    charset: 'UTF8MB4_0900_AI_CI',
});

pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
});

/*
 * How long to wait for a connection before giving up.
 *
 * mysql2's pool has `waitForConnections: true` and no acquire timeout, so a
 * starved pool waits FOREVER — silently, with no error and no recovery short
 * of restarting the process. That is not a theoretical shape: five concurrent
 * transactions that each ask the pool for one more connection while holding
 * one of the five wedge the entire application permanently, which on a busy
 * service means the restaurant simply stops being able to ring anything.
 *
 * Eight seconds is far longer than any query here takes and far shorter than
 * a service. Past it, ONE sale fails with something a cashier can act on,
 * instead of every sale hanging with nothing on screen at all.
 *
 * This is a backstop, not the fix. The fix is not to ask the pool for a second
 * connection while holding one — resolve what you need before the transaction
 * opens. Five such paths existed and were repaired; this is what catches the
 * sixth.
 */
const ACQUIRE_TIMEOUT_MS = 8_000;

const BUSY = 'The database is busy and did not free a connection. Nothing was saved — try again.';

/*
 * A connection, or a refusal. The pending getConnection is NOT abandoned: if
 * it arrives after we have given up it is released straight back, because a
 * leaked connection would shrink the pool by one every time this fires and
 * turn a transient squeeze into a permanent one.
 */
const acquire = async () => {
    let timer;
    const wanted = pool.getConnection();
    try {
        return await Promise.race([
            wanted,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(BUSY)), ACQUIRE_TIMEOUT_MS);
            }),
        ]);
    } catch (e) {
        wanted.then((c) => c.release()).catch(() => {});
        throw e;
    } finally {
        clearTimeout(timer);
    }
};

/*
 * Single query against the pool. Returns rows only.
 *
 * Bounded by the same timeout as a transaction's acquire, and for the same
 * reason: this is the call that actually wedges. `pool.query` takes a
 * connection internally and waits forever for one, so a transaction that asks
 * for a second connection through here hangs with no error — which is how five
 * concurrent writes stopped the whole application dead.
 */
export const query = async (sql, params = []) => {
    const conn = await acquire();
    try {
        const [rows] = await conn.query(sql, params);
        return rows;
    } finally {
        conn.release();
    }
};

/*
 * One transaction, one connection, commit-or-rollback. The callback gets the
 * raw connection so FOR UPDATE locks live until commit. Rethrows after
 * rollback — the caller's error message is the till's alert text.
 */
export const withTransaction = async (fn) => {
    const conn = await acquire();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (e) {
        try { await conn.rollback(); } catch { /* connection died mid-rollback; release anyway */ }
        throw e;
    } finally {
        conn.release();
    }
};

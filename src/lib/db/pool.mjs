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
});

pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
});

/* Single query against the pool. Returns rows only. */
export const query = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
};

/*
 * One transaction, one connection, commit-or-rollback. The callback gets the
 * raw connection so FOR UPDATE locks live until commit. Rethrows after
 * rollback — the caller's error message is the till's alert text.
 */
export const withTransaction = async (fn) => {
    const conn = await pool.getConnection();
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

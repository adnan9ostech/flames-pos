/*
 * FBR retry worker — a standalone PM2 process, not part of the Next server.
 * Drains fbr_invoices: every 60s it re-posts up to 10 pending rows (oldest
 * first), using the STORED payload — the document of record — never a
 * rebuilt one. A row that fails its 20th attempt is marked 'failed' for a
 * human to look at; success backfills orders.fbr_invoice_number so the next
 * reprint carries the number the live settle missed.
 *
 *   pm2 start scripts/fbr-worker.mjs --name fbr-worker
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same .env loading as scripts/db/migrate.mjs: first file that defines a key
// wins, the real environment wins over both.
for (const file of ['.env.local', '.env.production']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

if (process.env.FBR_ENABLED !== 'true') {
    console.log('[fbr-worker] FBR_ENABLED is not "true" — nothing to do, exiting');
    process.exit(0);
}
if (!process.env.DB_NAME) {
    console.error('[fbr-worker] DB_NAME is not set — refusing to guess which database holds the queue');
    process.exit(1);
}

// Dynamic imports, deliberately after the env loading above: the pool reads
// DB_* at module-evaluation time, and a static import would hoist past it.
const { pool, query } = await import('../src/lib/db/pool.mjs');
const { postInvoice } = await import('../src/lib/fbr/client.mjs');

const BATCH = 10;
const MAX_ATTEMPTS = 20;
const PASS_MS = 60_000;

let stopping = false;
let wake = null;
let timer = null;

const sleep = (ms) => new Promise((resolve) => {
    wake = resolve;
    timer = setTimeout(resolve, ms);
});

// SIGTERM (pm2 stop/restart) finishes the row in flight, skips the rest of
// the batch, closes the pool, and exits — no half-updated queue rows.
const stop = (sig) => {
    console.log(`[fbr-worker] ${sig} — finishing current row, then closing the pool`);
    stopping = true;
    if (timer) clearTimeout(timer);
    wake?.();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

const pass = async () => {
    const rows = await query(
        /*
         * The join is the point. This selected pending invoices with no
         * reference to the order at all, so a bill voided between one pass and
         * the next was still reported to FBR as a sale — a fiscal record of
         * something that did not happen, which the restaurant answers for.
         *
         * It narrows the window to the sub-second case where a void commits
         * between this SELECT and the POST below. Closing that too would mean
         * holding a row lock across a network call, which is worse. Stated
         * rather than implied.
         */
        `SELECT f.id, f.order_id, f.usin, f.payload, f.attempts
         FROM fbr_invoices f
         JOIN orders o ON o.id = f.order_id
         WHERE f.status = 'pending' AND f.attempts < ?
           AND o.status <> 'cancelled'
         ORDER BY f.created_at
         LIMIT ?`,
        [MAX_ATTEMPTS, BATCH],
    );

    for (const row of rows) {
        if (stopping) return;
        const res = await postInvoice(row.payload); // JSON column arrives parsed
        const attempt = row.attempts + 1;
        if (res.ok) {
            await query(
                `UPDATE fbr_invoices SET
                   status = 'sent', fbr_invoice_number = ?, attempts = attempts + 1,
                   last_error = NULL, sent_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [res.fbrInvoiceNumber, row.id],
            );
            await query(
                'UPDATE orders SET fbr_invoice_number = ? WHERE id = ?',
                [res.fbrInvoiceNumber, row.order_id],
            );
            console.log(`[fbr-worker] sent ${row.usin} (attempt ${attempt}) -> ${res.fbrInvoiceNumber}`);
        } else {
            // MySQL applies SET left to right, so the IF() sees the incremented
            // attempts: the 20th failure is what flips the row to 'failed'.
            await query(
                `UPDATE fbr_invoices SET
                   attempts = attempts + 1, last_error = ?,
                   status = IF(attempts >= ?, 'failed', status)
                 WHERE id = ?`,
                [res.error, MAX_ATTEMPTS, row.id],
            );
            console.log(attempt >= MAX_ATTEMPTS
                ? `[fbr-worker] gave up on ${row.usin} after ${attempt} attempts: ${res.error}`
                : `[fbr-worker] retry ${row.usin} (attempt ${attempt}) failed: ${res.error}`);
        }
    }
};

console.log(`[fbr-worker] up — mode=${process.env.FBR_MODE || 'sandbox'} db=${process.env.DB_NAME}, ` +
    `every ${PASS_MS / 1000}s, batch ${BATCH}, max ${MAX_ATTEMPTS} attempts`);

while (!stopping) {
    try {
        await pass();
    } catch (e) {
        // One bad pass (DB restart, network blip) must not kill the loop.
        console.error('[fbr-worker] pass failed:', e?.message || e);
    }
    if (!stopping) await sleep(PASS_MS);
}

await pool.end();
console.log('[fbr-worker] pool closed, exiting');

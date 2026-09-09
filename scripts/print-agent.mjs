/*
 * The local print agent: a small service on the till's own machine that takes
 * a bill and writes it to a thermal printer as ESC/POS.
 *
 *   node scripts/print-agent.mjs
 *   node scripts/print-agent.mjs --device /dev/cu.XXX --width 58 --port 9110
 *
 * WHY THE TILL CANNOT JUST PRINT
 *
 * The browser prints by handing the operating system a picture of a page, so
 * the printer has to exist as a print queue. A Bluetooth pocket printer that
 * advertises no SDP printing record never becomes one on macOS — CUPS finds the
 * device and declines — and its serial link is far too slow to carry a
 * rasterised receipt anyway. This agent closes both gaps: the till POSTs an
 * order id, the agent renders the bill as text and writes it to the device.
 *
 * SHAPE, deliberately: it binds to 127.0.0.1 by default, so nothing off this
 * machine can make it print; it accepts an order id rather than arbitrary
 * bytes, so a stray request cannot drive the printer directly; and it renders
 * from the database, so the paper always says what the bill says.
 *
 * If it is not running, the till falls back to browser printing on its own.
 * Nothing here is required for a sale to complete.
 */
import { readFileSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { renderReceipt, asPlainText } from '../src/lib/print/escpos.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env.local', '.env.production']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
        ? process.argv[i + 1] : fallback;
};

const DEVICE = arg('device', process.env.PRINTER_DEVICE || '/dev/cu.BlueToothPrinter');
const PORT = Number(arg('port', process.env.PRINT_AGENT_PORT || 9110));
const HOST = arg('host', process.env.PRINT_AGENT_HOST || '127.0.0.1');
const WIDTH = Number(arg('width', process.env.PRINTER_WIDTH_MM || 0)) || null;

const { DB_NAME, DB_USER = 'root', DB_PASSWORD = '', DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET } = process.env;
if (!DB_NAME) { console.error('DB_NAME is not set.'); process.exit(1); }

const pool = mysql.createPool({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
    timezone: 'Z', decimalNumbers: true, connectionLimit: 2,
});
const q = async (sql, params = []) => (await pool.query(sql, params))[0];

/*
 * One job at a time. Two receipts written to the same serial port at once
 * interleave into confetti, and the printer has no way to tell us.
 */
/*
 * Writing to the device must not be able to hang forever.
 *
 * A serial write blocks until the printer accepts every byte, and a thermal
 * printer that is out of paper, asleep or out of Bluetooth range simply stops
 * accepting them. A synchronous write then never returns, the queue behind it
 * never drains, and the agent is wedged until somebody notices. The deadline
 * turns that into an error the till can fall back from.
 */
const WRITE_DEADLINE_MS = Number(process.env.PRINT_WRITE_TIMEOUT_MS || 15000);

const writeWithDeadline = async (payload) => {
    const handle = await open(DEVICE, 'w');
    let timer;
    try {
        await Promise.race([
            handle.write(Buffer.from(payload, 'binary')),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const e = new Error('The printer stopped accepting data — check paper, power and range');
                    e.status = 504;
                    reject(e);
                }, WRITE_DEADLINE_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        // Closing a device whose write is still stuck can itself block, so it
        // is not awaited — the handle goes when the process does.
        handle.close().catch(() => {});
    }
};

let queue = Promise.resolve();
const enqueue = (job) => {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
};

const printBill = async (orderRef, { reprint = false } = {}) => {
    const orders = await q(
        'SELECT * FROM orders WHERE id = ? OR order_number = ? LIMIT 1',
        [orderRef, orderRef],
    );
    if (!orders.length) { const e = new Error('No such bill'); e.status = 404; throw e; }
    const order = orders[0];
    const items = await q(
        'SELECT name, variant, qty, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY round_no, seq',
        [order.id],
    );
    const settings = (await q('SELECT * FROM store_settings LIMIT 1'))[0] || {};
    const widthMm = WIDTH || Number(settings.receipt_width_mm) || 58;
    const payload = renderReceipt({ order, items, settings, widthMm, reprint });

    if (!existsSync(DEVICE)) { const e = new Error(`No printer at ${DEVICE}`); e.status = 503; throw e; }
    await writeWithDeadline(payload);
    return { order: order.order_number, total: Number(order.total), widthMm, bytes: payload.length };
};

// Only the till's own pages may ask for a print. A page from anywhere else
// gets no CORS headers and its fetch never reaches the printer.
const ALLOWED = /^https?:\/\/(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)(:\d+)?$/;

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (origin && ALLOWED.test(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Headers'] = 'content-type';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }

    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/health') {
            res.writeHead(200, headers);
            return res.end(JSON.stringify({ ok: true, device: DEVICE, present: existsSync(DEVICE) }));
        }
        if (url.pathname === '/receipt' && req.method === 'POST') {
            const body = await new Promise((resolve, reject) => {
                let raw = '';
                req.on('data', (c) => {
                    raw += c;
                    if (raw.length > 4096) { req.destroy(); reject(new Error('Too large')); }
                });
                req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
                req.on('error', reject);
            });
            const ref = String(body.orderId ?? body.order ?? '').trim();
            if (!ref) { res.writeHead(400, headers); return res.end(JSON.stringify({ error: 'orderId is required' })); }
            const out = await enqueue(() => printBill(ref, { reprint: Boolean(body.reprint) }));
            console.log(`printed order ${out.order} (Rs. ${out.total}) at ${out.widthMm}mm, ${out.bytes} bytes`);
            res.writeHead(200, headers);
            return res.end(JSON.stringify({ printed: true, ...out }));
        }
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
        console.error('print failed:', e.message);
        res.writeHead(e.status || 500, headers);
        res.end(JSON.stringify({ error: e.message }));
    }
});

server.listen(PORT, HOST, () => {
    console.log(`print agent on http://${HOST}:${PORT}  ->  ${DEVICE}`);
    console.log(existsSync(DEVICE) ? 'printer is present' : `WARNING: nothing at ${DEVICE} yet`);
    console.log('  GET  /health');
    console.log('  POST /receipt   {"orderId": "<id or order number>", "reprint": false}');
});

process.on('SIGINT', () => { server.close(); pool.end(); process.exit(0); });

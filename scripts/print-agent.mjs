/*
 * The local print agent: a small service on the till's own machine that takes
 * a bill and writes it to a thermal printer as ESC/POS.
 *
 *   node scripts/print-agent.mjs --queue PrinterCMD_ESCPO_POS80_Printer_USB
 *   node scripts/print-agent.mjs --device /dev/cu.XXX --width 58 --port 9110
 *
 * A USB printer is a CUPS queue and needs --queue; a Bluetooth serial one is a
 * device file and needs --device. See "TWO TRANSPORTS" below.
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
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { renderReceiptJob, renderKotSlip, asPlainText, drawerKick } from '../src/lib/print/escpos.mjs';
import { buildKotSlips } from '../src/lib/kotPrint.js';

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

/*
 * TWO TRANSPORTS, because two kinds of thermal printer attach two ways.
 *
 * A Bluetooth serial unit appears as a character device and is written to
 * directly — that is what this agent was built for. A USB printer does not:
 * macOS claims it for CUPS and it appears as a PRINT QUEUE with no /dev entry
 * at all, so `open(DEVICE)` can only ever fail. Sending raw ESC/POS to a queue
 * is `lp -o raw`, which hands the bytes over unfiltered.
 *
 *   --queue 'PrinterCMD_ESCPO_POS80_Printer_USB'   (or PRINTER_QUEUE=)
 *   `lpstat -p` lists the names.
 *
 * The queue MUST be raw, or driven by a thermal PPD. A USB receipt printer
 * that macOS has bound to a generic laser driver will offer Letter and duplex,
 * and `-o raw` is what steps around that.
 */
const QUEUE = arg('queue', process.env.PRINTER_QUEUE || '') || null;
const TRANSPORT = QUEUE ? 'cups' : 'device';

/*
 * Is there a printer on the end of this queue, or only the queue?
 *
 * `lpstat -p` exits non-zero when the queue does not exist. That is the easy
 * half. The hard half is that a queue whose printer has been unplugged still
 * reports "is idle" — CUPS remembers the printer and says nothing — so an
 * existence check alone answers `present: true` to a bare cable.
 *
 * This matters beyond tidiness: the till gates on `present` (see
 * `thermalAgentReady`). Answering yes to an absent printer makes every print
 * stall for the full deadline before falling back to the browser, on every
 * bill, all evening. Once CUPS has tried and failed once it raises
 * `offline-report` on the Alerts line, and from then on we answer honestly and
 * the till goes straight to the browser.
 */
const queueExists = () => {
    if (!QUEUE) return false;
    const r = spawnSync('lpstat', ['-l', '-p', QUEUE], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    const out = String(r.stdout || '');
    return !/offline/i.test(out) && !/\bdisabled\b/i.test(out);
};

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
/*
 * KEEP THIS UNDER THE TILL'S OWN TIMEOUT (20s, `printReceiptViaAgent` in
 * src/lib/thermalAgent.js). The till must hear the failure from us and fall
 * back to browser printing; if it gives up first, it falls back anyway but
 * nobody ever learns why the paper did not come out.
 */
const WRITE_DEADLINE_MS = Number(process.env.PRINT_WRITE_TIMEOUT_MS || 15000);

/*
 * How long to wait for a spooled job to actually leave the queue, and how often
 * to look. A 935-byte receipt prints in about a second over USB.
 */
const POLL_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lpstat = (args) => spawnSync('lpstat', args, { encoding: 'utf8' });

/* Is this job still waiting? Once it prints, CUPS drops it from the list. */
const jobIsQueued = (jobId) => {
    const r = lpstat(['-W', 'not-completed', '-o', QUEUE]);
    return r.status === 0 && String(r.stdout || '').includes(jobId);
};

/*
 * Why a job did not go, in words a cashier can act on.
 *
 * `-l` is not optional here. A queue whose printer is absent still reports
 * "is idle" on the state line; the only place CUPS admits the truth is the
 * Alerts line, as `offline-report` (checked against this printer, 9 Sep 2026).
 */
const queueTrouble = () => {
    const out = String(lpstat(['-l', '-p', QUEUE]).stdout || '');
    if (/\bdisabled\b/i.test(out)) return 'the print queue is paused';
    if (/offline/i.test(out)) return 'the printer is offline — check its power and cable';
    return 'the printer did not take the job';
};

/* Hand the bytes to CUPS. Returns the job id it named, or null. */
const runLp = async (payload) => await new Promise((resolve, reject) => {
    const child = spawn('lp', ['-d', QUEUE, '-o', 'raw'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
        child.kill('SIGKILL');
        const e = new Error('the print system stopped responding');
        e.status = 504;
        reject(e);
    }, WRITE_DEADLINE_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
            const e = new Error(`lp exited ${code}${err.trim() ? `: ${err.trim()}` : ''}`);
            e.status = 502;
            return reject(e);
        }
        // "request id is PrinterCMD_ESCPO_POS80_Printer_USB-20 (1 file(s))"
        const m = out.match(/request id is (\S+)/);
        resolve(m ? m[1] : null);
    });
    // ESC/POS is bytes, not text: latin1 keeps every code point below 256
    // exactly as the renderer emitted it.
    child.stdin.end(Buffer.from(payload, 'binary'));
});

/*
 * The CUPS path. `lp -o raw` passes the bytes through unfiltered, so the ESC/POS
 * the renderer produced is what the printer receives.
 *
 * SPOOLING IS ONLY HALF THE JOB. `lp` returns as soon as the scheduler accepts
 * the file, not when paper comes out — measured 9 Sep 2026 with the printer
 * unplugged entirely: `lp` exited 0 in 58ms and this agent told the till the
 * bill was printed. A cashier who reads "printed" hands the customer nothing
 * and does not try again, which is the worst way for a receipt to fail.
 *
 * So we wait for the job to LEAVE the queue, which is the only evidence CUPS
 * offers that it really went. The serial transport gets this for free: a write
 * to a device blocks until the printer accepts the bytes.
 *
 * A job that misses the deadline is CANCELLED, not left behind. A bill still
 * sitting in the queue prints hours later, out of nowhere, the moment the
 * printer is next plugged in — by which time it is somebody else's table.
 */
const spoolToQueue = async (payload) => {
    const jobId = await runLp(payload);
    // lp took it but named no job: nothing to wait on, and no evidence to give.
    if (!jobId) return;

    const deadline = Date.now() + WRITE_DEADLINE_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_MS);
        if (!jobIsQueued(jobId)) return;
    }
    spawnSync('cancel', [jobId], { encoding: 'utf8' });
    const e = new Error(`The bill was not printed: ${queueTrouble()}.`);
    e.status = 504;
    throw e;
};

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
    // Customer copy then restaurant copy, each ending in its own cut. An older
    // settings row with no column prints the pair, which is the house practice.
    const copies = settings.receipt_copies == null ? 2 : Number(settings.receipt_copies);
    const payload = renderReceiptJob({ order, items, settings, widthMm, reprint, copies });

    if (TRANSPORT === 'cups') {
        await spoolToQueue(payload);
    } else {
        if (!existsSync(DEVICE)) { const e = new Error(`No printer at ${DEVICE}`); e.status = 503; throw e; }
        await writeWithDeadline(payload);
    }
    return {
        order: order.order_number, total: Number(order.total),
        widthMm, bytes: payload.length, via: TRANSPORT,
    };
};

/*
 * Kitchen tickets, rendered from the database exactly as the bill is.
 *
 * `round` prints only that round's lines (a round just fired); omitting it
 * prints the whole order, which is what a reprint from the KDS wants. The cut
 * is per slip — renderKotSlip ends each one — so the whole round goes as ONE
 * spooled job and the printer cuts between the sections itself. Spooling each
 * slip separately raced: CUPS interleaved two jobs and handed the runner a
 * shuffled pile.
 */
const printKot = async (orderRef, { round = null, reprint = false } = {}) => {
    const orders = await q(
        'SELECT * FROM orders WHERE id = ? OR order_number = ? LIMIT 1',
        [orderRef, orderRef],
    );
    if (!orders.length) { const e = new Error('No such order'); e.status = 404; throw e; }
    const order = orders[0];

    const params = [order.id];
    let sql = `SELECT round_no, menu_item_id, name, variant, modifiers, qty, notes
               FROM order_items WHERE order_id = ?`;
    if (round != null) { sql += ' AND round_no = ?'; params.push(Number(round)); }
    sql += ' ORDER BY round_no, seq';
    const lines = await q(sql, params);
    if (!lines.length) { const e = new Error('Nothing to print for that round'); e.status = 404; throw e; }

    // buildKotSlips resolves a line's station through menu_items.category_id,
    // so it needs the menu as well as the lines. Only the columns it reads.
    const menuItems = await q('SELECT id, category_id FROM menu_items');
    const categories = await q('SELECT id, name, sort_order FROM categories');

    const settings = (await q('SELECT * FROM store_settings LIMIT 1'))[0] || {};
    const widthMm = WIDTH || Number(settings.receipt_width_mm) || 58;

    // The line shape buildKotSlips expects: `id` is the menu item, and the
    // stored `modifiers`/`variant` spellings are the ones toSlipLine reads.
    const roundItems = lines.map((l) => ({
        id: l.menu_item_id,
        name: l.name,
        variant: l.variant,
        modifiers: l.modifiers,
        qty: Number(l.qty) || 1,
        notes: l.notes,
    }));

    const slips = buildKotSlips(settings.kot_mode, roundItems, menuItems, categories);
    const meta = {
        orderNumber: order.order_number,
        table: order.table_number,
        waiter: order.waiter_name,
        orderType: order.order_type,
        roundNo: round != null ? Number(round) : (order.round_count || 1),
        at: new Date(),
        reprint,
    };
    const payload = slips.map((slip) => renderKotSlip({ slip, meta, widthMm })).join('');

    if (TRANSPORT === 'cups') {
        await spoolToQueue(payload);
    } else {
        if (!existsSync(DEVICE)) { const e = new Error(`No printer at ${DEVICE}`); e.status = 503; throw e; }
        await writeWithDeadline(payload);
    }
    return {
        order: order.order_number, slips: slips.length, round: meta.roundNo,
        widthMm, bytes: payload.length, via: TRANSPORT,
    };
};

/*
 * Open the cash drawer.
 *
 * The drawer hangs off the printer, so this agent is the only thing on the
 * machine that can reach it, and the decision of WHETHER to open belongs here
 * rather than in the till: the till would have to know the payment mode, the
 * setting and the wiring, and every terminal would have to agree. It posts the
 * bill it just took money for and this answers.
 *
 * `force` is a person pressing "Open drawer" — an explicit act, so it obeys no
 * setting but the wiring. Everything else is judged from store_settings:
 * 'never' opens nothing, 'always' opens on any completed sale, and 'cash' —
 * the default — opens only when cash actually crossed the counter. A card or
 * city-ledger bill leaving the drawer shut is the whole point of the setting.
 *
 * Never fires for a reprint: the caller simply does not ask on one.
 */
const kickDrawer = async (orderRef = null, { force = false } = {}) => {
    const settings = (await q('SELECT * FROM store_settings LIMIT 1'))[0] || {};
    const mode = settings.drawer_kick == null ? 'cash' : String(settings.drawer_kick);

    if (!force) {
        if (mode === 'never') return { opened: false, reason: 'the drawer is set never to open on a sale' };
        if (mode !== 'always') {
            if (!orderRef) return { opened: false, reason: 'no bill given, and the drawer opens on cash sales only' };
            const rows = await q(
                'SELECT payment_mode FROM orders WHERE id = ? OR order_number = ? LIMIT 1',
                [orderRef, orderRef],
            );
            if (!rows.length) { const e = new Error('No such bill'); e.status = 404; throw e; }
            // A split bill is stored as payment rows, and one cash row among
            // them is still cash at the counter, so the drawer must open.
            const cashRows = await q(
                "SELECT 1 FROM payments WHERE order_id = (SELECT id FROM orders WHERE id = ? OR order_number = ? LIMIT 1) AND method = 'cash' LIMIT 1",
                [orderRef, orderRef],
            );
            const paidCash = rows[0].payment_mode === 'cash' || cashRows.length > 0;
            if (!paidCash) {
                return { opened: false, reason: `paid by ${rows[0].payment_mode || 'another mode'}` };
            }
        }
    }

    const payload = drawerKick(settings.drawer_pin);
    if (TRANSPORT === 'cups') {
        await spoolToQueue(payload);
    } else {
        if (!existsSync(DEVICE)) { const e = new Error(`No printer at ${DEVICE}`); e.status = 503; throw e; }
        await writeWithDeadline(payload);
    }
    return { opened: true, pin: Number(settings.drawer_pin) || 2, via: TRANSPORT };
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
            return res.end(JSON.stringify(TRANSPORT === 'cups'
                ? { ok: true, transport: 'cups', queue: QUEUE, present: queueExists() }
                : { ok: true, transport: 'device', device: DEVICE, present: existsSync(DEVICE) }));
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
        if (url.pathname === '/kot' && req.method === 'POST') {
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
            const out = await enqueue(() => printKot(ref, {
                // null, not undefined: an absent round means the whole order.
                round: body.round == null ? null : Number(body.round),
                reprint: Boolean(body.reprint),
            }));
            console.log(`printed ${out.slips} kitchen slip(s) for order ${out.order} round ${out.round}, ${out.bytes} bytes`);
            res.writeHead(200, headers);
            return res.end(JSON.stringify({ printed: true, ...out }));
        }
        if (url.pathname === '/drawer' && req.method === 'POST') {
            const body = await new Promise((resolve, reject) => {
                let raw = '';
                req.on('data', (c) => {
                    raw += c;
                    if (raw.length > 4096) { req.destroy(); reject(new Error('Too large')); }
                });
                req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
                req.on('error', reject);
            });
            const ref = String(body.orderId ?? body.order ?? '').trim() || null;
            const out = await enqueue(() => kickDrawer(ref, { force: Boolean(body.force) }));
            console.log(out.opened
                ? `opened the cash drawer${ref ? ` for order ${ref}` : ''} (pin ${out.pin})`
                : `cash drawer left shut: ${out.reason}`);
            res.writeHead(200, headers);
            return res.end(JSON.stringify(out));
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
    const target = TRANSPORT === 'cups' ? `cups queue "${QUEUE}"` : DEVICE;
    const present = TRANSPORT === 'cups' ? queueExists() : existsSync(DEVICE);
    console.log(`print agent on http://${HOST}:${PORT}  ->  ${target}`);
    console.log(present
        ? 'printer is present'
        : TRANSPORT === 'cups'
            ? `WARNING: ${queueTrouble()} — \`lpstat -l -p ${QUEUE}\` says why`
            : `WARNING: nothing at ${DEVICE} yet`);
    console.log('  GET  /health');
    console.log('  POST /receipt   {"orderId": "<id or order number>", "reprint": false}');
    console.log('  POST /kot       {"orderId": "<id or order number>", "round": null, "reprint": false}');
    console.log('  POST /drawer    {"orderId": "<id or order number>", "force": false}');
});

process.on('SIGINT', () => { server.close(); pool.end(); process.exit(0); });

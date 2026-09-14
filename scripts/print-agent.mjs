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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

const PORT = Number(arg('port', process.env.PRINT_AGENT_PORT || 9110));
const HOST = arg('host', process.env.PRINT_AGENT_HOST || '127.0.0.1');

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
/*
 * WHAT THIS AGENT IS FOR, not which printer it drives.
 *
 * It used to be started with the queue name in its launchd plist, so every
 * machine was set up at a shell prompt and a replaced printer — or a cable
 * moved to another USB port, which makes macOS rename the queue — silently
 * stopped the till until somebody edited a file. Now it is started with a
 * ROLE and looks the printer up in the `printers` table, which the Settings
 * screen writes. Change the printer there and the next bill prints on it.
 *
 * --queue and --device still work and still win: an escape hatch for a
 * machine being debugged, and how the tests drive this file.
 */
const ROLE = arg('role', process.env.PRINTER_ROLE || 'receipt');

/*
 * ONLY the command line overrides Settings — not the environment.
 *
 * PRINTER_QUEUE in .env.local was how this used to be configured, and leaving
 * it as an override would have been the same trap in a new coat: every machine
 * that still has the line would ignore the Settings screen forever, and the
 * screen would look broken while being right. So a stale env var is noted in
 * the log and otherwise disregarded; `--queue` typed by a person debugging
 * this minute still wins, which is what an escape hatch is for.
 */
const QUEUE = arg('queue', null);
const DEVICE_ARG = arg('device', null);
const OVERRIDE = QUEUE
    ? { transport: 'cups', target: QUEUE, source: 'command line' }
    : DEVICE_ARG
        ? { transport: 'device', target: DEVICE_ARG, source: 'command line' }
        : null;
if (!OVERRIDE && (process.env.PRINTER_QUEUE || process.env.PRINTER_DEVICE)) {
    console.log('note: PRINTER_QUEUE/PRINTER_DEVICE in the environment are ignored — the printer comes from Settings now');
}

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
const queueExists = (queue) => {
    if (!queue) return false;
    const r = spawnSync('lpstat', ['-l', '-p', queue], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    const out = String(r.stdout || '');
    return !/offline/i.test(out) && !/\bdisabled\b/i.test(out);
};

/*
 * Every printer this machine can see, and a guess at which one is thermal.
 *
 * The guess matters because the whole point is that nobody should have to type
 * a queue name: a counter has one receipt printer and its queue is called
 * something like PrinterCMD_ESCPO_POS80_Printer_USB or XP-58 or TM-T20. The
 * score is deliberately crude and never decides alone — it orders the list the
 * Settings screen shows, and it only auto-selects when there is exactly one
 * candidate and nothing has been configured yet.
 */
const THERMAL_HINT = /(pos|thermal|receipt|esc.?pos|tm-?t|rp-?\d|xp-?\d|srp|zj-?\d|58|80mm|gprinter|bixolon|epson)/i;

export const discoverPrinters = () => {
    const found = [];

    const lp = spawnSync('lpstat', ['-p'], { encoding: 'utf8' });
    for (const line of String(lp.stdout || '').split('\n')) {
        const m = line.match(/^printer\s+(\S+)/);
        if (!m) continue;
        found.push({
            transport: 'cups',
            target: m[1],
            label: m[1].replace(/_/g, ' '),
            likelyThermal: THERMAL_HINT.test(m[1]),
            present: !/offline|disabled/i.test(line),
        });
    }

    // Bluetooth and USB-serial printers never become queues; they are device
    // files, and the name is the only clue there is.
    try {
        for (const name of readdirSync('/dev')) {
            if (!/^cu\./.test(name)) continue;
            if (!/print|thermal|pos|serial|bt/i.test(name)) continue;
            found.push({
                transport: 'device',
                target: `/dev/${name}`,
                label: name,
                likelyThermal: true,
                present: true,
            });
        }
    } catch { /* no /dev worth reading */ }

    return found.sort((a, b) => Number(b.likelyThermal) - Number(a.likelyThermal));
};

/*
 * WHICH PRINTER, right now.
 *
 * In order: an explicit --queue/--device (debugging, and how the tests drive
 * this); then the row the Settings screen wrote for this role; then, if
 * nothing is configured at all, a single obvious thermal printer on this
 * machine — which is the case on a counter with one printer plugged in, and
 * the reason a fresh install prints without anybody configuring anything.
 *
 * Resolved per print rather than at boot, so changing the printer on Settings
 * takes effect on the next bill with nothing restarted. The DB read is one
 * indexed row against a pool the agent already holds open.
 */
const DEFAULT_PROFILE = { widthMm: 80, cut: 'full', feedLines: 6, codepage: 0, drawerPin: 2 };

const resolveTarget = async () => {
    if (OVERRIDE) return { ...DEFAULT_PROFILE, ...OVERRIDE, label: OVERRIDE.target };

    const rows = await q(
        `SELECT label, transport, target, width_mm, cut_mode, feed_lines, codepage, drawer_pin
           FROM printers WHERE role = ? AND is_active = 1 LIMIT 1`,
        [ROLE],
    );
    if (rows.length) {
        const r = rows[0];
        return {
            transport: r.transport === 'device' ? 'device' : 'cups',
            target: r.target,
            label: r.label,
            widthMm: Number(r.width_mm) || 80,
            cut: r.cut_mode,
            feedLines: Number(r.feed_lines),
            codepage: Number(r.codepage),
            drawerPin: Number(r.drawer_pin) || 2,
            source: 'settings',
        };
    }

    // Nothing configured. One obvious thermal printer is not a guess worth
    // refusing to make; two is, and then the Settings screen has to ask.
    const candidates = discoverPrinters().filter((p) => p.likelyThermal && p.present);
    if (candidates.length === 1) {
        return { ...DEFAULT_PROFILE, ...candidates[0], source: 'found on this machine' };
    }
    return null;
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
const jobIsQueued = (jobId, queue) => {
    const r = lpstat(['-W', 'not-completed', '-o', queue]);
    return r.status === 0 && String(r.stdout || '').includes(jobId);
};

/*
 * Why a job did not go, in words a cashier can act on.
 *
 * `-l` is not optional here. A queue whose printer is absent still reports
 * "is idle" on the state line; the only place CUPS admits the truth is the
 * Alerts line, as `offline-report` (checked against this printer, 9 Sep 2026).
 */
const queueTrouble = (queue) => {
    const out = String(lpstat(['-l', '-p', queue]).stdout || '');
    if (/\bdisabled\b/i.test(out)) return 'the print queue is paused';
    if (/offline/i.test(out)) return 'the printer is offline — check its power and cable';
    return 'the printer did not take the job';
};

/* Hand the bytes to CUPS. Returns the job id it named, or null. */
const runLp = async (payload, queue) => await new Promise((resolve, reject) => {
    const child = spawn('lp', ['-d', queue, '-o', 'raw'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
const spoolToQueue = async (payload, queue) => {
    const jobId = await runLp(payload, queue);
    // lp took it but named no job: nothing to wait on, and no evidence to give.
    if (!jobId) return;

    const deadline = Date.now() + WRITE_DEADLINE_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_MS);
        if (!jobIsQueued(jobId, queue)) return;
    }
    spawnSync('cancel', [jobId], { encoding: 'utf8' });
    const e = new Error(`The bill was not printed: ${queueTrouble(queue)}.`);
    e.status = 504;
    throw e;
};

const writeWithDeadline = async (payload, device) => {
    const handle = await open(device, 'w');
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

/*
 * Hand the bytes to whatever this role's printer turns out to be. Every path
 * that prints goes through here, so "which printer" is answered once.
 */
const sendBytes = async (payload, printer) => {
    if (!printer) {
        const e = new Error('No printer is set up for this terminal — pick one under Settings, Kitchen & Printer');
        e.status = 503;
        throw e;
    }
    if (printer.transport === 'cups') {
        await spoolToQueue(payload, printer.target);
        return;
    }
    if (!existsSync(printer.target)) {
        const e = new Error(`No printer at ${printer.target}`);
        e.status = 503;
        throw e;
    }
    await writeWithDeadline(payload, printer.target);
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
    // The card slip's reference lives on the payment, not the order — it is a
    // fact about the tender — so the bill picks it up here rather than the
    // renderer going looking for it.
    const [card] = await q(
        "SELECT reference FROM payments WHERE order_id = ? AND method = 'card' AND reference IS NOT NULL LIMIT 1",
        [order.id],
    );
    if (card?.reference) order.card_reference = card.reference;
    const printer = await resolveTarget();
    // The printer's own width wins over the store-wide one: paper is a fact
    // about the machine, not about the shop.
    const widthMm = printer?.widthMm || Number(settings.receipt_width_mm) || 58;
    // Customer copy then restaurant copy, each ending in its own cut. An older
    // settings row with no column prints the pair, which is the house practice.
    const copies = settings.receipt_copies == null ? 2 : Number(settings.receipt_copies);
    const payload = renderReceiptJob({ order, items, settings, widthMm, reprint, copies, profile: printer ?? {} });

    await sendBytes(payload, printer);
    return {
        order: order.order_number, total: Number(order.total),
        widthMm, bytes: payload.length, via: printer.transport, printer: printer.label,
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
    const printer = await resolveTarget();
    const widthMm = printer?.widthMm || Number(settings.receipt_width_mm) || 58;

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
        tokenNo: order.token_no,
        table: order.table_number,
        waiter: order.waiter_name,
        orderType: order.order_type,
        roundNo: round != null ? Number(round) : (order.round_count || 1),
        at: new Date(),
        reprint,
    };
    const payload = slips
        .map((slip) => renderKotSlip({ slip, meta, widthMm, settings, profile: printer ?? {} }))
        .join('');

    await sendBytes(payload, printer);
    return {
        order: order.order_number, slips: slips.length, round: meta.roundNo,
        widthMm, bytes: payload.length, via: printer.transport, printer: printer.label,
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

    // The pin belongs to the printer the drawer is plugged into, not to the
    // shop — a second till with a different printer can be wired differently.
    const printer = await resolveTarget();
    const pin = Number(printer?.drawerPin) || Number(settings.drawer_pin) || 2;
    await sendBytes(drawerKick(pin), printer);
    return { opened: true, pin, via: printer.transport };
};

/*
 * The test page: enough to tell whether this printer is set up right without
 * ringing a sale. The width line is the one that matters — if the rule runs
 * off the paper the width is wrong, and if it stops short the paper is wider
 * than the setting says.
 */
const renderTestPage = (printer) => {
    const p = printer ?? DEFAULT_PROFILE;
    const cols = p.widthMm >= 80 ? 48 : 32;
    let out = `${'\x1b'}@`;
    out += `${'\x1b'}a\x01${'\x1b'}!\x30Test print\n${'\x1b'}!\x00`;
    out += `${'\x1b'}a\x00`;
    out += `${'-'.repeat(cols)}\n`;
    out += `Printer : ${p.label ?? p.target}\n`;
    out += `Reached : ${p.transport === 'cups' ? 'print queue' : 'device'}\n`;
    out += `Set by  : ${p.source ?? 'default'}\n`;
    out += `Width   : ${p.widthMm}mm (${cols} characters)\n`;
    out += `Cut     : ${p.cut}\n`;
    out += `Drawer  : pin ${p.drawerPin}\n`;
    out += `${'-'.repeat(cols)}\n`;
    out += 'If this line reaches the edge of the paper\nand no further, the width is right.\n';
    out += `${'\x1b'}d${String.fromCharCode(p.feedLines ?? 6)}`;
    out += p.cut === 'none' ? '' : `${'\x1d'}V${p.cut === 'partial' ? '\x01' : '\x00'}`;
    return out;
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
            const printer = await resolveTarget();
            const present = !printer ? false
                : printer.transport === 'cups' ? queueExists(printer.target) : existsSync(printer.target);
            res.writeHead(200, headers);
            return res.end(JSON.stringify({
                ok: true,
                role: ROLE,
                transport: printer?.transport ?? null,
                // Both spellings, because the till has read `queue`/`device`
                // since before printers were rows and a stale tab must not
                // start reading `undefined`.
                queue: printer?.transport === 'cups' ? printer.target : undefined,
                device: printer?.transport === 'device' ? printer.target : undefined,
                printer: printer?.label ?? null,
                configuredBy: printer?.source ?? null,
                present,
            }));
        }

        /*
         * Every printer this machine can see. The Settings screen calls this
         * so the owner picks from a list instead of typing a queue name — the
         * whole point of the exercise.
         */
        if (url.pathname === '/printers') {
            const printer = await resolveTarget();
            res.writeHead(200, headers);
            return res.end(JSON.stringify({
                role: ROLE,
                current: printer,
                available: discoverPrinters(),
            }));
        }

        /*
         * A page of paper that proves it. Prints the profile it printed with,
         * so an odd result reads as "this is the width and cut it used" rather
         * than as a mystery.
         */
        if (url.pathname === '/test' && req.method === 'POST') {
            const printer = await resolveTarget();
            const out = await enqueue(async () => {
                const payload = renderTestPage(printer);
                await sendBytes(payload, printer);
                return { printed: true, printer: printer.label, via: printer.transport };
            });
            console.log(`test page on ${out.printer}`);
            res.writeHead(200, headers);
            return res.end(JSON.stringify(out));
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

server.listen(PORT, HOST, async () => {
    console.log(`print agent on http://${HOST}:${PORT}  —  role: ${ROLE}`);
    try {
        const printer = await resolveTarget();
        if (!printer) {
            const seen = discoverPrinters();
            console.log('no printer set up for this role yet.');
            console.log(seen.length
                ? `this machine can see: ${seen.map((x) => x.target).join(', ')} — pick one under Settings, Kitchen & Printer`
                : 'and this machine can see none at all — plug one in, or check `lpstat -p`');
        } else {
            const present = printer.transport === 'cups'
                ? queueExists(printer.target) : existsSync(printer.target);
            console.log(`printing to ${printer.label} (${printer.target}), ${printer.source}`);
            console.log(present
                ? `printer is present — ${printer.widthMm}mm, cut ${printer.cut}`
                : printer.transport === 'cups'
                    ? `WARNING: ${queueTrouble(printer.target)}`
                    : `WARNING: nothing at ${printer.target} yet`);
        }
    } catch (e) {
        console.error('could not work out which printer to use:', e?.message ?? e);
    }
    console.log('  GET  /health');
    console.log('  GET  /printers');
    console.log('  POST /test');
    console.log('  POST /receipt   {"orderId": "<id or order number>", "reprint": false}');
    console.log('  POST /kot       {"orderId": "<id or order number>", "round": null, "reprint": false}');
    console.log('  POST /drawer    {"orderId": "<id or order number>", "force": false}');
});

process.on('SIGINT', () => { server.close(); pool.end(); process.exit(0); });

/*
 * Prints a real bill straight to a serial/Bluetooth thermal printer as ESC/POS.
 *
 *   node scripts/print-thermal.mjs                      # newest paid bill, 58mm
 *   node scripts/print-thermal.mjs --width 80           # 80mm paper
 *   node scripts/print-thermal.mjs --order <id|number>  # a specific bill
 *   node scripts/print-thermal.mjs --device /dev/cu.XXX # a different printer
 *   node scripts/print-thermal.mjs --dry                # print to the terminal
 *
 * WHY THIS EXISTS, and what it is not.
 *
 * The app prints through the BROWSER: it renders the receipt as a picture of a
 * page and hands it to the operating system, which needs the printer to exist
 * as a normal print queue. A Bluetooth pocket printer that advertises no SDP
 * printing record cannot become one on macOS — `/usr/libexec/cups/backend/
 * bluetooth` finds the device and then says "No SDP record", so no queue is
 * ever created and the browser has nothing to print to.
 *
 * The printer is still perfectly reachable: macOS exposes it as a serial port
 * (/dev/cu.BlueToothPrinter), and ESC/POS bytes written there print. So this
 * script is the bench test — it proves the printer, the paper width and the
 * bill layout without involving the browser at all. It is a DIAGNOSTIC, not
 * the till's print path: it does not know about the KOT slips, the QR codes or
 * the FBR block, and it is not wired into a sale.
 *
 * If the restaurant settles on Bluetooth printers rather than a USB or network
 * one at the counter, turning this into a real print path is its own piece of
 * work — a local agent the till posts to. Note it, do not assume it.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env.local', '.env.production']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
        ? process.argv[i + 1] : fallback;
};
const DRY = process.argv.includes('--dry');
const DEVICE = arg('device', '/dev/cu.BlueToothPrinter');
const WIDTH_MM = Number(arg('width', 58));
// Font A is 12 dots wide. 58mm paper prints 384 dots, 80mm prints 576.
const COLS = WIDTH_MM >= 80 ? 48 : 32;

const ESC = '\x1b', GS = '\x1d';
const INIT = `${ESC}@`;
const CENTER = `${ESC}a\x01`, LEFT = `${ESC}a\x00`;
const BIG = `${ESC}!\x30`, NORMAL = `${ESC}!\x00`, BOLD = `${ESC}E\x01`, UNBOLD = `${ESC}E\x00`;
const CUT = `${GS}V\x00`;

const rule = (ch = '-') => ch.repeat(COLS);
const money = (n) => (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });

/* Left text and right text on one line, padded to the paper's width. A name
 * longer than the space left over is wrapped, never truncated — a customer has
 * to be able to read what they were charged for. */
const row = (left, right) => {
    const r = String(right);
    const space = COLS - r.length - 1;
    const words = String(left).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
        if ((cur + (cur ? ' ' : '') + w).length > space) { if (cur) lines.push(cur); cur = w; }
        else cur += (cur ? ' ' : '') + w;
    }
    lines.push(cur);
    return lines
        .map((l, i) => (i === lines.length - 1 ? l.padEnd(space + 1) + r : l))
        .join('\n');
};

const {
    DB_NAME, DB_USER = 'root', DB_PASSWORD = '',
    DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET,
} = process.env;
if (!DB_NAME) { console.error('DB_NAME is not set.'); process.exit(1); }

const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER, password: DB_PASSWORD, database: DB_NAME, timezone: 'Z', decimalNumbers: true,
});

const wanted = arg('order');
const [orders] = await conn.query(
    wanted
        ? 'SELECT * FROM orders WHERE id = ? OR order_number = ? LIMIT 1'
        : `SELECT * FROM orders WHERE payment_status = 'paid' ORDER BY created_at DESC LIMIT 1`,
    wanted ? [wanted, wanted] : [],
);
if (!orders.length) { console.error('No such bill.'); await conn.end(); process.exit(1); }
const o = orders[0];
const [items] = await conn.query(
    'SELECT name, variant, qty, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY round_no, seq',
    [o.id],
);
const [[settings]] = await conn.query('SELECT * FROM store_settings LIMIT 1');
await conn.end();

const at = new Date(o.paid_at || o.created_at);
const stamp = at.toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
});
const rate = o.tax_rate != null ? `${Number((Number(o.tax_rate) * 100).toFixed(2))}%` : '';

let out = INIT + CENTER + BIG + `${settings?.merchant_name || 'Flames by the Indus'}\n` + NORMAL;
out += `${settings?.merchant_city || 'Islamabad'}\n`;
if (o.invoice_number) out += `Invoice: ${o.invoice_number}\n`;
out += LEFT + rule() + '\n';
out += `${stamp}\n`;
out += `Order #${o.order_number}${o.table_number ? `  Table ${o.table_number}` : ''}\n`;
if (o.waiter_name) out += `Served by ${o.waiter_name}\n`;
out += rule() + '\n';
for (const it of items) {
    const name = `${it.qty} x ${it.name}${it.variant ? ` (${it.variant})` : ''}`;
    out += row(name, money(it.line_total)) + '\n';
}
out += rule() + '\n';
out += row('Sub Total', `Rs. ${money(o.subtotal)}`) + '\n';
if (Number(o.discount) > 0) out += row('Discount', `- Rs. ${money(o.discount)}`) + '\n';
if (Number(o.tax) > 0) out += row(`${settings?.tax_label || 'GST'}${rate ? ` (${rate})` : ''}`, `Rs. ${money(o.tax)}`) + '\n';
out += BOLD + row('TOTAL', `Rs. ${money(o.total)}`) + UNBOLD + '\n';
out += rule() + '\n';
out += CENTER + 'Thank you for dining with us!\n' + LEFT;
out += '\n\n\n' + CUT;

if (DRY) {
    console.log(out.replace(/\x1b[!aE].|\x1d V?.|\x1b@/g, '').replace(/\x1dV./g, ''));
    console.log(`\n[dry run] ${COLS} columns for ${WIDTH_MM}mm paper, order ${o.order_number}`);
} else {
    if (!existsSync(DEVICE)) {
        console.error(`No printer at ${DEVICE}. Paired Bluetooth printers appear as /dev/cu.* — list them with: ls /dev/cu.*`);
        process.exit(1);
    }
    writeFileSync(DEVICE, out, 'binary');
    console.log(`Printed order ${o.order_number} (Rs. ${money(o.total)}) to ${DEVICE} at ${WIDTH_MM}mm / ${COLS} columns.`);
}

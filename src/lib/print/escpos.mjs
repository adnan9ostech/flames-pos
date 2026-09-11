/*
 * A bill as ESC/POS text, for a thermal printer reached directly rather than
 * through the browser.
 *
 * WHY THIS EXISTS ALONGSIDE THE BROWSER PATH
 *
 * The till normally prints by rendering the receipt as a picture of a page and
 * handing it to the operating system, which needs the printer to exist as a
 * print queue. Measured on the restaurant's own Black Copper Bluetooth printer
 * (3 Sep 2026), that route is closed twice over on macOS: the printer
 * advertises no SDP printing record, so CUPS refuses to build a queue for it at
 * all; and the Bluetooth serial link is slow enough that a rasterised receipt —
 * tens of kilobytes — takes the better part of a minute, against under a
 * kilobyte for the same bill as text.
 *
 * So this module renders the bill as characters, which is what a thermal
 * printer wants anyway: sharper, instant, and it can cut its own paper.
 *
 * Plain Node, no imports: the print agent, the bench script and a test can all
 * load it. It takes plain data and returns a string — it does not know where
 * the data came from and it does not touch a device.
 */

// The one import, and it is generated data rather than behaviour: the receipt
// logo as packed bits (scripts/print/make-logo.mjs). Keeping it out of here
// means this module still needs no image toolchain to print a header.
import { RECEIPT_LOGO } from './logo.mjs';

const ESC = '\x1b';
const GS = '\x1d';

export const CMD = {
    init: `${ESC}@`,
    center: `${ESC}a\x01`,
    left: `${ESC}a\x00`,
    big: `${ESC}!\x30`,
    normal: `${ESC}!\x00`,
    bold: `${ESC}E\x01`,
    unbold: `${ESC}E\x00`,
    cut: `${GS}V\x00`,
};

/*
 * Open the cash drawer (ESC p m t1 t2).
 *
 * The drawer has no cable to the till: it plugs into the PRINTER's RJ11 port,
 * and this pulse is the only thing that opens it. `m` picks the pin the pulse
 * goes to (0 = pin 2, the usual wiring; 1 = pin 5), and t1/t2 are the on and
 * off times in 2ms units — 25 and 250 is the range every drawer solenoid in
 * this class is specified for, long enough to throw the latch and short enough
 * not to cook the coil.
 *
 * Sent as its own tiny job rather than tacked onto the receipt, so the drawer
 * still opens on a sale that printed nothing (auto-print off, roll out), and
 * so one reprint of an old bill can never fire the cash drawer.
 */
export const drawerKick = (pin = 2) =>
    `${ESC}p${Number(pin) === 5 ? '\x01' : '\x00'}\x19\xfa`;

/*
 * Print and feed n lines (ESC d n).
 *
 * Bare newlines feed paper too, but they are not enough at the end of a bill:
 * on a POS80 the print head sits roughly 15-20mm BEFORE the cutter — four to
 * five lines of paper — so the last thing printed is still under the head when
 * the cut fires. Cut there and the blade lands in the middle of the tail: the
 * receipt comes off looking cropped and unfinished, and the missing lines are
 * left inside the printer to appear at the top of the NEXT bill.
 *
 * So the tail is advanced past the blade explicitly before cutting.
 */
export const feed = (n) =>
    `${ESC}d${String.fromCharCode(Math.max(0, Math.min(255, Math.round(n))))}`;

// Lines of paper pushed out after the last printed line, before the cut.
// Six covers the head-to-cutter gap on an 80mm counter printer with a little
// margin, and costs a couple of centimetres of roll.
export const TAIL_FEED = 6;

/*
 * Rows of the logo per `GS v 0` command. See renderLogo: the printer's raster
 * buffer cannot swallow the whole image at once, and the overflow comes out as
 * text rather than as a short picture.
 */
export const BAND_ROWS = 24;

/*
 * The logo, as a raster the printer draws dot for dot (`GS v 0`).
 *
 * The header used to be the merchant's NAME set in double-size text, which is
 * a typeface the printer happens to own — not the restaurant's mark. This
 * sends the actual artwork: mode 0, then bytes-per-row and row-count as
 * little-endian pairs, then the packed rows straight from logo.mjs (which
 * stores them in exactly this order, so nothing is repacked here).
 *
 * Returns '' when there is no bitmap for this paper, and renderReceipt then
 * falls back to the text header — a missing logo must never cost a bill.
 */
export const renderLogo = (widthMm) => {
    const bmp = RECEIPT_LOGO?.[Number(widthMm) >= 80 ? '80' : '58'];
    if (!bmp?.data || !bmp.width || !bmp.height) return '';

    const bytesPerRow = bmp.width / 8;
    if (!Number.isInteger(bytesPerRow)) return '';

    const pair = (n) => String.fromCharCode(n & 0xff, (n >> 8) & 0xff);
    // atob, not Buffer: this module is plain ECMAScript and runs wherever the
    // renderer is imported. The decoded string is one character per byte, and
    // the agent writes it with latin1, so every value below 256 survives.
    const rows = atob(bmp.data);

    /*
     * SENT IN STRIPS, and this is not an optimisation — the logo does not print
     * without it.
     *
     * This printer takes a `GS v 0` of about a kilobyte happily: a 512-dot
     * solid bar 16 rows tall printed as a clean black rectangle at every width
     * tried. Hand it the whole 512x148 logo in ONE command — 9.5 KB — and its
     * raster buffer gives up partway, and it prints the remaining bytes as
     * TEXT: pages of random characters. Splitting the identical bytes into
     * 24-row strips prints perfectly (proven on the hardware, 10 Sep 2026).
     *
     * Each strip is a complete raster command, and the printer stacks them with
     * no gap, so the seams are invisible. Keep BAND_ROWS small enough that a
     * strip stays near a kilobyte: at 64 bytes per row, 24 rows is ~1.5 KB.
     *
     * LEFT, not centre: the bitmap is already the full paper width with the
     * artwork centred in white inside it, so it starts at dot 0 and the printer
     * has no offset to compute. Asking it to centre as well shifts the rows
     * byte-wise, and a logo whose margin is not a whole number of bytes then
     * smears — which is what a 408-dot centred logo did.
     */
    let out = CMD.left;
    for (let y = 0; y < bmp.height; y += BAND_ROWS) {
        const h = Math.min(BAND_ROWS, bmp.height - y);
        out += `${GS}v0\x00` + pair(bytesPerRow) + pair(h)
            + rows.slice(y * bytesPerRow, (y + h) * bytesPerRow);
    }
    return out;
};

/*
 * Characters across the paper, in Font A (12 dots wide): 58mm paper prints 384
 * dots and 80mm prints 576. Anything unrecognised is treated as the narrow
 * roll, because a bill laid out too wide loses its right-hand column while one
 * laid out too narrow merely looks airy.
 */
export const columnsFor = (widthMm) => (Number(widthMm) >= 80 ? 48 : 32);

export const rule = (cols, ch = '-') => ch.repeat(cols);

const rupees = (n) => (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });

/*
 * A label on the left and a figure on the right, filling the width.
 *
 * A label too long for the space left over WRAPS rather than truncating, and
 * the figure sits against the last line: a customer has to be able to read
 * what they were charged for, and "Chicken Cheese Seekh Ke" is a support call.
 */
export const row = (left, right, cols) => {
    const r = String(right ?? '');
    const space = Math.max(1, cols - r.length - 1);
    const lines = [];
    let cur = '';
    for (const word of String(left ?? '').split(/\s+/).filter(Boolean)) {
        if (cur && (`${cur} ${word}`).length > space) { lines.push(cur); cur = word; }
        else cur = cur ? `${cur} ${word}` : word;
        // A single word longer than the column is broken rather than pushing
        // the figure off the paper.
        while (cur.length > space) { lines.push(cur.slice(0, space)); cur = cur.slice(space); }
    }
    if (cur || !lines.length) lines.push(cur);
    return lines
        .map((l, i) => (i === lines.length - 1 ? l.padEnd(space + 1) + r : l))
        .join('\n');
};

/*
 * A line's label: the dish, and its size when the name does not already say it.
 *
 * The till's modifier modal composes the cart line's name as
 * `Beef Seekh Kebab (12 pieces)` AND passes the variant separately, so
 * `order_items` stores the size twice over — once inside `name`, once in
 * `variant`. Appending it blindly printed "Beef Seekh Kebab (12 pieces) (12
 * pieces)", which wrapped onto a second line and looked like a bug on the
 * customer's copy, because it was one. Found on a bench render, 9 Sep 2026.
 *
 * The test is for the PARENTHESISED form the modal writes, not for the bare
 * word: a "Chicken Handi" whose size is genuinely called "Handi" must still
 * get its size printed.
 */
export const lineLabel = (name, variant) => {
    const n = String(name ?? '').trim();
    const v = String(variant ?? '').trim();
    if (!v) return n;
    return n.toLowerCase().includes(`(${v.toLowerCase()})`) ? n : `${n} (${v})`;
};

/* The Karachi wall-clock stamp the bill carries. */
export const stampOf = (value) => new Date(value).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/*
 * The bill. `order` and `items` are rows as stored; `settings` is the
 * store_settings row. Nothing here reads a database or a device.
 */
export const renderReceipt = ({ order, items = [], settings = {}, widthMm = 58, reprint = false, copyLabel = null }) => {
    const cols = columnsFor(widthMm);
    const line = rule(cols);
    const r = (l, right) => `${row(l, right, cols)}\n`;

    const rate = order.tax_rate != null
        ? `${Number((Number(order.tax_rate) * 100).toFixed(2))}%`
        : '';

    let out = CMD.init;
    // The mark itself when we have it for this paper; the name in big text is
    // the fallback, which is what every bill used to print.
    const logo = renderLogo(widthMm);
    out += logo
        ? logo + '\n'
        : CMD.center + CMD.big + `${settings.merchant_name || 'Flames by the Indus'}\n` + CMD.normal;
    // The full street address when there is one; the bare city is the fallback
    // (merchant_city stays short because the Raast QR caps it at 15 chars).
    out += CMD.center + `${settings.merchant_address || settings.merchant_city || 'Islamabad'}\n`;
    // The number a customer rings about a delivery or a missing item, so it
    // belongs on their copy rather than only on the website.
    if (settings.merchant_phone) out += `Phone: ${settings.merchant_phone}\n`;
    if (order.invoice_number) out += `Invoice: ${order.invoice_number}\n`;
    if (order.fbr_invoice_number) out += `FBR: ${order.fbr_invoice_number}\n`;
    if (reprint) out += CMD.bold + 'REPRINT - COPY OF ORIGINAL\n' + CMD.unbold;
    out += CMD.left + line + '\n';

    out += `${stampOf(order.paid_at || order.created_at)}\n`;
    out += `Order #${order.order_number}${order.table_number ? `  Table ${order.table_number}` : ''}\n`;
    if (order.waiter_name) out += `Served by ${order.waiter_name}\n`;
    out += line + '\n';

    for (const it of items) {
        const name = `${it.qty} x ${lineLabel(it.name, it.variant)}`;
        out += r(name, rupees(it.line_total));
    }
    out += line + '\n';

    out += r('Sub Total', `Rs. ${rupees(order.subtotal)}`);
    if (Number(order.discount) > 0) out += r('Discount', `- Rs. ${rupees(order.discount)}`);
    for (const c of Array.isArray(order.charges) ? order.charges : []) {
        out += r(c.name, `Rs. ${rupees(c.amount)}`);
    }
    if (Number(order.tax) > 0) {
        out += r(`${settings.tax_label || 'GST'}${rate ? ` (${rate})` : ''}`, `Rs. ${rupees(order.tax)}`);
    }
    out += CMD.bold + row('TOTAL', `Rs. ${rupees(order.total)}`, cols) + CMD.unbold + '\n';

    /*
     * The cash tender, below the total and only when there was one.
     *
     * On paper this settles the argument that starts a minute after the
     * customer has walked away: what they handed over and what went back are
     * on the receipt in their hand and on the restaurant's copy in the drawer.
     * A card or city-ledger bill has neither line, because it has neither
     * fact — printing "Change Rs. 0" there would be a claim about money that
     * never crossed the counter.
     */
    if (order.cash_received != null) {
        out += r('Cash', `Rs. ${rupees(order.cash_received)}`);
        out += CMD.bold + row('Change', `Rs. ${rupees(order.change_due || 0)}`, cols) + CMD.unbold + '\n';
    }

    out += line + '\n';

    out += CMD.center + 'Thank you for dining with us!\n';
    // Which copy this is, last thing on the slip: the pair comes off the roll
    // one after the other, and the label sits right by the tear so it is what
    // the cashier sees as they separate them.
    if (copyLabel) out += CMD.bold + `*** ${copyLabel} ***\n` + CMD.unbold;
    out += CMD.left + feed(TAIL_FEED) + CMD.cut;
    return out;
};

/* The two copies a sale prints, in the order they come off the roll. */
export const COPY_LABELS = ['CUSTOMER COPY', 'RESTAURANT COPY'];

/*
 * A whole print job: the bill once per copy.
 *
 * The cut BETWEEN the copies is not special-cased — renderReceipt already ends
 * every bill with feed-then-cut, so two of them back to back come off the roll
 * as two separated slips with nothing to tear by hand. That is also why the
 * copies are concatenated rather than joined with a separator: inserting one
 * would put a second cut between them and eject a blank stub.
 *
 * One copy is still a labelled copy: a reprint that says CUSTOMER COPY is
 * clearer than an unlabelled one, and it keeps the two paths identical.
 */
export const renderReceiptJob = ({ copies = 2, ...args }) => {
    const n = Math.min(Math.max(Math.round(Number(copies) || 1), 1), COPY_LABELS.length);
    return COPY_LABELS.slice(0, n)
        .map((copyLabel) => renderReceipt({ ...args, copyLabel }))
        .join('');
};

/* One kitchen slip: a station's lines from one round. Never shows a price. */
export const renderKotSlip = ({ slip, meta = {}, widthMm = 58 }) => {
    const cols = columnsFor(widthMm);
    let out = CMD.init + CMD.center + CMD.big + `${slip.categoryName}\n` + CMD.normal;
    out += CMD.left + rule(cols) + '\n';
    out += `Order #${meta.orderNumber ?? ''}${meta.table ? `  Table ${meta.table}` : ''}\n`;
    if (meta.waiter) out += `${meta.waiter}\n`;
    out += `${meta.orderType || ''}${meta.roundNo ? `  Round ${meta.roundNo}` : ''}\n`;
    if (meta.at) out += `${stampOf(meta.at)}\n`;
    out += rule(cols) + '\n';
    for (const it of slip.items || []) {
        out += CMD.bold + `${it.qty} x ${lineLabel(it.name, it.variant)}\n` + CMD.unbold;
        if (it.modifiers) out += `    ${it.modifiers}\n`;
        if (it.notes) out += `    ** ${it.notes}\n`;
    }
    out += rule(cols) + '\n' + feed(TAIL_FEED) + CMD.cut;
    return out;
};

/*
 * A raster block is not a control code with a fixed length — it is a header
 * followed by however many bytes the header declares, and those bytes are
 * arbitrary. A regex cannot skip it (the image data happily contains 0x1b and
 * 0x1d itself), so the block is measured and stepped over, leaving a marker in
 * its place. Everything after it stays aligned; a regex-only strip would have
 * dumped a screenful of binary into the terminal.
 */
const stripRasters = (s) => {
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s[i] === '\x1d' && s[i + 1] === 'v' && s[i + 2] === '0') {
            const bytesPerRow = s.charCodeAt(i + 4) | (s.charCodeAt(i + 5) << 8);
            const rows = s.charCodeAt(i + 6) | (s.charCodeAt(i + 7) << 8);
            i += 8 + bytesPerRow * rows;
            out += '[logo]\n';
            continue;
        }
        out += s[i++];
    }
    return out;
};

/* Strips the control codes, so a bill can be shown in a terminal. */
export const asPlainText = (escpos) =>
    // ESC d n (the tail feed) is stripped along with the rest: on paper it is
    // blank roll, and in a terminal its count byte would show as a stray glyph.
    stripRasters(String(escpos)).replace(/\x1b[!aE].|\x1bd.|\x1dV.|\x1b@/g, '');

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

/* The Karachi wall-clock stamp the bill carries. */
export const stampOf = (value) => new Date(value).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/*
 * The bill. `order` and `items` are rows as stored; `settings` is the
 * store_settings row. Nothing here reads a database or a device.
 */
export const renderReceipt = ({ order, items = [], settings = {}, widthMm = 58, reprint = false }) => {
    const cols = columnsFor(widthMm);
    const line = rule(cols);
    const r = (l, right) => `${row(l, right, cols)}\n`;

    const rate = order.tax_rate != null
        ? `${Number((Number(order.tax_rate) * 100).toFixed(2))}%`
        : '';

    let out = CMD.init;
    out += CMD.center + CMD.big + `${settings.merchant_name || 'Flames by the Indus'}\n` + CMD.normal;
    out += `${settings.merchant_city || 'Islamabad'}\n`;
    if (order.invoice_number) out += `Invoice: ${order.invoice_number}\n`;
    if (order.fbr_invoice_number) out += `FBR: ${order.fbr_invoice_number}\n`;
    if (reprint) out += CMD.bold + 'REPRINT - COPY OF ORIGINAL\n' + CMD.unbold;
    out += CMD.left + line + '\n';

    out += `${stampOf(order.paid_at || order.created_at)}\n`;
    out += `Order #${order.order_number}${order.table_number ? `  Table ${order.table_number}` : ''}\n`;
    if (order.waiter_name) out += `Served by ${order.waiter_name}\n`;
    out += line + '\n';

    for (const it of items) {
        const name = `${it.qty} x ${it.name}${it.variant ? ` (${it.variant})` : ''}`;
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
    out += line + '\n';

    out += CMD.center + 'Thank you for dining with us!\n' + CMD.left;
    out += '\n\n\n' + CMD.cut;
    return out;
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
        out += CMD.bold + `${it.qty} x ${it.name}\n` + CMD.unbold;
        if (it.variant) out += `    ${it.variant}\n`;
        if (it.modifiers) out += `    ${it.modifiers}\n`;
        if (it.notes) out += `    ** ${it.notes}\n`;
    }
    out += rule(cols) + '\n\n\n' + CMD.cut;
    return out;
};

/* Strips the control codes, so a bill can be shown in a terminal. */
export const asPlainText = (escpos) =>
    String(escpos).replace(/\x1b[!aE].|\x1dV.|\x1b@/g, '');

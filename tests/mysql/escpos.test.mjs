/*
 * The receipt renderer, driven directly. No database: this file lives with the
 * MySQL suite so one glob keeps everything green, but it never opens the pool.
 *
 * It exists because the module had no coverage at all, and a bench render on
 * 9 Sep 2026 found a bug on the customer's copy that had been shipping for
 * weeks: the till's modifier modal writes the size INTO the line's name
 * (`Beef Seekh Kebab (12 pieces)`) and passes `variant` alongside it, so the
 * receipt printed the size twice and wrapped onto a second line. What is
 * asserted here is the part a customer reads and cannot query — that the size
 * is said once, that nothing overruns the paper, and that the bytes a thermal
 * printer needs to start and to cut are where they belong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CMD, columnsFor, row, lineLabel, renderReceipt, renderKotSlip, asPlainText,
} from '../../src/lib/print/escpos.mjs';

const order = {
    order_number: '466181', table_number: '7', waiter_name: 'Bilal',
    created_at: '2026-09-09T15:27:00Z',
    subtotal: 17015, discount: 0, tax: 2680, tax_rate: 0.15, total: 20546,
    charges: [{ name: 'Service Charge', amount: 851 }],
};
const items = [
    { qty: 1, name: 'Beef Seekh Kebab (12 pieces)', variant: '12 pieces', line_total: 3795 },
    { qty: 2, name: 'Tandoori Chicken', variant: null, line_total: 5990 },
];

test('a size already inside the name is not printed twice', () => {
    // The exact shape the till stores: name carries "(12 pieces)", and so
    // does variant. Only one of them may reach the paper.
    assert.equal(lineLabel('Beef Seekh Kebab (12 pieces)', '12 pieces'), 'Beef Seekh Kebab (12 pieces)');
    assert.equal(lineLabel('Aloo Gosht (Beef) (Half)', 'Half'), 'Aloo Gosht (Beef) (Half)');
    // Case is not a licence to repeat it.
    assert.equal(lineLabel('Aloo Gosht (FULL)', 'Full'), 'Aloo Gosht (FULL)');
    // But a size the name does NOT state must still be printed, even when the
    // word happens to appear unbracketed in the dish's own name.
    assert.equal(lineLabel('Chicken Handi', 'Handi'), 'Chicken Handi (Handi)');
    assert.equal(lineLabel('Karak Chai', 'Full'), 'Karak Chai (Full)');
    // No size at all, in either shape a row arrives in.
    assert.equal(lineLabel('Aloo Bhujia', null), 'Aloo Bhujia');
    assert.equal(lineLabel('Aloo Bhujia', ''), 'Aloo Bhujia');
});

test('paper width decides the column count, and anything unrecognised is the narrow roll', () => {
    assert.equal(columnsFor(80), 48);
    assert.equal(columnsFor('80'), 48);
    assert.equal(columnsFor(58), 32);
    // A bill laid out too wide loses its right-hand column; too narrow only
    // looks airy. Unknown values must fall the safe way.
    assert.equal(columnsFor(null), 32);
    assert.equal(columnsFor('wide'), 32);
});

test('a long dish wraps and its figure still lands against the last line', () => {
    const out = row('Chicken Cheese Seekh Kebab Platter For Two', 'Rs. 3,795', 32);
    const lines = out.split('\n');
    assert.ok(lines.length > 1, 'a name too long for the space must wrap, not truncate');
    assert.ok(lines.every((l) => l.length <= 32), 'no wrapped line may overrun the paper');
    assert.ok(lines.at(-1).endsWith('Rs. 3,795'), 'the figure sits against the last line');
    // A single unbreakable word must be cut rather than push the figure off.
    const long = row('Supercalifragilisticexpialidocious', '99', 20);
    assert.ok(long.split('\n').every((l) => l.length <= 20));
});

test('the bill fits the roll, says each size once, and carries init and cut', () => {
    const escpos = renderReceipt({ order, items, settings: { tax_label: 'GST' }, widthMm: 80 });

    assert.ok(escpos.startsWith(CMD.init), 'a receipt must reset the printer first');
    assert.ok(escpos.endsWith(CMD.cut), 'and cut the paper last');

    const text = asPlainText(escpos);
    assert.ok(text.split('\n').every((l) => l.length <= 48), 'nothing may overrun 80mm paper');
    assert.equal(text.match(/12 pieces/g).length, 1, 'the size is stated once');
    assert.ok(text.includes('Order #466181'));
    assert.ok(text.includes('Table 7'));
    assert.ok(text.includes('Served by Bilal'));
    assert.ok(text.includes('Service Charge'), 'a charge appears as its own line');
    assert.ok(text.includes('GST (15%)'), 'the tax line names its rate');
    assert.ok(text.includes('TOTAL'));
});

test('a discount prints only when there is one', () => {
    const without = asPlainText(renderReceipt({ order, items, widthMm: 58 }));
    assert.ok(!without.includes('Discount'));
    const withOne = asPlainText(renderReceipt({
        order: { ...order, discount: 500 }, items, widthMm: 58,
    }));
    assert.ok(withOne.includes('Discount'));
    assert.ok(withOne.split('\n').every((l) => l.length <= 32), 'and still fits 58mm paper');
});

test('a reprint says so, so a copy cannot pass as the original', () => {
    const plain = asPlainText(renderReceipt({ order, items, widthMm: 80 }));
    assert.ok(!plain.includes('REPRINT'));
    const copy = asPlainText(renderReceipt({ order, items, widthMm: 80, reprint: true }));
    assert.ok(copy.includes('REPRINT - COPY OF ORIGINAL'));
});

test('a kitchen slip states the size once and never shows a price', () => {
    const escpos = renderKotSlip({
        slip: {
            categoryName: 'GRILL',
            items: [
                { qty: 2, name: 'Beef Seekh Kebab (12 pieces)', variant: '12 pieces', notes: 'no chilli' },
                { qty: 1, name: 'Tandoori Chicken', variant: null },
            ],
        },
        meta: { orderNumber: '466181', table: '7', waiter: 'Bilal', orderType: 'dine-in', roundNo: 2 },
        widthMm: 80,
    });
    const text = asPlainText(escpos);

    assert.equal(text.match(/12 pieces/g).length, 1, 'the size is stated once');
    assert.ok(text.split('\n').every((l) => l.length <= 48));
    assert.ok(text.includes('** no chilli'), 'a note the cook must see is marked');
    assert.ok(text.includes('Round 2'));
    // The kitchen is never told what anything costs.
    assert.ok(!/Rs\.|[0-9],[0-9]{3}/.test(text), 'a kitchen slip carries no money');
    assert.ok(escpos.endsWith(CMD.cut));
});

test('a printer profile changes the bytes, and its absence changes nothing', () => {
    const base = {
        order: { order_number: 7, subtotal: 100, tax: 16, total: 116, created_at: new Date() },
        items: [{ name: 'Karahi', qty: 1, unit_price: 100, line_total: 100 }],
        settings: {},
        widthMm: 80,
    };

    // No profile: exactly what this renderer emitted before profiles existed —
    // six lines of feed and a full cut.
    const plain = renderReceipt(base);
    assert.ok(plain.endsWith('\x1bd\x06\x1dV\x00'), 'default is feed 6 then GS V 0');

    // A printer with no cutter gets paper to tear and no cut command at all —
    // a blade command to a machine without one prints as a stray character.
    const noCutter = renderReceipt({ ...base, profile: { cut: 'none' } });
    assert.ok(!noCutter.includes('\x1dV'), 'no cut command reaches a printer with no cutter');
    assert.ok(noCutter.endsWith('\x1bd\x06'), 'but the paper still comes out to tear');

    // Partial cut, and a head-to-cutter gap of two lines rather than six.
    const partial = renderReceipt({ ...base, profile: { cut: 'partial', feedLines: 2 } });
    assert.ok(partial.endsWith('\x1bd\x02\x1dV\x01'));

    // A code page has to land before any text, because ESC @ clears it.
    const cp = renderReceipt({ ...base, profile: { codepage: 16 } });
    assert.ok(cp.startsWith('\x1b@\x1bt\x10'), 'reset, then the code page, then the bill');
    assert.ok(!plain.includes('\x1bt'), 'and nothing is sent when none is asked for');

    // Nonsense is not obeyed: an unknown cut and a silly feed fall back rather
    // than reaching a printer as garbage.
    const junk = renderReceipt({ ...base, profile: { cut: 'chop', feedLines: 900 } });
    assert.ok(junk.endsWith('\x1bd\x1e\x1dV\x00'), 'unknown cut -> full, feed clamped to 30');
});

/*
 * Two outlets keep two sets of books.
 *
 * Everything in the Accounts module used to file under a named constant,
 * `BRANCH_ID = 1`. A grep for `branch_id = 1` never found it — a constant is
 * the one shape that sweep cannot see — so the ledger went on answering "one"
 * long after the rest of the app had learned to ask.
 *
 * Two things had to be true and neither was:
 *
 *   1. A journal belongs to the branch of the DOCUMENT it explains. Not to
 *      whoever is looking at a screen, and certainly not to a constant: most
 *      of these post from a background call with no request at all.
 *
 *   2. Voucher numbers come from PER-BRANCH sequences. The counter is keyed
 *      (branch, day, type) and always was, so this is the half that would have
 *      failed loudly — two outlets minting from one sequence hand out JV-0001
 *      twice on the same day, and a voucher number stops identifying anything.
 *
 * These drive the real posting engines over documents the real verbs wrote.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one } from './helpers.mjs';
import { createOrder } from '../../src/lib/db/orders.mjs';
import { afterSettleGl } from '../../src/lib/accounts/post.mjs';
import { afterWasteGl, afterStockDocGl } from '../../src/lib/accounts/stockPost.mjs';

const LAHORE = 2;
let original;

before(async () => {
    await acquireSuiteLock();
    await resetDb();
    await q(`INSERT INTO branches (id, name, code, is_active) VALUES (?, 'Test Lahore', 'LHR', 1)`, [LAHORE]);

    const settings = await one('SELECT * FROM gl_settings WHERE id = 1');
    original = { start_date: settings.start_date, posting_enabled: settings.posting_enabled };
    await q("UPDATE gl_settings SET posting_enabled = 1, start_date = '2000-01-01' WHERE id = 1");
});

after(async () => {
    await q('UPDATE gl_settings SET posting_enabled = ?, start_date = ? WHERE id = 1',
        [original.posting_enabled, original.start_date]);
    await closeDb();
});

const journalFor = async (sourceType, sourceId) => one(
    'SELECT branch_id, voucher_no, business_date FROM gl_journals WHERE source_type = ? AND source_id = ?',
    [sourceType, String(sourceId)],
);

test('a sale posts its journal to the branch that rang it', async () => {
    const dish = await one('SELECT id, name, price FROM menu_items LIMIT 1');

    const orders = {};
    for (const branch of [1, LAHORE]) {
        orders[branch] = await createOrder(
            [{ id: dish.id, name: dish.name, price: 1000, qty: 1 }],
            { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash', branch_id: branch },
            randomUUID(),
        );
        await afterSettleGl(orders[branch]);
    }

    const head = await journalFor('order_sale', orders[1].id);
    const lahore = await journalFor('order_sale', orders[LAHORE].id);
    assert.equal(Number(head.branch_id), 1);
    assert.equal(Number(lahore.branch_id), LAHORE, 'Lahore’s takings are Lahore’s');

    /*
     * The heart of it. Both are the FIRST sale voucher of that day at their own
     * outlet, so both end -0001. One shared sequence would have produced -0001
     * and -0002, which reads perfectly plausibly and is wrong.
     */
    assert.ok(head.voucher_no.endsWith('-0001'), `head office got ${head.voucher_no}`);
    assert.ok(lahore.voucher_no.endsWith('-0001'), `Lahore got ${lahore.voucher_no}`);
    assert.equal(head.voucher_no, lahore.voucher_no,
        'same type, same day, same number — the sequences are genuinely separate');

    const counters = await q(
        'SELECT branch_id, last_no FROM gl_voucher_counters WHERE voucher_type = ? ORDER BY branch_id',
        [head.voucher_no.split('-')[0]],
    );
    assert.equal(counters.length, 2, 'one counter row per branch');
    assert.deepEqual(counters.map((c) => Number(c.last_no)), [1, 1]);
});

test('waste posts to the branch that binned the food', async () => {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const item = (await q(
        'INSERT INTO inventory_items (name, unit_id, avg_cost, is_active) VALUES (?, 1, 200, 1)',
        [`Branch Waste Item ${randomUUID().slice(0, 8)}`],
    )).insertId;
    const dish = await one('SELECT id FROM menu_items LIMIT 1');

    const docs = {};
    for (const branch of [1, LAHORE]) {
        const doc = (await q(
            'INSERT INTO waste_docs (branch_id, business_date, reason) VALUES (?, ?, ?)',
            [branch, day, 'spoiled'],
        )).insertId;
        await q(
            'INSERT INTO waste_lines (waste_doc_id, menu_item_id, variant_name, qty, cost) VALUES (?, ?, ?, 1, 400)',
            [doc, dish.id, ''],
        );
        await q(
            `INSERT INTO stock_ledger (inventory_item_id, warehouse_id, delta, source_type, source_id, business_date)
             VALUES (?, 1, -2, 'waste', ?, ?)`,
            [item, String(doc), day],
        );
        docs[branch] = doc;
        await afterWasteGl(doc);
    }

    assert.equal(Number((await journalFor('dish_waste', docs[1])).branch_id), 1);
    assert.equal(Number((await journalFor('dish_waste', docs[LAHORE])).branch_id), LAHORE);
});

test('a stock adjustment posts to the branch that made it', async () => {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const item = (await q(
        'INSERT INTO inventory_items (name, unit_id, avg_cost, is_active) VALUES (?, 1, 150, 1)',
        [`Branch Adjust Item ${randomUUID().slice(0, 8)}`],
    )).insertId;

    const docs = {};
    for (const branch of [1, LAHORE]) {
        const doc = (await q(
            `INSERT INTO stock_docs (branch_id, doc_type, warehouse_id, business_date, reason)
             VALUES (?, 'adjustment', 1, ?, 'count correction')`,
            [branch, day],
        )).insertId;
        await q(
            `INSERT INTO stock_ledger (inventory_item_id, warehouse_id, delta, source_type, source_id, business_date)
             VALUES (?, 1, -3, 'adjustment', ?, ?)`,
            [item, String(doc), day],
        );
        docs[branch] = doc;
        await afterStockDocGl(doc);
    }

    assert.equal(Number((await journalFor('stock_doc', docs[1])).branch_id), 1);
    assert.equal(Number((await journalFor('stock_doc', docs[LAHORE])).branch_id), LAHORE);
});

test('minting a voucher without a branch is refused, not defaulted', async () => {
    const { nextVoucherNo } = await import('../../src/lib/accounts/kit.mjs');
    const { pool } = await import('../../src/lib/db/pool.mjs');
    const conn = await pool.getConnection();
    try {
        // The old signature defaulted to 1. Silently filing a second outlet's
        // voucher under the first is exactly the failure this whole file is
        // about, so the absence has to be loud.
        await assert.rejects(
            () => nextVoucherNo(conn, 'JV', '2026-09-14'),
            /branch/i,
        );
    } finally {
        conn.release();
    }
});

test('the ledger separates by branch when asked', async () => {
    const rows = await q(
        `SELECT branch_id, COUNT(*) AS n FROM gl_journals
          WHERE branch_id IN (1, ?) GROUP BY branch_id ORDER BY branch_id`,
        [LAHORE],
    );
    assert.equal(rows.length, 2, 'both outlets have journals of their own');
    assert.ok(Number(rows[1].n) >= 3, 'Lahore has its sale, its waste and its adjustment');
});

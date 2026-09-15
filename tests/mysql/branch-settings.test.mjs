/*
 * A second outlet charges its own tax.
 *
 * This is the reason branch_settings exists. A branch in Lahore answers to the
 * Punjab Revenue Authority and one in Islamabad to the FBR, at rates that do
 * not match, and the rate on a bill is a property of WHERE IT WAS RUNG. The
 * settle path therefore has to read the rate against the order's own branch,
 * and these tests are what stop it quietly going back to reading one global
 * number — which is what it did until now and which no existing test could
 * have caught, because until now there was only one branch to be wrong about.
 *
 * The third test is the subtle one. Every override column is NULLable and NULL
 * means "the company's answer", so the merge has to distinguish an ABSENT
 * override from a DELIBERATE ZERO. `??` does; `||` does not, and a branch
 * genuinely exempt from sales tax would have been silently charged 16%.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, TAX, createOrder } from './helpers.mjs';
import { settingsFor, taxRatesFor } from '../../src/lib/db/branchSettings.mjs';

const LAHORE = 2;
const PRICE = 1000;

before(async () => {
    await acquireSuiteLock();
    await resetDb();
    await q(
        `INSERT INTO branches (id, name, code, is_active) VALUES (?, 'Test Lahore', 'LHR', 1)`,
        [LAHORE],
    );
});
after(closeDb);

const ring = async (branchId, method) => createOrder(
    [{ name: 'Test Rate Probe', price: PRICE, qty: 1 }],
    { order_type: 'takeaway', payment_status: 'paid', payment_mode: method, branch_id: branchId },
    randomUUID(),
);

test('with no override row, a branch is taxed at the company rate', async () => {
    const order = await ring(LAHORE, 'cash');
    assert.equal(order.branch_id, LAHORE);
    assert.equal(order.total, PRICE + Math.round(PRICE * TAX.cash));
});

test('an override re-prices its own outlet and leaves the other alone', async () => {
    // PRA's restaurant rate, against the company's 16%.
    await q(
        'INSERT INTO branch_settings (branch_id, tax_rate_cash) VALUES (?, ?)',
        [LAHORE, 0.05],
    );

    const lahore = await ring(LAHORE, 'cash');
    assert.equal(lahore.total, PRICE + Math.round(PRICE * 0.05), 'Lahore charges its own 5%');
    assert.equal(Number(lahore.tax_rate), 0.05, 'and the rate is stamped on the row');

    const head = await ring(1, 'cash');
    assert.equal(head.total, PRICE + Math.round(PRICE * TAX.cash), 'head office is untouched');
});

test('a column left NULL falls through, a column set to 0 does not', async () => {
    // Only the cash rate was overridden above: card must still be the company's.
    const partial = await taxRatesFor(null, LAHORE);
    assert.equal(partial.cash, 0.05);
    assert.equal(partial.card, TAX.card, 'NULL card rate means the company card rate');

    await q('UPDATE branch_settings SET tax_rate_card = 0 WHERE branch_id = ?', [LAHORE]);
    const exempt = await taxRatesFor(null, LAHORE);
    assert.equal(exempt.card, 0, 'a deliberate 0% is a rate, not an absence');

    const order = await ring(LAHORE, 'card');
    assert.equal(order.total, PRICE, 'and it reaches the bill as no tax at all');
});

test('settingsFor merges over the company row and names what it overrode', async () => {
    await q(
        `UPDATE branch_settings SET tax_label = 'PST', tax_authority = 'PRA',
                receipt_footer = 'Thank you', opening_float = 5000
          WHERE branch_id = ?`,
        [LAHORE],
    );

    const merged = await settingsFor(LAHORE);
    assert.equal(merged.tax_label, 'PST');
    assert.equal(merged.tax_authority, 'PRA');
    assert.equal(merged.receipt_footer, 'Thank you');
    // store_settings names this column default_opening_float; the override is
    // opening_float and has to land on the store's own name to be readable.
    assert.equal(Number(merged.default_opening_float), 5000);
    assert.equal(merged.merchant_name, 'Flames Test', 'company fields survive the merge');
    assert.deepEqual(
        merged.overridden.sort(),
        ['opening_float', 'receipt_footer', 'tax_authority', 'tax_label',
         'tax_rate_card', 'tax_rate_cash'],
    );

    const head = await settingsFor(1);
    assert.equal(head.tax_label, 'GST', 'the outlet with no row reads the company row');
    assert.deepEqual(head.overridden, []);
});

test('deleting a branch takes its overrides with it', async () => {
    await q(`INSERT INTO branches (id, name, code) VALUES (99, 'Test Temp', 'TMP')`);
    await q('INSERT INTO branch_settings (branch_id, tax_rate_cash) VALUES (99, 0.1)');
    await q('DELETE FROM branches WHERE id = 99');
    assert.equal((await q('SELECT * FROM branch_settings WHERE branch_id = 99')).length, 0);
});

/*
 * The other posters, driven directly: a city-ledger receipt, a supplier
 * payment with its goods receiving, and a drawer close that did not count
 * to the rupee must each land in the general ledger as ONE balanced
 * journal on the right accounts, exactly once however often the hook
 * fires — and a drawer that counted right must post nothing.
 *
 * Documents are seeded straight into the test database (the receiving
 * through the real kernel verb, so its stored total is the verb's own
 * arithmetic). No account NUMBER appears here: every expected account is
 * resolved the way the poster resolves it — gl_settings by role, gl_links
 * by mapping, the chart by link code — so renumbering cannot turn this
 * suite red or green by accident.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSuiteLock, resetDb, closeDb, q, one, count } from './helpers.mjs';
import { pool } from '../../src/lib/db/pool.mjs';
import { receiveStock } from '../../src/lib/db/inventory.mjs';
import {
    afterReceiptGl, afterSupplierPaymentGl, afterReceivingGl, afterDrawerCloseGl, OTHER_SOURCE_TYPES,
} from '../../src/lib/accounts/otherPost.mjs';

const COMPANY_ID = '00000000-0000-4000-8000-0000000000c1';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const karachiDayOf = (d) => new Date(d.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);

let fx;        // resetDb fixtures (the two users)
let original;  // gl_settings switches as found, restored in after()
let acct;      // the accounts the poster must use, resolved — never numbered
let supplier;  // suppliers row id
let item;      // inventory_items row id
const WAREHOUSE_ID = 1; // 'Main Store', seeded by migration 002

const journalFor = (type, id) =>
    one('SELECT * FROM gl_journals WHERE source_type = ? AND source_id = ?', [type, String(id)]);
const journalsFor = (type, id) =>
    count('SELECT COUNT(*) AS n FROM gl_journals WHERE source_type = ? AND source_id = ?', [type, String(id)]);
const linesOf = (journalId) =>
    q('SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id', [journalId]);
const sumSide = (lines, side) => money(lines.reduce((s, l) => s + Number(l[side]), 0));
const shape = (lines) => lines
    .map((l) => [Number(l.account_id), money(l.debit), money(l.credit)])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

/* Net balance of one account across the whole ledger, credit-positive for
 * a liability: what the AP control says the suppliers are owed. */
const creditBalance = async (accountId) => money(
    (await one(
        'SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS bal FROM gl_journal_lines WHERE account_id = ?',
        [accountId],
    )).bal,
);

const assertBalanced = async (journal, label = journal.voucher_no) => {
    const lines = await linesOf(journal.id);
    const dr = sumSide(lines, 'debit');
    const cr = sumSide(lines, 'credit');
    assert.equal(dr, cr, `SUM(debit) !== SUM(credit) on ${label}`);
    assert.equal(money(journal.debit_total), dr, `header debit_total !== lines on ${label}`);
    assert.equal(money(journal.credit_total), cr, `header credit_total !== lines on ${label}`);
    assert.equal(journal.status, 'posted');
    for (const l of lines) {
        assert.ok((money(l.debit) > 0) !== (money(l.credit) > 0), `a line carries both or neither side on ${label}`);
    }
    return lines;
};

const insertReceipt = async ({ amount, method, reference = null, invoiceId = null }) => {
    const [res] = await pool.query(
        `INSERT INTO company_receipts (company_id, invoice_id, amount, method, reference)
         VALUES (?, ?, ?, ?, ?)`,
        [COMPANY_ID, invoiceId, amount, method, reference],
    );
    return one('SELECT * FROM company_receipts WHERE id = ?', [res.insertId]);
};

const insertSupplierPayment = async ({ amount, method, reference = null }) => {
    const [res] = await pool.query(
        'INSERT INTO supplier_payments (supplier_id, amount, method, reference) VALUES (?, ?, ?, ?)',
        [supplier, amount, method, reference],
    );
    return one('SELECT * FROM supplier_payments WHERE id = ?', [res.insertId]);
};

const insertClosedSession = async ({ businessDate, expected, counted, open = false }) => {
    const variance = money(counted - expected);
    const [res] = await pool.query(
        open
            ? `INSERT INTO drawer_sessions (branch_id, business_date, cashier_role, opening_float)
               VALUES (1, ?, 'cashier', 5000)`
            : `INSERT INTO drawer_sessions
                 (branch_id, business_date, cashier_role, opening_float, closed_at,
                  expected_amount, counted_amount, variance)
               VALUES (1, ?, 'cashier', 5000, UTC_TIMESTAMP(3), ?, ?, ?)`,
        open ? [businessDate] : [businessDate, expected, counted, variance],
    );
    return one('SELECT * FROM drawer_sessions WHERE id = ?', [res.insertId]);
};

before(async () => {
    await acquireSuiteLock();
    fx = await resetDb();

    const settings = await one('SELECT * FROM gl_settings WHERE id = 1');
    assert.ok(settings, 'gl_settings has no row — migration 006 seeds it and resetDb must never wipe it');
    original = { start_date: ymd(settings.start_date), posting_enabled: settings.posting_enabled };
    await q("UPDATE gl_settings SET posting_enabled = 1, start_date = '2000-01-01' WHERE id = 1");

    const link = async (type, ref) =>
        (await one('SELECT account_id FROM gl_links WHERE link_type = ? AND ref_id = ?', [type, ref]))?.account_id ?? null;
    const byCode = async (code, extra = '', params = []) =>
        (await one(
            `SELECT id FROM accounts WHERE is_active = 1 AND JSON_CONTAINS(link_codes, ?) ${extra}
              ORDER BY account_number LIMIT 1`,
            [JSON.stringify(code), ...params],
        ))?.id ?? null;
    acct = {
        cash: await link('payment_method', 'cash'),
        arCityLedger: await link('payment_method', 'city_ledger'),
        receiptCash: await link('receipt_method', 'cash'),
        receiptBank: await link('receipt_method', 'bank'),
        receiptCheque: await link('receipt_method', 'cheque'),
        // Resolved exactly as resolveApSuppliers does it: the lowest-numbered
        // AP account in the payables category. Matching the old seed's
        // '%Suppliers%' wording is what hid the posting break when the chart
        // moved to the accountant's names.
        apSuppliers: await byCode('AP', "AND category = 'ACCOUNTS PAYABLE'"),
        inventory: await byCode('INVENTORY'),
        overShort: settings.cash_over_short_account_id,
    };
    for (const [k, v] of Object.entries(acct)) assert.ok(v, `no account resolved for ${k} — is the 006 seed present?`);
    assert.notEqual(acct.receiptBank, acct.receiptCash, 'bank and cash receipts must land on different accounts for these tests to mean anything');
    assert.notEqual(acct.apSuppliers, acct.inventory);
    assert.notEqual(acct.overShort, acct.cash);

    // The documents' masters: a company, a supplier and a stock item. Fixed
    // identities, so every run reseeds the same rows.
    await q(
        `INSERT INTO companies (id, name, is_active) VALUES (?, 'Test Ledger Co', 1) AS new_row
         ON DUPLICATE KEY UPDATE name = new_row.name, is_active = 1`,
        [COMPANY_ID],
    );
    supplier = (await one("SELECT id FROM suppliers WHERE name = 'Test GL Supplier'"))?.id
        ?? (await pool.query(
            "INSERT INTO suppliers (name, is_active) VALUES ('Test GL Supplier', 1)",
        ))[0].insertId;
    await q('UPDATE suppliers SET is_active = 1 WHERE id = ?', [supplier]);
    const unit = await one("SELECT id FROM units WHERE name = 'Kilogram'");
    assert.ok(unit, 'units are seeded by migration 002');
    item = (await one("SELECT id FROM inventory_items WHERE name = 'Test GL Onion'"))?.id
        ?? (await pool.query(
            "INSERT INTO inventory_items (name, unit_id, avg_cost) VALUES ('Test GL Onion', ?, 0)", [unit.id],
        ))[0].insertId;

    // The documents themselves start empty. resetDb leaves these tables
    // alone (no other suite writes them); children before parents.
    for (const sql of [
        'DELETE FROM company_receipts',
        'DELETE FROM supplier_payments',
        'DELETE FROM stock_receiving_lines',
        "DELETE FROM stock_ledger WHERE source_type = 'receiving'",
        'DELETE FROM stock_receivings',
        'DELETE FROM drawer_movements',
        'DELETE FROM drawer_sessions',
    ]) await q(sql);
});

after(async () => {
    await q('UPDATE gl_settings SET posting_enabled = ?, start_date = ? WHERE id = 1',
        [original.posting_enabled, original.start_date]);
    await closeDb();
});

test('a. a city-ledger receipt posts one balanced RV: Dr the receipt account, Cr AR city ledger; a replay is a no-op', async () => {
    const receipt = await insertReceipt({ amount: 12345.5, method: 'bank', reference: 'CHQ 771' });

    const result = await afterReceiptGl(receipt.id, { userId: fx.users.admin });
    assert.equal(result.status, 'posted', result.reason);
    assert.equal(result.vouchers.length, 1);
    assert.equal(result.vouchers[0].voucher_type, 'RV');

    const rv = await journalFor(OTHER_SOURCE_TYPES.receipt, receipt.id);
    assert.ok(rv, 'no RV journal keyed on the receipt');
    assert.match(rv.voucher_no, /^RV-\d{6}-\d{4}$/);
    assert.equal(rv.reference, 'CHQ 771');
    assert.equal(rv.description, 'Receipt bank · Test Ledger Co');
    assert.equal(rv.created_by, fx.users.admin, 'the acting user is on the header');
    // No business day is open in this suite, so the receipt sits on the
    // Karachi calendar day it was received.
    assert.equal(ymd(rv.business_date), karachiDayOf(receipt.received_at));
    const lines = await assertBalanced(rv);
    assert.deepEqual(shape(lines), shape([
        { account_id: acct.receiptBank, debit: 12345.5, credit: 0 },
        { account_id: acct.arCityLedger, debit: 0, credit: 12345.5 },
    ]));
    assert.equal(lines.find((l) => Number(l.account_id) === acct.arCityLedger).memo, 'Test Ledger Co');

    const auditRow = await one(
        "SELECT * FROM audit_log WHERE action = 'gl_post_receipt' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(auditRow, 'the posting audits');
    assert.equal(auditRow.staff_id, fx.users.admin);
    assert.equal(auditRow.details.receipt_id, receipt.id);
    assert.equal(auditRow.details.vouchers[0].voucher_no, rv.voucher_no);

    // A second call, and four concurrent ones: still exactly one journal.
    const again = await afterReceiptGl(receipt);
    assert.equal(again.status, 'posted');
    assert.equal(again.vouchers.length, 0, 'a replay writes nothing');
    const race = await Promise.allSettled([1, 2, 3, 4].map(() => afterReceiptGl(receipt.id)));
    assert.ok(race.every((r) => r.status === 'fulfilled' && r.value.status === 'posted'));
    assert.equal(await journalsFor(OTHER_SOURCE_TYPES.receipt, receipt.id), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gl_post_receipt'"), 1,
        'a no-op replay does not audit');

    // Cash lands on the cash receipt account, and an unrecorded receipt
    // method (nothing mapped for it) is a refusal, not a plug.
    const cashReceipt = await insertReceipt({ amount: 700, method: 'cash' });
    const cashResult = await afterReceiptGl(cashReceipt.id);
    assert.equal(cashResult.status, 'posted', cashResult.reason);
    const cashLines = await linesOf(cashResult.vouchers[0].id);
    assert.deepEqual(shape(cashLines), shape([
        { account_id: acct.receiptCash, debit: 700, credit: 0 },
        { account_id: acct.arCityLedger, debit: 0, credit: 700 },
    ]));

    await q("DELETE FROM gl_links WHERE link_type = 'receipt_method' AND ref_id = 'cheque'");
    try {
        const cheque = await insertReceipt({ amount: 900, method: 'cheque' });
        const refused = await afterReceiptGl(cheque.id);
        assert.equal(refused.status, 'failed');
        assert.match(refused.reason, /cheque/);
        assert.equal(await journalsFor(OTHER_SOURCE_TYPES.receipt, cheque.id), 0, 'a refusal books nothing');
    } finally {
        await q(
            "INSERT INTO gl_links (link_type, ref_id, account_id) VALUES ('receipt_method', 'cheque', ?)",
            [acct.receiptCheque],
        );
    }
});

test('b. a receiving and a supplier payment post JV + PV and the AP control nets to what is still owed', async () => {
    // Two lines, priced so the total carries paise: 10 × 250.50 + 4 × 99.99.
    const grn = await receiveStock({
        supplierId: supplier, warehouseId: WAREHOUSE_ID, supplierInvoice: 'SI-42',
        lines: [{ itemId: item, qty: 10, unitCost: 250.5 }, { itemId: item, qty: 4, unitCost: 99.99 }],
    });
    assert.equal(grn.total, 2904.96, 'the kernel verb stores the total this suite expects');
    const receiving = await one('SELECT * FROM stock_receivings WHERE id = ?', [grn.id]);

    const recvResult = await afterReceivingGl(grn.id, { userId: fx.users.admin });
    assert.equal(recvResult.status, 'posted', recvResult.reason);
    assert.equal(recvResult.vouchers.length, 1);
    const jv = await journalFor(OTHER_SOURCE_TYPES.receiving, grn.id);
    assert.ok(jv);
    assert.equal(jv.voucher_type, 'JV');
    assert.match(jv.voucher_no, /^JV-\d{6}-\d{4}$/);
    assert.equal(jv.reference, 'SI-42');
    assert.equal(jv.description, 'Goods received SI-42 · Test GL Supplier');
    assert.equal(ymd(jv.business_date), ymd(receiving.business_date), 'the GRN posts on its own business date');
    const jvLines = await assertBalanced(jv);
    assert.deepEqual(shape(jvLines), shape([
        { account_id: acct.inventory, debit: 2904.96, credit: 0 },
        { account_id: acct.apSuppliers, debit: 0, credit: 2904.96 },
    ]));
    assert.equal(jvLines.find((l) => Number(l.account_id) === acct.inventory).memo, '2 lines · Main Store');
    assert.equal(await creditBalance(acct.apSuppliers), 2904.96, 'the whole GRN is owed until something is paid');

    // Part-pay in cash.
    const payment = await insertSupplierPayment({ amount: 2000, method: 'cash', reference: 'adv' });
    const payResult = await afterSupplierPaymentGl(payment.id, { userId: fx.users.admin });
    assert.equal(payResult.status, 'posted', payResult.reason);
    const pv = await journalFor(OTHER_SOURCE_TYPES.supplierPayment, payment.id);
    assert.ok(pv);
    assert.equal(pv.voucher_type, 'PV');
    assert.match(pv.voucher_no, /^PV-\d{6}-\d{4}$/);
    assert.equal(pv.reference, 'adv');
    assert.equal(pv.description, 'Payment cash · Test GL Supplier');
    assert.equal(ymd(pv.business_date), karachiDayOf(payment.paid_at));
    assert.equal(pv.created_by, fx.users.admin);
    const pvLines = await assertBalanced(pv);
    assert.deepEqual(shape(pvLines), shape([
        { account_id: acct.apSuppliers, debit: 2000, credit: 0 },
        { account_id: acct.cash, debit: 0, credit: 2000 },
    ]));

    // The AP control agrees with the supplier ledger's own arithmetic:
    // receivings − payments, paise-exact.
    const owed = money(Number(receiving.total) - Number(payment.amount));
    assert.equal(owed, 904.96);
    assert.equal(await creditBalance(acct.apSuppliers), owed, 'AP nets to the unpaid remainder');

    // Replays: nothing more lands, nothing more is audited.
    const audits = await count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('gl_post_receiving', 'gl_post_supplier_payment')",
    );
    assert.equal(audits, 2);
    const [r2, p2] = await Promise.all([afterReceivingGl(receiving), afterSupplierPaymentGl(payment)]);
    assert.equal(r2.status, 'posted'); assert.equal(r2.vouchers.length, 0);
    assert.equal(p2.status, 'posted'); assert.equal(p2.vouchers.length, 0);
    assert.equal(await journalsFor(OTHER_SOURCE_TYPES.receiving, grn.id), 1);
    assert.equal(await journalsFor(OTHER_SOURCE_TYPES.supplierPayment, payment.id), 1);
    assert.equal(await count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('gl_post_receiving', 'gl_post_supplier_payment')",
    ), audits);

    // A bank payment credits the bank account — supplier_payments allows
    // 'bank' and 'cheque', which only the receipt_method links know.
    const bankPay = await insertSupplierPayment({ amount: 404.96, method: 'bank', reference: 'TT 9' });
    const bankResult = await afterSupplierPaymentGl(bankPay.id);
    assert.equal(bankResult.status, 'posted', bankResult.reason);
    const bankLines = await linesOf(bankResult.vouchers[0].id);
    assert.deepEqual(shape(bankLines), shape([
        { account_id: acct.apSuppliers, debit: 404.96, credit: 0 },
        { account_id: acct.receiptBank, debit: 0, credit: 404.96 },
    ]));
    assert.equal(await creditBalance(acct.apSuppliers), 500, 'AP: 2904.96 − 2000 − 404.96');

    // A supplier the owner has mapped to its own control posts there.
    const [other] = await q(
        `SELECT id FROM accounts WHERE is_active = 1 AND JSON_CONTAINS(link_codes, '"AP"') AND id <> ?
          ORDER BY account_number LIMIT 1`,
        [acct.apSuppliers],
    );
    assert.ok(other, 'the seeded chart carries a second AP account');
    await q("INSERT INTO gl_links (link_type, ref_id, account_id) VALUES ('supplier', ?, ?)", [String(supplier), other.id]);
    try {
        const mapped = await insertSupplierPayment({ amount: 100, method: 'cash' });
        const mappedResult = await afterSupplierPaymentGl(mapped.id);
        assert.equal(mappedResult.status, 'posted', mappedResult.reason);
        const mappedLines = await linesOf(mappedResult.vouchers[0].id);
        assert.ok(mappedLines.some((l) => Number(l.account_id) === other.id && money(l.debit) === 100),
            'the supplier link overrides the default AP control');
    } finally {
        await q("DELETE FROM gl_links WHERE link_type = 'supplier' AND ref_id = ?", [String(supplier)]);
    }
});

test('c. a drawer close Rs 150 short posts one balanced journal against cash over/short; a zero variance posts nothing', async () => {
    const short = await insertClosedSession({ businessDate: '2026-08-15', expected: 12150, counted: 12000 });
    assert.equal(money(short.variance), -150);

    const result = await afterDrawerCloseGl(short.id, { userId: fx.users.cashier });
    assert.equal(result.status, 'posted', result.reason);
    assert.equal(result.vouchers.length, 1);
    const jv = await journalFor(OTHER_SOURCE_TYPES.drawerVariance, short.id);
    assert.ok(jv);
    assert.equal(jv.voucher_type, 'JV');
    assert.equal(jv.reference, `DRW-${short.id}`);
    assert.equal(jv.description, 'Drawer close cashier · short');
    assert.equal(ymd(jv.business_date), '2026-08-15', 'the variance sits on the session\'s own trading day');
    assert.equal(jv.created_by, fx.users.cashier);
    const lines = await assertBalanced(jv);
    assert.deepEqual(shape(lines), shape([
        { account_id: acct.overShort, debit: 150, credit: 0 },
        { account_id: acct.cash, debit: 0, credit: 150 },
    ]));
    const auditRow = await one("SELECT * FROM audit_log WHERE action = 'gl_post_drawer_variance' ORDER BY id DESC LIMIT 1");
    assert.equal(auditRow.staff_id, fx.users.cashier);
    assert.equal(auditRow.details.variance, -150);
    assert.equal(ymd(auditRow.business_date), '2026-08-15');

    const again = await afterDrawerCloseGl(short);
    assert.equal(again.status, 'posted');
    assert.equal(again.vouchers.length, 0);
    assert.equal(await journalsFor(OTHER_SOURCE_TYPES.drawerVariance, short.id), 1);

    // Counted to the rupee: nothing to explain, nothing booked.
    const exact = await insertClosedSession({ businessDate: '2026-08-15', expected: 8000, counted: 8000 });
    const nothing = await afterDrawerCloseGl(exact.id);
    assert.equal(nothing.status, 'skipped');
    assert.match(nothing.reason, /no variance/);
    assert.equal(await journalsFor(OTHER_SOURCE_TYPES.drawerVariance, exact.id), 0);

    // Over: the drawer holds cash nobody rang up — the sides swap.
    const over = await insertClosedSession({ businessDate: '2026-08-16', expected: 9000, counted: 9080 });
    const overResult = await afterDrawerCloseGl(over.id);
    assert.equal(overResult.status, 'posted', overResult.reason);
    const overLines = await linesOf(overResult.vouchers[0].id);
    assert.deepEqual(shape(overLines), shape([
        { account_id: acct.cash, debit: 80, credit: 0 },
        { account_id: acct.overShort, debit: 0, credit: 80 },
    ]));
    assert.equal((await journalFor(OTHER_SOURCE_TYPES.drawerVariance, over.id)).description, 'Drawer close cashier · over');

    // Still open: no count yet, nothing to book.
    const stillOpen = await insertClosedSession({ businessDate: '2026-08-16', expected: 0, counted: 0, open: true });
    const openResult = await afterDrawerCloseGl(stillOpen.id);
    assert.equal(openResult.status, 'skipped');
    assert.match(openResult.reason, /still open/);

    // The whole ledger this suite wrote balances, journal by journal.
    const all = await q('SELECT * FROM gl_journals ORDER BY id');
    assert.ok(all.length >= 7);
    for (const j of all) await assertBalanced(j);
});

test('d. the switches are honoured: posting off, or a document before the start date, books nothing', async () => {
    await q('UPDATE gl_settings SET posting_enabled = 0 WHERE id = 1');
    try {
        const r = await insertReceipt({ amount: 50, method: 'cash' });
        const off = await afterReceiptGl(r.id);
        assert.equal(off.status, 'skipped');
        assert.match(off.reason, /switched off/);
        assert.equal(await journalsFor(OTHER_SOURCE_TYPES.receipt, r.id), 0);
    } finally {
        await q('UPDATE gl_settings SET posting_enabled = 1 WHERE id = 1');
    }

    await q("UPDATE gl_settings SET start_date = '2099-01-01' WHERE id = 1");
    try {
        const s = await insertClosedSession({ businessDate: '2026-08-17', expected: 100, counted: 90 });
        const early = await afterDrawerCloseGl(s.id);
        assert.equal(early.status, 'skipped');
        assert.match(early.reason, /before the ledger start date/);
        assert.equal(await journalsFor(OTHER_SOURCE_TYPES.drawerVariance, s.id), 0);
    } finally {
        await q("UPDATE gl_settings SET start_date = '2000-01-01' WHERE id = 1");
    }

    // A missing document, and no document at all, are skips — never throws.
    assert.equal((await afterSupplierPaymentGl(999999999)).status, 'skipped');
    assert.equal((await afterReceivingGl(null)).status, 'skipped');
    assert.equal((await afterReceiptGl({})).status, 'skipped');
});

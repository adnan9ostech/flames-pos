/*
 * The manual journal voucher and the Posting Health lists, driven directly.
 *
 * A hand-written JV is the one place a person, not the till, writes to the
 * books — so the refusals matter more than the happy path: an unbalanced
 * voucher, a line with both sides, an inactive account, must each leave
 * NOTHING behind, not even a burnt voucher number. And Health must name a
 * settled bill the engine has not booked, then stop naming it the moment
 * the engine has — because that list is the only failure queue there is.
 *
 * No account NUMBER appears here: accounts are resolved through gl_settings
 * and by group, the way the screens resolve them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, count, createOrder } from './helpers.mjs';
import { voidOrder } from '../../src/lib/db/orders.mjs';
import { syncOrderJournals } from '../../src/lib/accounts/post.mjs';
import {
    postManualJournal, cleanLines, MANUAL_SOURCE_TYPE, MANUAL_VOUCHER_TYPE,
    OPENING_REFERENCE, OPENING_DESCRIPTION,
} from '../../src/app/accounts/journals/new/manualJournal.mjs';
import { unpostedOrders, unpostedPayments, brokenJournals, legacyExpenses } from '../../src/app/accounts/health/gaps.mjs';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const DAY = '2026-03-15';
let fx;
let original;
let acct;   // { cash, bank, equity } resolved, never numbered
let inactiveId;

const counter = async (type, day) =>
    Number((await one(
        'SELECT last_no FROM gl_voucher_counters WHERE branch_id = 1 AND voucher_type = ? AND day = ?', [type, day],
    ))?.last_no ?? 0);

before(async () => {
    await acquireSuiteLock();
    fx = await resetDb();

    const settings = await one('SELECT * FROM gl_settings WHERE id = 1');
    assert.ok(settings, 'gl_settings has no row — migration 006 seeds it');
    original = { start_date: ymd(settings.start_date), posting_enabled: settings.posting_enabled };
    await q("UPDATE gl_settings SET posting_enabled = 1, start_date = '2000-01-01' WHERE id = 1");

    const link = async (type, ref) =>
        (await one('SELECT account_id FROM gl_links WHERE link_type = ? AND ref_id = ?', [type, ref]))?.account_id;
    // Two distinct asset accounts a JV can move money between, plus the
    // equity account opening balances post against.
    const cash = await link('payment_method', 'cash');
    const [other] = await q(
        `SELECT id FROM accounts WHERE account_group = 'asset' AND is_active = 1 AND id <> ?
          ORDER BY account_number LIMIT 1`, [cash],
    );
    acct = { cash: Number(cash), bank: Number(other.id), equity: Number(settings.opening_equity_account_id) };
    for (const [k, v] of Object.entries(acct)) assert.ok(v, `no account resolved for ${k}`);

    // One deliberately inactive, non-system account for the refusal test.
    const [row] = await q(
        `SELECT id FROM accounts WHERE is_system = 0 AND is_active = 1 AND account_group = 'expense'
          ORDER BY account_number DESC LIMIT 1`,
    );
    inactiveId = Number(row.id);
    await q('UPDATE accounts SET is_active = 0 WHERE id = ?', [inactiveId]);
});

after(async () => {
    await q('UPDATE accounts SET is_active = 1 WHERE id = ?', [inactiveId]);
    await q('UPDATE gl_settings SET posting_enabled = ?, start_date = ? WHERE id = 1',
        [original.posting_enabled, original.start_date]);
    await closeDb();
});

test('1. a balanced JV posts once: header, lines, audit, and the voucher number minted for its day', async () => {
    const before = await counter(MANUAL_VOUCHER_TYPE, DAY);
    const posted = await postManualJournal({
        businessDate: DAY,
        description: 'Cash banked',
        reference: 'DEP-001',
        notes: 'Friday takings',
        lines: [
            { account_id: acct.bank, debit: '5000', credit: '', memo: 'to bank' },
            { account_id: acct.cash, debit: '', credit: 5000, memo: 'from drawer' },
        ],
        userId: fx.users.admin,
    });

    assert.match(posted.voucher_no, /^JV-260315-\d{4}$/);
    assert.equal(await counter(MANUAL_VOUCHER_TYPE, DAY), before + 1);

    const j = await one('SELECT * FROM gl_journals WHERE id = ?', [posted.id]);
    assert.equal(j.voucher_type, MANUAL_VOUCHER_TYPE);
    assert.equal(j.source_type, MANUAL_SOURCE_TYPE);
    assert.equal(j.source_id, posted.voucher_no, 'a manual voucher is keyed on its own number');
    assert.equal(j.status, 'posted');
    assert.equal(ymd(j.business_date), DAY);
    assert.equal(j.description, 'Cash banked');
    assert.equal(j.reference, 'DEP-001');
    assert.equal(j.created_by, fx.users.admin, 'the person who posted it is on the header');
    assert.equal(money(j.debit_total), 5000);
    assert.equal(money(j.credit_total), 5000);

    const lines = await q('SELECT * FROM gl_journal_lines WHERE journal_id = ? ORDER BY id', [posted.id]);
    assert.equal(lines.length, 2);
    assert.deepEqual(
        lines.map((l) => [Number(l.account_id), money(l.debit), money(l.credit), l.memo]),
        [[acct.bank, 5000, 0, 'to bank'], [acct.cash, 0, 5000, 'from drawer']],
    );

    const auditRow = await one("SELECT * FROM audit_log WHERE action = 'gl_post_manual' ORDER BY id DESC LIMIT 1");
    assert.ok(auditRow, 'posting a JV is audited in the same transaction');
    assert.equal(auditRow.staff_id, fx.users.admin);
    assert.equal(ymd(auditRow.business_date), DAY);
    assert.equal(auditRow.details.voucher_no, posted.voucher_no);
    assert.equal(auditRow.details.notes, 'Friday takings', 'notes live in the audit row (the header has no column)');
    assert.equal(auditRow.details.lines.length, 2);

    assert.deepEqual(await brokenJournals(), [], 'a fresh JV never shows on the broken list');
});

test('2. an unbalanced voucher is refused and leaves nothing behind — not even a voucher number', async () => {
    const journals = await count('SELECT COUNT(*) AS n FROM gl_journals');
    const audits = await count('SELECT COUNT(*) AS n FROM audit_log');
    const before = await counter(MANUAL_VOUCHER_TYPE, DAY);

    await assert.rejects(
        postManualJournal({
            businessDate: DAY, description: 'Wrong', userId: fx.users.admin,
            lines: [
                { account_id: acct.bank, debit: 1000 },
                { account_id: acct.cash, credit: 999.5 },
            ],
        }),
        /Out of balance by Rs 0\.5/,
    );

    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals'), journals);
    assert.equal(await count('SELECT COUNT(*) AS n FROM audit_log'), audits);
    assert.equal(await counter(MANUAL_VOUCHER_TYPE, DAY), before, 'a refusal mints no number');
});

test('3. the shared rules refuse what the ledger would refuse, in the words a person should read', () => {
    const ok = cleanLines([
        { account_id: acct.bank, debit: '120.005', credit: '' },   // rounds to paise
        { account_id: acct.cash, debit: '', credit: 120.01 },
        { account_id: '', debit: '', credit: '', memo: '' },         // an untouched row is ignored
    ]);
    assert.equal(ok.lines.length, 2);
    assert.equal(ok.debitTotal, 120.01);

    assert.throws(() => cleanLines([
        { account_id: acct.bank, debit: 10, credit: 10 },
        { account_id: acct.cash, credit: 0 },
    ]), /Line 1: a line carries a debit or a credit, never both/);
    assert.throws(() => cleanLines([
        { account_id: acct.bank, debit: 10 },
        { account_id: 0, credit: 10 },
    ]), /Line 2: pick an account/);
    assert.throws(() => cleanLines([
        { account_id: acct.bank, debit: -10 },
        { account_id: acct.cash, credit: -10 },
    ]), /cannot be negative/);
    assert.throws(() => cleanLines([{ account_id: acct.bank, debit: 10 }]), /at least two lines/);
    assert.throws(() => cleanLines([]), /at least two lines/);
    assert.throws(() => cleanLines([
        { account_id: acct.bank, debit: 10 },
        { account_id: acct.cash, credit: 10 },
        { account_id: acct.equity, debit: '', credit: '' },
    ]), /Line 3: enter a debit or a credit/);
});

test('4. an inactive account, a missing description and no user are each refused before anything is written', async () => {
    const journals = await count('SELECT COUNT(*) AS n FROM gl_journals');
    const base = {
        businessDate: DAY, description: 'x', userId: fx.users.admin,
        lines: [{ account_id: acct.bank, debit: 10 }, { account_id: acct.cash, credit: 10 }],
    };
    await assert.rejects(
        postManualJournal({ ...base, lines: [{ account_id: inactiveId, debit: 10 }, { account_id: acct.cash, credit: 10 }] }),
        /is inactive and cannot be posted to/,
    );
    await assert.rejects(postManualJournal({ ...base, description: '   ' }), /A description is needed/);
    await assert.rejects(postManualJournal({ ...base, userId: null }), /signed-in user/);
    await assert.rejects(
        postManualJournal({ ...base, lines: [{ account_id: 999999999, debit: 10 }, { account_id: acct.cash, credit: 10 }] }),
        /no longer exists/,
    );
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals'), journals);
});

test('5. opening balances are an ordinary JV against the opening-equity account, dated before the ledger start', async () => {
    const posted = await postManualJournal({
        businessDate: '2026-01-31',
        description: OPENING_DESCRIPTION,
        reference: OPENING_REFERENCE,
        lines: [
            { account_id: acct.cash, debit: 25000, memo: 'Float' },
            { account_id: acct.bank, debit: 400000, memo: 'Bank balance' },
            { account_id: acct.equity, credit: 425000, memo: 'Opening balance equity' },
        ],
        userId: fx.users.admin,
    });
    assert.match(posted.voucher_no, /^JV-260131-0001$/);
    const j = await one('SELECT * FROM gl_journals WHERE id = ?', [posted.id]);
    assert.equal(j.reference, OPENING_REFERENCE);
    assert.equal(money(j.debit_total), 425000);
    const eq = await one(
        'SELECT credit FROM gl_journal_lines WHERE journal_id = ? AND account_id = ?', [posted.id, acct.equity],
    );
    assert.equal(money(eq.credit), 425000);
});

test('6. Health names a settled bill until the engine books it, then stops; a void re-opens it until reversed', async () => {
    // The engine is NOT fired here (the hook lives in orderActions.js), so
    // this bill is exactly what a failed post-commit posting looks like.
    const order = await createOrder(
        [{ name: 'Test Chicken Karahi', price: 1200, qty: 1, id: fx.menuItem.id }],
        { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
        randomUUID(),
    );

    let orders = await unpostedOrders();
    let payments = await unpostedPayments();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, order.id);
    assert.equal(orders[0].gap, 'no sale journal');
    assert.equal(orders[0].invoice_number, order.invoice_number);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].order_id, order.id);
    assert.equal(money(payments[0].amount), order.total);

    // Repost — the same call the Health button awaits.
    const result = await syncOrderJournals(order.id, { userId: fx.users.admin });
    assert.equal(result.status, 'posted', result.reason);
    assert.equal(result.vouchers.length, 2);
    assert.equal(
        (await one("SELECT created_by FROM gl_journals WHERE source_type = 'order_sale' AND source_id = ?", [order.id])).created_by,
        fx.users.admin, 'a manual repost carries the person who pressed the button',
    );
    assert.deepEqual(await unpostedOrders(), []);
    assert.deepEqual(await unpostedPayments(), []);

    // Voided after posting: the negative payment and the missing reversal
    // both surface, under their own words, until the engine runs again.
    await voidOrder(order.id, 'test void', 'tester');
    orders = await unpostedOrders();
    payments = await unpostedPayments();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].gap, 'void not reversed');
    assert.equal(payments.length, 1);
    assert.ok(money(payments[0].amount) < 0, 'the void\'s negative payments row is the gap');

    const again = await syncOrderJournals(order.id, { userId: fx.users.admin });
    assert.equal(again.status, 'posted', again.reason);
    assert.equal(again.vouchers.length, 2, 'settlement reversal + sale reversal');
    assert.deepEqual(await unpostedOrders(), []);
    assert.deepEqual(await unpostedPayments(), []);
    assert.deepEqual(await brokenJournals(), [], 'every journal the engine wrote balances');
});

test('7. a bill voided before it ever posted is not a gap on the bills list, but its payments still are', async () => {
    const order = await createOrder(
        [{ name: 'Test Chicken Karahi', price: 1200, qty: 1, id: fx.menuItem.id }],
        { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
        randomUUID(),
    );
    await voidOrder(order.id, 'wrong table', 'tester');

    assert.deepEqual(await unpostedOrders(), [], 'nothing to book for a sale that was undone before booking');
    const payments = await unpostedPayments();
    assert.equal(payments.length, 2, 'the payment and its reversal both want a settlement journal');

    const result = await syncOrderJournals(order.id, { userId: fx.users.admin });
    assert.equal(result.status, 'posted', result.reason);
    assert.equal(result.vouchers.length, 2, 'two SMs that net to nothing; no SV');
    assert.deepEqual(await unpostedPayments(), []);
    assert.equal(
        await count("SELECT COUNT(*) AS n FROM gl_journals WHERE voucher_type = 'SV' AND reference = ?", [order.invoice_number]),
        0,
    );
});

test('8. the broken-journals list catches a header that disagrees with its lines', async () => {
    // The CHECK forbids Dr <> Cr on the header and the poster asserts
    // lines-vs-header, so the only way to get here is by hand — which is
    // what the list is for.
    const r = await q(
        `INSERT INTO gl_journals (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
                                  description, status, debit_total, credit_total)
         VALUES (1, ?, 'JV', 'JV-TEST-BROKEN', 'manual', 'JV-TEST-BROKEN', 'tampered', 'posted', 100, 100)`,
        [DAY],
    );
    const id = r.insertId;
    await q('INSERT INTO gl_journal_lines (journal_id, account_id, debit, credit) VALUES (?, ?, 100, 0), (?, ?, 0, 90)',
        [id, acct.bank, id, acct.cash]);

    const broken = await brokenJournals();
    assert.equal(broken.length, 1);
    assert.equal(broken[0].voucher_no, 'JV-TEST-BROKEN');
    assert.equal(money(broken[0].line_credit), 90);
    assert.equal(money(broken[0].credit_total), 100);

    await q('DELETE FROM gl_journals WHERE id = ?', [id]);
    assert.deepEqual(await brokenJournals(), []);
});

test('9. Health names an expense typed on the Expenses screen since the ledger began — it reaches the drawer, never the books', async () => {
    assert.deepEqual(await legacyExpenses(), []);
    const chit = await q(
        `INSERT INTO expenses (business_date, description, payee, amount, paid_from, status)
         VALUES (?, 'Mandi run', 'Sabzi wala', 1250, 'drawer', 'paid')`, [DAY],
    );
    const old = await q(
        `INSERT INTO expenses (business_date, description, amount, paid_from, status)
         VALUES ('1999-12-31', 'Before the ledger', 5, 'drawer', 'paid')`,
    );
    try {
        const listed = await legacyExpenses();
        assert.equal(listed.length, 1, 'only rows since the ledger start date');
        assert.equal(listed[0].id, chit.insertId);
        assert.equal(ymd(listed[0].business_date), DAY);
        assert.equal(listed[0].description, 'Mandi run');
        assert.equal(money(listed[0].amount), 1250);
        assert.equal(listed[0].paid_from, 'drawer');
        assert.equal(listed[0].status, 'paid');
    } finally {
        await q('DELETE FROM expenses WHERE id IN (?, ?)', [chit.insertId, old.insertId]);
    }
    assert.deepEqual(await legacyExpenses(), []);
});

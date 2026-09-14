/*
 * Expense vouchers, driven through the kernel the actions wrap: a posted
 * voucher must become ONE balanced EV journal on the accounts its codes
 * carry, project exactly one `expenses` row per line (so the drawer and the
 * handover see it), never project twice however the post is repeated, take
 * later payments as PV journals that flip its rows to paid, and reverse
 * into contra journals that leave the books at zero and the drawer clean.
 *
 * Account NUMBERS appear only in the fixture setup below, where the test's
 * own expense codes are seeded; everything the engine must use is then
 * resolved the way the engine resolves it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSuiteLock, resetDb, closeDb, q, one, count } from './helpers.mjs';
import { pool, withTransaction } from '../../src/lib/db/pool.mjs';
import {
    saveDraft, postVoucher, addPayment, reverseVoucher, deleteDraft, loadVoucher,
    EXPENSE_SOURCE_TYPES,
} from '../../src/lib/accounts/expensePost.mjs';
import { legacyExpenses } from '../../src/app/accounts/health/gaps.mjs';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const todayKarachi = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

let fx;        // resetDb fixtures (users)
let original;  // gl_settings switches as found, restored in after()
let acct;      // accounts resolved through links and the seeded codes
let codes;     // the two expense codes this suite seeds
let category;  // their category

const tx = (fn) => withTransaction(fn);
const linesOf = (journalId) =>
    q('SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id', [journalId]);
const sumSide = (lines, side) => money(lines.reduce((s, l) => s + Number(l[side]), 0));
const shape = (lines) => lines
    .map((l) => [Number(l.account_id), money(l.debit), money(l.credit)])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
const journalsFor = (voucherNo) => q('SELECT * FROM gl_journals WHERE reference = ? ORDER BY id', [voucherNo]);
const projectedFor = async (voucherId) => q(
    `SELECT e.* FROM expenses e
       JOIN expense_voucher_lines l ON l.id = e.voucher_line_id
      WHERE l.voucher_id = ? ORDER BY l.id`,
    [voucherId],
);

/* The drawer's own filter (src/app/drawer/actions.js sessionFlows), restated:
 * what a session opened at `since` would subtract from expected cash. */
const drawerExpensesSince = async (since) => money((await one(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
      WHERE paid_from = 'drawer' AND status = 'paid' AND created_at >= ?`,
    [since],
)).total);

const assertBalanced = async (journal, label = journal.voucher_no) => {
    const lines = await linesOf(journal.id);
    const dr = sumSide(lines, 'debit');
    const cr = sumSide(lines, 'credit');
    assert.equal(dr, cr, `SUM(debit) !== SUM(credit) on ${label}`);
    assert.equal(money(journal.debit_total), dr, `header debit_total !== lines on ${label}`);
    assert.equal(money(journal.credit_total), cr, `header credit_total !== lines on ${label}`);
    for (const l of lines) {
        assert.ok((money(l.debit) > 0) !== (money(l.credit) > 0), `a line carries both or neither side on ${label}`);
    }
    return lines;
};

/* Net position per account across every journal that references a voucher. */
const netByAccount = async (voucherNo) => {
    const rows = await q(
        `SELECT l.account_id, SUM(l.debit) - SUM(l.credit) AS net
           FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id
          WHERE j.reference = ? GROUP BY l.account_id`,
        [voucherNo],
    );
    return Object.fromEntries(rows.map((r) => [r.account_id, money(r.net)]));
};

before(async () => {
    await acquireSuiteLock();
    fx = await resetDb();

    const settings = await one('SELECT * FROM gl_settings WHERE id = 1');
    assert.ok(settings, 'gl_settings has no row — migration 006 seeds it');
    original = { start_date: ymd(settings.start_date), posting_enabled: settings.posting_enabled };
    await q("UPDATE gl_settings SET posting_enabled = 1, start_date = '2000-01-01' WHERE id = 1");

    const link = async (type, ref) =>
        (await one('SELECT account_id FROM gl_links WHERE link_type = ? AND ref_id = ?', [type, ref]))?.account_id ?? null;
    const byNumber = async (n) => (await one('SELECT id FROM accounts WHERE account_number = ?', [n]))?.id ?? null;
    acct = {
        cash: await link('payment_method', 'cash'),
        drawer: await link('expense_paid_from', 'drawer'),
        bank: await link('expense_paid_from', 'bank'),
        elec: await byNumber('7010'),
        gas: await byNumber('7020'),
        payable: await byNumber('2005'),
        // Two more payable accounts, for the test that moves a code's payable
        // under a posted voucher.
        accrued: await byNumber('2010'),
        wages: await byNumber('2020'),
    };
    for (const [k, v] of Object.entries(acct)) assert.ok(v, `no account resolved for ${k} — is the 006 seed present?`);
    assert.equal(acct.drawer, acct.cash, 'the seed pays drawer expenses from the account the till settles cash into');
    assert.notEqual(acct.bank, acct.cash);

    // One category and two codes of this suite's own, keyed on their UNIQUE
    // names so every run reseeds the same rows.
    await q(
        `INSERT INTO expense_categories (name, is_active) VALUES ('Test Utilities', 1) AS new_row
         ON DUPLICATE KEY UPDATE is_active = 1`,
    );
    category = await one("SELECT id FROM expense_categories WHERE name = 'Test Utilities'");
    for (const [code, name, account] of [['TST-ELEC', 'Test Electricity', acct.elec], ['TST-GAS', 'Test Gas', acct.gas]]) {
        await q(
            `INSERT INTO expense_codes (code, name, category_id, account_id, payable_account_id, is_active)
             VALUES (?, ?, ?, ?, ?, 1) AS new_row
             ON DUPLICATE KEY UPDATE name = new_row.name, category_id = new_row.category_id,
               account_id = new_row.account_id, payable_account_id = new_row.payable_account_id, is_active = 1`,
            [code, name, category.id, account, acct.payable],
        );
    }
    codes = {
        elec: (await one("SELECT id FROM expense_codes WHERE code = 'TST-ELEC'")).id,
        gas: (await one("SELECT id FROM expense_codes WHERE code = 'TST-GAS'")).id,
    };
});

after(async () => {
    await q("DELETE FROM expenses WHERE expense_code_id IN (SELECT id FROM expense_codes WHERE code LIKE 'TST-%')");
    await q("DELETE FROM expense_voucher_lines WHERE expense_code_id IN (SELECT id FROM expense_codes WHERE code LIKE 'TST-%')");
    await q("DELETE FROM expense_codes WHERE code LIKE 'TST-%'");
    await q("DELETE FROM expense_categories WHERE name = 'Test Utilities'");
    await q('UPDATE gl_settings SET posting_enabled = ?, start_date = ? WHERE id = 1',
        [original.posting_enabled, original.start_date]);
    await closeDb();
});

const day = todayKarachi();

test('a. a two-line voucher paid in full from cash: one balanced EV, two paid rows the drawer counts', async () => {
    const since = new Date(Date.now() - 1000);
    const drawerBefore = await drawerExpensesSince(since);

    const id = await tx((conn) => saveDraft(conn, {
        business_date: day,
        remarks: 'K-Electric and SSGC',
        lines: [
            { expense_code_id: codes.elec, description: 'Bill for August', amount: '1500' },
            { expense_code_id: codes.gas, description: '', amount: 500.004 }, // rounds to paise
        ],
        payments: [{ account_id: acct.cash, amount: 2000, paid_on: day, reference: 'cash from drawer' }],
    }, fx.users.admin));

    const draft = await loadVoucher(pool, id);
    assert.equal(draft.status, 'draft');
    assert.match(draft.voucher_no, /^EV-\d{6}-\d{4}$/);
    assert.equal(draft.total, 2000);
    assert.equal(draft.paid_total, 2000);
    assert.equal(draft.journals.length, 0, 'a draft is not in the books');
    assert.equal(draft.expenses.length, 0, 'a draft is not projected');
    assert.equal(await count('SELECT COUNT(*) AS n FROM expenses WHERE voucher_line_id IS NOT NULL'), 0);

    const { voucher, journal } = await tx((conn) => postVoucher(conn, id, fx.users.admin));
    assert.equal(voucher.status, 'posted');
    assert.equal(voucher.posted_by, fx.users.admin);
    assert.ok(voucher.posted_at);
    assert.equal(money(voucher.total), 2000);
    assert.equal(money(voucher.paid_total), 2000);

    const journals = await journalsFor(voucher.voucher_no);
    assert.equal(journals.length, 1, 'exactly one journal for a fully-paid voucher');
    const ev = journals[0];
    assert.equal(ev.id, journal.id);
    assert.equal(ev.voucher_type, 'EV');
    assert.match(ev.voucher_no, /^EV-\d{6}-\d{4}$/);
    assert.equal(ev.source_type, EXPENSE_SOURCE_TYPES.voucher);
    assert.equal(ev.source_id, String(id));
    assert.equal(ymd(ev.business_date), day);
    assert.equal(ev.created_by, fx.users.admin, 'the person who posted is on the journal');
    assert.equal(ev.description, `Expense ${voucher.voucher_no} · K-Electric and SSGC`);
    const lines = await assertBalanced(ev);
    assert.deepEqual(shape(lines), shape([
        { account_id: acct.elec, debit: 1500, credit: 0 },
        { account_id: acct.gas, debit: 500, credit: 0 },
        { account_id: acct.cash, debit: 0, credit: 2000 },
    ]));
    assert.ok(!lines.some((l) => l.account_id === acct.payable), 'paid in full: no payable line');
    assert.equal(lines.find((l) => l.account_id === acct.elec).memo, 'TST-ELEC · Bill for August');
    assert.equal(lines.find((l) => l.account_id === acct.gas).memo, 'TST-GAS · Test Gas');

    // The projection: one row per line, traceable, categorised, paid from the drawer.
    const rows = await projectedFor(id);
    assert.equal(rows.length, 2);
    const voucherLines = await q('SELECT id FROM expense_voucher_lines WHERE voucher_id = ? ORDER BY id', [id]);
    assert.deepEqual(rows.map((r) => r.voucher_line_id), voucherLines.map((l) => l.id));
    for (const r of rows) {
        assert.equal(r.status, 'paid');
        assert.equal(r.paid_from, 'drawer');
        assert.ok(r.paid_at, 'a paid row carries paid_at');
        assert.equal(ymd(r.business_date), day);
        assert.equal(r.category_id, category.id);
        assert.equal(r.payee, 'K-Electric and SSGC');
    }
    assert.equal(rows[0].description, 'TST-ELEC · Bill for August');
    assert.equal(rows[0].expense_code_id, codes.elec);
    assert.equal(money(rows[0].amount), 1500);
    assert.equal(rows[1].description, 'TST-GAS · Test Gas', 'no description: the code name stands in');
    assert.equal(money(rows[1].amount), 500);
    assert.equal(await drawerExpensesSince(since), money(drawerBefore + 2000), 'the drawer opened before the post now expects 2,000 less');
    assert.deepEqual(await legacyExpenses(), [], 'a projected row is in the ledger, so Health has nothing to name');

    const auditRow = await one("SELECT * FROM audit_log WHERE action = 'expense_voucher_post' ORDER BY id DESC LIMIT 1");
    assert.equal(auditRow.staff_id, fx.users.admin);
    assert.equal(auditRow.details.voucher_id, id);
    assert.equal(auditRow.details.projected.length, 2);

    // Read back as the screen will: journals and projection attached.
    const full = await loadVoucher(pool, id);
    assert.equal(full.journals.length, 1);
    assert.equal(full.journals[0].voucher_no, ev.voucher_no);
    assert.equal(full.expenses.length, 2);
    assert.equal(full.owed, 0);
});

let unpaid; // the voucher tests b and d share

test('b. an unpaid voucher credits the payable; each payment is a PV that flips the rows it completes', async () => {
    const id = await tx((conn) => saveDraft(conn, {
        business_date: day, remarks: 'Pay later',
        lines: [
            { expense_code_id: codes.elec, description: 'Sept bill', amount: 700 },
            { expense_code_id: codes.gas, description: 'Sept bill', amount: 300 },
        ],
        payments: [],
    }, fx.users.admin));
    const { voucher } = await tx((conn) => postVoucher(conn, id, fx.users.admin));
    unpaid = voucher;
    assert.equal(money(voucher.paid_total), 0);

    const [ev] = await journalsFor(voucher.voucher_no);
    const evLines = await assertBalanced(ev);
    assert.deepEqual(shape(evLines), shape([
        { account_id: acct.elec, debit: 700, credit: 0 },
        { account_id: acct.gas, debit: 300, credit: 0 },
        { account_id: acct.payable, debit: 0, credit: 1000 },
    ]), 'one payable credit: both codes share the payable account');

    let rows = await projectedFor(id);
    assert.equal(rows.length, 2);
    for (const r of rows) {
        assert.equal(r.status, 'payable');
        assert.equal(r.paid_at, null);
        assert.equal(r.paid_from, 'other', 'nothing has left any account yet');
    }
    assert.ok(await one('SELECT id FROM expense_vouchers WHERE id = ? AND status = ? AND paid_total < total', [id, 'posted']),
        'this is what the payables report lists');

    // Too much is refused; the document is untouched.
    await assert.rejects(
        tx((conn) => addPayment(conn, id, { account_id: acct.cash, amount: 1001, paid_on: day }, fx.users.admin)),
        /more than the Rs\. 1,000\.00 still owed/,
    );
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_payments WHERE voucher_id = ?', [id]), 0);

    // 700 from the drawer completes line 1 only.
    const since = new Date(Date.now() - 1000);
    const drawerBefore = await drawerExpensesSince(since);
    const first = await tx((conn) => addPayment(conn, id, {
        account_id: acct.cash, amount: 700, paid_on: day, reference: 'petty cash',
    }, fx.users.admin));
    assert.equal(money(first.voucher.paid_total), 700);
    const pv1 = (await journalsFor(voucher.voucher_no)).find((j) => j.id === first.journal.id);
    assert.equal(pv1.voucher_type, 'PV');
    assert.match(pv1.voucher_no, /^PV-\d{6}-\d{4}$/);
    assert.equal(pv1.source_type, EXPENSE_SOURCE_TYPES.payment);
    assert.equal(pv1.source_id, String(first.payment_id));
    assert.deepEqual(shape(await assertBalanced(pv1)), shape([
        { account_id: acct.payable, debit: 700, credit: 0 },
        { account_id: acct.cash, debit: 0, credit: 700 },
    ]));
    rows = await projectedFor(id);
    assert.equal(rows[0].status, 'paid');
    assert.equal(rows[0].paid_from, 'drawer');
    assert.ok(rows[0].paid_at);
    assert.ok(rows[0].created_at >= since, 'created_at moved to the payment, so the open drawer counts it');
    assert.equal(rows[1].status, 'payable');
    assert.equal(await drawerExpensesSince(since), money(drawerBefore + 700));

    // 300 from the bank completes line 2; the voucher is settled and leaves the payables list.
    const second = await tx((conn) => addPayment(conn, id, {
        account_id: acct.bank, amount: 300, paid_on: day, reference: 'IBFT 4471',
    }, fx.users.admin));
    assert.equal(money(second.voucher.paid_total), 1000);
    const pv2 = (await journalsFor(voucher.voucher_no)).find((j) => j.id === second.journal.id);
    assert.deepEqual(shape(await assertBalanced(pv2)), shape([
        { account_id: acct.payable, debit: 300, credit: 0 },
        { account_id: acct.bank, debit: 0, credit: 300 },
    ]));
    rows = await projectedFor(id);
    assert.equal(rows[1].status, 'paid');
    assert.equal(rows[1].paid_from, 'bank');
    assert.equal(await drawerExpensesSince(since), money(drawerBefore + 700), 'bank money never touches the drawer');
    assert.equal(await one('SELECT id FROM expense_vouchers WHERE id = ? AND paid_total < total', [id]), null);

    // Payable account nets to zero across EV + PV + PV.
    const net = await netByAccount(voucher.voucher_no);
    assert.equal(net[acct.payable], 0);
    assert.equal(net[acct.elec], 700);
    assert.equal(net[acct.gas], 300);
    assert.equal(net[acct.cash], -700);
    assert.equal(net[acct.bank], -300);

    await assert.rejects(
        tx((conn) => addPayment(conn, id, { account_id: acct.cash, amount: 1, paid_on: day }, fx.users.admin)),
        /already paid in full/,
    );
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'expense_voucher_pay'"), 2);
});

test('c. posting the same voucher twice — concurrently or again — cannot double the journal or the projection', async () => {
    const id = await tx((conn) => saveDraft(conn, {
        business_date: day, remarks: 'Race',
        lines: [{ expense_code_id: codes.gas, description: 'cylinder', amount: 250 }],
        payments: [{ account_id: acct.cash, amount: 250, paid_on: day }],
    }, fx.users.admin));

    const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => tx((conn) => postVoucher(conn, id, fx.users.admin))),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1, `exactly one poster wins: ${results.map((r) => r.status)}`);
    for (const r of results) {
        if (r.status === 'rejected') assert.match(r.reason.message, /already posted/);
    }
    const voucherNo = won[0].value.voucher.voucher_no;
    assert.equal((await journalsFor(voucherNo)).length, 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE source_type = ? AND source_id = ?',
        [EXPENSE_SOURCE_TYPES.voucher, String(id)]), 1);
    assert.equal((await projectedFor(id)).length, 1, 'one line, one projected row');

    // And a plain second attempt after the fact.
    await assert.rejects(tx((conn) => postVoucher(conn, id, fx.users.admin)), /already posted/);
    assert.equal((await projectedFor(id)).length, 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'expense_voucher_post' AND JSON_EXTRACT(details, '$.voucher_id') = ?", [id]), 1);

    // The database has the last word even if a poster got past the status
    // check: a second projection of the same line is a duplicate key.
    const line = await one('SELECT id, expense_code_id FROM expense_voucher_lines WHERE voucher_id = ?', [id]);
    await assert.rejects(
        q(`INSERT INTO expenses (business_date, description, amount, voucher_line_id) VALUES (?, 'twin', 1, ?)`, [day, line.id]),
        (e) => e.code === 'ER_DUP_ENTRY',
    );
});

test('d. a reversal writes contras on the open day, voids the document and deletes its projection', async () => {
    const id = unpaid.id;
    const before = await journalsFor(unpaid.voucher_no);
    assert.equal(before.length, 3, 'EV + two PVs from test b');
    assert.equal((await projectedFor(id)).length, 2);

    const result = await tx((conn) => reverseVoucher(conn, id, fx.users.admin, 'entered on the wrong month'));
    assert.equal(result.voucher.status, 'void');
    assert.equal(result.journals.length, 3, 'one contra per original journal');
    assert.equal(result.deleted_expenses, 2);

    const all = await journalsFor(unpaid.voucher_no);
    assert.equal(all.length, 6);
    const contras = all.filter((j) => j.source_type.endsWith('_reversal'));
    assert.equal(contras.length, 3);
    const openDay = ymd((await one('SELECT business_date FROM business_days WHERE closed_at IS NULL ORDER BY business_date DESC LIMIT 1'))?.business_date ?? day);
    for (const c of contras) {
        assert.equal(ymd(c.business_date), openDay, 'a correction lands on the open day');
        assert.match(c.description, /reversal .* · void of .* · entered on the wrong month$/);
        await assertBalanced(c);
        // Same lines as the original, sides swapped.
        const orig = all.find((j) => !j.source_type.endsWith('_reversal') && j.source_id === c.source_id && j.voucher_type === c.voucher_type);
        assert.ok(orig, `contra ${c.voucher_no} has an original`);
        assert.deepEqual(
            shape(await linesOf(c.id)),
            shape((await linesOf(orig.id)).map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit }))),
        );
    }
    for (const j of before) {
        const still = await one('SELECT status, debit_total FROM gl_journals WHERE id = ?', [j.id]);
        assert.equal(still.status, 'posted', 'the original journals are never touched');
        assert.equal(money(still.debit_total), money(j.debit_total));
    }

    const net = await netByAccount(unpaid.voucher_no);
    for (const [account, n] of Object.entries(net)) assert.equal(n, 0, `account ${account} does not net to zero`);

    assert.equal((await projectedFor(id)).length, 0, 'the projection is gone: the drawer stops counting it');
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_lines WHERE voucher_id = ?', [id]), 2, 'the document keeps its lines');
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_payments WHERE voucher_id = ?', [id]), 2);

    const auditRow = await one("SELECT * FROM audit_log WHERE action = 'expense_voucher_reverse' ORDER BY id DESC LIMIT 1");
    assert.equal(auditRow.staff_id, fx.users.admin);
    assert.equal(auditRow.details.deleted_expenses.length, 2, 'the deleted rows live on in the audit');
    assert.equal(auditRow.details.reason, 'entered on the wrong month');

    // A void voucher is finished: no second reversal, no payment, no delete.
    await assert.rejects(tx((conn) => reverseVoucher(conn, id, fx.users.admin)), /is void/);
    await assert.rejects(tx((conn) => addPayment(conn, id, { account_id: acct.cash, amount: 1, paid_on: day }, fx.users.admin)), /is void/);
    await assert.rejects(tx((conn) => deleteDraft(conn, id, fx.users.admin)), /Only a draft can be deleted/);
});

test('e. drafts are validated on the way in, editable in place, and deletable; posted ones are not', async () => {
    const base = { business_date: day, lines: [{ expense_code_id: codes.elec, amount: 100 }] };
    await assert.rejects(
        tx((conn) => saveDraft(conn, { ...base, payments: [{ account_id: acct.cash, amount: 150, paid_on: day }] })),
        /Payments \(Rs\. 150\.00\) exceed the voucher total \(Rs\. 100\.00\)/,
    );
    await assert.rejects(
        tx((conn) => saveDraft(conn, { ...base, payments: [{ account_id: acct.payable, amount: 50, paid_on: day }] })),
        /AP_PAID/, 'a payable account cannot pay an expense',
    );
    await assert.rejects(tx((conn) => saveDraft(conn, { ...base, business_date: 'yesterday' })), /valid voucher date/);
    await assert.rejects(tx((conn) => saveDraft(conn, { business_date: day, lines: [] })), /at least one expense line/);
    await assert.rejects(tx((conn) => saveDraft(conn, { business_date: day, lines: [{ expense_code_id: codes.elec, amount: 0 }] })), /amount above zero/);

    // Save, then edit in place: same number, new lines.
    const id = await tx((conn) => saveDraft(conn, base, fx.users.admin));
    const first = await one('SELECT * FROM expense_vouchers WHERE id = ?', [id]);
    await tx((conn) => saveDraft(conn, {
        id, business_date: day, remarks: 'edited',
        lines: [{ expense_code_id: codes.gas, amount: 40 }, { expense_code_id: codes.elec, amount: 60 }],
        payments: [{ account_id: acct.bank, amount: 25, paid_on: day, reference: 'chq 1' }],
    }, fx.users.admin));
    const edited = await one('SELECT * FROM expense_vouchers WHERE id = ?', [id]);
    assert.equal(edited.voucher_no, first.voucher_no, 'editing keeps the number');
    assert.equal(edited.status, 'draft');
    assert.equal(money(edited.total), 100);
    assert.equal(money(edited.paid_total), 25);
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_lines WHERE voucher_id = ?', [id]), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_payments WHERE voucher_id = ?', [id]), 1);
    assert.equal((await journalsFor(edited.voucher_no)).length, 0, 'still nothing in the books');

    // A draft may carry any payments; posting one whose payment stops part-
    // way through a line is refused, because the Expenses screen and the
    // drawer can only say "paid from X" or "owed" about a line, never "25 of
    // 40". The draft is left as it was.
    await assert.rejects(
        tx((conn) => postVoucher(conn, id, fx.users.admin)),
        /Line 1 \(TST-GAS, Rs\. 40\.00\) is only part-paid/,
    );
    assert.equal((await one('SELECT status FROM expense_vouchers WHERE id = ?', [id])).status, 'draft');
    assert.equal((await journalsFor(edited.voucher_no)).length, 0);
    assert.equal((await projectedFor(id)).length, 0);

    // Paid to the line boundary instead: the first line from the bank in
    // full, the second owed.
    await tx((conn) => saveDraft(conn, {
        id, business_date: day, remarks: 'edited',
        lines: [{ expense_code_id: codes.gas, amount: 40 }, { expense_code_id: codes.elec, amount: 60 }],
        payments: [{ account_id: acct.bank, amount: 40, paid_on: day, reference: 'chq 1' }],
    }, fx.users.admin));
    const { journal } = await tx((conn) => postVoucher(conn, id, fx.users.admin));
    assert.deepEqual(shape(await assertBalanced(await one('SELECT * FROM gl_journals WHERE id = ?', [journal.id]))), shape([
        { account_id: acct.gas, debit: 40, credit: 0 },
        { account_id: acct.elec, debit: 60, credit: 0 },
        { account_id: acct.bank, debit: 0, credit: 40 },
        { account_id: acct.payable, debit: 0, credit: 60 },
    ]));
    const rows = await projectedFor(id);
    assert.deepEqual(rows.map((r) => [r.status, r.paid_from]), [['paid', 'bank'], ['payable', 'other']], 'each line says one true thing');

    await assert.rejects(tx((conn) => saveDraft(conn, { id, ...base }, fx.users.admin)), /can no longer be edited/);
    await assert.rejects(tx((conn) => deleteDraft(conn, id, fx.users.admin)), /Only a draft can be deleted/);

    // A fresh draft can go.
    const gone = await tx((conn) => saveDraft(conn, base, fx.users.admin));
    const res = await tx((conn) => deleteDraft(conn, gone, fx.users.admin));
    assert.equal(res.deleted, gone);
    assert.equal(await one('SELECT id FROM expense_vouchers WHERE id = ?', [gone]), null);
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_lines WHERE voucher_id = ?', [gone]), 0, 'lines cascade');
    const auditRow = await one("SELECT * FROM audit_log WHERE action = 'expense_voucher_delete' ORDER BY id DESC LIMIT 1");
    assert.equal(auditRow.details.id, gone);
    assert.equal(auditRow.details.lines.length, 1);
});

test('f. the ledger start date and the posting switch are honoured; nothing half-posts', async () => {
    const id = await tx((conn) => saveDraft(conn, {
        business_date: '1999-12-31', lines: [{ expense_code_id: codes.elec, amount: 10 }],
    }, fx.users.admin));
    await assert.rejects(tx((conn) => postVoucher(conn, id, fx.users.admin)), /ledger starts on 2000-01-01/);
    assert.equal((await one('SELECT status FROM expense_vouchers WHERE id = ?', [id])).status, 'draft');
    assert.equal((await projectedFor(id)).length, 0);

    await q('UPDATE gl_settings SET posting_enabled = 0 WHERE id = 1');
    try {
        const ok = await tx((conn) => saveDraft(conn, { business_date: day, lines: [{ expense_code_id: codes.elec, amount: 10 }] }, fx.users.admin));
        await assert.rejects(tx((conn) => postVoucher(conn, ok, fx.users.admin)), /switched off/);
        assert.equal((await one('SELECT status FROM expense_vouchers WHERE id = ?', [ok])).status, 'draft');
    } finally {
        await q('UPDATE gl_settings SET posting_enabled = 1 WHERE id = 1');
    }

    // A code with no payable account can only be posted paid in full.
    await q('UPDATE expense_codes SET payable_account_id = NULL WHERE id = ?', [codes.gas]);
    try {
        const bare = await tx((conn) => saveDraft(conn, { business_date: day, lines: [{ expense_code_id: codes.gas, amount: 10 }] }, fx.users.admin));
        await assert.rejects(tx((conn) => postVoucher(conn, bare, fx.users.admin)), /has no payable account/);
        assert.equal((await journalsFor((await one('SELECT voucher_no FROM expense_vouchers WHERE id = ?', [bare])).voucher_no)).length, 0);
    } finally {
        await q('UPDATE expense_codes SET payable_account_id = ? WHERE id = ?', [acct.payable, codes.gas]);
    }
});

test('g. a line paid from two sources, or a payment that stops mid-line, is refused — the drawer is never off by a part nobody can name', async () => {
    const since = new Date(Date.now() - 1000);
    const drawerBefore = await drawerExpensesSince(since);
    const voucherNoOf = async (id) => (await one('SELECT voucher_no FROM expense_vouchers WHERE id = ?', [id])).voucher_no;

    // One 10,000 line paid 6,000 from the bank and 4,000 from the drawer:
    // whichever source the row named, the drawer would be off by the other.
    const split = await tx((conn) => saveDraft(conn, {
        business_date: day, lines: [{ expense_code_id: codes.elec, amount: 10000 }],
        payments: [
            { account_id: acct.bank, amount: 6000, paid_on: day },
            { account_id: acct.cash, amount: 4000, paid_on: day },
        ],
    }, fx.users.admin));
    await assert.rejects(tx((conn) => postVoucher(conn, split, fx.users.admin)), /Line 1 \(TST-ELEC\) is paid from bank and drawer/);
    assert.equal((await journalsFor(await voucherNoOf(split))).length, 0);
    assert.equal((await projectedFor(split)).length, 0);

    // Two 3,000 lines against one 4,000 drawer payment: the second line is
    // part-paid, and the drawer would miss the 1,000 that reached it.
    const straddle = await tx((conn) => saveDraft(conn, {
        business_date: day,
        lines: [{ expense_code_id: codes.elec, amount: 3000 }, { expense_code_id: codes.gas, amount: 3000 }],
        payments: [{ account_id: acct.cash, amount: 4000, paid_on: day }],
    }, fx.users.admin));
    await assert.rejects(tx((conn) => postVoucher(conn, straddle, fx.users.admin)), /Line 2 \(TST-GAS, Rs\. 3,000\.00\) is only part-paid/);
    assert.equal((await journalsFor(await voucherNoOf(straddle))).length, 0);
    assert.equal(await drawerExpensesSince(since), drawerBefore, 'a refused post moves nothing');

    // The same money, said honestly: two lines, each paid in full from one
    // place. The drawer expects exactly the cash that left it.
    const honest = await tx((conn) => saveDraft(conn, {
        business_date: day,
        lines: [
            { expense_code_id: codes.elec, description: 'bank half', amount: 6000 },
            { expense_code_id: codes.elec, description: 'drawer half', amount: 4000 },
        ],
        payments: [
            { account_id: acct.bank, amount: 6000, paid_on: day },
            { account_id: acct.cash, amount: 4000, paid_on: day },
        ],
    }, fx.users.admin));
    const { journal } = await tx((conn) => postVoucher(conn, honest, fx.users.admin));
    assert.deepEqual(shape(await assertBalanced(await one('SELECT * FROM gl_journals WHERE id = ?', [journal.id]))), shape([
        { account_id: acct.elec, debit: 10000, credit: 0 },
        { account_id: acct.bank, debit: 0, credit: 6000 },
        { account_id: acct.cash, debit: 0, credit: 4000 },
    ]));
    assert.deepEqual(
        (await projectedFor(honest)).map((r) => [r.status, r.paid_from, money(r.amount)]),
        [['paid', 'bank', 6000], ['paid', 'drawer', 4000]],
    );
    assert.equal(await drawerExpensesSince(since), money(drawerBefore + 4000));

    // A later payment lands on a line boundary too, and the refusal names
    // the amounts that would.
    const owed = await tx((conn) => saveDraft(conn, {
        business_date: day,
        lines: [{ expense_code_id: codes.elec, amount: 700 }, { expense_code_id: codes.gas, amount: 300 }],
        payments: [],
    }, fx.users.admin));
    await tx((conn) => postVoucher(conn, owed, fx.users.admin));
    await assert.rejects(
        tx((conn) => addPayment(conn, owed, { account_id: acct.cash, amount: 500, paid_on: day }, fx.users.admin)),
        /Rs\. 500\.00 would leave line 1 \(TST-ELEC\) part-paid\. A payment clears whole lines\. Pay Rs\. 700\.00 or Rs\. 1,000\.00\./,
    );
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_payments WHERE voucher_id = ?', [owed]), 0, 'a refused payment is not recorded');
    assert.equal(money((await one('SELECT paid_total FROM expense_vouchers WHERE id = ?', [owed])).paid_total), 0);
    assert.equal((await journalsFor(await voucherNoOf(owed))).length, 1, 'the EV alone');

    await tx((conn) => addPayment(conn, owed, { account_id: acct.cash, amount: 1000, paid_on: day }, fx.users.admin));
    assert.deepEqual((await projectedFor(owed)).map((r) => [r.status, r.paid_from]), [['paid', 'drawer'], ['paid', 'drawer']]);
    assert.equal(await drawerExpensesSince(since), money(drawerBefore + 4000 + 1000));
    assert.equal(await one('SELECT id FROM expense_vouchers WHERE id = ? AND paid_total < total', [owed]), null);
});

test('h. nothing posts ahead of the books: a voucher or a payment dated after the open day is refused', async () => {
    const future = '2031-01-01';
    const id = await tx((conn) => saveDraft(conn, {
        business_date: future, lines: [{ expense_code_id: codes.elec, amount: 10 }],
    }, fx.users.admin));
    await assert.rejects(
        tx((conn) => postVoucher(conn, id, fx.users.admin)),
        /The voucher date cannot be after \d{4}-\d{2}-\d{2}\. Nothing posts ahead of the books/,
    );
    assert.equal((await one('SELECT status FROM expense_vouchers WHERE id = ?', [id])).status, 'draft');
    assert.equal((await projectedFor(id)).length, 0);

    const posted = await tx((conn) => saveDraft(conn, {
        business_date: day, lines: [{ expense_code_id: codes.elec, amount: 10 }],
    }, fx.users.admin));
    await tx((conn) => postVoucher(conn, posted, fx.users.admin));
    await assert.rejects(
        tx((conn) => addPayment(conn, posted, { account_id: acct.cash, amount: 10, paid_on: future }, fx.users.admin)),
        /The payment date cannot be after \d{4}-\d{2}-\d{2}/,
    );
    assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_payments WHERE voucher_id = ?', [posted]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE business_date = ?', [future]), 0, 'nothing landed in 2031');
});

test('i. a payment clears the payable the EV credited, whatever the code points at now; a code that drifted off it is refused', async () => {
    // One payable on the voucher: the PV debits it even after the code has
    // been pointed elsewhere (by hand here — the screen refuses the move).
    const single = await tx((conn) => saveDraft(conn, {
        business_date: day, lines: [{ expense_code_id: codes.elec, amount: 500 }], payments: [],
    }, fx.users.admin));
    const { voucher: sv } = await tx((conn) => postVoucher(conn, single, fx.users.admin));
    await q('UPDATE expense_codes SET payable_account_id = ? WHERE id = ?', [acct.accrued, codes.elec]);
    try {
        const paid = await tx((conn) => addPayment(conn, single, { account_id: acct.cash, amount: 500, paid_on: day }, fx.users.admin));
        assert.deepEqual(shape(await assertBalanced(await one('SELECT * FROM gl_journals WHERE id = ?', [paid.journal.id]))), shape([
            { account_id: acct.payable, debit: 500, credit: 0 },
            { account_id: acct.cash, debit: 0, credit: 500 },
        ]), 'the PV debits the account the EV credited, not the code\'s new one');
        const net = await netByAccount(sv.voucher_no);
        assert.equal(net[acct.payable], 0, 'the liability is cleared where it was booked');
        assert.equal(net[acct.accrued] ?? 0, 0, 'the re-pointed account is never touched');
    } finally {
        await q('UPDATE expense_codes SET payable_account_id = ? WHERE id = ?', [acct.payable, codes.elec]);
    }

    // Two payables on one voucher: each line's code must still point at one
    // of them; a code moved off both is refused rather than guessed.
    await q('UPDATE expense_codes SET payable_account_id = ? WHERE id = ?', [acct.accrued, codes.gas]);
    try {
        const two = await tx((conn) => saveDraft(conn, {
            business_date: day,
            lines: [{ expense_code_id: codes.elec, amount: 700 }, { expense_code_id: codes.gas, amount: 300 }],
            payments: [],
        }, fx.users.admin));
        const { voucher, journal } = await tx((conn) => postVoucher(conn, two, fx.users.admin));
        assert.deepEqual(shape(await assertBalanced(await one('SELECT * FROM gl_journals WHERE id = ?', [journal.id]))), shape([
            { account_id: acct.elec, debit: 700, credit: 0 },
            { account_id: acct.gas, debit: 300, credit: 0 },
            { account_id: acct.payable, debit: 0, credit: 700 },
            { account_id: acct.accrued, debit: 0, credit: 300 },
        ]));

        await q('UPDATE expense_codes SET payable_account_id = ? WHERE id = ?', [acct.wages, codes.gas]);
        await assert.rejects(
            tx((conn) => addPayment(conn, two, { account_id: acct.cash, amount: 1000, paid_on: day }, fx.users.admin)),
            /Expense code TST-GAS no longer points at the payable account voucher EV-.* was booked with/,
        );
        assert.equal(await count('SELECT COUNT(*) AS n FROM expense_voucher_payments WHERE voucher_id = ?', [two]), 0);

        await q('UPDATE expense_codes SET payable_account_id = ? WHERE id = ?', [acct.accrued, codes.gas]);
        const paid = await tx((conn) => addPayment(conn, two, { account_id: acct.cash, amount: 1000, paid_on: day }, fx.users.admin));
        assert.deepEqual(shape(await assertBalanced(await one('SELECT * FROM gl_journals WHERE id = ?', [paid.journal.id]))), shape([
            { account_id: acct.payable, debit: 700, credit: 0 },
            { account_id: acct.accrued, debit: 300, credit: 0 },
            { account_id: acct.cash, debit: 0, credit: 1000 },
        ]));
        const net = await netByAccount(voucher.voucher_no);
        assert.equal(net[acct.payable], 0);
        assert.equal(net[acct.accrued], 0);
        assert.equal(net[acct.wages] ?? 0, 0);
    } finally {
        await q('UPDATE expense_codes SET payable_account_id = ? WHERE id = ?', [acct.payable, codes.gas]);
    }
});

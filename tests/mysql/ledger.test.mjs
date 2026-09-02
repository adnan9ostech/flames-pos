/*
 * The general ledger's read model and its one correction, driven directly
 * through src/app/accounts/ledger/gl.mjs (the server actions in
 * journals/actions.js are thin permission-checked wrappers over it and need
 * a session cookie the suite does not have).
 *
 * Journals come from the real posting engine over orders the real verbs
 * settled, so the ledger being read is the one the till writes. As in
 * accounts.test.mjs, no account NUMBER appears here.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, count } from './helpers.mjs';
import { createOrder, voidOrder } from '../../src/lib/db/orders.mjs';
import { afterSettleGl, afterVoidGl, ORDER_SOURCE_TYPES } from '../../src/lib/accounts/post.mjs';
import {
    ledgerLines, journalList, journalById, accountOptions, reverseJournal,
    REVERSAL_SOURCE_TYPE, PAGE_SIZE,
} from '../../src/app/accounts/ledger/gl.mjs';
import { postManualJournal } from '../../src/app/accounts/journals/new/manualJournal.mjs';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const dayAfter = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const todayKarachi = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const sum = (rows, side) => money(rows.reduce((s, r) => s + Number(r[side]), 0));

let fx;
let original;
let acct;
let cashOrder;   // settled cash bill: SV + SM on its own day
let cardOrder;   // settled card bill: SV + SM, same day
let sv;          // the cash bill's sale journal (raw row)

before(async () => {
    await acquireSuiteLock();
    fx = await resetDb();

    const settings = await one('SELECT * FROM gl_settings WHERE id = 1');
    assert.ok(settings, 'gl_settings has no row — migration 006 seeds it');
    original = { start_date: ymd(settings.start_date), posting_enabled: settings.posting_enabled };
    await q("UPDATE gl_settings SET posting_enabled = 1, start_date = '2000-01-01' WHERE id = 1");
    // Two asset accounts a hand-written JV can move money between, for the
    // reversal tests: the drawer, and the next active asset account.
    const cash = (await one("SELECT account_id FROM gl_links WHERE link_type = 'payment_method' AND ref_id = 'cash'"))?.account_id;
    const [safe] = await q(
        `SELECT id FROM accounts WHERE account_group = 'asset' AND is_active = 1 AND id <> ?
          ORDER BY account_number LIMIT 1`, [cash],
    );
    acct = {
        guest: settings.guest_ledger_account_id, tax: settings.tax_payable_account_id,
        cash: Number(cash), safe: Number(safe.id),
    };
    for (const [k, v] of Object.entries(acct)) assert.ok(v, `no account resolved for ${k}`);

    cashOrder = await createOrder(
        [{ name: 'Test Chicken Karahi', price: 1200, qty: 2, id: fx.menuItem.id }],
        { order_type: 'dine-in', table_number: 'T1', payment_status: 'paid', payment_mode: 'cash', discount: 50 },
        randomUUID(),
    );
    cardOrder = await createOrder(
        [{ name: 'Card bill', price: 900, qty: 1 }],
        { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'card' },
        randomUUID(),
    );
    assert.equal((await afterSettleGl(cashOrder)).vouchers.length, 2);
    assert.equal((await afterSettleGl(cardOrder)).vouchers.length, 2);
    sv = await one("SELECT * FROM gl_journals WHERE source_type = 'order_sale' AND source_id = ?", [cashOrder.id]);
    assert.ok(sv);
});

after(async () => {
    await q('UPDATE gl_settings SET posting_enabled = ?, start_date = ? WHERE id = 1',
        [original.posting_enabled, original.start_date]);
    await closeDb();
});

test('a. the ledger lists every posted line for the day, balanced, with totals over the whole set', async () => {
    const day = cashOrder.business_date;
    const res = await ledgerLines({ from: day, to: day });
    assert.deepEqual(res.range, { from: day, to: day });

    const expected = await count(
        `SELECT COUNT(*) AS n FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id
          WHERE j.business_date = ? AND j.status = 'posted'`, [day],
    );
    assert.equal(res.rows.length, expected);
    assert.equal(res.totals.count, expected);
    assert.equal(res.hasMore, false);
    assert.equal(res.totals.debit, res.totals.credit, 'a ledger of balanced journals balances');
    assert.equal(sum(res.rows, 'debit'), res.totals.debit);
    assert.equal(sum(res.rows, 'credit'), res.totals.credit);

    // Every row carries what the screen shows, and never both sides.
    for (const r of res.rows) {
        assert.match(r.voucher_no, /^(SV|SM)-\d{6}-\d{4}$/);
        assert.match(r.account_number, /^\d{5}$/);
        assert.ok(r.account_name);
        assert.equal(r.business_date, day);
        assert.ok((r.debit > 0) !== (r.credit > 0), `line ${r.id} carries both or neither side`);
    }
    // Booked order: the cash bill's SV first, its SM, then the card bill's pair.
    const order = res.rows.map((r) => r.journal_id);
    assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

test('b. account and voucher-type filters narrow the set and the totals follow', async () => {
    const day = cashOrder.business_date;

    const guest = await ledgerLines({ from: day, to: day, accountId: acct.guest });
    assert.ok(guest.rows.length >= 4, 'two sales and two settlements each touch the guest ledger');
    assert.ok(guest.rows.every((r) => r.account_id === Number(acct.guest)));
    assert.equal(guest.totals.count, guest.rows.length);
    // Sales debit it, settlements credit it, for the same money: it nets to zero.
    assert.equal(guest.totals.debit, guest.totals.credit);
    assert.equal(guest.totals.debit, money(cashOrder.total + cardOrder.total));

    const sales = await ledgerLines({ from: day, to: day, voucherType: 'SV' });
    assert.ok(sales.rows.every((r) => r.voucher_type === 'SV'));
    assert.equal(sales.totals.debit, money(cashOrder.total + cashOrder.discount + cardOrder.total));

    const both = await ledgerLines({ from: day, to: day, voucherType: 'SM', accountId: acct.tax });
    assert.equal(both.rows.length, 0, 'a settlement never touches GST');
    assert.deepEqual(both.totals, { count: 0, debit: 0, credit: 0 });

    // A range that holds nothing, and an unknown type, are empty rather than errors.
    const nothing = await ledgerLines({ from: '2001-01-01', to: '2001-01-02' });
    assert.equal(nothing.rows.length, 0);
    const unfiltered = await ledgerLines({ from: day, to: day });
    const unknownType = await ledgerLines({ from: day, to: day, voucherType: 'XX' });
    assert.equal(unknownType.rows.length, unfiltered.rows.length, 'an unknown type means no type filter');
});

test('c. paging: limit/offset walk the set in order, hasMore says when to stop', async () => {
    const day = cashOrder.business_date;
    const all = await ledgerLines({ from: day, to: day });
    const first = await ledgerLines({ from: day, to: day }, { limit: 3, offset: 0 });
    const second = await ledgerLines({ from: day, to: day }, { limit: 3, offset: 3 });
    assert.equal(first.rows.length, 3);
    assert.equal(first.hasMore, all.rows.length > 3);
    assert.deepEqual(first.rows.map((r) => r.id), all.rows.slice(0, 3).map((r) => r.id));
    assert.deepEqual(second.rows.map((r) => r.id), all.rows.slice(3, 6).map((r) => r.id));
    assert.deepEqual(first.totals, all.totals, 'totals are the set\'s, not the page\'s');
    assert.ok(PAGE_SIZE >= 100);
});

test('d. the voucher list: one row per journal, machine vs manual, header totals', async () => {
    const day = cashOrder.business_date;
    const res = await journalList({ from: day, to: day });
    assert.equal(res.rows.length, 4);
    assert.equal(res.totals.count, 4);
    assert.ok(res.rows.every((j) => j.is_manual === false && j.created_by === null && j.created_by_name === null));
    assert.ok(res.rows.every((j) => j.status === 'posted'));
    assert.equal(res.totals.debit, sum(res.rows, 'debit_total'));
    assert.equal(res.totals.credit, res.totals.debit);
    const types = res.rows.map((j) => j.voucher_type).sort();
    assert.deepEqual(types, ['SM', 'SM', 'SV', 'SV']);
    assert.equal(res.rows.find((j) => j.id === Number(sv.id)).voucher_type_label, 'Sale');

    const sales = await journalList({ from: day, to: day, voucherType: 'SV' });
    assert.equal(sales.rows.length, 2);
    assert.ok(sales.rows.every((j) => j.reference && j.reference === (j.source_id === cashOrder.id ? cashOrder.invoice_number : cardOrder.invoice_number)));
});

test('e. a blank range resolves to the current business day and comes back with the rows', async () => {
    const open = await one(
        'SELECT business_date FROM business_days WHERE branch_id = 1 AND closed_at IS NULL ORDER BY business_date DESC LIMIT 1',
    );
    const expected = open ? ymd(open.business_date) : todayKarachi();
    const res = await journalList({});
    assert.deepEqual(res.range, { from: expected, to: expected });
    const lines = await ledgerLines({ from: '', to: '' });
    assert.deepEqual(lines.range, { from: expected, to: expected });
    // One end given: the other follows it. Reversed ends are swapped, not refused.
    assert.deepEqual((await journalList({ from: '2020-05-05' })).range, { from: '2020-05-05', to: '2020-05-05' });
    assert.deepEqual((await journalList({ from: '2020-05-09', to: '2020-05-05' })).range, { from: '2020-05-05', to: '2020-05-09' });
});

test('f. one voucher as a document: header, lines with account names, no reversal yet', async () => {
    const doc = await journalById(sv.id);
    assert.equal(doc.id, Number(sv.id));
    assert.equal(doc.voucher_no, sv.voucher_no);
    assert.equal(doc.status, 'posted');
    assert.equal(doc.reference, cashOrder.invoice_number);
    assert.equal(doc.lines.length, await count('SELECT COUNT(*) AS n FROM gl_journal_lines WHERE journal_id = ?', [sv.id]));
    assert.equal(sum(doc.lines, 'debit'), doc.debit_total);
    assert.equal(sum(doc.lines, 'credit'), doc.credit_total);
    assert.ok(doc.lines.every((l) => /^\d{5}$/.test(l.account_number) && l.account_name));
    assert.equal(doc.reversal, null);
    assert.equal(doc.reverses, null);
    assert.equal(doc.is_manual, false);
    assert.equal(await journalById(999_999_999), null);

    // The filter's account list: every active account, ordered by number.
    const options = await accountOptions();
    assert.ok(options.some((a) => a.id === Number(acct.guest)));
    assert.equal(options.filter((a) => a.is_active).length, await count('SELECT COUNT(*) AS n FROM accounts WHERE is_active = 1'));
    const numbers = options.map((a) => a.account_number);
    assert.deepEqual(numbers, [...numbers].sort());
});

/* A hand-written JV on the cash bill's day: drawer money moved to the safe. */
const postFloatToSafe = (amount, reference) => postManualJournal({
    businessDate: cashOrder.business_date,
    description: 'Float to safe',
    reference,
    lines: [
        { account_id: acct.safe, debit: amount, credit: 0, memo: 'to safe' },
        { account_id: acct.cash, debit: 0, credit: amount, memo: 'from drawer' },
    ],
    userId: fx.users.admin,
});

test('g. reversing a manual voucher writes a contra JV on the open day, lines swapped, audited; an engine journal is refused', async () => {
    // Open a day after the sale's, so "the current open day" is observably
    // not the sale's own. Removed again below whatever happens.
    const nextDay = dayAfter(cashOrder.business_date);
    await q('INSERT INTO business_days (branch_id, business_date) VALUES (1, ?)', [nextDay]);
    try {
        // The engine's journals are undone from their documents — a void,
        // a voucher reversal — never here: a hand-made contra on top of the
        // engine's own would un-book the sale twice. Refused by name, and
        // nothing is minted.
        const sm = await one("SELECT * FROM gl_journals WHERE source_type = 'order_settlement' AND reference = ?", [cashOrder.invoice_number]);
        for (const engine of [sv, sm]) {
            await assert.rejects(
                reverseJournal(engine.id, { userId: fx.users.admin }),
                new RegExp(`${engine.voucher_no} was posted automatically \\(${engine.source_type}\\) — void the bill \\(${cashOrder.invoice_number}\\)`),
            );
        }
        assert.equal((await journalById(sv.id)).reversal, null);
        assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE source_type = ?', [REVERSAL_SOURCE_TYPE]), 0);
        assert.equal(await count('SELECT COUNT(*) AS n FROM gl_voucher_counters WHERE voucher_type = ?', ['JV']), 0, 'a refusal mints no number');

        const manual = await one('SELECT * FROM gl_journals WHERE id = ?', [(await postFloatToSafe(750, 'SAFE-1')).id]);
        assert.equal(manual.source_type, 'manual');

        const before = await count(
            'SELECT COALESCE(MAX(last_no), 0) AS n FROM gl_voucher_counters WHERE branch_id = 1 AND voucher_type = ? AND day = ?',
            ['JV', nextDay],
        );
        const result = await reverseJournal(manual.id, { userId: fx.users.admin });
        assert.match(result.voucher_no, /^JV-\d{6}-0001$/);
        assert.equal(result.voucher_type, 'JV');
        assert.equal(result.business_date, nextDay);
        assert.equal(result.amount, money(manual.debit_total));
        assert.deepEqual(result.reverses, { id: Number(manual.id), voucher_no: manual.voucher_no });
        assert.equal(before, 0);

        const jv = await one('SELECT * FROM gl_journals WHERE id = ?', [result.id]);
        assert.equal(jv.source_type, REVERSAL_SOURCE_TYPE);
        assert.equal(jv.source_id, String(manual.id));
        assert.equal(jv.status, 'posted');
        assert.equal(jv.description, `Reversal of ${manual.voucher_no}`);
        assert.equal(jv.reference, 'SAFE-1');
        assert.equal(jv.created_by, fx.users.admin);
        assert.equal(ymd(jv.business_date), nextDay);
        assert.equal(money(jv.debit_total), 750);
        assert.equal(money(jv.credit_total), 750);

        // Every stored line comes back with its sides swapped and its memo kept.
        const orig = await q('SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id', [manual.id]);
        const rev = await q('SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id', [jv.id]);
        assert.deepEqual(
            rev.map((l) => [Number(l.account_id), money(l.debit), money(l.credit), l.memo]),
            orig.map((l) => [Number(l.account_id), money(l.credit), money(l.debit), l.memo]),
        );
        assert.equal(sum(rev, 'debit'), sum(rev, 'credit'));

        // The original was not touched: still posted, still the same lines.
        const still = await one('SELECT status, debit_total, credit_total FROM gl_journals WHERE id = ?', [manual.id]);
        assert.equal(still.status, 'posted');
        assert.equal(money(still.debit_total), 750);

        // The pair nets to zero on every account they share.
        const net = await q(
            `SELECT account_id, SUM(debit) - SUM(credit) AS net FROM gl_journal_lines
              WHERE journal_id IN (?, ?) GROUP BY account_id`, [manual.id, jv.id],
        );
        assert.ok(net.every((r) => money(r.net) === 0), JSON.stringify(net));

        // Audited, with the person.
        const auditRow = await one("SELECT * FROM audit_log WHERE action = 'gl_reverse_journal' ORDER BY id DESC LIMIT 1");
        assert.ok(auditRow);
        assert.equal(auditRow.staff_id, fx.users.admin);
        assert.equal(ymd(auditRow.business_date), nextDay);
        assert.equal(auditRow.details.journal_id, Number(manual.id));
        assert.equal(auditRow.details.reversal_voucher_no, jv.voucher_no);

        // The document now links both ways, and the list flags the JV as manual.
        const doc = await journalById(manual.id);
        assert.deepEqual(doc.reversal, { id: Number(jv.id), voucher_no: jv.voucher_no, business_date: nextDay });
        const revDoc = await journalById(jv.id);
        assert.deepEqual(revDoc.reverses, { id: Number(manual.id), voucher_no: manual.voucher_no, business_date: cashOrder.business_date });
        assert.equal(revDoc.is_manual, true);
        assert.equal(revDoc.created_by_name, 'Test Admin');
        const listed = (await journalList({ from: nextDay, to: nextDay })).rows.find((j) => j.id === Number(jv.id));
        assert.ok(listed && listed.is_manual && listed.voucher_type === 'JV');

        // Reversing it again is refused, naming the reversal, and mints nothing.
        await assert.rejects(reverseJournal(manual.id, { userId: fx.users.admin }), new RegExp(`already reversed by ${jv.voucher_no}`));
        assert.equal(await count("SELECT COUNT(*) AS n FROM gl_journals WHERE source_type = ? AND source_id = ?", [REVERSAL_SOURCE_TYPE, String(manual.id)]), 1);
        const jvCounter = await one('SELECT last_no FROM gl_voucher_counters WHERE branch_id = 1 AND voucher_type = ? AND day = ?', ['JV', nextDay]);
        assert.equal(Number(jvCounter.last_no), 1);
    } finally {
        await q('DELETE FROM business_days WHERE branch_id = 1 AND business_date = ?', [nextDay]);
    }
});

test('h. five concurrent reversals of one voucher: exactly one JV — the unique key decides', async () => {
    const manual = await one('SELECT * FROM gl_journals WHERE id = ?', [(await postFloatToSafe(120, 'SAFE-2')).id]);
    const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => reverseJournal(manual.id, { userId: fx.users.admin })),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, `winners: ${won.length}`);
    assert.equal(lost.length, 4);
    for (const r of lost) assert.match(r.reason.message, /already reversed by JV-/);
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE source_type = ? AND source_id = ?', [REVERSAL_SOURCE_TYPE, String(manual.id)]), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gl_reverse_journal' AND details->>'$.journal_id' = ?", [String(manual.id)]), 1);
    // A reversal of a reversal is allowed — it is just another posted voucher.
    const back = await reverseJournal(won[0].value.id, { userId: fx.users.admin });
    assert.equal(back.reverses.voucher_no, won[0].value.voucher_no);
    const net = await q(
        `SELECT account_id, SUM(debit) - SUM(credit) AS net FROM gl_journal_lines
          WHERE journal_id IN (?, ?) GROUP BY account_id`, [won[0].value.id, back.id],
    );
    assert.ok(net.every((r) => money(r.net) === 0));
});

test('i. only a posted voucher can be reversed; an unknown one is refused by name', async () => {
    await assert.rejects(reverseJournal(999_999_999), /no longer exists/);

    // A draft header, written by hand: nothing in the app writes one yet, but
    // the CHECK allows it and the screens must treat it as not-yet-ledger.
    await q(
        `INSERT INTO gl_journals (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
                                  description, status, debit_total, credit_total)
         VALUES (1, ?, 'JV', 'JV-TEST-DRAFT', 'test', ?, 'draft under test', 'draft', 0, 0)`,
        [cashOrder.business_date, randomUUID()],
    );
    const draftId = (await one("SELECT id FROM gl_journals WHERE voucher_no = 'JV-TEST-DRAFT'")).id;
    try {
        await assert.rejects(reverseJournal(draftId), /Only a posted voucher/);
        // And a draft never reaches the ledger's line list, though the voucher list shows it.
        const listed = (await journalList({ from: cashOrder.business_date, to: cashOrder.business_date })).rows;
        assert.ok(listed.some((j) => j.id === Number(draftId) && j.status === 'draft'));
        assert.ok(!(await ledgerLines({ from: cashOrder.business_date, to: cashOrder.business_date })).rows.some((r) => r.journal_id === Number(draftId)));
    } finally {
        await q('DELETE FROM gl_journals WHERE id = ?', [draftId]);
    }
});

test('j. a voided bill: the engine\'s own contra is the sale journal\'s reversal on the document, and a second one is still refused', async () => {
    const voided = await voidOrder(cashOrder.id, 'ledger test void', 'admin');
    assert.equal((await afterVoidGl(voided)).vouchers.length, 2);
    const rev = await one('SELECT * FROM gl_journals WHERE source_type = ? AND source_id = ?', [ORDER_SOURCE_TYPES.saleReversal, cashOrder.id]);
    assert.ok(rev);

    const doc = await journalById(sv.id);
    assert.deepEqual(doc.reversal, { id: Number(rev.id), voucher_no: rev.voucher_no, business_date: ymd(rev.business_date) });
    const revDoc = await journalById(rev.id);
    assert.deepEqual(revDoc.reverses, { id: Number(sv.id), voucher_no: sv.voucher_no, business_date: cashOrder.business_date });
    assert.equal(revDoc.is_manual, false);

    // Neither the sale nor its contra can be reversed by hand on top.
    await assert.rejects(reverseJournal(sv.id, { userId: fx.users.admin }), /posted automatically/);
    await assert.rejects(reverseJournal(rev.id, { userId: fx.users.admin }), /posted automatically/);
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE reference = ?', [cashOrder.invoice_number]), 4);
});

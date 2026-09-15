/*
 * The posting engine, driven directly: a settled order must land in the
 * general ledger as balanced journals on the right accounts, exactly once,
 * however many times or how concurrently the after-commit hook fires — and
 * a void must undo it with contra journals, never with an UPDATE.
 *
 * The engine is called through post.mjs rather than orderActions.js (the
 * suite has no session cookie), which is the same code path: the hooks are
 * one-line delegates. Orders come from the real verbs, so every stored
 * money column the engine reads was written by the till's own arithmetic.
 *
 * No account NUMBER appears here. Every expected account is resolved the
 * way the engine resolves it — gl_settings by role, gl_links by mapping —
 * so renumbering the chart cannot turn this suite red or green by accident.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, count, TAX, createOrder } from './helpers.mjs';
import { settleOrder, voidOrder } from '../../src/lib/db/orders.mjs';
import {
    syncOrderJournals, afterSettleGl, afterVoidGl, ORDER_SOURCE_TYPES,
} from '../../src/lib/accounts/post.mjs';

const COMPANY_ID = '00000000-0000-4000-8000-0000000000c0';
const CATEGORY_ID = '00000000-0000-4000-8000-0000000000ca';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const dayAfter = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pick = (xs) => xs[randInt(0, xs.length - 1)];

let fx;          // resetDb fixtures (the linked menu item)
let original;    // gl_settings switches as found, restored in after()
let acct;        // the accounts the engine must use, resolved — never numbered

const journalsFor = (invoice) => q('SELECT * FROM gl_journals WHERE reference = ? ORDER BY id', [invoice]);
const linesOf = (journalId) =>
    q('SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id', [journalId]);
const sumSide = (lines, side) => money(lines.reduce((s, l) => s + Number(l[side]), 0));
/* Order-independent shape of a journal's lines: [account, debit, credit]. */
const shape = (lines) => lines
    .map((l) => [Number(l.account_id), money(l.debit), money(l.credit)])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
const counter = async (type, day) =>
    Number((await one(
        'SELECT last_no FROM gl_voucher_counters WHERE branch_id = 1 AND voucher_type = ? AND day = ?', [type, day],
    ))?.last_no ?? 0);

/* Every journal is balanced on its lines AND its header agrees with them. */
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

before(async () => {
    await acquireSuiteLock();
    fx = await resetDb();

    const settings = await one('SELECT * FROM gl_settings WHERE id = 1');
    assert.ok(settings, 'gl_settings has no row — migration 006 seeds it and resetDb must never wipe it');
    original = { start_date: ymd(settings.start_date), posting_enabled: settings.posting_enabled };
    // Pin the two switches so the suite does not depend on the day it runs.
    await q("UPDATE gl_settings SET posting_enabled = 1, start_date = '2000-01-01' WHERE id = 1");

    const link = async (type, ref) =>
        (await one('SELECT account_id FROM gl_links WHERE link_type = ? AND ref_id = ?', [type, ref]))?.account_id ?? null;
    acct = {
        guest: settings.guest_ledger_account_id,
        tax: settings.tax_payable_account_id,
        discount: settings.discount_account_id,
        revenue: settings.default_revenue_account_id,
        charge: settings.default_charge_account_id,
        cash: await link('payment_method', 'cash'),
        card: await link('payment_method', 'card'),
        cityLedger: await link('payment_method', 'city_ledger'),
    };
    for (const [k, v] of Object.entries(acct)) assert.ok(v, `no account resolved for ${k} — is the 006 seed present?`);
    assert.notEqual(acct.card, acct.cash, 'card and cash must settle to different accounts for these tests to mean anything');
    assert.notEqual(acct.cityLedger, acct.cash);

    // Two more item-revenue accounts and one more charge account, so the
    // item → category → default chain has three distinct destinations.
    const [itemAcct, catAcct] = await q(
        `SELECT id FROM accounts
          WHERE account_group = 'income' AND is_active = 1 AND id <> ?
            AND JSON_CONTAINS(link_codes, '"IC_ITEM_INCOME"')
          ORDER BY account_number LIMIT 2`,
        [acct.revenue],
    );
    const [feeAcct] = await q(
        `SELECT id FROM accounts
          WHERE account_group = 'income' AND is_active = 1 AND id <> ?
            AND JSON_CONTAINS(link_codes, '"IC_SERVICE_INCOME"')
          ORDER BY account_number LIMIT 1`,
        [acct.charge],
    );
    assert.ok(itemAcct && catAcct && feeAcct, 'the seeded chart should carry spare item-income and service-income accounts');
    acct.item = itemAcct.id;
    acct.category = catAcct.id;
    acct.fee = feeAcct.id;

    // A company for city-ledger bills, a category for the test dish, and
    // the three mappings under test. Fixed ids: every run reseeds the same rows.
    await q(
        `INSERT INTO companies (id, name, is_active) VALUES (?, 'Test Co', 1) AS new_row
         ON DUPLICATE KEY UPDATE name = new_row.name, is_active = 1`,
        [COMPANY_ID],
    );
    await q(
        `INSERT INTO categories (id, name) VALUES (?, 'Test Category') AS new_row
         ON DUPLICATE KEY UPDATE name = new_row.name`,
        [CATEGORY_ID],
    );
    await q('UPDATE menu_items SET category_id = ? WHERE id = ?', [CATEGORY_ID, fx.menuItem.id]);
    for (const [type, ref, account] of [
        ['menu_item', fx.menuItem.id, acct.item],
        ['menu_category', CATEGORY_ID, acct.category],
        ['charge', 'Delivery Fee', acct.fee],
    ]) {
        await q(
            `INSERT INTO gl_links (link_type, ref_id, account_id) VALUES (?, ?, ?) AS new_row
             ON DUPLICATE KEY UPDATE account_id = new_row.account_id`,
            [type, ref, account],
        );
    }
});

after(async () => {
    // Leave the seeded mapping tables as this suite found them.
    await q(
        "DELETE FROM gl_links WHERE (link_type = 'menu_item' AND ref_id = ?) OR (link_type = 'menu_category' AND ref_id = ?) OR (link_type = 'charge' AND ref_id = 'Delivery Fee')",
        [fx.menuItem.id, CATEGORY_ID],
    );
    await q('UPDATE menu_items SET category_id = NULL WHERE id = ?', [fx.menuItem.id]);
    await q('DELETE FROM categories WHERE id = ?', [CATEGORY_ID]);
    await q('DELETE FROM charges');
    await q('UPDATE gl_settings SET posting_enabled = ?, start_date = ? WHERE id = 1',
        [original.posting_enabled, original.start_date]);
    await closeDb();
});

let cashOrder; // the bill tests a–b share

test('a. a cash settle posts SV + SM: balanced, on the right accounts, rate stamped', async () => {
    cashOrder = await createOrder(
        [
            { name: 'Test Chicken Karahi', price: 1200, qty: 2, id: fx.menuItem.id }, // mapped dish
            { name: 'Test Naan', price: 60, qty: 3 },                                  // unmapped line
        ],
        {
            order_type: 'dine-in', table_number: 'T4', payment_status: 'paid', payment_mode: 'cash',
            discount: 100, discount_reason: 'Regular',
        },
        randomUUID(),
    );
    const order = cashOrder;
    assert.equal(order.subtotal, 2580);
    assert.equal(order.tax, Math.round((2580 - 100) * TAX.cash));
    assert.equal(order.total, 2480 + order.tax);
    assert.equal(Number(order.tax_rate), TAX.cash, 'the verb stamps the rate it settled at');

    const result = await afterSettleGl(order);
    assert.equal(result.status, 'posted', result.reason);
    assert.equal(result.vouchers.length, 2);

    const journals = await journalsFor(order.invoice_number);
    assert.equal(journals.length, 2);
    const sv = journals.find((j) => j.voucher_type === 'SV');
    const sm = journals.find((j) => j.voucher_type === 'SM');
    assert.ok(sv && sm);

    // The sale: header
    assert.equal(sv.source_type, ORDER_SOURCE_TYPES.sale);
    assert.equal(sv.source_id, order.id);
    assert.match(sv.voucher_no, /^SV-\d{6}-\d{4}$/);
    assert.equal(ymd(sv.business_date), order.business_date, 'the sale sits in the order\'s own trading day');
    assert.equal(sv.status, 'posted');
    assert.equal(sv.created_by, null, 'a machine posting carries no user');
    assert.equal(sv.description, `Sale ${order.invoice_number} · dine-in`);
    assert.equal(money(sv.debit_total), order.total + order.discount);
    const svLines = await assertBalanced(sv);
    // ...and lines: Dr guest ledger for the bill, Dr discount, Cr revenue
    // grouped by resolved account (mapped dish vs default), Cr GST.
    assert.deepEqual(shape(svLines), shape([
        { account_id: acct.guest, debit: order.total, credit: 0 },
        { account_id: acct.discount, debit: 100, credit: 0 },
        { account_id: acct.item, debit: 0, credit: 2400 },
        { account_id: acct.revenue, debit: 0, credit: 180 },
        { account_id: acct.tax, debit: 0, credit: order.tax },
    ]));
    assert.equal(svLines.find((l) => l.account_id === acct.tax).memo, 'GST 16%');

    // The settlement: cash in, guest ledger cleared, keyed on the payments row.
    const payment = await one('SELECT id FROM payments WHERE order_id = ?', [order.id]);
    assert.equal(sm.source_type, ORDER_SOURCE_TYPES.settlement);
    assert.equal(sm.source_id, payment.id);
    assert.match(sm.voucher_no, /^SM-\d{6}-\d{4}$/);
    assert.equal(ymd(sm.business_date), order.business_date);
    assert.equal(sm.description, `Settlement cash ${order.invoice_number}`);
    const smLines = await assertBalanced(sm);
    assert.deepEqual(shape(smLines), shape([
        { account_id: acct.cash, debit: order.total, credit: 0 },
        { account_id: acct.guest, debit: 0, credit: order.total },
    ]));

    // The stamp survived the round trip, and the books were audited.
    assert.equal(Number((await one('SELECT tax_rate FROM orders WHERE id = ?', [order.id])).tax_rate), TAX.cash);
    const auditRow = await one("SELECT * FROM audit_log WHERE action = 'gl_post_order' AND order_id = ?", [order.id]);
    assert.ok(auditRow, 'posting is audited in the same transaction');
    assert.equal(auditRow.staff_id, null);
    assert.equal(auditRow.details.vouchers.length, 2);
});

test('b. firing the hook twice for one order leaves exactly two journals', async () => {
    const day = cashOrder.business_date;
    const before = { sv: await counter('SV', day), sm: await counter('SM', day) };

    const again = await syncOrderJournals(cashOrder);
    assert.equal(again.status, 'posted');
    assert.equal(again.vouchers.length, 0, 'a replay writes nothing');

    assert.equal((await journalsFor(cashOrder.invoice_number)).length, 2);
    assert.equal(await counter('SV', day), before.sv, 'a replay mints no voucher number');
    assert.equal(await counter('SM', day), before.sm);
    assert.equal(
        await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gl_post_order' AND order_id = ?", [cashOrder.id]),
        1, 'nothing written, nothing audited',
    );
});

test('c. five concurrent fires: exactly two journals — the unique key decides, not luck', async () => {
    const order = await createOrder(
        [{ name: 'Race post', price: 700, qty: 1 }],
        { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
        randomUUID(),
    );
    const day = order.business_date;
    const before = { sv: await counter('SV', day), sm: await counter('SM', day) };

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => syncOrderJournals(order)));

    for (const r of results) {
        assert.equal(r.status, 'fulfilled', `the engine must never reject: ${r.reason?.message}`);
        assert.notEqual(r.value.status, 'failed', `a losing twin is not a failure: ${r.value.reason}`);
    }
    const written = results.map((r) => r.value.vouchers.length);
    assert.equal(written.reduce((s, n) => s + n, 0), 2, `vouchers written per caller: ${written}`);

    const journals = await journalsFor(order.invoice_number);
    assert.equal(journals.length, 2);
    assert.deepEqual(journals.map((j) => j.voucher_type).sort(), ['SM', 'SV']);
    for (const j of journals) await assertBalanced(j);
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE source_id = ?', [order.id]), 1);

    // The losers handed their voucher numbers back: the counters moved by
    // exactly one, so the day's numbering is gapless.
    assert.equal(await counter('SV', day), before.sv + 1, 'SV numbering has a gap');
    assert.equal(await counter('SM', day), before.sm + 1, 'SM numbering has a gap');
});

test('d. a card settle credits GST at the card rate the order stored and debits card clearing', async () => {
    let order = await createOrder(
        [{ name: 'Tax check', price: 999, qty: 2 }], // 1998 gross
        { order_type: 'dine-in', table_number: 'T9', payment_status: 'unpaid' },
    );
    order = await settleOrder(order.id, { method: 'card', clientRequestId: randomUUID() });
    assert.equal(order.tax, Math.round(1998 * TAX.card));
    assert.notEqual(order.tax, Math.round(1998 * TAX.cash), 'the two rates must differ for this to prove anything');
    assert.equal(Number(order.tax_rate), TAX.card);

    const result = await afterSettleGl(order);
    assert.equal(result.status, 'posted', result.reason);

    const journals = await journalsFor(order.invoice_number);
    const sv = journals.find((j) => j.voucher_type === 'SV');
    const sm = journals.find((j) => j.voucher_type === 'SM');
    const svLines = await assertBalanced(sv);
    const gst = svLines.find((l) => l.account_id === acct.tax);
    assert.equal(money(gst.credit), order.tax, 'GST credited is the amount the card rate produced');
    assert.equal(gst.memo, 'GST 5%');

    const smLines = await assertBalanced(sm);
    assert.deepEqual(shape(smLines), shape([
        { account_id: acct.card, debit: order.total, credit: 0 },
        { account_id: acct.guest, debit: 0, credit: order.total },
    ]));
    assert.ok(!smLines.some((l) => l.account_id === acct.cash), 'card money never touches the drawer');
});

test('e. a city_ledger settle debits the city-ledger receivable, never cash', async () => {
    let order = await createOrder(
        [{ name: 'Corporate lunch', price: 1500, qty: 2 }],
        { order_type: 'dine-in', payment_status: 'unpaid' },
    );
    order = await settleOrder(order.id, {
        method: 'city_ledger', companyId: COMPANY_ID, clientRequestId: randomUUID(),
    });
    assert.equal(order.payment_mode, 'city_ledger');

    const result = await afterSettleGl(order);
    assert.equal(result.status, 'posted', result.reason);

    const sm = (await journalsFor(order.invoice_number)).find((j) => j.voucher_type === 'SM');
    assert.equal(sm.description, `Settlement city_ledger ${order.invoice_number} · Test Co`);
    const smLines = await assertBalanced(sm);
    assert.deepEqual(shape(smLines), shape([
        { account_id: acct.cityLedger, debit: order.total, credit: 0 },
        { account_id: acct.guest, debit: 0, credit: order.total },
    ]));
    assert.ok(!smLines.some((l) => l.account_id === acct.cash));
});

test('f. a void of a paid bill adds reversal journals on the open day and the balances net to zero', async () => {
    const order = await createOrder(
        [{ name: 'Voided later', price: 500, qty: 1, id: fx.menuItem.id }, { name: 'Side', price: 80, qty: 2 }],
        { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
        randomUUID(),
    );
    assert.equal((await afterSettleGl(order)).vouchers.length, 2);

    // Open a business day AFTER the sale's, so "the current open day" is
    // observably not the sale's day. Removed again below whatever happens.
    const nextDay = dayAfter(order.business_date);
    await q('INSERT INTO business_days (branch_id, business_date) VALUES (1, ?)', [nextDay]);
    try {
        const voided = await voidOrder(order.id, 'test void', 'admin');
        assert.equal(voided.status, 'cancelled');

        const result = await afterVoidGl(voided);
        assert.equal(result.status, 'posted', result.reason);
        assert.equal(result.vouchers.length, 2, 'one settlement reversal, one sale reversal');

        const journals = await journalsFor(order.invoice_number);
        assert.equal(journals.length, 4);
        for (const j of journals) await assertBalanced(j);

        const sale = journals.find((j) => j.source_type === ORDER_SOURCE_TYPES.sale);
        const saleRev = journals.find((j) => j.source_type === ORDER_SOURCE_TYPES.saleReversal);
        const settles = journals.filter((j) => j.source_type === ORDER_SOURCE_TYPES.settlement);
        assert.ok(saleRev && settles.length === 2);

        // The sale is untouched (append-only); its reversal is its stored
        // lines with the sides swapped, dated the open day, not the sale's.
        assert.equal(ymd(sale.business_date), order.business_date);
        assert.equal(ymd(saleRev.business_date), nextDay);
        assert.equal(saleRev.voucher_type, 'SV');
        assert.equal(saleRev.source_id, order.id);
        assert.equal(saleRev.description, `Sale reversal ${order.invoice_number} · void of ${sale.voucher_no}`);
        const saleLines = await linesOf(sale.id);
        const revLines = await linesOf(saleRev.id);
        assert.deepEqual(
            shape(revLines),
            shape(saleLines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit }))),
        );

        // The negative payments row got its own SM, keyed on that row, on the open day.
        const negative = await one('SELECT id, amount FROM payments WHERE order_id = ? AND amount < 0', [order.id]);
        const smRev = settles.find((j) => j.source_id === negative.id);
        assert.ok(smRev, 'the void\'s payments row has a settlement journal');
        assert.equal(ymd(smRev.business_date), nextDay);
        assert.equal(smRev.description, `Settlement reversal cash ${order.invoice_number}`);
        assert.deepEqual(shape(await linesOf(smRev.id)), shape([
            { account_id: acct.guest, debit: order.total, credit: 0 },
            { account_id: acct.cash, debit: 0, credit: order.total },
        ]));

        // Every account this bill touched nets to zero across its four journals.
        const nets = await q(
            `SELECT l.account_id, SUM(l.debit) AS d, SUM(l.credit) AS c
               FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id
              WHERE j.reference = ? GROUP BY l.account_id`,
            [order.invoice_number],
        );
        assert.ok(nets.length >= 4);
        for (const n of nets) assert.equal(money(n.d), money(n.c), `account ${n.account_id} does not net to zero`);

        // And voiding a void, or re-firing, adds nothing.
        assert.equal((await afterVoidGl(voided)).vouchers.length, 0);
        assert.equal((await journalsFor(order.invoice_number)).length, 4);
    } finally {
        await q('DELETE FROM business_days WHERE branch_id = 1 AND business_date = ?', [nextDay]);
    }
});

test('g. 150 random carts: every journal balances exactly and the sale credits equal total + discount', async () => {
    // A taxable percent charge on dine-in and a fixed after-tax fee on
    // delivery — the fee is mapped, the service charge falls to the default.
    await q(
        `INSERT INTO charges (name, value_type, value, order_types, before_tax, auto_apply, is_active) VALUES
           ('Service Charge', 'percent', 5.00, '["dine-in"]', 1, 1, 1),
           ('Delivery Fee', 'fixed', 150.00, '["delivery"]', 0, 1, 1)`,
    );
    try {
        for (let i = 0; i < 150; i++) {
            const method = pick(['cash', 'card', 'city_ledger']);
            const orderType = pick(['dine-in', 'takeaway', 'delivery']);
            const includeTax = Math.random() < 0.7;
            const items = Array.from({ length: randInt(1, 6) }, (_, j) => ({
                name: `Cart${i} line${j}`,
                price: randInt(1, 5000),
                qty: randInt(1, 5),
                /*
                 * Half the lines are mapped to a real dish, which is what this
                 * test is about: revenue resolves menu item → category →
                 * default. They carry THAT DISH'S price, because the server
                 * prices every line from the menu now and a claimed price is
                 * ignored — so a mapped line claiming Rs 2,962 would ring at
                 * the dish's Rs 1,200 and the arithmetic below would be a test
                 * of nothing.
                 */
                ...(Math.random() < 0.5 ? { id: fx.menuItem.id, price: Number(fx.menuItem.price) } : {}),
            }));
            const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
            // Kept below the subtotal so these carts exercise a partial
            // discount. A fully comped bill settles fine now — it writes no
            // payment row, because no money moved — and test 23 covers it.
            const discount = Math.random() < 0.5 ? 0 : randInt(0, subtotal - 1);
            const label = `cart ${i}: method=${method} type=${orderType} includeTax=${includeTax} discount=${discount} ` +
                `items=${JSON.stringify(items.map(({ price, qty, id }) => [price, qty, id ? 'mapped' : '-']))}`;

            const order = await createOrder(
                items,
                {
                    payment_status: 'paid', payment_mode: method,
                    company_id: method === 'city_ledger' ? COMPANY_ID : null,
                    order_type: orderType, include_tax: includeTax, discount,
                    discount_reason: discount ? 'promo' : null,
                },
                randomUUID(),
            );
            assert.equal(order.subtotal, subtotal, `subtotal — ${label}`);
            assert.equal(Number(order.tax_rate), method === 'card' ? TAX.card : TAX.cash, `tax_rate — ${label}`);

            const result = await syncOrderJournals(order);
            assert.equal(result.status, 'posted', `${result.reason} — ${label}`);
            assert.equal(result.vouchers.length, 2, `vouchers — ${label}`);

            const journals = await journalsFor(order.invoice_number);
            assert.equal(journals.length, 2, `journals — ${label}`);
            const sv = journals.find((j) => j.voucher_type === 'SV');
            const sm = journals.find((j) => j.voucher_type === 'SM');
            const svLines = await assertBalanced(sv, `SV — ${label}`);
            const smLines = await assertBalanced(sm, `SM — ${label}`);

            const credits = svLines.filter((l) => money(l.credit) > 0);
            const creditOn = (accounts) => sumSide(credits.filter((l) => accounts.includes(l.account_id)), 'credit');
            assert.equal(sumSide(credits, 'credit'), order.total + order.discount, `SV credits — ${label}`);
            assert.equal(creditOn([acct.item, acct.revenue]), order.subtotal, `revenue — ${label}`);
            assert.equal(creditOn([acct.charge, acct.fee]), order.charges_total, `charges — ${label}`);
            assert.equal(creditOn([acct.tax]), order.tax, `tax — ${label}`);
            if (orderType === 'delivery') assert.equal(creditOn([acct.fee]), 150, `mapped delivery fee — ${label}`);
            if (orderType === 'dine-in') assert.equal(creditOn([acct.charge]), order.charges_total, `service charge — ${label}`);
            assert.equal(sumSide(svLines.filter((l) => l.account_id === acct.guest), 'debit'), order.total, `guest ledger — ${label}`);
            assert.equal(sumSide(svLines.filter((l) => l.account_id === acct.discount), 'debit'), order.discount, `discount — ${label}`);

            const paidTo = { cash: acct.cash, card: acct.card, city_ledger: acct.cityLedger }[method];
            assert.deepEqual(shape(smLines), shape([
                { account_id: paidTo, debit: order.total, credit: 0 },
                { account_id: acct.guest, debit: 0, credit: order.total },
            ]), `SM lines — ${label}`);
        }
    } finally {
        await q('DELETE FROM charges');
    }
});

test('h. revenue resolves menu item → menu category → default, in that order', async () => {
    const ring = async () => {
        const order = await createOrder(
            [{ name: 'Test Chicken Karahi', price: 1000, qty: 1, id: fx.menuItem.id }],
            { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
            randomUUID(),
        );
        assert.equal((await syncOrderJournals(order)).status, 'posted');
        const sv = (await journalsFor(order.invoice_number)).find((j) => j.voucher_type === 'SV');
        const revenue = (await linesOf(sv.id)).filter((l) => money(l.credit) > 0 && l.account_id !== acct.tax);
        assert.equal(revenue.length, 1);
        return revenue[0].account_id;
    };

    assert.equal(await ring(), acct.item, 'the item mapping wins');
    await q("DELETE FROM gl_links WHERE link_type = 'menu_item' AND ref_id = ?", [fx.menuItem.id]);
    assert.equal(await ring(), acct.category, 'then the category the dish belongs to');
    await q("DELETE FROM gl_links WHERE link_type = 'menu_category' AND ref_id = ?", [CATEGORY_ID]);
    assert.equal(await ring(), acct.revenue, 'then the default revenue account');
});

test('i. posting_enabled and start_date are honoured; a refusal logs one line and books nothing', async () => {
    const ring = () => createOrder(
        [{ name: 'Switch test', price: 300, qty: 1 }],
        { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
        randomUUID(),
    );

    await q('UPDATE gl_settings SET posting_enabled = 0 WHERE id = 1');
    const off = await ring();
    let r = await syncOrderJournals(off);
    assert.equal(r.status, 'skipped');
    assert.equal((await journalsFor(off.invoice_number)).length, 0, 'switched off means nothing posts');

    await q('UPDATE gl_settings SET posting_enabled = 1, start_date = ? WHERE id = 1', [dayAfter(off.business_date)]);
    r = await syncOrderJournals(off);
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /before the ledger start date/);
    assert.equal((await journalsFor(off.invoice_number)).length, 0, 'a day before the start date never posts');

    await q("UPDATE gl_settings SET start_date = '2000-01-01' WHERE id = 1");
    r = await syncOrderJournals(off);
    assert.equal(r.status, 'posted');
    assert.equal((await journalsFor(off.invoice_number)).length, 2, 'back on, the same order posts normally');

    // A bill whose lines and header disagree is refused, not plugged: one
    // console.error line in the agreed shape, no journal, no throw.
    const broken = await ring();
    await q('UPDATE orders SET subtotal = subtotal + 1 WHERE id = ?', [broken.id]);
    const logged = [];
    const realError = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    try {
        r = await syncOrderJournals(broken);
    } finally {
        console.error = realError;
    }
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /does not match orders\.subtotal/);
    assert.equal(logged.length, 1);
    assert.ok(
        logged[0].startsWith(`[accounts] posting for order ${broken.id} failed (settle unaffected):`),
        `unexpected log line: ${logged[0]}`,
    );
    assert.equal((await journalsFor(broken.invoice_number)).length, 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE source_id = ?', [broken.id]), 0);
});

test('j. an unpaid order, and a void of one, book nothing', async () => {
    const tab = await createOrder([{ name: 'Open tab', price: 400, qty: 1 }], { payment_status: 'unpaid' });
    assert.equal((await afterSettleGl(tab)).status, 'skipped');
    const voided = await voidOrder(tab.id, 'changed mind', 'admin');
    assert.equal((await afterVoidGl(voided)).status, 'skipped');
    assert.equal(await count('SELECT COUNT(*) AS n FROM gl_journals WHERE source_id = ?', [tab.id]), 0);
});

test('k. a void reverses the settlement out of the account it was booked into, even after the method was re-mapped', async () => {
    let order = await createOrder(
        [{ name: 'Remapped later', price: 640, qty: 1 }],
        { order_type: 'dine-in', table_number: 'T2', payment_status: 'unpaid' },
    );
    order = await settleOrder(order.id, { method: 'card', clientRequestId: randomUUID() });
    assert.equal((await afterSettleGl(order)).vouchers.length, 2);

    // Between the settle and the void, the owner points card settlements
    // at another account. The reversal must still come OUT of the account
    // the money was booked INTO — the stored lines, not the live mapping.
    const [elsewhere] = await q(
        `SELECT id FROM accounts
          WHERE account_group = 'asset' AND is_active = 1 AND id NOT IN (?, ?, ?)
          ORDER BY account_number LIMIT 1`,
        [acct.card, acct.cash, acct.guest],
    );
    assert.ok(elsewhere, 'the seeded chart has a spare asset account');
    await q("UPDATE gl_links SET account_id = ? WHERE link_type = 'payment_method' AND ref_id = 'card'", [elsewhere.id]);
    try {
        const voided = await voidOrder(order.id, 'remap test', 'admin');
        const result = await afterVoidGl(voided);
        assert.equal(result.status, 'posted', result.reason);
        assert.equal(result.vouchers.length, 2);

        const negative = await one('SELECT id FROM payments WHERE order_id = ? AND amount < 0', [order.id]);
        const smRev = await one(
            'SELECT * FROM gl_journals WHERE source_type = ? AND source_id = ?',
            [ORDER_SOURCE_TYPES.settlement, negative.id],
        );
        assert.ok(smRev, 'the void\'s payments row has its settlement reversal');
        assert.deepEqual(shape(await assertBalanced(smRev)), shape([
            { account_id: acct.guest, debit: order.total, credit: 0 },
            { account_id: acct.card, debit: 0, credit: order.total },
        ]), 'the reversal credits the account the settle debited, not where card points now');

        const nets = await q(
            `SELECT l.account_id, SUM(l.debit) AS d, SUM(l.credit) AS c
               FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id
              WHERE j.reference = ? GROUP BY l.account_id`,
            [order.invoice_number],
        );
        for (const n of nets) assert.equal(money(n.d), money(n.c), `account ${n.account_id} does not net to zero`);
        assert.ok(!nets.some((n) => Number(n.account_id) === Number(elsewhere.id)), 'the re-mapped account never enters this bill');
    } finally {
        await q("UPDATE gl_links SET account_id = ? WHERE link_type = 'payment_method' AND ref_id = 'card'", [acct.card]);
    }
});

test('l. a settle hook and a void hook overlapping on one bill, beside a settle on another, never lose a journal or deadlock', async () => {
    // Three transactions in flight at once, eight rounds: bill A's settle
    // hook while A is being voided (its void hook fires the moment the void
    // commits), and bill B's settle hook beside them. Before the order row
    // was locked first, the void hook could snapshot ahead of the settle
    // hook's commit and never write the sale reversal; before every path
    // took its voucher counters SV-then-SM, A's void and B's settle could
    // deadlock and one would come back 'failed'.
    for (let round = 0; round < 8; round++) {
        const a = await createOrder(
            [{ name: `Overlap A${round}`, price: 300 + round, qty: 1 }],
            { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'cash' },
            randomUUID(),
        );
        const b = await createOrder(
            [{ name: `Overlap B${round}`, price: 900 + round, qty: 1 }],
            { order_type: 'takeaway', payment_status: 'paid', payment_mode: 'card' },
            randomUUID(),
        );
        const results = await Promise.all([
            afterSettleGl(a),
            (async () => afterVoidGl(await voidOrder(a.id, 'overlap', 'admin')))(),
            afterSettleGl(b),
        ]);
        for (const r of results) assert.notEqual(r.status, 'failed', `round ${round}: ${r.reason}`);

        // Two honest outcomes for A, depending on who took the row first:
        // the settle hook booked the sale and the void reversed it (four
        // journals), or the void landed first and the sale was never booked
        // — two settlements that net to nothing. What can never happen is a
        // sale with no reversal, a payments row with no settlement, or a
        // journal that got lost to a deadlock.
        const forA = await journalsFor(a.invoice_number);
        const types = forA.map((j) => j.source_type);
        const has = (t) => types.filter((x) => x === t).length;
        assert.equal(has(ORDER_SOURCE_TYPES.settlement), 2, `round ${round}: both payments rows booked — ${types}`);
        assert.equal(has(ORDER_SOURCE_TYPES.sale), has(ORDER_SOURCE_TYPES.saleReversal), `round ${round}: a sale without its reversal — ${types}`);
        assert.ok(forA.length === 2 || forA.length === 4, `round ${round}: ${types}`);
        for (const j of forA) await assertBalanced(j);
        const nets = await q(
            `SELECT l.account_id, SUM(l.debit) AS d, SUM(l.credit) AS c
               FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id
              WHERE j.reference = ? GROUP BY l.account_id`,
            [a.invoice_number],
        );
        for (const n of nets) assert.equal(money(n.d), money(n.c), `round ${round}: account ${n.account_id} does not net to zero`);
        assert.equal(
            results.reduce((s, r) => s + r.vouchers.length, 0), forA.length + 2,
            `round ${round}: every journal written exactly once across the three callers`,
        );
        assert.equal((await journalsFor(b.invoice_number)).length, 2, `round ${round}: bill B`);
    }
});

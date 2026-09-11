/*
 * The posting engine: a settled order becomes journals in the general
 * ledger. Called AFTER the settle (or void) transaction commits, fire-and-
 * forget, from orderActions.js — the same posture as the FBR reporter and
 * the stock consumption: the money is already taken, so nothing in this
 * module throws to its caller. It runs its own transaction on the pool,
 * never the settle's, and a fault logs one line and stops.
 *
 * One reconciler, two thin entry points. syncOrderJournals brings the
 * ledger up to date with the order AS STORED: a sale journal (SV) for the
 * bill, a settlement journal (SM) for every payments row, and — once a paid
 * bill has been voided — the reversal of the sale, built from the stored
 * journal lines with the sides swapped. A void writes a NEGATIVE payments
 * row, so the settlement's reversal falls out of "one SM per payments row"
 * without a second hand-written path; it too is the ORIGINAL settlement's
 * stored lines swapped, never re-resolved, so a payment method re-mapped
 * since the settle still reverses out of the account it was booked into.
 *
 * Two orderings are load-bearing. The order row is read first and FOR
 * UPDATE, so a settle hook, its replay twins and a void hook on one bill
 * take turns and each sees what the last one committed. And the voucher
 * counters are always taken SV before SM, sale day before open day, so two
 * posters on different bills can never wait on each other's counter rows.
 *
 *   SV  Dr Guest Ledger Control        order.total
 *       Dr Discounts Allowed           order.discount        (omitted if 0)
 *         Cr revenue per resolved account   SUM(line_total) grouped
 *         Cr charge per resolved account    each charge amount
 *         Cr GST Payable                    order.tax         (omitted if 0)
 *   SM  Dr <account for payments.method>    payments.amount
 *         Cr Guest Ledger Control           payments.amount
 *
 * Money is read from the stored order columns — subtotal, discount,
 * charges, charges_total, tax, total — never recomputed: calcTotals is a
 * contract of the till's, and this module reads its results. Accounts are
 * never named by number here; every one comes from gl_settings (by role)
 * or gl_links (by mapping).
 *
 * Idempotency is structural. gl_journals is UNIQUE on (source_type,
 * source_id) and every header is inserted ON DUPLICATE KEY UPDATE id = id,
 * so however many times — or how concurrently — the hook fires for one
 * order, the database holds one journal per business event. NOTE the
 * driver detail: mysql2 connects with CLIENT_FOUND_ROWS, under which a
 * duplicate that "updates" a row to its own values reports affectedRows 1,
 * the same as a real insert. insertId is the honest signal (0 on the
 * duplicate, the new id otherwise), so that is what decides who owns it.
 *
 * Plain-Node importable, relative imports only, like consume.mjs and
 * fbr/afterSettle.mjs: the test suite drives it directly. That is why the
 * few small helpers below are restated from helpers.mjs rather than
 * imported — that file is `server-only` and alias-imported and cannot load
 * outside Next.
 */
import { withTransaction } from '../db/pool.mjs';
import { VOUCHER_TYPES } from './constants.mjs';
import { money, ymd, todayKarachi, clip, currentBusinessDate, nextVoucherNo, audit } from './kit.mjs';

/* The business events an order produces, as gl_journals.source_type. The
 * Health screen and repostOrder key on these; keep them in one place. */
export const ORDER_SOURCE_TYPES = Object.freeze({
    sale: 'order_sale',                  // source_id = orders.id
    settlement: 'order_settlement',      // source_id = payments.id
    saleReversal: 'order_sale_reversal', // source_id = orders.id
});

/* Paise-exact. DECIMAL comes back as a JS number (the pool sets
 * decimalNumbers), and a sum of those can carry float dust; every figure
 * that reaches a journal line or an equality check goes through here. */

/* Voucher numbers minted like invoice numbers: the upsert X-locks the
 * counter row until commit, which is what serializes two same-moment
 * posters. Format <TYPE>-YYMMDD-NNNN. */

/* Every write to the books leaves a row here, inside the same transaction.
 * staff_id is NULL for a machine posting; repostOrder passes the person. */

/* JSON columns arrive parsed from mysql2; a serialized row or an older
 * driver could hand over the text. */
const asArray = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    return [];
};

/* The concrete mappings the poster reads, as one Map keyed 'type:ref'. */
const loadLinks = async (conn) => {
    const [rows] = await conn.query(
        `SELECT link_type, ref_id, account_id FROM gl_links
         WHERE link_type IN ('menu_item', 'menu_category', 'charge', 'payment_method')`,
    );
    return new Map(rows.map((r) => [`${r.link_type}:${r.ref_id}`, r.account_id]));
};

const findJournal = async (conn, sourceType, sourceId) => {
    const [rows] = await conn.query(
        'SELECT id, voucher_no, business_date FROM gl_journals WHERE source_type = ? AND source_id = ?',
        [sourceType, sourceId],
    );
    return rows[0] ?? null;
};

/*
 * One balanced voucher, written atomically under a savepoint. Lines are
 * rounded to paise, zero lines dropped (the side CHECK forbids them, which
 * is how a zero discount or a tax-free bill simply has no such line), and
 * Dr === Cr asserted BEFORE anything is written. Returns the header, or
 * null when a twin already owns this (source_type, source_id) — in which
 * case the savepoint rollback also hands back the voucher number, so the
 * counter stays gapless.
 */
const postJournal = async (conn, j) => {
    const lines = j.lines
        .map((l) => ({
            account_id: l.account_id,
            debit: money(l.debit),
            credit: money(l.credit),
            memo: l.memo == null ? null : clip(l.memo),
        }))
        .filter((l) => l.debit !== 0 || l.credit !== 0);

    for (const l of lines) {
        if (!l.account_id) throw new Error(`${j.voucherType} for ${j.reference}: a line has no account`);
        if (l.debit < 0 || l.credit < 0 || (l.debit !== 0 && l.credit !== 0)) {
            throw new Error(`${j.voucherType} for ${j.reference}: a line must carry exactly one positive side`);
        }
    }
    if (lines.length === 0) throw new Error(`${j.voucherType} for ${j.reference}: nothing to post`);

    const debitTotal = money(lines.reduce((s, l) => s + l.debit, 0));
    const creditTotal = money(lines.reduce((s, l) => s + l.credit, 0));
    if (debitTotal !== creditTotal) {
        throw new Error(
            `${j.voucherType} for ${j.reference} does not balance: Dr ${debitTotal} vs Cr ${creditTotal}`,
        );
    }

    await conn.query('SAVEPOINT journal');
    const voucherNo = await nextVoucherNo(conn, j.voucherType, j.businessDate, j.branchId);
    const [result] = await conn.query(
        `INSERT INTO gl_journals
           (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
            description, reference, status, debit_total, credit_total, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
            j.branchId, j.businessDate, j.voucherType, voucherNo, j.sourceType, String(j.sourceId),
            clip(j.description), j.reference ?? null, debitTotal, creditTotal, j.userId ?? null,
        ],
    );
    if (!result.insertId) {
        // The twin owns it. Undo this journal's work only — its voucher
        // number included — and let the caller carry on with the rest.
        await conn.query('ROLLBACK TO SAVEPOINT journal');
        return null;
    }

    await conn.query(
        'INSERT INTO gl_journal_lines (journal_id, account_id, debit, credit, memo) VALUES ?',
        [lines.map((l) => [result.insertId, l.account_id, l.debit, l.credit, l.memo])],
    );
    return {
        id: result.insertId,
        voucher_type: j.voucherType,
        voucher_no: voucherNo,
        source_type: j.sourceType,
        source_id: String(j.sourceId),
        business_date: j.businessDate,
        amount: debitTotal,
    };
};

/*
 * The sale journal's lines, from the stored order and its stored items.
 * Revenue resolves per item: gl_links(menu_item) → gl_links(menu_category
 * via menu_items.category_id) → the default revenue account, then groups by
 * account so a forty-line bill is a handful of journal lines. A line whose
 * dish lost its FK (deleted from the menu) has no menu_item_id and falls to
 * the default, which is correct and still balances.
 */
const saleLines = async (conn, order, settings, links) => {
    const [items] = await conn.query(
        `SELECT oi.menu_item_id, oi.line_total, mi.category_id
           FROM order_items oi
           LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
          WHERE oi.order_id = ?
          ORDER BY oi.round_no, oi.seq`,
        [order.id],
    );

    // The one refusal: if the lines and the header disagree, the bill is
    // not one this module can vouch for. A visible gap on the Health screen
    // beats a silent plug to Suspense.
    const itemsTotal = money(items.reduce((s, i) => s + Number(i.line_total), 0));
    if (itemsTotal !== money(order.subtotal)) {
        throw new Error(
            `order_items total ${itemsTotal} does not match orders.subtotal ${money(order.subtotal)} — refusing to post`,
        );
    }

    const revenue = new Map();
    for (const i of items) {
        const account = (i.menu_item_id && links.get(`menu_item:${i.menu_item_id}`))
            || (i.category_id && links.get(`menu_category:${i.category_id}`))
            || settings.default_revenue_account_id;
        revenue.set(account, money((revenue.get(account) || 0) + Number(i.line_total)));
    }

    const charges = asArray(order.charges);
    const chargesTotal = money(charges.reduce((s, c) => s + Number(c?.amount || 0), 0));
    if (chargesTotal !== money(order.charges_total)) {
        throw new Error(
            `charges snapshot ${chargesTotal} does not match orders.charges_total ${money(order.charges_total)} — refusing to post`,
        );
    }
    const chargeLines = new Map();
    for (const c of charges) {
        const account = links.get(`charge:${c.name}`) || settings.default_charge_account_id;
        const cur = chargeLines.get(account) || { amount: 0, names: [] };
        cur.amount = money(cur.amount + Number(c.amount || 0));
        cur.names.push(c.name);
        chargeLines.set(account, cur);
    }

    const taxPct = order.tax_rate == null ? null : Math.round(Number(order.tax_rate) * 10000) / 100;
    const where = order.table_number ? `${order.order_type} · table ${order.table_number}` : order.order_type;

    return [
        { account_id: settings.guest_ledger_account_id, debit: order.total, memo: where },
        /*
         * Discounts Allowed carries the rounding too, and that is not a fudge:
         * the grand total only ever rounds DOWN (migration 035), so what is
         * shaved off the tail is money given away, which is what this account
         * is for. Posting it here is also what keeps the entry balanced —
         * total + discount + rounding is exactly revenue + charges + tax.
         */
        {
            account_id: settings.discount_account_id,
            debit: money(Number(order.discount || 0) + Number(order.rounding || 0)),
            memo: [
                order.discount_reason ? `Discount · ${order.discount_reason}` : (Number(order.discount) ? 'Discount' : null),
                Number(order.rounding) ? `Rounding ${money(order.rounding)}` : null,
            ].filter(Boolean).join(' · ') || 'Discount',
        },
        ...[...revenue].map(([account_id, amount]) => ({
            account_id, credit: amount, memo: `Items sold · ${items.length} line${items.length === 1 ? '' : 's'}`,
        })),
        ...[...chargeLines].map(([account_id, c]) => ({ account_id, credit: c.amount, memo: c.names.join(', ') })),
        {
            account_id: settings.tax_payable_account_id,
            credit: order.tax,
            memo: taxPct == null ? 'GST' : `GST ${taxPct}%`,
        },
    ];
};

const skipped = (reason) => ({ status: 'skipped', reason, vouchers: [] });

/* The stored lines of a journal with the sides swapped: a contra. */
const contraLinesOf = async (conn, journalId) => {
    const [stored] = await conn.query(
        'SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id',
        [journalId],
    );
    return stored.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo }));
};

const syncTx = async (conn, orderId, userId) => {
    // The row as stored, not as the caller remembers it (the hook hands
    // over a serialized copy; repostOrder may hand over just an id) — read
    // FIRST, and LOCKED. The lock is what makes a settle hook, its replay
    // twins and a void hook on the same bill take turns; its place is what
    // makes the turns mean anything: InnoDB opens a transaction's snapshot
    // at its first NON-locking read, so everything read below sees what the
    // previous holder committed. Snapshot first and a void hook could look
    // before the settle hook's commit, find no sale journal, and never
    // write the reversal.
    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    const order = orderRows[0];
    if (!order) return skipped('order not found');

    const [settingsRows] = await conn.query('SELECT * FROM gl_settings WHERE id = 1');
    const settings = settingsRows[0];
    if (!settings) return skipped('gl_settings has no row');
    if (!settings.posting_enabled) return skipped('posting is switched off');

    // Only a settled, numbered sale is a ledger event. An open tab, and a
    // void of one, have nothing to book.
    if (!order.invoice_number) return skipped('order is not settled');

    const saleDate = ymd(order.business_date);
    if (saleDate < ymd(settings.start_date)) return skipped(`business day ${saleDate} is before the ledger start date`);

    const branchId = order.branch_id;
    const invoice = order.invoice_number;
    const links = await loadLinks(conn);
    const vouchers = [];
    let openDay = null;
    const reversalDay = async () => (openDay ??= await currentBusinessDate(conn, branchId));

    // Counter rows are X-locked until commit, so the steps below take them
    // in the one order every path shares: every SV before any SM, and
    // within a type the sale's day before the open day. A settle (SV, SM)
    // and a void (SV reversal, SM, SM reversal) on two different bills can
    // then never wait on each other — which is why the sale's reversal is
    // step 2 and the settlements step 3.

    // 1. The sale. Skipped for a bill voided before it ever reached the
    //    ledger — booking and un-booking it in one breath records nothing.
    let sale = await findJournal(conn, ORDER_SOURCE_TYPES.sale, order.id);
    if (!sale && order.status !== 'cancelled') {
        sale = await postJournal(conn, {
            branchId,
            businessDate: saleDate,
            voucherType: 'SV',
            sourceType: ORDER_SOURCE_TYPES.sale,
            sourceId: order.id,
            description: `${VOUCHER_TYPES.SV} ${invoice} · ${order.order_type}`,
            reference: invoice,
            lines: await saleLines(conn, order, settings, links),
            userId,
        });
        if (sale) vouchers.push(sale);
    }

    // 2. The sale's reversal, once the bill is voided: the stored lines with
    //    the sides swapped, on the current open day so a closed day stays
    //    closed. Never re-derived — mappings, rates and charges may all have
    //    moved since the sale was booked.
    if (order.status === 'cancelled' && sale
        && !(await findJournal(conn, ORDER_SOURCE_TYPES.saleReversal, order.id))) {
        const posted = await postJournal(conn, {
            branchId,
            businessDate: await reversalDay(),
            voucherType: 'SV',
            sourceType: ORDER_SOURCE_TYPES.saleReversal,
            sourceId: order.id,
            description: `${VOUCHER_TYPES.SV} reversal ${invoice} · void of ${sale.voucher_no}`,
            reference: invoice,
            lines: await contraLinesOf(conn, sale.id),
            userId,
        });
        if (posted) vouchers.push(posted);
    }

    // 3. One settlement per payments row. A positive row lands on the
    //    order's own trading day; a negative one (the void's reversal) on
    //    the current open day. The reversal undoes the positive row of the
    //    same method and amount, and is THAT settlement's stored lines
    //    swapped — the same rule as the sale's reversal, for the same
    //    reason: the payment method's mapping may have moved since.
    const [payments] = await conn.query(
        `SELECT p.id, p.method, p.amount, c.name AS company_name
           FROM payments p
           LEFT JOIN companies c ON c.id = p.company_id
          WHERE p.order_id = ?
          ORDER BY p.paid_at, p.id`,
        [order.id],
    );
    const undone = new Set(); // positive rows already matched to a reversal
    for (const p of payments) {
        if (await findJournal(conn, ORDER_SOURCE_TYPES.settlement, p.id)) continue;
        const amount = money(p.amount);
        if (amount === 0) continue;

        const reversal = amount < 0;
        const abs = money(Math.abs(amount));
        const memo = clip(p.company_name ? `${p.method} · ${p.company_name}` : p.method);

        let lines = null;
        if (reversal) {
            const original = payments.find((o) => o.method === p.method && money(o.amount) === abs && !undone.has(o.id));
            const originalSm = original ? await findJournal(conn, ORDER_SOURCE_TYPES.settlement, original.id) : null;
            if (originalSm) {
                undone.add(original.id);
                lines = await contraLinesOf(conn, originalSm.id);
            }
        }
        if (!lines) {
            // A payment in — or, defensively, a reversal whose original was
            // never booked — resolves the method's account as mapped now.
            const methodAccount = links.get(`payment_method:${p.method}`);
            if (!methodAccount) throw new Error(`no gl_links payment_method mapping for '${p.method}'`);
            lines = reversal
                ? [
                    { account_id: settings.guest_ledger_account_id, debit: abs, memo },
                    { account_id: methodAccount, credit: abs, memo },
                ]
                : [
                    { account_id: methodAccount, debit: abs, memo },
                    { account_id: settings.guest_ledger_account_id, credit: abs, memo },
                ];
        }

        const posted = await postJournal(conn, {
            branchId,
            businessDate: reversal ? await reversalDay() : saleDate,
            voucherType: 'SM',
            sourceType: ORDER_SOURCE_TYPES.settlement,
            sourceId: p.id,
            description: `${VOUCHER_TYPES.SM}${reversal ? ' reversal' : ''} ${p.method} ${invoice}`
                + (p.company_name ? ` · ${p.company_name}` : ''),
            reference: invoice,
            lines,
            userId,
        });
        if (posted) vouchers.push(posted);
    }

    if (vouchers.length > 0) {
        await audit(conn, {
            branchId,
            bd: await reversalDay(),
            action: 'gl_post_order',
            orderId: order.id,
            userId,
            details: {
                order_id: order.id,
                invoice_number: invoice,
                order_status: order.status,
                vouchers: vouchers.map(({ voucher_type, voucher_no, source_type, source_id, business_date, amount }) => ({
                    voucher_type, voucher_no, source_type, source_id, business_date, amount,
                })),
            },
        });
    }
    return { status: 'posted', reason: null, vouchers };
};

/*
 * Reconcile one order's journals with its stored state. Accepts the order
 * row (serialized or raw) or just its id. Never throws: returns
 *   { status: 'posted',  vouchers: [...written THIS call, possibly none] }
 *   { status: 'skipped', reason }   nothing to do (off, too early, unpaid)
 *   { status: 'failed',  reason }   logged; the settle is unaffected
 * userId is the person behind a manual re-post; the hooks leave it NULL.
 */
export const syncOrderJournals = async (orderLike, { userId = null } = {}) => {
    const orderId = typeof orderLike === 'string' ? orderLike : orderLike?.id;
    try {
        if (!orderId) return skipped('no order');
        return await withTransaction((conn) => syncTx(conn, orderId, userId));
    } catch (e) {
        const message = e?.message ?? String(e);
        console.error(`[accounts] posting for order ${orderId} failed (settle unaffected):`, message);
        return { status: 'failed', reason: message, vouchers: [] };
    }
};

/* The two hooks orderActions.js fires after commit. Both delegate to the
 * one reconciler: a void of a paid bill is just an order with one more
 * payments row and a cancelled status. */
export const afterSettleGl = (order) => syncOrderJournals(order);
export const afterVoidGl = (order) => syncOrderJournals(order);

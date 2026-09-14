/*
 * The rest of the money movements, posted to the general ledger: a city-
 * ledger receipt, a supplier payment, a goods receiving, and a drawer close
 * that did not count to the rupee. Same posture as post.mjs — called AFTER
 * the document's transaction commits, fire-and-forget, own transaction on
 * the pool, never throws to its caller, one console.error line on a fault.
 *
 *   RV  city-ledger receipt (company_receipts row)
 *       Dr <receipt account for method>          receipt.amount
 *         Cr AR — City Ledger                    receipt.amount
 *       Nothing posts from company_invoices: the receivable already reached
 *       the GL when the bill settled (SM: Dr AR City Ledger / Cr Guest
 *       Ledger), so booking the invoice again would count it twice.
 *
 *   PV  supplier payment (supplier_payments row)
 *       Dr AP — Suppliers                        payment.amount
 *         Cr <payment account for method>        payment.amount
 *
 *   JV  goods received (stock_receivings row)
 *       Dr Inventory control                     receiving.total
 *         Cr AP — Suppliers                      receiving.total
 *       This and the PV land together, or AP runs permanently one-sided.
 *       Typed JV: the ledger's six voucher types carry no purchase voucher
 *       and a receiving is not a payment, so it files as a general journal
 *       keyed by source_type 'stock_receiving'.
 *
 *   JV  drawer variance (drawer_sessions row, closed, variance <> 0)
 *       short:  Dr Cash Over and Short / Cr Cash in Drawer   |variance|
 *       over:   Dr Cash in Drawer / Cr Cash Over and Short   |variance|
 *       A drawer that counted right posts nothing.
 *
 * How each account is found (never by number):
 *   receipt account     gl_links receipt_method:<method>, else payment_method:<method>
 *   AR city ledger      gl_links payment_method:city_ledger — the SAME account the
 *                       settle credited into, so the receipt clears what the
 *                       settle booked. (A per-company 'company' link is not
 *                       honoured here because the settle does not honour it
 *                       either; the two must agree.)
 *   AP suppliers        gl_links supplier:<supplier_id> when the owner has mapped
 *                       that supplier, else the active account carrying link
 *                       code AP in category ACCOUNTS PAYABLE whose name contains
 *                       'Suppliers' (lowest number wins).
 *   payment account     gl_links payment_method:<method>, else receipt_method:<method>
 *                       (supplier_payments.method allows 'bank' and 'cheque',
 *                       which only the receipt_method links know).
 *   inventory control   gl_links has no 'inventory' link_type (the CHECK on
 *                       link_type forbids it), so: the lowest-numbered active
 *                       account carrying link code INVENTORY.
 *   cash in drawer      gl_links payment_method:cash
 *   cash over/short     gl_settings.cash_over_short_account_id
 * A resolution that comes up empty is a refusal — logged, nothing posted —
 * never a plug to Suspense.
 *
 * Business dates. A receiving and a drawer session carry their own
 * business_date and post there. A receipt and a supplier payment carry only
 * a UTC timestamp, so they post to the business day that was open at that
 * moment (business_days by opened_at/closed_at window), falling back to the
 * Karachi calendar day of the timestamp — which is exactly the day the
 * recording action stamped on its own audit row.
 *
 * Idempotent on gl_journals UNIQUE (source_type, source_id): header first,
 * ON DUPLICATE KEY UPDATE id = id, duplicate detected by insertId === 0 (not
 * affectedRows, which this driver reports as 1 under CLIENT_FOUND_ROWS), and
 * a SAVEPOINT so a lost race hands its voucher number back.
 *
 * Plain-Node importable, relative imports only, like post.mjs — the small
 * helpers are restated rather than imported from helpers.mjs, which is
 * `server-only` and alias-imported.
 */
import { withTransaction } from '../db/pool.mjs';
import { VOUCHER_TYPES } from './constants.mjs';
import { BRANCH_ID, money, ymd, karachiDayOf, clip, nextVoucherNo, audit } from './kit.mjs';

/* The business events this module books, as gl_journals.source_type. */
export const OTHER_SOURCE_TYPES = Object.freeze({
    receipt: 'cl_receipt',                  // source_id = company_receipts.id
    supplierPayment: 'supplier_payment',    // source_id = supplier_payments.id
    receiving: 'stock_receiving',           // source_id = stock_receivings.id
    drawerVariance: 'drawer_variance',      // source_id = drawer_sessions.id
});

/* The business day that was open at a moment: the day the recording action
 * itself stamped. Falls back to the calendar day of the moment. */
const businessDayAt = async (conn, at) => {
    const [rows] = await conn.query(
        `SELECT business_date FROM business_days
          WHERE branch_id = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at >= ?)
          ORDER BY business_date DESC LIMIT 1`,
        [BRANCH_ID, at, at],
    );
    return rows.length ? ymd(rows[0].business_date) : karachiDayOf(at);
};

const linkAccount = async (conn, type, ref) => {
    const [rows] = await conn.query(
        'SELECT account_id FROM gl_links WHERE link_type = ? AND ref_id = ?',
        [type, String(ref)],
    );
    return rows[0]?.account_id ?? null;
};

/* The first active account carrying a link code, optionally narrowed. */
/*
 * Resolve an account by what it is FOR, never by what it is called. The name
 * option this used to take is gone on purpose: a chart is renamed by whoever
 * keeps the books, and a resolver that reads the name turns that into a silent
 * posting failure. Link code, category and the number's order are structure;
 * the name is prose.
 */
const accountByLinkCode = async (conn, code, { category = null } = {}) => {
    const where = ['is_active = 1', 'JSON_CONTAINS(link_codes, ?)'];
    const params = [JSON.stringify(code)];
    if (category) { where.push('category = ?'); params.push(category); }
    const [rows] = await conn.query(
        `SELECT id FROM accounts WHERE ${where.join(' AND ')} ORDER BY account_number LIMIT 1`,
        params,
    );
    return rows[0]?.id ?? null;
};

const resolveReceiptAccount = async (conn, method) =>
    (await linkAccount(conn, 'receipt_method', method))
    ?? (await linkAccount(conn, 'payment_method', method));

const resolvePaymentAccount = async (conn, method) =>
    (await linkAccount(conn, 'payment_method', method))
    ?? (await linkAccount(conn, 'receipt_method', method));

const resolveArCityLedger = (conn) => linkAccount(conn, 'payment_method', 'city_ledger');

/*
 * The supplier's own mapped account if it has one, else the payables control.
 *
 * That fallback used to match on the NAME containing "Suppliers", which is the
 * wording the 006 seed happened to use. It broke the day the chart moved to the
 * accountant's, where the account is called plainly "Accounts Payable" (2000)
 * with "Accounts Payable - Sundry" (2005) beside it — every GRN and supplier
 * payment stopped posting, silently, because these hooks swallow their own
 * errors. Resolve by structure instead: the lowest-numbered active account
 * carrying the AP link code in the payables category, which is the control by
 * construction and cannot be the sundry one next to it.
 */
const resolveApSuppliers = async (conn, supplierId) =>
    (supplierId != null && await linkAccount(conn, 'supplier', supplierId))
    || accountByLinkCode(conn, 'AP', { category: 'ACCOUNTS PAYABLE' });

const resolveInventory = (conn) => accountByLinkCode(conn, 'INVENTORY');

const need = (accountId, what) => {
    if (!accountId) throw new Error(`no account resolves for ${what}. Map it under Accounts before this can post`);
    return accountId;
};

const findJournal = async (conn, sourceType, sourceId) => {
    const [rows] = await conn.query(
        'SELECT id, voucher_no, business_date FROM gl_journals WHERE source_type = ? AND source_id = ?',
        [sourceType, String(sourceId)],
    );
    return rows[0] ?? null;
};

/*
 * One balanced voucher under a savepoint — the same contract as post.mjs's
 * writer: paise-rounded, zero lines dropped, Dr === Cr asserted before any
 * write, null back when a twin already owns the (source_type, source_id).
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
        if (!l.account_id) throw new Error(`${j.voucherType} ${j.sourceType}/${j.sourceId}: a line has no account`);
        if (l.debit < 0 || l.credit < 0 || (l.debit !== 0 && l.credit !== 0)) {
            throw new Error(`${j.voucherType} ${j.sourceType}/${j.sourceId}: a line must carry exactly one positive side`);
        }
    }
    if (lines.length === 0) throw new Error(`${j.voucherType} ${j.sourceType}/${j.sourceId}: nothing to post`);

    const debitTotal = money(lines.reduce((s, l) => s + l.debit, 0));
    const creditTotal = money(lines.reduce((s, l) => s + l.credit, 0));
    if (debitTotal !== creditTotal) {
        throw new Error(
            `${j.voucherType} ${j.sourceType}/${j.sourceId} does not balance: Dr ${debitTotal} vs Cr ${creditTotal}`,
        );
    }

    await conn.query('SAVEPOINT journal');
    const voucherNo = await nextVoucherNo(conn, j.voucherType, j.businessDate);
    const [result] = await conn.query(
        `INSERT INTO gl_journals
           (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
            description, reference, status, debit_total, credit_total, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
            BRANCH_ID, j.businessDate, j.voucherType, voucherNo, j.sourceType, String(j.sourceId),
            clip(j.description), j.reference == null ? null : clip(j.reference, 64),
            debitTotal, creditTotal, j.userId ?? null,
        ],
    );
    if (!result.insertId) {
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

const skipped = (reason) => ({ status: 'skipped', reason, vouchers: [] });

/* The module switches: off, or a document dated before the ledger began. */
const gate = async (conn, bd) => {
    const [rows] = await conn.query('SELECT * FROM gl_settings WHERE id = 1');
    const settings = rows[0];
    if (!settings) return { settings: null, skip: skipped('gl_settings has no row') };
    if (!settings.posting_enabled) return { settings, skip: skipped('posting is switched off') };
    if (bd < ymd(settings.start_date)) {
        return { settings, skip: skipped(`business day ${bd} is before the ledger start date`) };
    }
    return { settings, skip: null };
};

/* One shape for every entry point: id or row in, a result envelope out,
 * a fault logged and swallowed. */
const run = (label, docLike, userId, body) => {
    const id = (docLike && typeof docLike === 'object') ? docLike.id : docLike;
    const docId = Number(id);
    return (async () => {
        try {
            if (!Number.isInteger(docId) || docId <= 0) return skipped(`no ${label}`);
            return await withTransaction((conn) => body(conn, docId, userId));
        } catch (e) {
            const message = e?.message ?? String(e);
            console.error(`[accounts] posting for ${label} ${id} failed (document unaffected):`, message);
            return { status: 'failed', reason: message, vouchers: [] };
        }
    })();
};

const posted = (vouchers) => ({ status: 'posted', reason: null, vouchers });

// ---------------------------------------------------------------- receipts

const receiptTx = async (conn, receiptId, userId) => {
    const [rows] = await conn.query(
        `SELECT r.id, r.company_id, r.invoice_id, r.amount, r.method, r.reference, r.received_at,
                c.name AS company_name, i.invoice_no
           FROM company_receipts r
           JOIN companies c ON c.id = r.company_id
           LEFT JOIN company_invoices i ON i.id = r.invoice_id
          WHERE r.id = ?`,
        [receiptId],
    );
    const r = rows[0];
    if (!r) return skipped('receipt not found');
    if (await findJournal(conn, OTHER_SOURCE_TYPES.receipt, r.id)) return posted([]);

    const bd = await businessDayAt(conn, r.received_at);
    const { skip } = await gate(conn, bd);
    if (skip) return skip;

    const amount = money(r.amount);
    if (amount <= 0) return skipped('receipt amount is not positive');

    const receiptAccount = need(await resolveReceiptAccount(conn, r.method), `receipt method '${r.method}'`);
    const arAccount = need(await resolveArCityLedger(conn), 'the city-ledger receivable (payment_method city_ledger)');

    const memo = r.reference ? `${r.method} · ${r.reference}` : r.method;
    const voucher = await postJournal(conn, {
        businessDate: bd,
        voucherType: 'RV',
        sourceType: OTHER_SOURCE_TYPES.receipt,
        sourceId: r.id,
        description: `${VOUCHER_TYPES.RV} ${r.method} · ${r.company_name}` + (r.invoice_no ? ` · ${r.invoice_no}` : ''),
        reference: r.reference || r.invoice_no || null,
        lines: [
            { account_id: receiptAccount, debit: amount, memo },
            { account_id: arAccount, credit: amount, memo: r.company_name },
        ],
        userId,
    });
    if (!voucher) return posted([]);

    await audit(conn, {
        bd, action: 'gl_post_receipt', userId,
        details: {
            receipt_id: r.id, company_id: r.company_id, company: r.company_name,
            invoice_no: r.invoice_no ?? null, amount, method: r.method,
            vouchers: [voucher],
        },
    });
    return posted([voucher]);
};

/*
 * A city-ledger receipt reaches the ledger: Dr the account the money landed
 * in, Cr the receivable the settle booked. Accepts the company_receipts row
 * or its id. Never throws.
 */
export const afterReceiptGl = (receiptLike, { userId = null } = {}) =>
    run('receipt', receiptLike, userId, receiptTx);

// ------------------------------------------------------- supplier payments

const supplierPaymentTx = async (conn, paymentId, userId) => {
    const [rows] = await conn.query(
        `SELECT p.id, p.supplier_id, p.amount, p.method, p.reference, p.paid_at, s.name AS supplier_name
           FROM supplier_payments p
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.id = ?`,
        [paymentId],
    );
    const p = rows[0];
    if (!p) return skipped('supplier payment not found');
    if (await findJournal(conn, OTHER_SOURCE_TYPES.supplierPayment, p.id)) return posted([]);

    const bd = await businessDayAt(conn, p.paid_at);
    const { skip } = await gate(conn, bd);
    if (skip) return skip;

    const amount = money(p.amount);
    if (amount <= 0) return skipped('payment amount is not positive');

    const apAccount = need(await resolveApSuppliers(conn, p.supplier_id), 'the suppliers payable control (link code AP)');
    const paidFrom = need(await resolvePaymentAccount(conn, p.method), `payment method '${p.method}'`);

    const memo = p.reference ? `${p.method} · ${p.reference}` : p.method;
    const voucher = await postJournal(conn, {
        businessDate: bd,
        voucherType: 'PV',
        sourceType: OTHER_SOURCE_TYPES.supplierPayment,
        sourceId: p.id,
        description: `${VOUCHER_TYPES.PV} ${p.method} · ${p.supplier_name}`,
        reference: p.reference || null,
        lines: [
            { account_id: apAccount, debit: amount, memo: p.supplier_name },
            { account_id: paidFrom, credit: amount, memo },
        ],
        userId,
    });
    if (!voucher) return posted([]);

    await audit(conn, {
        bd, action: 'gl_post_supplier_payment', userId,
        details: {
            payment_id: p.id, supplier_id: p.supplier_id, supplier: p.supplier_name,
            amount, method: p.method, reference: p.reference ?? null,
            vouchers: [voucher],
        },
    });
    return posted([voucher]);
};

/*
 * Money out to a supplier: Dr the payables control, Cr the account it left.
 * Accepts the supplier_payments row or its id. Never throws.
 */
export const afterSupplierPaymentGl = (paymentLike, { userId = null } = {}) =>
    run('supplier payment', paymentLike, userId, supplierPaymentTx);

// -------------------------------------------------------------- receivings

const receivingTx = async (conn, receivingId, userId) => {
    const [rows] = await conn.query(
        `SELECT r.id, r.supplier_id, r.warehouse_id, r.supplier_invoice, r.business_date, r.total,
                s.name AS supplier_name, w.name AS warehouse_name,
                (SELECT COUNT(*) FROM stock_receiving_lines l WHERE l.receiving_id = r.id) AS line_count
           FROM stock_receivings r
           JOIN suppliers s ON s.id = r.supplier_id
           JOIN warehouses w ON w.id = r.warehouse_id
          WHERE r.id = ?`,
        [receivingId],
    );
    const r = rows[0];
    if (!r) return skipped('receiving not found');
    if (await findJournal(conn, OTHER_SOURCE_TYPES.receiving, r.id)) return posted([]);

    const bd = ymd(r.business_date);
    const { skip } = await gate(conn, bd);
    if (skip) return skip;

    // The stored header total, never re-summed from the lines: the receiving
    // verb rounded it once, and that is the figure the supplier ledger shows.
    const total = money(r.total);
    if (total <= 0) return skipped('receiving total is zero. Nothing owed');

    const inventoryAccount = need(await resolveInventory(conn), 'the stock control account (link code INVENTORY)');
    const apAccount = need(await resolveApSuppliers(conn, r.supplier_id), 'the suppliers payable control (link code AP)');

    const n = Number(r.line_count);
    const voucher = await postJournal(conn, {
        businessDate: bd,
        voucherType: 'JV',
        sourceType: OTHER_SOURCE_TYPES.receiving,
        sourceId: r.id,
        description: `Goods received ${r.supplier_invoice || `GRN ${r.id}`} · ${r.supplier_name}`,
        reference: r.supplier_invoice || `GRN-${r.id}`,
        lines: [
            { account_id: inventoryAccount, debit: total, memo: `${n} line${n === 1 ? '' : 's'} · ${r.warehouse_name}` },
            { account_id: apAccount, credit: total, memo: r.supplier_name },
        ],
        userId,
    });
    if (!voucher) return posted([]);

    await audit(conn, {
        bd, action: 'gl_post_receiving', userId,
        details: {
            receiving_id: r.id, supplier_id: r.supplier_id, supplier: r.supplier_name,
            warehouse_id: r.warehouse_id, supplier_invoice: r.supplier_invoice ?? null,
            total, lines: n,
            vouchers: [voucher],
        },
    });
    return posted([voucher]);
};

/*
 * Goods received: Dr stock control, Cr the supplier payable, for the GRN's
 * stored total. Accepts the stock_receivings row or its id. Never throws.
 */
export const afterReceivingGl = (receivingLike, { userId = null } = {}) =>
    run('receiving', receivingLike, userId, receivingTx);

// --------------------------------------------------------- drawer variance

const drawerCloseTx = async (conn, sessionId, userId) => {
    const [rows] = await conn.query(
        `SELECT id, business_date, cashier_role, closed_at, expected_amount, counted_amount, variance
           FROM drawer_sessions WHERE id = ?`,
        [sessionId],
    );
    const s = rows[0];
    if (!s) return skipped('drawer session not found');
    if (!s.closed_at) return skipped('drawer session is still open');
    if (await findJournal(conn, OTHER_SOURCE_TYPES.drawerVariance, s.id)) return posted([]);

    // The frozen figure on the row, not a re-count: what the cashier signed
    // off is what the ledger explains.
    const variance = s.variance == null
        ? money(Number(s.counted_amount) - Number(s.expected_amount))
        : money(s.variance);
    if (variance === 0) return skipped('drawer counted to the rupee, so there is no variance to book');

    const bd = ymd(s.business_date);
    const { settings, skip } = await gate(conn, bd);
    if (skip) return skip;

    const cashAccount = need(await linkAccount(conn, 'payment_method', 'cash'), 'the cash drawer (payment_method cash)');
    const overShort = need(settings.cash_over_short_account_id, 'gl_settings.cash_over_short_account_id');

    const abs = money(Math.abs(variance));
    const short = variance < 0;
    const memo = `${s.cashier_role} drawer · ${short ? 'short' : 'over'}`;
    const voucher = await postJournal(conn, {
        businessDate: bd,
        voucherType: 'JV',
        sourceType: OTHER_SOURCE_TYPES.drawerVariance,
        sourceId: s.id,
        description: `Drawer close ${s.cashier_role} · ${short ? 'short' : 'over'}`,
        reference: `DRW-${s.id}`,
        lines: short
            ? [
                { account_id: overShort, debit: abs, memo },
                { account_id: cashAccount, credit: abs, memo },
            ]
            : [
                { account_id: cashAccount, debit: abs, memo },
                { account_id: overShort, credit: abs, memo },
            ],
        userId,
    });
    if (!voucher) return posted([]);

    await audit(conn, {
        bd, action: 'gl_post_drawer_variance', userId,
        details: {
            session_id: s.id, cashier_role: s.cashier_role,
            expected: money(s.expected_amount), counted: money(s.counted_amount), variance,
            vouchers: [voucher],
        },
    });
    return posted([voucher]);
};

/*
 * A closed drawer's variance: a short is an expense against the cash the
 * drawer no longer holds; an over is cash the drawer holds against income
 * nobody rang up. Zero books nothing. Accepts the drawer_sessions row or its
 * id. Never throws.
 */
export const afterDrawerCloseGl = (sessionLike, { userId = null } = {}) =>
    run('drawer session', sessionLike, userId, drawerCloseTx);

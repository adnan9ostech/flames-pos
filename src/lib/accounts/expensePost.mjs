/*
 * Expense vouchers: the document, its posting, and its projection.
 *
 * ChowPOS's Expense Voucher, kept to its shape: a dated document with many
 * expense lines (each picks a CODE, and the code carries both accounts) and
 * many payment lines (each names the asset account the money left). DRAFT
 * until posted; posting does three things in ONE transaction:
 *
 *   1. The EV journal.
 *        Dr  <code.account_id>            per line, grouped by account
 *          Cr <payment.account_id>        per payment, grouped by account
 *          Cr <code.payable_account_id>   whatever the payments did not cover
 *      Payments are allocated to lines first-to-last, so the unpaid remainder
 *      of a part-paid voucher credits the payable account of the LAST lines,
 *      deterministically; with every code on one payable account (the seed)
 *      it is one line either way. Balanced by construction, asserted anyway.
 *
 *   2. The PROJECTION: one `expenses` row per voucher line, carrying
 *      voucher_line_id back to its origin. This is what the drawer's expected-
 *      cash figure and the handover report read (they never see vouchers), so
 *      the row's paid_from/status/created_at are set to make the drawer count
 *      right: a line paid from the drawer account TODAY is
 *      paid_from='drawer', status='paid', created_at=now — exactly what
 *      src/app/drawer/actions.js filters on. The UNIQUE on voucher_line_id
 *      makes a second projection structurally impossible.
 *
 *   3. The document flips to 'posted' and the audit row is written.
 *
 * A payment added to a posted voucher is a PV journal (Dr payable / Cr the
 * paying account) and flips the projected rows it completes to 'paid'. A
 * reversal is contra journals for the EV and every PV, the document marked
 * 'void', and the projected rows DELETED — they are a projection, and the
 * drawer must stop counting them.
 *
 * Plain-Node importable, relative imports only, like post.mjs: the test
 * suite drives every verb here directly through withTransaction. The small
 * helpers are restated from helpers.mjs for the same reason post.mjs
 * restates them — that file is `server-only` and cannot load outside Next.
 * No account NUMBER appears here; every account comes from the code, the
 * payment line, gl_links or gl_settings.
 */
import { VOUCHER_TYPES } from './constants.mjs';
import { money, ymd, todayKarachi, clip, requireDate, requireId, currentBusinessDate, audit, nextVoucherNo } from './kit.mjs';

/* The business events a voucher produces, as gl_journals.source_type. */
export const EXPENSE_SOURCE_TYPES = Object.freeze({
    voucher: 'expense_voucher',                    // source_id = expense_vouchers.id
    payment: 'expense_payment',                    // source_id = expense_voucher_payments.id
    voucherReversal: 'expense_voucher_reversal',   // source_id = expense_vouchers.id
    paymentReversal: 'expense_payment_reversal',   // source_id = expense_voucher_payments.id
});

/* expenses.paid_from's vocabulary (002_features.sql CHECK). */
const PAID_FROM = ['drawer', 'bank', 'other'];

const rupees = (n) => `Rs. ${money(n).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* The current open business day on this connection: where a correction
 * lands, and the day an audit row is filed under. */

/* The latest day a document may post on: the open trading day or the
 * Karachi calendar day, whichever is later (after a late-night close the
 * open day carries tomorrow's date). Nothing posts ahead of the books —
 * the same bound the manual journal applies. */
const latestPostingDate = async (conn, branchId = 1) =>
    [await currentBusinessDate(conn, branchId), todayKarachi()].sort().at(-1);

/*
 * The document's own number, EV-YYMMDD-NNNN, from expense_voucher_counters —
 * the same upsert-then-read idiom as nextVoucherNo, so two vouchers saved in
 * the same instant cannot share one. Distinct from the EV JOURNAL's number,
 * which gl_voucher_counters mints when the voucher is posted; the journal
 * carries the document number in its `reference` so the two are always
 * joined.
 */
const nextExpenseVoucherNo = async (conn, bd, branchId = 1) => {
    await conn.query(
        `INSERT INTO expense_voucher_counters (branch_id, day, last_no) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE last_no = last_no + 1`,
        [branchId, bd],
    );
    const [rows] = await conn.query(
        'SELECT last_no FROM expense_voucher_counters WHERE branch_id = ? AND day = ?',
        [branchId, bd],
    );
    return `EV-${bd.slice(2).replace(/-/g, '')}-${String(rows[0].last_no).padStart(4, '0')}`;
};

/*
 * One balanced journal under a savepoint: the post.mjs idiom restated.
 * Zero lines dropped, Dr === Cr asserted before anything is written, and a
 * duplicate (source_type, source_id) — insertId 0 under CLIENT_FOUND_ROWS,
 * never affectedRows — rolls this journal's work back, voucher number
 * included, and returns null.
 */
const writeJournal = async (conn, j) => {
    const lines = j.lines
        .map((l) => ({
            account_id: l.account_id, debit: money(l.debit), credit: money(l.credit),
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
        throw new Error(`${j.voucherType} for ${j.reference} does not balance: Dr ${debitTotal} vs Cr ${creditTotal}`);
    }

    await conn.query('SAVEPOINT expense_journal');
    const voucherNo = await nextVoucherNo(conn, j.voucherType, j.businessDate, j.branchId);
    const [result] = await conn.query(
        `INSERT INTO gl_journals
           (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
            description, reference, status, debit_total, credit_total, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [j.branchId, j.businessDate, j.voucherType, voucherNo, j.sourceType, String(j.sourceId),
            clip(j.description), j.reference ?? null, debitTotal, creditTotal, j.userId ?? null],
    );
    if (!result.insertId) {
        await conn.query('ROLLBACK TO SAVEPOINT expense_journal');
        return null;
    }
    await conn.query(
        'INSERT INTO gl_journal_lines (journal_id, account_id, debit, credit, memo) VALUES ?',
        [lines.map((l) => [result.insertId, l.account_id, l.debit, l.credit, l.memo])],
    );
    return {
        id: result.insertId, voucher_type: j.voucherType, voucher_no: voucherNo,
        source_type: j.sourceType, source_id: String(j.sourceId),
        business_date: j.businessDate, amount: debitTotal,
    };
};

/* The stored lines of a journal with the sides swapped: a contra. */
const contraLinesOf = async (conn, journalId) => {
    const [stored] = await conn.query(
        'SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id',
        [journalId],
    );
    return stored.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo }));
};

/* Grouped Dr/Cr lines: one journal line per account, memos joined. */
const grouped = (entries, side) => {
    const map = new Map();
    for (const e of entries) {
        if (money(e.amount) === 0) continue;
        const cur = map.get(e.account_id) || { amount: 0, memos: [] };
        cur.amount = money(cur.amount + e.amount);
        if (e.memo && !cur.memos.includes(e.memo)) cur.memos.push(e.memo);
        map.set(e.account_id, cur);
    }
    return [...map].map(([account_id, g]) => ({
        account_id, [side]: g.amount, memo: g.memos.join(', ') || null,
    }));
};

/*
 * account → expenses.paid_from. The seed maps expense_paid_from
 * drawer/bank/other to the drawer, the bank and suspense; any account the
 * till settles cash into is the drawer too. Anything else is 'other'.
 */
const loadPaidFromMap = async (conn) => {
    const [rows] = await conn.query(
        `SELECT link_type, ref_id, account_id FROM gl_links
          WHERE link_type IN ('expense_paid_from', 'payment_method')`,
    );
    const map = new Map();
    for (const r of rows) {
        if (r.link_type === 'expense_paid_from' && PAID_FROM.includes(r.ref_id) && !map.has(r.account_id)) {
            map.set(r.account_id, r.ref_id);
        }
    }
    for (const r of rows) {
        if (r.link_type === 'payment_method' && r.ref_id === 'cash' && !map.has(r.account_id)) {
            map.set(r.account_id, 'drawer');
        }
    }
    return (accountId) => map.get(accountId) || 'other';
};

/* ---------------------------------------------------------------- reading */

const loadDocument = async (conn, voucherId, { forUpdate = false } = {}) => {
    const [vRows] = await conn.query(
        `SELECT * FROM expense_vouchers WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [voucherId],
    );
    const voucher = vRows[0];
    if (!voucher) throw new Error('That voucher no longer exists');
    const [lines] = await conn.query(
        `SELECT l.id, l.voucher_id, l.expense_code_id, l.description, l.amount,
                c.code, c.name AS code_name, c.category_id, c.account_id, c.payable_account_id,
                c.is_active AS code_active,
                cat.name AS category_name, a.name AS account_name, a.account_number,
                pa.name AS payable_account_name
           FROM expense_voucher_lines l
           JOIN expense_codes c ON c.id = l.expense_code_id
           LEFT JOIN expense_categories cat ON cat.id = c.category_id
           LEFT JOIN accounts a ON a.id = c.account_id
           LEFT JOIN accounts pa ON pa.id = c.payable_account_id
          WHERE l.voucher_id = ?
          ORDER BY l.id`,
        [voucherId],
    );
    const [payments] = await conn.query(
        `SELECT p.id, p.voucher_id, p.account_id, p.amount, p.paid_on, p.reference, p.created_at,
                a.name AS account_name, a.account_number
           FROM expense_voucher_payments p
           LEFT JOIN accounts a ON a.id = p.account_id
          WHERE p.voucher_id = ?
          ORDER BY p.id`,
        [voucherId],
    );
    return { voucher, lines, payments };
};

/* Every journal this voucher has produced: the EV, its PVs, their contras. */
const loadJournals = async (conn, doc) => {
    const paymentIds = doc.payments.map((p) => String(p.id));
    const [rows] = await conn.query(
        `SELECT id, voucher_type, voucher_no, source_type, source_id, business_date,
                description, debit_total, status
           FROM gl_journals
          WHERE (source_type IN (?, ?) AND source_id = ?)
             ${paymentIds.length ? 'OR (source_type IN (?, ?) AND source_id IN (?))' : ''}
          ORDER BY id`,
        [
            EXPENSE_SOURCE_TYPES.voucher, EXPENSE_SOURCE_TYPES.voucherReversal, String(doc.voucher.id),
            ...(paymentIds.length
                ? [EXPENSE_SOURCE_TYPES.payment, EXPENSE_SOURCE_TYPES.paymentReversal, paymentIds]
                : []),
        ],
    );
    return rows;
};

/* The whole document as the screens want it: plain values, dates as text. */
const serializeDocument = (doc, journals = [], expenses = []) => ({
    ...doc.voucher,
    business_date: ymd(doc.voucher.business_date),
    total: money(doc.voucher.total),
    paid_total: money(doc.voucher.paid_total),
    owed: money(doc.voucher.total - doc.voucher.paid_total),
    created_at: doc.voucher.created_at?.toISOString?.() ?? doc.voucher.created_at,
    posted_at: doc.voucher.posted_at?.toISOString?.() ?? doc.voucher.posted_at,
    lines: doc.lines.map((l) => ({
        id: l.id, expense_code_id: l.expense_code_id, description: l.description,
        amount: money(l.amount), code: l.code, code_name: l.code_name,
        category_id: l.category_id, category_name: l.category_name,
        account_id: l.account_id, account_name: l.account_name, account_number: l.account_number,
        payable_account_id: l.payable_account_id, payable_account_name: l.payable_account_name,
    })),
    payments: doc.payments.map((p) => ({
        id: p.id, account_id: p.account_id, amount: money(p.amount), paid_on: ymd(p.paid_on),
        reference: p.reference, account_name: p.account_name, account_number: p.account_number,
    })),
    journals: journals.map((j) => ({
        id: j.id, voucher_type: j.voucher_type, voucher_no: j.voucher_no,
        source_type: j.source_type, source_id: j.source_id,
        business_date: ymd(j.business_date), description: j.description,
        amount: money(j.debit_total), status: j.status,
    })),
    expenses: expenses.map((e) => ({
        id: e.id, voucher_line_id: e.voucher_line_id, status: e.status, paid_from: e.paid_from,
        amount: money(e.amount),
    })),
});

/* Read one voucher with its journals and projected rows, on any runner. */
export const loadVoucher = async (conn, voucherId) => {
    const doc = await loadDocument(conn, requireId(voucherId, 'voucher'));
    const journals = await loadJournals(conn, doc);
    const [expenses] = await conn.query(
        `SELECT id, voucher_line_id, status, paid_from, amount FROM expenses
          WHERE voucher_line_id IN (?) ORDER BY id`,
        [doc.lines.length ? doc.lines.map((l) => l.id) : [0]],
    );
    return serializeDocument(doc, journals, expenses);
};

/* ------------------------------------------------------------- allocation */

/*
 * Payments allocated to lines first-to-last. Each line learns how much of it
 * is unpaid, which payments went into it and which one completed it; that
 * one decision feeds the EV's payable credits, the PV's payable debits and
 * the projection's paid_from, so the three can never disagree.
 */
const allocate = (lines, payments) => {
    const pool = payments.map((p) => ({ ...p, left: money(p.amount) }));
    let cursor = 0;
    return lines.map((l) => {
        let need = money(l.amount);
        let completedBy = null;
        const paidBy = [];
        while (need > 0 && cursor < pool.length) {
            const p = pool[cursor];
            if (p.left <= 0) { cursor += 1; continue; }
            const take = money(Math.min(need, p.left));
            p.left = money(p.left - take);
            need = money(need - take);
            paidBy.push({ payment: p, amount: take });
            if (need === 0) completedBy = p;
            if (p.left === 0) cursor += 1;
        }
        return { line: l, unpaid: need, completedBy, paidBy };
    });
};

/*
 * The projection can say exactly one thing about a line — paid from the
 * drawer, paid from the bank, paid from elsewhere, or owed — so a line must
 * be either untouched by payments or paid in full from ONE source. A line a
 * payment only part-covers, or one cleared from two sources, has no honest
 * `expenses` row and the drawer's expected cash would be off by the part it
 * could not say; it is refused, with what would be accepted.
 */
const checkAllocation = (allocation, paidFromOf) => {
    allocation.forEach((a, i) => {
        const amount = money(a.line.amount);
        if (a.unpaid > 0 && a.unpaid < amount) {
            throw new Error(
                `Line ${i + 1} (${a.line.code}, ${rupees(amount)}) is only part-paid. A line is paid in full `
                + 'from one account or left unpaid. Adjust the payments, or split the line in two.',
            );
        }
        const sources = [...new Set(a.paidBy.map((x) => paidFromOf(x.payment.account_id)))];
        if (sources.length > 1) {
            throw new Error(
                `Line ${i + 1} (${a.line.code}) is paid from ${sources.join(' and ')}: pay each line from one `
                + 'account, or split the line in two.',
            );
        }
    });
};

/* "Rs. a, Rs. b or Rs. c" */
const listOr = (amounts) => {
    const words = amounts.map(rupees);
    return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
};

/* -------------------------------------------------------------- the draft */

const cleanLines = (input) => {
    const raw = Array.isArray(input) ? input : [];
    const lines = raw
        .filter((l) => l && (l.expense_code_id || String(l.amount ?? '').trim() !== '' || String(l.description ?? '').trim()))
        .map((l) => {
            const expense_code_id = Number(l.expense_code_id);
            if (!Number.isInteger(expense_code_id) || expense_code_id <= 0) throw new Error('Every expense line needs an expense code');
            const amount = money(l.amount);
            if (!(amount > 0)) throw new Error('Every expense line needs an amount above zero');
            return { expense_code_id, amount, description: clip(String(l.description ?? '').trim()) || null };
        });
    if (lines.length === 0) throw new Error('A voucher needs at least one expense line');
    return lines;
};

const cleanPayments = (input) => {
    const raw = Array.isArray(input) ? input : [];
    return raw
        .filter((p) => p && (p.account_id || String(p.amount ?? '').trim() !== '' || String(p.reference ?? '').trim()))
        .map((p) => {
            const account_id = Number(p.account_id);
            if (!Number.isInteger(account_id) || account_id <= 0) throw new Error('Every payment needs an account to pay from');
            const amount = money(p.amount);
            if (!(amount > 0)) throw new Error('Every payment needs an amount above zero');
            return {
                account_id, amount,
                paid_on: requireDate(p.paid_on, 'paid-on date'),
                reference: clip(String(p.reference ?? '').trim(), 64) || null,
            };
        });
};

/* Codes must exist and be active; payment accounts must be active and carry
 * AP_PAID — the same filter the picker applies, enforced where it counts. */
const checkReferences = async (conn, lines, payments) => {
    const codeIds = [...new Set(lines.map((l) => l.expense_code_id))];
    if (codeIds.length) {
        const [codes] = await conn.query(
            'SELECT id, code, name, is_active, account_id FROM expense_codes WHERE id IN (?)', [codeIds],
        );
        for (const id of codeIds) {
            const c = codes.find((x) => x.id === id);
            if (!c) throw new Error('One of the expense codes no longer exists');
            if (!c.is_active) throw new Error(`Expense code ${c.code} (${c.name}) is inactive`);
        }
    }
    if (payments.length) {
        const acctIds = [...new Set(payments.map((p) => p.account_id))];
        const [accts] = await conn.query(
            'SELECT id, name, is_active, link_codes FROM accounts WHERE id IN (?)', [acctIds],
        );
        for (const id of acctIds) {
            const a = accts.find((x) => x.id === id);
            if (!a) throw new Error('One of the payment accounts no longer exists');
            if (!a.is_active) throw new Error(`${a.name} is inactive and cannot pay an expense`);
            const codes = Array.isArray(a.link_codes) ? a.link_codes : [];
            if (!codes.includes('AP_PAID')) throw new Error(`${a.name} is not marked as able to pay an expense (AP_PAID)`);
        }
    }
};

/*
 * Save a draft: a new one, or a replacement of an existing draft's lines and
 * payments (a draft is not in the books, so rewriting it is safe). Returns
 * the voucher id. Never touches a posted voucher.
 */
export const saveDraft = async (conn, input, userId = null) => {
    const business_date = requireDate(input?.business_date, 'voucher date');
    const remarks = clip(String(input?.remarks ?? '').trim()) || null;
    const lines = cleanLines(input?.lines);
    const payments = cleanPayments(input?.payments);
    const total = money(lines.reduce((s, l) => s + l.amount, 0));
    const paid_total = money(payments.reduce((s, p) => s + p.amount, 0));
    if (paid_total > total) {
        throw new Error(`Payments (${rupees(paid_total)}) exceed the voucher total (${rupees(total)})`);
    }
    await checkReferences(conn, lines, payments);

    const branchId = 1;
    let id = input?.id ? requireId(input.id, 'voucher') : null;
    let voucherNo;
    if (id) {
        const [rows] = await conn.query('SELECT * FROM expense_vouchers WHERE id = ? FOR UPDATE', [id]);
        if (!rows[0]) throw new Error('That voucher no longer exists');
        if (rows[0].status !== 'draft') throw new Error(`Voucher ${rows[0].voucher_no} is ${rows[0].status} and can no longer be edited`);
        voucherNo = rows[0].voucher_no;
        await conn.query(
            `UPDATE expense_vouchers
                SET business_date = ?, remarks = ?, total = ?, paid_total = ?
              WHERE id = ?`,
            [business_date, remarks, total, paid_total, id],
        );
        await conn.query('DELETE FROM expense_voucher_lines WHERE voucher_id = ?', [id]);
        await conn.query('DELETE FROM expense_voucher_payments WHERE voucher_id = ?', [id]);
    } else {
        voucherNo = await nextExpenseVoucherNo(conn, business_date, branchId);
        const [result] = await conn.query(
            `INSERT INTO expense_vouchers
               (branch_id, voucher_no, business_date, status, remarks, total, paid_total, created_by)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
            [branchId, voucherNo, business_date, remarks, total, paid_total, userId],
        );
        id = result.insertId;
    }
    await conn.query(
        'INSERT INTO expense_voucher_lines (voucher_id, expense_code_id, description, amount) VALUES ?',
        [lines.map((l) => [id, l.expense_code_id, l.description, l.amount])],
    );
    if (payments.length) {
        await conn.query(
            'INSERT INTO expense_voucher_payments (voucher_id, account_id, amount, paid_on, reference) VALUES ?',
            [payments.map((p) => [id, p.account_id, p.amount, p.paid_on, p.reference])],
        );
    }
    await audit(conn, {
        branchId, bd: await currentBusinessDate(conn, branchId), userId,
        action: 'expense_voucher_save',
        details: {
            voucher_id: id, voucher_no: voucherNo, mode: input?.id ? 'update' : 'create',
            business_date, remarks, total, paid_total, lines, payments,
        },
    });
    return id;
};

/* A draft leaves nothing behind, so it may simply go. Audited with the
 * whole document, because the row is the only other record of it. */
export const deleteDraft = async (conn, voucherId, userId = null) => {
    const doc = await loadDocument(conn, requireId(voucherId, 'voucher'), { forUpdate: true });
    if (doc.voucher.status !== 'draft') {
        throw new Error(`Voucher ${doc.voucher.voucher_no} is ${doc.voucher.status}. Only a draft can be deleted; reverse a posted one instead`);
    }
    await conn.query('DELETE FROM expense_vouchers WHERE id = ?', [doc.voucher.id]);
    await audit(conn, {
        branchId: doc.voucher.branch_id, bd: await currentBusinessDate(conn, doc.voucher.branch_id), userId,
        action: 'expense_voucher_delete',
        details: serializeDocument(doc),
    });
    return { deleted: doc.voucher.id, voucher_no: doc.voucher.voucher_no };
};

/* ------------------------------------------------------------- the posting */

const loadSettings = async (conn) => {
    const [rows] = await conn.query('SELECT * FROM gl_settings WHERE id = 1');
    if (!rows[0]) throw new Error('The ledger is not set up (gl_settings has no row)');
    if (!rows[0].posting_enabled) throw new Error('Ledger posting is switched off. Nothing can be posted until it is on');
    return rows[0];
};

/*
 * Post a draft. Accepts the voucher id or a row carrying one. Inside the
 * caller's transaction; throws to it. Returns { voucher, journal }.
 */
export const postVoucher = async (conn, voucherLike, userId = null) => {
    const voucherId = requireId(typeof voucherLike === 'object' && voucherLike ? voucherLike.id : voucherLike, 'voucher');
    const settings = await loadSettings(conn);
    // FOR UPDATE: a second poster waits here, then finds it already posted.
    const doc = await loadDocument(conn, voucherId, { forUpdate: true });
    const { voucher, lines, payments } = doc;
    if (voucher.status !== 'draft') throw new Error(`Voucher ${voucher.voucher_no} is already ${voucher.status}`);
    if (lines.length === 0) throw new Error('A voucher needs at least one expense line');

    const bd = ymd(voucher.business_date);
    if (bd < ymd(settings.start_date)) {
        throw new Error(`The ledger starts on ${ymd(settings.start_date)}; this voucher is dated ${bd}`);
    }
    const branchId = voucher.branch_id;
    const latest = await latestPostingDate(conn, branchId);
    if (bd > latest) throw new Error(`The voucher date cannot be after ${latest}. Nothing posts ahead of the books`);
    const total = money(lines.reduce((s, l) => s + Number(l.amount), 0));
    const paidTotal = money(payments.reduce((s, p) => s + Number(p.amount), 0));
    if (paidTotal > total) throw new Error(`Payments (${rupees(paidTotal)}) exceed the voucher total (${rupees(total)})`);
    for (const l of lines) {
        if (!l.code_active) throw new Error(`Expense code ${l.code} (${l.code_name}) is inactive`);
        if (!l.account_id) throw new Error(`Expense code ${l.code} has no expense account`);
    }

    const paidFromOf = await loadPaidFromMap(conn);
    const allocation = allocate(lines, payments);
    checkAllocation(allocation, paidFromOf);
    for (const a of allocation) {
        if (a.unpaid > 0 && !a.line.payable_account_id) {
            throw new Error(`Expense code ${a.line.code} (${a.line.code_name}) has no payable account. Pay this voucher in full or set one on the code`);
        }
    }

    const journal = await writeJournal(conn, {
        branchId,
        businessDate: bd,
        voucherType: 'EV',
        sourceType: EXPENSE_SOURCE_TYPES.voucher,
        sourceId: voucher.id,
        description: `${VOUCHER_TYPES.EV} ${voucher.voucher_no}${voucher.remarks ? ` · ${voucher.remarks}` : ''}`,
        reference: voucher.voucher_no,
        userId,
        lines: [
            ...grouped(lines.map((l) => ({
                account_id: l.account_id, amount: Number(l.amount),
                memo: l.description ? `${l.code} · ${l.description}` : `${l.code} · ${l.code_name}`,
            })), 'debit'),
            ...grouped(payments.map((p) => ({
                account_id: p.account_id, amount: Number(p.amount),
                memo: p.reference ? `Paid · ${p.reference}` : 'Paid',
            })), 'credit'),
            ...grouped(allocation.map((a) => ({
                account_id: a.line.payable_account_id, amount: a.unpaid,
                memo: `Payable · ${a.line.code}`,
            })), 'credit'),
        ],
    });
    if (!journal) throw new Error(`Voucher ${voucher.voucher_no} already has a journal. It was posted by someone else`);

    // The projection. Rows completed by a payment are 'paid' from wherever
    // that payment came (checkAllocation made sure that is one place); the
    // rest are payables. created_at defaults to now, which is the drawer's
    // window — the cash left it today, whatever the voucher is dated.
    const projected = [];
    for (const a of allocation) {
        const l = a.line;
        const paid = a.unpaid === 0;
        const paidFrom = paid ? paidFromOf(a.completedBy.account_id) : 'other';
        try {
            await conn.query('SAVEPOINT expense_projection');
            const [result] = await conn.query(
                `INSERT INTO expenses
                   (business_date, category_id, description, payee, amount, paid_from, status,
                    created_by, paid_at, expense_code_id, voucher_line_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'voucher', ${paid ? 'UTC_TIMESTAMP(3)' : 'NULL'}, ?, ?)`,
                [bd, l.category_id, clip(`${l.code} · ${l.description || l.code_name}`), voucher.remarks,
                    money(l.amount), paidFrom, paid ? 'paid' : 'payable', l.expense_code_id, l.id],
            );
            projected.push({ expense_id: result.insertId, voucher_line_id: l.id, status: paid ? 'paid' : 'payable', paid_from: paidFrom });
        } catch (e) {
            if (e.code !== 'ER_DUP_ENTRY') throw e;
            // Already projected (a voucher_line_id can only be there once).
            await conn.query('ROLLBACK TO SAVEPOINT expense_projection');
        }
    }

    await conn.query(
        `UPDATE expense_vouchers
            SET status = 'posted', total = ?, paid_total = ?, posted_at = UTC_TIMESTAMP(3), posted_by = ?
          WHERE id = ?`,
        [total, paidTotal, userId, voucher.id],
    );
    await audit(conn, {
        branchId, bd: await currentBusinessDate(conn, branchId), userId,
        action: 'expense_voucher_post',
        details: {
            voucher_id: voucher.id, voucher_no: voucher.voucher_no, business_date: bd,
            total, paid_total: paidTotal, journal, projected,
        },
    });
    const [after] = await conn.query('SELECT * FROM expense_vouchers WHERE id = ?', [voucher.id]);
    return { voucher: after[0], journal };
};

/*
 * A payment against what a posted voucher still owes: a PV journal, the
 * document's paid_total moved up, and every projected row the payment
 * completes flipped to 'paid' — with created_at moved to now, because that
 * is the window the drawer counts, and the cash left it now, not on the day
 * the debt was booked (the bug step 10 of the spec names in markPaid).
 */
export const addPayment = async (conn, voucherLike, payment, userId = null) => {
    const voucherId = requireId(typeof voucherLike === 'object' && voucherLike ? voucherLike.id : voucherLike, 'voucher');
    const settings = await loadSettings(conn);
    const [clean] = cleanPayments([{ ...payment, amount: payment?.amount ?? '', account_id: payment?.account_id ?? '' }]);
    if (!clean) throw new Error('A payment needs an account and an amount');
    await checkReferences(conn, [], [clean]);
    if (clean.paid_on < ymd(settings.start_date)) {
        throw new Error(`The ledger starts on ${ymd(settings.start_date)}; this payment is dated ${clean.paid_on}`);
    }

    const doc = await loadDocument(conn, voucherId, { forUpdate: true });
    const { voucher, lines, payments } = doc;
    if (voucher.status !== 'posted') throw new Error(`Voucher ${voucher.voucher_no} is ${voucher.status}. Only a posted voucher takes a payment`);
    const branchId = voucher.branch_id;
    const latest = await latestPostingDate(conn, branchId);
    if (clean.paid_on > latest) throw new Error(`The payment date cannot be after ${latest}. Nothing posts ahead of the books`);
    const owed = money(voucher.total - voucher.paid_total);
    if (owed <= 0) throw new Error(`Voucher ${voucher.voucher_no} is already paid in full`);
    if (clean.amount > owed) throw new Error(`${rupees(clean.amount)} is more than the ${rupees(owed)} still owed`);

    // What this payment clears, line by line: the allocation before and after
    // it, differenced, tells which payable accounts to debit and by how much.
    // A payment clears WHOLE lines (the projection cannot say "half paid"),
    // so one that would stop part-way through a line is refused, naming the
    // amounts that would land on a line boundary.
    const paidFromOf = await loadPaidFromMap(conn);
    const before = allocate(lines, payments);
    const after = allocate(lines, [...payments, { id: 0, ...clean }]);
    const partial = after.findIndex((a) => a.unpaid > 0 && a.unpaid < money(a.line.amount));
    if (partial >= 0) {
        let sum = 0;
        const steps = before.filter((b) => b.unpaid > 0).map((b) => (sum = money(sum + b.unpaid)));
        throw new Error(
            `${rupees(clean.amount)} would leave line ${partial + 1} (${after[partial].line.code}) part-paid. `
            + `A payment clears whole lines. Pay ${listOr(steps)}.`,
        );
    }
    checkAllocation(after, paidFromOf);
    const cleared = before.map((b, i) => ({
        line: b.line, amount: money(b.unpaid - after[i].unpaid), nowPaid: after[i].unpaid === 0 && b.unpaid > 0,
    }));

    // The payable this clears is the one the EV CREDITED — read from the
    // stored journal, never from the code as it stands now: a code whose
    // payable account has been moved since would otherwise debit one
    // account for a liability sitting in another, and both would stay
    // wrong for good. The EV's credit lines, less the accounts the payments
    // came from, are the payables it booked; with one (the seed's case) it
    // is simply that one, with several the code's account must be among them.
    const [evRows] = await conn.query(
        'SELECT id FROM gl_journals WHERE source_type = ? AND source_id = ?',
        [EXPENSE_SOURCE_TYPES.voucher, String(voucher.id)],
    );
    if (!evRows[0]) throw new Error(`Voucher ${voucher.voucher_no} has no journal to pay against`);
    const paidFromAccounts = new Set(payments.map((p) => Number(p.account_id)));
    const [evCredits] = await conn.query(
        'SELECT DISTINCT account_id FROM gl_journal_lines WHERE journal_id = ? AND credit > 0',
        [evRows[0].id],
    );
    const bookedPayables = [...new Set(evCredits.map((l) => Number(l.account_id)).filter((a) => !paidFromAccounts.has(a)))];
    const payableFor = (line) => {
        const target = bookedPayables.length === 1 ? bookedPayables[0] : Number(line.payable_account_id);
        if (!bookedPayables.includes(target)) {
            throw new Error(
                `Expense code ${line.code} no longer points at the payable account voucher ${voucher.voucher_no} `
                + 'was booked with: restore it on the code before paying',
            );
        }
        return target;
    };

    const [ins] = await conn.query(
        'INSERT INTO expense_voucher_payments (voucher_id, account_id, amount, paid_on, reference) VALUES (?, ?, ?, ?, ?)',
        [voucher.id, clean.account_id, clean.amount, clean.paid_on, clean.reference],
    );
    const paymentId = ins.insertId;
    const [acctRows] = await conn.query('SELECT name FROM accounts WHERE id = ?', [clean.account_id]);
    const payingName = acctRows[0]?.name ?? '';

    const journal = await writeJournal(conn, {
        branchId,
        businessDate: clean.paid_on,
        voucherType: 'PV',
        sourceType: EXPENSE_SOURCE_TYPES.payment,
        sourceId: paymentId,
        description: `${VOUCHER_TYPES.PV} ${voucher.voucher_no} · ${payingName}${clean.reference ? ` · ${clean.reference}` : ''}`,
        reference: voucher.voucher_no,
        userId,
        lines: [
            ...grouped(cleared.filter((c) => c.amount > 0).map((c) => ({
                account_id: payableFor(c.line), amount: c.amount, memo: `Payable · ${c.line.code}`,
            })), 'debit'),
            { account_id: clean.account_id, credit: clean.amount, memo: clean.reference ? `Paid · ${clean.reference}` : 'Paid' },
        ],
    });
    if (!journal) throw new Error('This payment has already been posted');

    const paidFrom = paidFromOf(clean.account_id);
    const flipped = [];
    for (const c of cleared) {
        if (!c.nowPaid) continue;
        const [r] = await conn.query(
            `UPDATE expenses
                SET status = 'paid', paid_from = ?, paid_at = UTC_TIMESTAMP(3), created_at = UTC_TIMESTAMP(3)
              WHERE voucher_line_id = ? AND status = 'payable'`,
            [paidFrom, c.line.id],
        );
        if (r.affectedRows) flipped.push(c.line.id);
    }

    const newPaid = money(voucher.paid_total + clean.amount);
    await conn.query('UPDATE expense_vouchers SET paid_total = ? WHERE id = ?', [newPaid, voucher.id]);
    await audit(conn, {
        branchId, bd: await currentBusinessDate(conn, branchId), userId,
        action: 'expense_voucher_pay',
        details: {
            voucher_id: voucher.id, voucher_no: voucher.voucher_no, payment_id: paymentId, ...clean,
            paid_total: newPaid, owed: money(voucher.total - newPaid), journal, flipped_lines: flipped,
        },
    });
    const [rows] = await conn.query('SELECT * FROM expense_vouchers WHERE id = ?', [voucher.id]);
    return { voucher: rows[0], journal, payment_id: paymentId };
};

/*
 * Reverse a posted voucher: a contra for the EV and for every PV, dated the
 * current open day; the document marked void; the projected rows deleted.
 * The journals stay — the ledger is append-only — which is why the projected
 * rows go into the audit details in full.
 */
export const reverseVoucher = async (conn, voucherLike, userId = null, reason = null) => {
    const voucherId = requireId(typeof voucherLike === 'object' && voucherLike ? voucherLike.id : voucherLike, 'voucher');
    await loadSettings(conn);
    const doc = await loadDocument(conn, voucherId, { forUpdate: true });
    const { voucher, lines } = doc;
    if (voucher.status !== 'posted') throw new Error(`Voucher ${voucher.voucher_no} is ${voucher.status}. Only a posted voucher can be reversed`);

    const branchId = voucher.branch_id;
    const day = await currentBusinessDate(conn, branchId);
    const originals = await loadJournals(conn, doc);
    const why = clip(String(reason ?? '').trim()) || null;
    const journals = [];
    for (const j of originals) {
        if (j.source_type !== EXPENSE_SOURCE_TYPES.voucher && j.source_type !== EXPENSE_SOURCE_TYPES.payment) continue;
        const isEv = j.source_type === EXPENSE_SOURCE_TYPES.voucher;
        const posted = await writeJournal(conn, {
            branchId,
            businessDate: day,
            voucherType: j.voucher_type,
            sourceType: isEv ? EXPENSE_SOURCE_TYPES.voucherReversal : EXPENSE_SOURCE_TYPES.paymentReversal,
            sourceId: j.source_id,
            description: `${VOUCHER_TYPES[j.voucher_type]} reversal ${voucher.voucher_no} · void of ${j.voucher_no}${why ? ` · ${why}` : ''}`,
            reference: voucher.voucher_no,
            userId,
            lines: await contraLinesOf(conn, j.id),
        });
        if (posted) journals.push(posted);
    }

    const lineIds = lines.map((l) => l.id);
    const [projected] = await conn.query(
        'SELECT * FROM expenses WHERE voucher_line_id IN (?)', [lineIds.length ? lineIds : [0]],
    );
    if (projected.length) {
        await conn.query('DELETE FROM expenses WHERE voucher_line_id IN (?)', [lineIds]);
    }
    await conn.query("UPDATE expense_vouchers SET status = 'void' WHERE id = ?", [voucher.id]);
    await audit(conn, {
        branchId, bd: day, userId,
        action: 'expense_voucher_reverse',
        details: {
            voucher_id: voucher.id, voucher_no: voucher.voucher_no, reason: why,
            total: money(voucher.total), paid_total: money(voucher.paid_total),
            reversed: originals.map((j) => j.voucher_no), journals,
            deleted_expenses: projected.map((e) => ({
                ...e,
                business_date: ymd(e.business_date),
                created_at: e.created_at?.toISOString?.() ?? e.created_at,
                paid_at: e.paid_at?.toISOString?.() ?? e.paid_at,
            })),
        },
    });
    const [rows] = await conn.query('SELECT * FROM expense_vouchers WHERE id = ?', [voucher.id]);
    return { voucher: rows[0], journals, deleted_expenses: projected.length };
};

/*
 * The general ledger's read model, and the one correction it allows.
 *
 * Three views over gl_journals + gl_journal_lines — the flat line list
 * ChowPOS calls "GL Transaction", the voucher list, and one voucher as a
 * document — plus reverseJournal, the only way a posted voucher is ever
 * undone: a contra JV built from the stored lines with debit and credit
 * swapped. Nothing here UPDATEs or DELETEs a posted row.
 *
 * Plain-Node importable, relative imports only, like post.mjs: the test
 * suite drives it directly, and helpers.mjs is `server-only` and alias-
 * imported and so cannot load outside Next. That is why the same four small
 * helpers post.mjs restates are restated once more here; the server actions
 * in ../journals/actions.js use helpers.mjs for everything a browser sends.
 */
import { query, withTransaction } from '../../../lib/db/pool.mjs';
import { VOUCHER_TYPES } from '../../../lib/accounts/constants.mjs';
import { money, ymd, todayKarachi, currentBusinessDate, nextVoucherNo, audit } from '../../../lib/accounts/kit.mjs';

export const PAGE_SIZE = 100;
/* The most one export may pull in a single call. */
export const EXPORT_LIMIT = 5000;
/* gl_journals.source_type of a contra journal; source_id = the reversed id. */
export const REVERSAL_SOURCE_TYPE = 'reversal';
/* source types a person wrote by hand, as opposed to the engine. */
const MANUAL_SOURCE_TYPES = new Set(['manual', REVERSAL_SOURCE_TYPE]);

/*
 * Engine journals that carry their OWN contra — written by the engine when
 * the document is undone (a void, a voucher reversal), keyed on the same
 * source_id. The voucher document reports them as its reversal, and it is
 * why reverseJournal below refuses an engine journal outright: a second,
 * hand-made contra on top of the engine's would un-book the sale twice.
 */
const ENGINE_REVERSAL_OF = {
    order_sale: 'order_sale_reversal',
    expense_voucher: 'expense_voucher_reversal',
    expense_payment: 'expense_payment_reversal',
};
const ENGINE_REVERSES = Object.fromEntries(Object.entries(ENGINE_REVERSAL_OF).map(([k, v]) => [v, k]));

/* Where a machine posting IS corrected, in the words the refusal shows. */
const correctionFor = (j) => {
    const t = String(j.source_type);
    if (t.startsWith('order_')) return `Void the bill (${j.reference}) instead. The ledger writes the contra itself`;
    if (t.startsWith('expense_')) return `reverse expense voucher ${j.reference} under Accounts › Expense Vouchers instead`;
    return 'correct it with a contra voucher from Add Transaction';
};

const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

/* ---- Filters ---- */

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/*
 * The filter every view shares. Dates default to the current open business
 * day when the caller sends none, and the resolved range comes back so the
 * screen can show what it is looking at.
 */
const resolveFilters = async (f = {}) => {
    let from = isYmd(f.from) ? f.from : null;
    let to = isYmd(f.to) ? f.to : null;
    if (!from && !to) {
        const rows = await query(
            `SELECT business_date FROM business_days
             WHERE branch_id = 1 AND closed_at IS NULL
             ORDER BY business_date DESC LIMIT 1`,
        );
        from = to = rows.length ? ymd(rows[0].business_date) : todayKarachi();
    }
    from ??= to;
    to ??= from;
    if (from > to) [from, to] = [to, from];

    const voucherType = VOUCHER_TYPES[f.voucherType] ? f.voucherType : null;
    const accountId = Number.isInteger(Number(f.accountId)) && Number(f.accountId) > 0
        ? Number(f.accountId) : null;
    return { from, to, voucherType, accountId };
};

const pageArgs = (p = {}) => {
    const limit = Math.min(EXPORT_LIMIT, Math.max(1, Math.trunc(Number(p.limit) || PAGE_SIZE)));
    const offset = Math.max(0, Math.trunc(Number(p.offset) || 0));
    return { limit, offset };
};

/* ---- Row shapes ---- */

const journalRow = (r) => ({
    id: Number(r.id),
    branch_id: Number(r.branch_id),
    business_date: ymd(r.business_date),
    voucher_type: r.voucher_type,
    voucher_type_label: VOUCHER_TYPES[r.voucher_type] || r.voucher_type,
    voucher_no: r.voucher_no,
    source_type: r.source_type,
    source_id: r.source_id,
    description: r.description,
    reference: r.reference ?? null,
    status: r.status,
    debit_total: money(r.debit_total),
    credit_total: money(r.credit_total),
    created_by: r.created_by ?? null,
    created_by_name: r.created_by ? (r.created_by_name || r.created_by_username || null) : null,
    created_at: iso(r.created_at),
    is_manual: MANUAL_SOURCE_TYPES.has(r.source_type),
});

const lineRow = (r) => ({
    id: Number(r.id),
    account_id: Number(r.account_id),
    account_number: r.account_number,
    account_name: r.account_name,
    debit: money(r.debit),
    credit: money(r.credit),
    memo: r.memo ?? null,
});

/* ---- GL Transaction: the flat line list ---- */

const LEDGER_FROM = `
      FROM gl_journal_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id`;

const ledgerWhere = (f) => {
    const clauses = ["j.status = 'posted'", 'j.business_date BETWEEN ? AND ?'];
    const params = [f.from, f.to];
    if (f.accountId) { clauses.push('l.account_id = ?'); params.push(f.accountId); }
    if (f.voucherType) { clauses.push('j.voucher_type = ?'); params.push(f.voucherType); }
    return { where: ` WHERE ${clauses.join(' AND ')}`, params };
};

/*
 * Posted lines in a date range, oldest first, in the order they were booked
 * within a day. The totals cover the WHOLE filtered set, not just this page,
 * so the footer is the ledger's answer and not the screen's.
 */
export const ledgerLines = async (filters, page) => {
    const f = await resolveFilters(filters);
    const { limit, offset } = pageArgs(page);
    const { where, params } = ledgerWhere(f);

    const [rows, totals] = await Promise.all([
        query(
            `SELECT l.id, l.journal_id, l.account_id, l.debit, l.credit, l.memo,
                    j.business_date, j.voucher_no, j.voucher_type, j.description, j.reference,
                    a.account_number, a.name AS account_name
             ${LEDGER_FROM}${where}
             ORDER BY j.business_date, j.id, l.id
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
        ),
        query(
            `SELECT COUNT(*) AS n, COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
             ${LEDGER_FROM}${where}`,
            params,
        ),
    ]);
    const count = Number(totals[0].n);
    return {
        range: { from: f.from, to: f.to },
        rows: rows.map((r) => ({
            ...lineRow(r),
            journal_id: Number(r.journal_id),
            business_date: ymd(r.business_date),
            voucher_no: r.voucher_no,
            voucher_type: r.voucher_type,
            description: r.description,
            reference: r.reference ?? null,
        })),
        totals: { count, debit: money(totals[0].debit), credit: money(totals[0].credit) },
        hasMore: offset + rows.length < count,
    };
};

/* ---- Voucher list ---- */

const journalWhere = (f) => {
    const clauses = ['j.business_date BETWEEN ? AND ?'];
    const params = [f.from, f.to];
    if (f.voucherType) { clauses.push('j.voucher_type = ?'); params.push(f.voucherType); }
    return { where: ` WHERE ${clauses.join(' AND ')}`, params };
};

export const journalList = async (filters, page) => {
    const f = await resolveFilters(filters);
    const { limit, offset } = pageArgs(page);
    const { where, params } = journalWhere(f);

    const [rows, totals] = await Promise.all([
        query(
            `SELECT j.*, u.full_name AS created_by_name, u.username AS created_by_username
               FROM gl_journals j
               LEFT JOIN users u ON u.id = j.created_by
             ${where}
             ORDER BY j.business_date, j.id
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
        ),
        query(
            `SELECT COUNT(*) AS n,
                    COALESCE(SUM(CASE WHEN j.status = 'posted' THEN j.debit_total END), 0) AS debit,
                    COALESCE(SUM(CASE WHEN j.status = 'posted' THEN j.credit_total END), 0) AS credit
               FROM gl_journals j${where}`,
            params,
        ),
    ]);
    const count = Number(totals[0].n);
    return {
        range: { from: f.from, to: f.to },
        rows: rows.map(journalRow),
        totals: { count, debit: money(totals[0].debit), credit: money(totals[0].credit) },
        hasMore: offset + rows.length < count,
    };
};

/* ---- One voucher as a document ---- */

const journalSummary = (r) => (r ? { id: Number(r.id), voucher_no: r.voucher_no, business_date: ymd(r.business_date) } : null);

export const journalById = async (id) => {
    const [header] = await query(
        `SELECT j.*, u.full_name AS created_by_name, u.username AS created_by_username
           FROM gl_journals j
           LEFT JOIN users u ON u.id = j.created_by
          WHERE j.id = ?`,
        [id],
    );
    if (!header) return null;

    const pairedType = ENGINE_REVERSAL_OF[header.source_type] ?? null;
    const reversedType = ENGINE_REVERSES[header.source_type] ?? null;
    const [lines, reversal, reverses] = await Promise.all([
        query(
            `SELECT l.id, l.account_id, l.debit, l.credit, l.memo, a.account_number, a.name AS account_name
               FROM gl_journal_lines l
               JOIN accounts a ON a.id = l.account_id
              WHERE l.journal_id = ?
              ORDER BY l.id`,
            [id],
        ),
        // The contra journal that undid this one, if any: a hand-made one
        // keyed on this journal's id, or the engine's own, keyed on the
        // document both were posted from.
        query(
            `SELECT id, voucher_no, business_date FROM gl_journals
              WHERE (source_type = ? AND source_id = ?) OR (source_type = ? AND source_id = ?)
              ORDER BY id LIMIT 1`,
            [REVERSAL_SOURCE_TYPE, String(id), pairedType ?? '', pairedType ? String(header.source_id) : ''],
        ),
        // And, if this IS a contra journal, the one it undid.
        header.source_type === REVERSAL_SOURCE_TYPE
            ? query('SELECT id, voucher_no, business_date FROM gl_journals WHERE id = ?', [Number(header.source_id)])
            : reversedType
                ? query(
                    'SELECT id, voucher_no, business_date FROM gl_journals WHERE source_type = ? AND source_id = ?',
                    [reversedType, String(header.source_id)],
                )
                : Promise.resolve([]),
    ]);

    return {
        ...journalRow(header),
        lines: lines.map(lineRow),
        reversal: journalSummary(reversal[0]),
        reverses: journalSummary(reverses[0]),
    };
};

/* ---- Accounts for the ledger's filter ---- */

/* Active accounts, plus any inactive one the ledger has posted to — a filter
 * that cannot reach a posted account would hide part of the books. */
export const accountOptions = () =>
    query(
        `SELECT a.id, a.account_number, a.name, a.account_group, a.is_active
           FROM accounts a
          WHERE a.is_active = 1
             OR EXISTS (SELECT 1 FROM gl_journal_lines l WHERE l.account_id = a.id)
          ORDER BY a.account_number`,
    ).then((rows) => rows.map((r) => ({
        id: Number(r.id),
        account_number: r.account_number,
        name: r.name,
        account_group: r.account_group,
        is_active: Boolean(r.is_active),
    })));

/* ---- The reversal ---- */

/*
 * Undo a posted voucher with a contra JV: the stored lines, sides swapped,
 * memos kept, dated the current open business day so a closed day never
 * gains a correction. The original is not touched — it stays 'posted', and
 * the pair nets to zero on every account they share.
 *
 * Only a voucher a person wrote — a manual JV, or a reversal — is reversed
 * here. An engine journal belongs to its document: voiding the bill or
 * reversing the expense voucher makes the engine write the contra itself,
 * and a hand-made one on top would un-book the same money twice. The
 * machine postings with no such document (a receipt, a supplier payment, a
 * receiving, a drawer variance) are corrected with a contra voucher from
 * Add Transaction, where the accountant states every line.
 *
 * At most one reversal per voucher, structurally: gl_journals is UNIQUE on
 * (source_type, source_id) and the header goes in ON DUPLICATE KEY UPDATE
 * id = id under a savepoint, so a lost race rolls back its own work (voucher
 * number included) and reports the twin that won. FOR UPDATE on the original
 * serializes same-moment callers before they get that far.
 */
export const reverseJournal = (journalId, { userId = null } = {}) =>
    withTransaction(async (conn) => {
        const [found] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
        const original = found[0];
        if (!original) throw new Error('That voucher no longer exists');
        if (original.status !== 'posted') throw new Error('Only a posted voucher can be reversed');
        if (!MANUAL_SOURCE_TYPES.has(original.source_type)) {
            throw new Error(
                `${original.voucher_no} was posted automatically (${original.source_type}). ${correctionFor(original)}`,
            );
        }

        const [existing] = await conn.query(
            'SELECT id, voucher_no FROM gl_journals WHERE source_type = ? AND source_id = ?',
            [REVERSAL_SOURCE_TYPE, String(original.id)],
        );
        if (existing[0]) throw new Error(`${original.voucher_no} was already reversed by ${existing[0].voucher_no}`);

        const [stored] = await conn.query(
            'SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_id = ? ORDER BY id',
            [original.id],
        );
        if (stored.length === 0) throw new Error(`${original.voucher_no} has no lines to reverse`);

        const lines = stored.map((l) => ({
            account_id: l.account_id, debit: money(l.credit), credit: money(l.debit), memo: l.memo,
        }));
        const debitTotal = money(lines.reduce((s, l) => s + l.debit, 0));
        const creditTotal = money(lines.reduce((s, l) => s + l.credit, 0));
        if (debitTotal !== creditTotal) {
            throw new Error(`${original.voucher_no} does not balance on its lines: Dr ${debitTotal} vs Cr ${creditTotal}`);
        }

        const branchId = original.branch_id;
        const bd = await currentBusinessDate(conn, branchId);

        await conn.query('SAVEPOINT reversal');
        const voucherNo = await nextVoucherNo(conn, 'JV', bd, branchId);
        const [result] = await conn.query(
            `INSERT INTO gl_journals
               (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
                description, reference, status, debit_total, credit_total, created_by)
             VALUES (?, ?, 'JV', ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
             ON DUPLICATE KEY UPDATE id = id`,
            [
                branchId, bd, voucherNo, REVERSAL_SOURCE_TYPE, String(original.id),
                `Reversal of ${original.voucher_no}`, original.reference ?? null,
                debitTotal, creditTotal, userId,
            ],
        );
        if (!result.insertId) {
            await conn.query('ROLLBACK TO SAVEPOINT reversal');
            const [twin] = await conn.query(
                'SELECT voucher_no FROM gl_journals WHERE source_type = ? AND source_id = ?',
                [REVERSAL_SOURCE_TYPE, String(original.id)],
            );
            throw new Error(`${original.voucher_no} was already reversed by ${twin[0]?.voucher_no ?? 'another voucher'}`);
        }

        await conn.query(
            'INSERT INTO gl_journal_lines (journal_id, account_id, debit, credit, memo) VALUES ?',
            [lines.map((l) => [result.insertId, l.account_id, l.debit, l.credit, l.memo])],
        );

        await audit(conn, {
            branchId,
            bd,
            action: 'gl_reverse_journal',
            userId,
            details: {
                journal_id: Number(original.id),
                voucher_no: original.voucher_no,
                voucher_type: original.voucher_type,
                reversal_id: result.insertId,
                reversal_voucher_no: voucherNo,
                business_date: bd,
                amount: debitTotal,
                lines: lines.length,
            },
        });

        return {
            id: result.insertId,
            voucher_no: voucherNo,
            voucher_type: 'JV',
            business_date: bd,
            amount: debitTotal,
            reverses: { id: Number(original.id), voucher_no: original.voucher_no },
        };
    });

/*
 * The manual journal voucher's core: validate a balanced set of lines and
 * write them as ONE posted JV, atomically, under the same idempotency and
 * savepoint contract the posting engine uses. The server action in
 * actions.js is a thin wrapper — permission, business day, user — around
 * postManualJournal below. The rules themselves live in jvRules.mjs, which
 * the browser shares; this file is the half that touches the database.
 *
 * Plain-Node importable, relative imports only, so the test suite can drive
 * it directly the way it drives post.mjs. That is why the two small helpers
 * (voucher numbers, the date) are restated here rather than imported from
 * helpers.mjs, which is `server-only` and alias-imported and cannot load
 * outside Next — the same reasoning post.mjs spells out.
 *
 * A manual JV posts immediately: there are no draft journals in v1. Nothing
 * here can be edited afterwards; a mistake is corrected by a contra JV.
 */
import { withTransaction } from '../../../../lib/db/pool.mjs';
import { VOUCHER_TYPES } from '../../../../lib/accounts/constants.mjs';
import { BRANCH_ID, ymd, nextVoucherNo } from '../../../../lib/accounts/kit.mjs';
import { cleanLines, clip, MANUAL_SOURCE_TYPE, MANUAL_VOUCHER_TYPE } from './jvRules.mjs';

export { cleanLines, money, MANUAL_SOURCE_TYPE, MANUAL_VOUCHER_TYPE, OPENING_REFERENCE, OPENING_DESCRIPTION } from './jvRules.mjs';

/*
 * Post one manual JV. Returns the header it wrote. Throws on any refusal;
 * the caller turns that into the {error} envelope. Every write — header,
 * lines, audit — lands in one transaction, or none of them does.
 *
 *   businessDate  'YYYY-MM-DD', already validated by the caller
 *   description   required
 *   reference     optional (≤ 64)
 *   notes         optional; the schema has no notes column, so they are
 *                 kept in the audit row rather than dropped
 *   lines         [{ account_id, debit, credit, memo }]
 *   userId        the person posting — written to created_by and the audit
 */
export const postManualJournal = async ({ businessDate, description, reference, notes, lines, userId }) => {
    const bd = ymd(businessDate);
    const desc = clip(description, 191);
    if (!desc) throw new Error('A description is needed');
    const ref = clip(reference, 64) || null;
    const note = clip(notes, 1000) || null;
    if (!userId) throw new Error('A manual journal must be posted by a signed-in user');

    const clean = cleanLines(lines);

    return withTransaction(async (conn) => {
        // Every account must exist and be active; a deactivated account is
        // off every picker, and a stale form must not sneak one through.
        const ids = [...new Set(clean.lines.map((l) => l.account_id))];
        const [accounts] = await conn.query(
            'SELECT id, account_number, name, is_active FROM accounts WHERE id IN (?)',
            [ids],
        );
        const byId = new Map(accounts.map((a) => [Number(a.id), a]));
        for (const id of ids) {
            const a = byId.get(id);
            if (!a) throw new Error('One of the accounts no longer exists. Reload and try again');
            if (!a.is_active) throw new Error(`${a.account_number} ${a.name} is inactive and cannot be posted to`);
        }

        await conn.query('SAVEPOINT manual_jv');
        const voucherNo = await nextVoucherNo(conn, MANUAL_VOUCHER_TYPE, bd);
        const [result] = await conn.query(
            `INSERT INTO gl_journals
               (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
                description, reference, status, debit_total, credit_total, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
             ON DUPLICATE KEY UPDATE id = id`,
            [
                BRANCH_ID, bd, MANUAL_VOUCHER_TYPE, voucherNo, MANUAL_SOURCE_TYPE, voucherNo,
                desc, ref, clean.debitTotal, clean.creditTotal, userId,
            ],
        );
        if (!result.insertId) {
            // Cannot happen while the counter row is locked, but the contract
            // is the contract: hand the number back and refuse loudly.
            await conn.query('ROLLBACK TO SAVEPOINT manual_jv');
            throw new Error(`Voucher ${voucherNo} was already posted. Try again`);
        }

        await conn.query(
            'INSERT INTO gl_journal_lines (journal_id, account_id, debit, credit, memo) VALUES ?',
            [clean.lines.map((l) => [result.insertId, l.account_id, l.debit, l.credit, l.memo])],
        );

        await conn.query(
            `INSERT INTO audit_log (branch_id, business_date, action, staff_id, details)
             VALUES (?, ?, 'gl_post_manual', ?, ?)`,
            [BRANCH_ID, bd, userId, JSON.stringify({
                journal_id: result.insertId,
                voucher_type: MANUAL_VOUCHER_TYPE,
                voucher_no: voucherNo,
                business_date: bd,
                description: desc,
                reference: ref,
                notes: note,
                amount: clean.debitTotal,
                lines: clean.lines.map((l) => ({
                    account_id: l.account_id,
                    account_number: byId.get(l.account_id).account_number,
                    debit: l.debit,
                    credit: l.credit,
                    memo: l.memo,
                })),
            })],
        );

        return {
            id: result.insertId,
            voucher_type: MANUAL_VOUCHER_TYPE,
            voucher_no: voucherNo,
            business_date: bd,
            description: desc,
            reference: ref,
            amount: clean.debitTotal,
            label: `${VOUCHER_TYPES.JV} ${voucherNo}`,
        };
    });
};

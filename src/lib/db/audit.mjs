/*
 * One audit row, for the branch that wrote it.
 *
 * Ten files kept their own three-line copy of this INSERT. Every copy wrote
 * `branch_id` as the literal 1, which was true right up until a branch became
 * a variable — and then it is the worst kind of wrong: the row still lands,
 * still reads plausibly, and files the second outlet's paper trail under the
 * first one's name. An audit log that quietly attributes actions to the wrong
 * place is worse than no audit log, because it is believed.
 *
 * So it lives here once, and it resolves the branch itself. Callers that
 * already know the day pass it; callers that do not get the open one. Callers
 * inside a transaction pass the connection, so the row commits or rolls back
 * with the thing it is describing — which is the whole reason most of them
 * had a local copy in the first place.
 *
 * No `next/headers` and no `@/` alias here. It is reached from the waste verb
 * and the inventory kernel, which the suite loads directly in plain Node.
 */
import { query } from './pool.mjs';
import { openBusinessDate } from '../day/openDay.mjs';

/* Same lazy resolution as openDay.mjs, and for the same reason: outside a
 * request there is no cookie to read, and the answer there is the one outlet. */
const requestBranch = async () => {
    try {
        const { currentBranchId } = await import('./branch.mjs');
        return await currentBranchId();
    } catch {
        return 1;
    }
};

/*
 * `details` is stringified here rather than by each caller: ten call sites
 * each remembering to JSON.stringify is ten chances for one of them to insert
 * "[object Object]" into the only record of what happened.
 */
export const writeAudit = async (conn, {
    action,
    details = null,
    businessDate = null,
    orderId = null,
    staffId = null,
    branchId = null,
}) => {
    const branch = branchId ?? await requestBranch();
    const day = businessDate ?? await openBusinessDate(branch, conn);
    const sql = `INSERT INTO audit_log
                     (branch_id, business_date, action, order_id, staff_id, details)
                 VALUES (?, ?, ?, ?, ?, ?)`;
    const params = [
        branch, day, action, orderId, staffId,
        details == null ? null : JSON.stringify(details),
    ];
    if (conn) await conn.query(sql, params);
    else await query(sql, params);
};

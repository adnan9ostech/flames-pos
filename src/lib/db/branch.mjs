/*
 * Which outlet this request is about.
 *
 * Fifteen tables have carried `branch_id` since the first schema, all writing
 * the constant 1. This is the one place that constant becomes an answer, so
 * there is exactly one rule to read and exactly one place to change it.
 *
 * THE RULE:
 *   a person tied to a branch works at that branch and cannot switch;
 *   a person tied to none (an owner, an accountant) works at the branch they
 *     last picked, which rides in a cookie beside the session;
 *   with neither, the lowest active branch, which on a single-outlet
 *     restaurant is the only one and makes all of this invisible.
 *
 * The cookie is a PREFERENCE, never a permission: it is validated against the
 * branches table on every read, and a user tied to a branch ignores it
 * outright. Nothing here trusts a number typed into a browser.
 */
import { cookies } from 'next/headers';
import { query } from './pool.mjs';

export const BRANCH_COOKIE = 'fbi_branch';

/* The branches a person may act on: their own, or all of them. */
export const branchesFor = async (user) => {
    const rows = await query(
        'SELECT id, name, code FROM branches WHERE is_active = 1 ORDER BY sort_order, id',
    );
    if (user?.branchId == null) return rows;
    return rows.filter((b) => Number(b.id) === Number(user.branchId));
};

/*
 * The branch to read and write as. Takes the user so it never has to re-read
 * the session; callers inside a verb that already has one pass it through.
 */
export const currentBranchId = async (user = null) => {
    if (user?.branchId != null) return Number(user.branchId);

    let picked = null;
    try {
        picked = Number((await cookies()).get(BRANCH_COOKIE)?.value) || null;
    } catch {
        // Outside a request (a worker, a script): there is no cookie to read.
    }

    const rows = await query(
        'SELECT id FROM branches WHERE is_active = 1 ORDER BY sort_order, id',
    );
    if (rows.length === 0) return 1;
    if (picked && rows.some((b) => Number(b.id) === picked)) return picked;
    return Number(rows[0].id);
};

/*
 * For the handful of places that run outside a request and must still name a
 * branch — the FBR worker, a script. The lowest active one, which is the only
 * defensible answer when nobody is asking.
 */
export const defaultBranchId = async () => {
    const rows = await query(
        'SELECT id FROM branches WHERE is_active = 1 ORDER BY sort_order, id LIMIT 1',
    );
    return rows.length ? Number(rows[0].id) : 1;
};

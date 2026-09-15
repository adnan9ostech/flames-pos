/*
 * The authorization seam every server action and API route goes through.
 * This replaces 21 RLS policies, so the rule is blunt: no data function
 * runs without one of these having said yes first.
 *
 * requireUser also re-checks token_version against the users table — the one
 * DB read in the auth path. Changing a password, a role or a permission
 * bumps the version, so every other device's cookie dies at its next action
 * instead of living out its 30 days on rights it no longer has.
 */
import { cookies } from 'next/headers';
import { COOKIE_NAME, verifySession } from '../auth/session.mjs';
import { effectivePermissions } from '../auth/permissions.mjs';
import { query } from './pool.mjs';

export class AuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthError';
        this.status = 401;
    }
}

/* Cookie-only read (no DB): for the layout and cheap display decisions. */
export const readSession = async () => {
    const store = await cookies();
    return verifySession(store.get(COOKIE_NAME)?.value);
};

export const requireUser = async () => {
    const session = await readSession();
    if (!session) throw new AuthError('Sign in to continue');
    const rows = await query(
        'SELECT id, role, token_version, permissions, is_active, full_name, username, branch_id FROM users WHERE id = ?',
        [session.sub],
    );
    const row = rows[0];
    if (!row || row.token_version !== session.pv) {
        throw new AuthError('Session expired: sign in again');
    }
    if (!row.is_active) throw new AuthError('This account has been suspended');
    return {
        id: row.id,
        role: row.role,
        name: row.full_name || row.username,
        // NULL means every branch: an owner and an accountant see the company,
        // a cashier sees the outlet they stand in.
        branchId: row.branch_id ?? null,
        // Read fresh rather than trusted from the cookie: the cookie is for
        // the route gate, but an action about to move money should answer to
        // the rights the account has right now.
        permissions: effectivePermissions(row.role, row.permissions),
    };
};

/* Throws unless the signed-in account holds this right. */
export const requirePermission = async (key) => {
    const user = await requireUser();
    if (!user.permissions[key]) {
        throw new AuthError('Your account does not have access to this');
    }
    return user;
};

/*
 * Throws unless the account holds AT LEAST ONE of these rights.
 *
 * For the handful of verbs two different screens legitimately reach. Moving a
 * ticket along is the example: the kitchen does it from the Kitchen Display
 * (`kds`) and the counter does it from Order History (`orders`), and neither
 * screen's right implies the other's — a kitchen account has only the first,
 * an accountant only the second, and both are meant to work.
 */
export const requireAnyPermission = async (...keys) => {
    const user = await requireUser();
    if (!keys.some((k) => user.permissions[k])) {
        throw new AuthError('Your account does not have access to this');
    }
    return user;
};


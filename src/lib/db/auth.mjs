/*
 * The authorization seam every server action and API route goes through.
 * This replaces 21 RLS policies, so the rule is blunt: no data function
 * runs without one of these having said yes first.
 *
 * requireUser also re-checks pin_version against the users table — the one
 * DB read in the auth path (a two-row table). A PIN change bumps the
 * version, so every other device's cookie dies at its next action instead
 * of living out its 30 days.
 */
import { cookies } from 'next/headers';
import { COOKIE_NAME, verifySession } from '../auth/session.mjs';
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
    const rows = await query('SELECT id, role, pin_version FROM users WHERE id = ?', [session.sub]);
    if (rows.length === 0 || rows[0].pin_version !== session.pv) {
        throw new AuthError('Session expired — sign in again');
    }
    return { id: rows[0].id, role: rows[0].role };
};

export const requireAdmin = async () => {
    const user = await requireUser();
    if (user.role !== 'admin') throw new AuthError('Only an admin can do this');
    return user;
};

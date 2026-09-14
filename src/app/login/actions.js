'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'
import { query } from '@/lib/db/pool.mjs'
import { signSession, COOKIE_NAME, cookieOptions } from '@/lib/auth/session.mjs'
import { effectivePermissions, grantedKeys, landingPath } from '@/lib/auth/permissions.mjs'

/*
 * Sign in with an email OR a username — people remember one or the other,
 * and the account carries both.
 *
 * Failures say "Incorrect email or password" whichever half was wrong: told
 * which one matched, an attacker learns which accounts exist.
 */

// Per-identifier throttle, in memory. A restaurant runs one server process,
// so this is enough to make guessing slow without a table to maintain; a
// restart forgives, which is the acceptable side of that trade.
const attempts = new Map()
const MAX_FREE = 5
const MAX_DELAY_MS = 30_000

const backoff = async (key) => {
    const n = attempts.get(key) || 0
    if (n < MAX_FREE) return
    const delay = Math.min(2 ** (n - MAX_FREE) * 1000, MAX_DELAY_MS)
    await new Promise((r) => setTimeout(r, delay))
}

export async function login(formData) {
    const identifier = String(formData.get('identifier') || '').trim()
    const password = String(formData.get('password') || '')

    if (!identifier || !password) {
        return { error: 'Enter your email or username and your password' }
    }

    const ip = (await headers()).get('x-forwarded-for') || 'local'
    const throttleKey = `${identifier.toLowerCase()}|${ip}`
    await backoff(throttleKey)

    const rows = await query(
        `SELECT id, role, password_hash, token_version, permissions, is_active,
                must_change_password, full_name, username
         FROM users
         WHERE (email = ? OR username = ?) LIMIT 1`,
        [identifier, identifier],
    )
    const user = rows[0]

    // Compared even when there is no such account, so a missing user and a
    // wrong password take the same time to answer.
    const ok = await bcrypt.compare(password, user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid')

    if (!user || !ok) {
        attempts.set(throttleKey, (attempts.get(throttleKey) || 0) + 1)
        return { error: 'Incorrect email or password' }
    }
    if (!user.is_active) {
        return { error: 'This account has been suspended. Ask an admin.' }
    }

    attempts.delete(throttleKey)

    const perms = effectivePermissions(user.role, user.permissions)
    const store = await cookies()
    store.set(
        COOKIE_NAME,
        await signSession({
            sub: user.id,
            role: user.role,
            pv: user.token_version,
            perms: grantedKeys(perms),
        }),
        cookieOptions(),
    )

    await query('UPDATE users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [user.id])

    // A handed-over password is a shared secret until its owner changes it.
    if (user.must_change_password) redirect('/profile?first=1')

    // Everyone lands on the first screen their role can actually open — a
    // kitchen account has no business bouncing off /pos on the way in.
    redirect(landingPath(grantedKeys(perms)))
}

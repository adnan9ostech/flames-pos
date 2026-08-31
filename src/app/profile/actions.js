
'use server'

import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { query } from '@/lib/db/pool.mjs'
import { readSession, requireUser, requireAdmin } from '@/lib/db/auth.mjs'
import { COOKIE_NAME, signSession, cookieOptions } from '@/lib/auth/session.mjs'

/*
 * Bumping pin_version strands every other device's cookie at its next action
 * (requireUser re-checks it) — that is the point of a PIN change. The device
 * that made the change gets its own cookie re-signed with the new version so
 * it alone stays signed in.
 */
const setPinForRole = async (role, pin) => {
    const hash = await bcrypt.hash(pin, 12)
    await query(
        'UPDATE users SET pin_hash = ?, pin_version = pin_version + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE role = ?',
        [hash, role]
    )
    const rows = await query('SELECT id, role, pin_version FROM users WHERE role = ?', [role])
    return rows[0]
}

const resignOwnCookie = async (row) => {
    const store = await cookies()
    store.set(
        COOKIE_NAME,
        await signSession({ sub: row.id, role: row.role, pv: row.pin_version }),
        cookieOptions()
    )
}

export async function updatePassword(formData) {
    try {
        const user = await requireUser()

        const password = formData.get('password')
        const confirmPassword = formData.get('confirmPassword')

        if (password !== confirmPassword) {
            return { error: 'Passwords do not match' }
        }

        /*
         * Exactly six digits — the same shape the login screen enforces. This
         * form used to accept anything of six-plus characters, so a
         * seven-digit PIN or one with a letter saved fine and then nobody
         * could sign in with the account again: the login field refuses what
         * this form had stored.
         */
        if (!/^\d{6}$/.test(password)) {
            return { error: 'PIN must be exactly 6 digits' }
        }

        const row = await setPinForRole(user.role, password)
        await resignOwnCookie(row)

        return { success: 'Password updated successfully' }
    } catch (e) {
        return { error: e.message }
    }
}

/* Cookie-only — the profile card needs the role label, nothing more. */
export async function getUser() {
    const session = await readSession()
    return session ? { role: session.role } : null
}

/*
 * Admin resets either role's PIN from Settings — this replaces the emailed
 * recovery flow (a staff PIN forgotten mid-shift is fixed at the counter,
 * not in an inbox). If the admin resets their own role, their cookie is
 * re-signed so this device survives its own reset.
 */
export async function adminSetPin(role, pin) {
    try {
        const admin = await requireAdmin()

        if (role !== 'admin' && role !== 'staff') {
            return { error: 'Unknown role' }
        }
        if (!/^\d{6}$/.test(pin || '')) {
            return { error: 'PIN must be exactly 6 digits' }
        }

        const row = await setPinForRole(role, pin)
        if (row.id === admin.id) {
            await resignOwnCookie(row)
        }

        return { data: true }
    } catch (e) {
        return { error: e.message }
    }
}

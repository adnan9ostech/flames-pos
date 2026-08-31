'use server'

import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { query } from '@/lib/db/pool.mjs'
import { requireUser, readSession } from '@/lib/db/auth.mjs'
import { signSession, COOKIE_NAME, cookieOptions } from '@/lib/auth/session.mjs'
import { effectivePermissions, grantedKeys, PERMISSIONS, ROLES } from '@/lib/auth/permissions.mjs'

const MIN_PASSWORD = 8

/* The signed-in account, for the profile screen. */
export async function getUser() {
    try {
        const user = await requireUser()
        const rows = await query(
            `SELECT email, username, full_name, role, must_change_password, last_login_at
             FROM users WHERE id = ?`,
            [user.id],
        )
        const row = rows[0]
        return {
            data: {
                email: row.email,
                username: row.username,
                full_name: row.full_name,
                role: row.role,
                role_label: ROLES[row.role] || row.role,
                must_change_password: Boolean(row.must_change_password),
                last_login_at: row.last_login_at ? row.last_login_at.toISOString() : null,
                // Shown so a person can see what they hold without asking.
                permissions: Object.entries(PERMISSIONS)
                    .filter(([key]) => user.permissions[key])
                    .map(([key, label]) => ({ key, label })),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/* Name and email are the holder's own to correct; the role is not. */
export async function updateProfile(formData) {
    try {
        const user = await requireUser()
        const full_name = String(formData.get('full_name') || '').trim()
        const email = String(formData.get('email') || '').trim() || null

        if (!full_name) return { error: 'Your name cannot be empty' }
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return { error: 'That email does not look right' }
        }

        await query('UPDATE users SET full_name = ?, email = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
            [full_name, email, user.id])
        return { data: true }
    } catch (e) {
        if (e.errno === 1062) return { error: 'Another account already uses that email' }
        return { error: e.message }
    }
}

/*
 * Change your own password. The current one is required even though the
 * session already proves who you are — an unattended till is exactly where
 * a passerby would otherwise lock the owner out of their own account.
 *
 * Bumping token_version strands every OTHER device signed in as this person,
 * which is the point after a password change; this device is re-signed on
 * the way out so the person who just changed it is not thrown to /login.
 */
export async function changePassword(formData) {
    try {
        const user = await requireUser()
        const current = String(formData.get('current_password') || '')
        const next = String(formData.get('new_password') || '')
        const confirm = String(formData.get('confirm_password') || '')

        if (next.length < MIN_PASSWORD) {
            return { error: `Use at least ${MIN_PASSWORD} characters` }
        }
        if (next !== confirm) return { error: 'The new passwords do not match' }

        const rows = await query('SELECT password_hash FROM users WHERE id = ?', [user.id])
        if (!(await bcrypt.compare(current, rows[0].password_hash))) {
            return { error: 'Your current password is not right' }
        }
        if (await bcrypt.compare(next, rows[0].password_hash)) {
            return { error: 'That is already your password' }
        }

        const hash = await bcrypt.hash(next, 12)
        await query(
            `UPDATE users SET password_hash = ?, token_version = token_version + 1,
                    must_change_password = 0, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            [hash, user.id],
        )

        const fresh = await query('SELECT role, token_version, permissions FROM users WHERE id = ?', [user.id])
        const perms = effectivePermissions(fresh[0].role, fresh[0].permissions)
        const store = await cookies()
        store.set(
            COOKIE_NAME,
            await signSession({
                sub: user.id, role: fresh[0].role, pv: fresh[0].token_version, perms: grantedKeys(perms),
            }),
            cookieOptions(),
        )

        return { data: 'Password changed' }
    } catch (e) {
        return { error: e.message }
    }
}

/* Whether to nudge on arrival — the login redirects here after a handover. */
export async function mustChangePassword() {
    const session = await readSession()
    if (!session) return false
    const rows = await query('SELECT must_change_password FROM users WHERE id = ?', [session.sub])
    return Boolean(rows[0]?.must_change_password)
}

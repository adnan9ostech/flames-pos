'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import bcrypt from 'bcryptjs'
import { query } from '@/lib/db/pool.mjs'
import { requireAdmin } from '@/lib/db/auth.mjs'
import {
    ROLES, PERMISSION_KEYS, ROLE_DEFAULTS, effectivePermissions,
} from '@/lib/auth/permissions.mjs'

/*
 * The accounts screen: who can sign in, as what, and with which rights.
 *
 * Two things make this file different from the other admin CRUD screens.
 * First, it hands out credentials, so nothing here ever reads, returns or
 * logs a password or its hash — the only direction a password travels is in.
 * Second, it can lock the restaurant out of its own back office, so the
 * paths that could remove the last account holding `users` refuse instead.
 */

const MIN_PASSWORD = 8
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// 'staff' is the pre-migration shared login. An existing row still resolves
// through it; nobody gets assigned to it again.
const ASSIGNABLE_ROLES = Object.keys(ROLES).filter((r) => r !== 'staff')

const audit = (actorId, action, details) =>
    query(
        `INSERT INTO audit_log (branch_id, business_date, staff_id, action, details)
         VALUES (1, CURRENT_DATE, ?, ?, ?)`,
        [actorId, action, JSON.stringify(details)],
    )

/*
 * Shared by create and update: an account needs a name, a real role, and at
 * least one thing to type into the login box. Both credentials are allowed —
 * people remember one or the other and the login accepts either.
 */
const readIdentity = ({ email, username, full_name, role }) => {
    const name = String(full_name || '').trim()
    // Empty string is not a free-for-all under a UNIQUE index — two blank
    // usernames would collide where two NULLs do not.
    const mail = String(email || '').trim().toLowerCase() || null
    const user = String(username || '').trim() || null

    if (!name) return { error: 'The person needs a name' }
    if (!mail && !user) return { error: 'Give the account an email, a username, or both' }
    if (mail && !EMAIL_RE.test(mail)) return { error: 'That email does not look right' }
    if (user && !USERNAME_RE.test(user)) {
        return { error: 'A username is 3–32 characters: letters, numbers, dot, dash or underscore' }
    }
    if (!ASSIGNABLE_ROLES.includes(role)) return { error: 'Pick a role' }

    return { values: { email: mail, username: user, full_name: name, role } }
}

/*
 * Names the colliding half rather than letting the driver's constraint name
 * reach the screen. Checked up front for the plain message, and caught again
 * on 1062 for the race between the check and the write.
 */
const findClash = async (email, username, exceptId = null) => {
    const rows = await query(
        `SELECT id, email, username FROM users
         WHERE ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND username = ?))
           AND (? IS NULL OR id <> ?)`,
        [email, email, username, username, exceptId, exceptId],
    )
    for (const row of rows) {
        if (email && (row.email || '').toLowerCase() === email) {
            return `Another account already uses ${email}`
        }
        if (username && (row.username || '').toLowerCase() === username.toLowerCase()) {
            return `The username “${username}” is taken`
        }
    }
    return null
}

const duplicateMessage = (e, email, username) => {
    const text = String(e.message || '')
    if (text.includes('users_email_uq')) return `Another account already uses ${email}`
    if (text.includes('users_username_uq')) return `The username “${username}” is taken`
    return 'That email or username is already taken'
}

/*
 * The one lockout with no way back. `users` is the right that hands out every
 * other right; with no active account holding it, nothing inside the app can
 * grant it again and it takes a hand-written UPDATE over SSH to recover. So
 * suspending, deleting, or revoking the right from the last holder is refused.
 *
 * Returns true when the change would strand the restaurant.
 */
const wouldStrandUserAdmin = async (targetId, targetKeepsRight) => {
    if (targetKeepsRight) return false
    const rows = await query('SELECT id, role, permissions FROM users WHERE is_active = 1')
    const holders = rows.filter((r) => effectivePermissions(r.role, r.permissions).users)
    return holders.length <= 1 && holders.some((r) => r.id === targetId)
}

const STRANDED = 'That is the only account left that can manage users'
const OWN_ACCOUNT = 'You cannot do that to your own account.'

export async function listUsers() {
    try {
        const actor = await requireAdmin()
        const rows = await query(
            `SELECT id, email, username, full_name, role, is_active,
                    must_change_password, last_login_at, permissions
             FROM users
             ORDER BY is_active DESC, full_name, username`,
        )
        return {
            // password_hash is not in the SELECT at all, so it cannot leak by
            // someone later spreading the row into the response.
            data: rows.map((row) => ({
                id: row.id,
                email: row.email,
                username: row.username,
                full_name: row.full_name,
                role: row.role,
                role_label: ROLES[row.role] || row.role,
                // So the screen can withhold the three buttons that refuse on
                // your own account, rather than offering them and then failing.
                is_you: row.id === actor.id,
                is_active: Boolean(row.is_active),
                must_change_password: Boolean(row.must_change_password),
                last_login_at: row.last_login_at ? row.last_login_at.toISOString() : null,
                has_overrides: Boolean(row.permissions && Object.keys(row.permissions).length),
                permissions: effectivePermissions(row.role, row.permissions),
            })),
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * The admin picks the first password and reads it out; must_change_password
 * makes it a one-time handover rather than a secret two people share.
 */
export async function createUser({ email, username, full_name, role, password }) {
    try {
        const actor = await requireAdmin()
        const { error, values } = readIdentity({ email, username, full_name, role })
        if (error) return { error }
        if (String(password || '').length < MIN_PASSWORD) {
            return { error: `The password needs at least ${MIN_PASSWORD} characters` }
        }

        const clash = await findClash(values.email, values.username)
        if (clash) return { error: clash }

        const id = randomUUID()
        const hash = await bcrypt.hash(String(password), 12)
        await query(
            `INSERT INTO users (id, email, username, full_name, role, password_hash,
                                must_change_password, is_active)
             VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
            [id, values.email, values.username, values.full_name, values.role, hash],
        )
        await audit(actor.id, 'user_create', {
            id, username: values.username, email: values.email, role: values.role,
        })

        revalidatePath('/users')
        return { data: { id } }
    } catch (e) {
        if (e.errno === 1062) return { error: duplicateMessage(e, email, username) }
        return { error: e.message }
    }
}

export async function updateUser({ id, email, username, full_name, role }) {
    try {
        const actor = await requireAdmin()
        const { error, values } = readIdentity({ email, username, full_name, role })
        if (error) return { error }

        const [before] = await query(
            'SELECT id, email, username, full_name, role FROM users WHERE id = ?', [id],
        )
        if (!before) return { error: 'That account no longer exists' }

        const roleChanged = before.role !== values.role
        // An admin who demotes themselves mid-session loses the screen they
        // are standing on, and the fix is a support call.
        if (roleChanged && id === actor.id) return { error: OWN_ACCOUNT }

        const clash = await findClash(values.email, values.username, id)
        if (clash) return { error: clash }

        const changed = {}
        for (const key of ['email', 'username', 'full_name', 'role']) {
            if ((before[key] ?? null) !== values[key]) {
                changed[key] = { from: before[key] ?? null, to: values[key] }
            }
        }
        if (!Object.keys(changed).length) return { data: true }

        await query(
            `UPDATE users SET email = ?, username = ?, full_name = ?, role = ?,
                    token_version = token_version + ?, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            // A new role means a new set of rights, and the rights travel in
            // the signed cookie: bump the version so their other devices
            // re-authenticate onto what they hold now.
            [values.email, values.username, values.full_name, values.role, roleChanged ? 1 : 0, id],
        )
        await audit(actor.id, 'user_update', { id, changed })

        revalidatePath('/users')
        return { data: true }
    } catch (e) {
        if (e.errno === 1062) return { error: duplicateMessage(e, email, username) }
        return { error: e.message }
    }
}

/*
 * Per-user rights on top of the role. Stored as a delta, not a snapshot: an
 * override that merely restates what the role already grants is dropped, so
 * "Using Cashier defaults" stays true after a save that changed nothing, and
 * a later role change carries its own defaults through.
 */
export async function setPermissions({ id, overrides }) {
    try {
        const actor = await requireAdmin()
        const [row] = await query('SELECT id, role, username, email FROM users WHERE id = ?', [id])
        if (!row) return { error: 'That account no longer exists' }

        const defaults = ROLE_DEFAULTS[row.role] || {}
        let delta = null
        if (overrides && typeof overrides === 'object') {
            const entries = PERMISSION_KEYS
                .filter((key) => key in overrides)
                .map((key) => [key, Boolean(overrides[key])])
                .filter(([key, value]) => value !== Boolean(defaults[key]))
            if (entries.length) delta = Object.fromEntries(entries)
        }

        const next = effectivePermissions(row.role, delta)
        if (await wouldStrandUserAdmin(id, Boolean(next.users))) return { error: STRANDED }

        await query(
            `UPDATE users SET permissions = ?, token_version = token_version + 1,
                    updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            [delta ? JSON.stringify(delta) : null, id],
        )
        await audit(actor.id, 'user_permissions', {
            id, username: row.username, role: row.role, overrides: delta,
        })

        revalidatePath('/users')
        return { data: true }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * A forgotten password, reset by an admin. Bumping the version signs the
 * account out everywhere, which is the point: the old password is either
 * forgotten or compromised, and neither should keep a session alive.
 */
export async function resetPassword({ id, password }) {
    try {
        const actor = await requireAdmin()
        if (String(password || '').length < MIN_PASSWORD) {
            return { error: `The password needs at least ${MIN_PASSWORD} characters` }
        }
        const [row] = await query('SELECT id, username FROM users WHERE id = ?', [id])
        if (!row) return { error: 'That account no longer exists' }

        const hash = await bcrypt.hash(String(password), 12)
        await query(
            `UPDATE users SET password_hash = ?, must_change_password = 1,
                    token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            [hash, id],
        )
        await audit(actor.id, 'user_reset_password', { id, username: row.username })

        revalidatePath('/users')
        return { data: true }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Suspend or restore. Suspending is the reversible answer to someone leaving:
 * requireUser refuses an inactive account on its next action, and the version
 * bump makes that immediate rather than at the cookie's leisure.
 */
export async function toggleActive(id) {
    try {
        const actor = await requireAdmin()
        if (id === actor.id) return { error: OWN_ACCOUNT }

        const [row] = await query('SELECT id, username, email, is_active FROM users WHERE id = ?', [id])
        if (!row) return { error: 'That account no longer exists' }

        const suspending = Boolean(row.is_active)
        if (suspending && await wouldStrandUserAdmin(id, false)) return { error: STRANDED }

        await query(
            `UPDATE users SET is_active = ?, token_version = token_version + ?,
                    updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            [suspending ? 0 : 1, suspending ? 1 : 0, id],
        )
        await audit(actor.id, 'user_toggle_active', {
            id, username: row.username, active: !suspending,
        })

        revalidatePath('/users')
        return { data: { is_active: !suspending } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Hard delete. Nothing in the schema has a foreign key to `users` —
 * audit_log.staff_id and drawer_sessions both store the id as loose text —
 * so past orders, shifts and log entries keep reading exactly as they did.
 * What goes is the account and its login. The whole row (minus the hash)
 * lands in the audit log first, which is what makes this reversible by hand.
 */
export async function deleteUser(id) {
    try {
        const actor = await requireAdmin()
        if (id === actor.id) return { error: OWN_ACCOUNT }

        const [row] = await query(
            `SELECT id, email, username, full_name, role, permissions, is_active,
                    must_change_password, last_login_at, created_at
             FROM users WHERE id = ?`,
            [id],
        )
        if (!row) return { error: 'That account is already gone' }
        if (await wouldStrandUserAdmin(id, false)) return { error: STRANDED }

        await audit(actor.id, 'user_delete', {
            deleted: {
                ...row,
                last_login_at: row.last_login_at ? row.last_login_at.toISOString() : null,
                created_at: row.created_at ? row.created_at.toISOString() : null,
            },
        })
        await query('DELETE FROM users WHERE id = ?', [id])

        revalidatePath('/users')
        return { data: true }
    } catch (e) {
        return { error: e.message }
    }
}

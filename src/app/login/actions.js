
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { headers, cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { query } from '@/lib/db/pool.mjs'
import { COOKIE_NAME, signSession, cookieOptions } from '@/lib/auth/session.mjs'

// The role toggle only picks which account row to attempt — it is never
// trusted as a role claim. The session's role comes from the users row this
// login actually authenticates against, and every later check re-reads it
// from the signed cookie or the DB.
const ROLES = new Set(['admin', 'staff'])

/*
 * A 6-digit PIN is a million-key space, which online guessing chews through
 * unless failures cost time. Per role+IP, consecutive failures past 5 buy an
 * exponentially growing wait (capped — this must slow a script, not lock out
 * a fat-fingered waiter). In-memory on purpose: single-process deploy, and a
 * process restart forgiving the count is an acceptable trade.
 */
const failures = new Map()
const FREE_ATTEMPTS = 5
const MAX_DELAY_MS = 30_000

const clientKey = async (role) => {
    const h = await headers()
    const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
    return `${role}:${ip}`
}

const failureDelay = (count) =>
    count < FREE_ATTEMPTS ? 0 : Math.min(MAX_DELAY_MS, 1000 * 2 ** (count - FREE_ATTEMPTS))

export async function login(formData) {
    const role = formData.get('role')
    const pin = formData.get('pin')

    if (!ROLES.has(role)) {
        return { error: 'Unknown role' }
    }
    if (!/^\d{6}$/.test(pin || '')) {
        return { error: 'Enter a 6-digit PIN' }
    }

    const key = await clientKey(role)
    const delay = failureDelay(failures.get(key) ?? 0)
    if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
    }

    const rows = await query(
        'SELECT id, role, pin_hash, pin_version FROM users WHERE role = ?',
        [role]
    )
    // A missing row and a wrong PIN answer identically — the PIN's keyspace
    // is small enough that error detail isn't worth leaking.
    const user = rows[0]
    const ok = user ? await bcrypt.compare(pin, user.pin_hash) : false

    if (!ok) {
        failures.set(key, (failures.get(key) ?? 0) + 1)
        return { error: 'Incorrect PIN' }
    }
    failures.delete(key)

    const store = await cookies()
    store.set(
        COOKIE_NAME,
        await signSession({ sub: user.id, role: user.role, pv: user.pin_version }),
        cookieOptions()
    )

    revalidatePath('/pos', 'layout')
    redirect('/pos')
}

'use server'

import { requireUser } from '@/lib/db/auth.mjs'
import { markNotificationsSeen, dismissNotification, raiseNotification } from '@/lib/db/notifications.mjs'
import { karachiDay } from '@/lib/day/karachi.mjs'

const permsOf = (user) => Object.keys(user.permissions || {}).filter((k) => user.permissions[k])

/* Everything this person can see is now read. The badge counts the unseen. */
export async function markAllSeen() {
    try {
        const user = await requireUser()
        return { data: { marked: await markNotificationsSeen(permsOf(user)) } }
    } catch (e) {
        return { error: e.message }
    }
}

/* Dismiss one. A derived notice comes straight back on the next scan, which is
 * correct — a problem that is still true is not dismissable. */
export async function dismiss(id) {
    try {
        await requireUser()
        return { data: { dismissed: await dismissNotification(Number(id)) } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * The till's one way onto the board: something failed in front of a customer
 * and the manager should know without the cashier having to say so.
 *
 * Narrow on purpose — a fixed set of events, no free-form titles from the
 * client. The bell is a record of what the system knows, not a place any page
 * can write a sentence into.
 */
const EVENTS = {
    print_failed: {
        kind: 'print_failed',
        severity: 'warn',
        title: 'A receipt did not print',
        href: '/orders',
        permission: null,
    },
}

export async function reportEvent(event, detail = '') {
    try {
        await requireUser()
        const spec = EVENTS[event]
        if (!spec) return { error: 'Unknown event' }
        const day = karachiDay()
        await raiseNotification({
            ...spec,
            body: String(detail || '').slice(0, 480) || null,
            businessDate: day,
            // One line a day per event, not one per bill: a printer that is off
            // fails on every sale, and thirty identical notices is a wall.
            dedupeKey: `${event}:${day}`,
        })
        return { data: { ok: true } }
    } catch (e) {
        return { error: e.message }
    }
}

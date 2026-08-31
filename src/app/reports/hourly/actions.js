'use server'

import { query } from '@/lib/db/pool.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The calendar day in Asia/Karachi (fixed UTC+5, no DST); en-CA emits ISO order.
const karachiDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

// 0–23 hour of an instant on the Karachi clock (h23 so midnight is 0, not 24)
const karachiHour = (isoString) => Number(
    new Date(isoString).toLocaleString('en-US', {
        timeZone: 'Asia/Karachi', hour: '2-digit', hourCycle: 'h23',
    }),
)

// 12-hour labels, matching how times read everywhere else in the app
const hourLabel = (hour) => {
    const period = hour < 12 ? 'AM' : 'PM'
    const twelve = hour % 12 === 0 ? 12 : hour % 12
    return `${twelve} ${period}`
}

/*
 * The day this report defaults to: the open business day once day-close is in
 * use, else the Karachi calendar day — the same resolution the money verbs
 * apply when they stamp orders.business_date.
 */
const defaultBusinessDay = async () => {
    const rows = await query(
        `SELECT business_date FROM business_days
         WHERE branch_id = 1 AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
    )
    if (rows.length === 0) return karachiDay()
    const d = rows[0].business_date
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d)
}

/*
 * Bills and money per hour of one business day. An order lands in the hour it
 * was paid — that is when the till actually took the money — falling back to
 * when it was rung in for a tab still open. Voids are out entirely.
 */
export async function getHourlySales(businessDate = null) {
    // Admin-only. Returned rather than thrown — production redacts thrown
    // action errors.
    try {
        await requirePermission('reports')
    } catch (e) {
        return { error: e.message }
    }

    try {
        const day = DATE_RE.test(businessDate || '') ? businessDate : await defaultBusinessDay()

        const orders = serializeRows('orders', await query(
            `SELECT total, paid_at, created_at
               FROM orders
              WHERE branch_id = 1 AND business_date = ? AND status <> 'cancelled'`,
            [day],
        ))

        /*
         * Bucketed on the Karachi clock in JS from the serialized ISO strings:
         * the DATETIMEs are UTC and the server may be anywhere, so the hour has
         * to be computed against the restaurant's timezone, never the host's.
         * Every hour is present even at zero so the day's shape reads directly.
         */
        const hours = Array.from({ length: 24 }, (_, hour) => ({
            hour, label: hourLabel(hour), bills: 0, revenue: 0,
        }))
        for (const o of orders) {
            const h = karachiHour(o.paid_at || o.created_at)
            hours[h].bills += 1
            hours[h].revenue += Number(o.total) || 0
        }

        return {
            data: {
                businessDate: day,
                hours,
                totals: {
                    bills: orders.length,
                    revenue: hours.reduce((sum, h) => sum + h.revenue, 0),
                },
            },
        }
    } catch (e) {
        console.error('hourly report failed', e)
        return { error: 'Could not load the hourly report' }
    }
}

'use server'

import { query } from '@/lib/db/pool.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The calendar day in Asia/Karachi (fixed UTC+5, no DST); en-CA emits ISO order.
const karachiDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/*
 * The day this report defaults to: the open business day once day-close is in
 * use, else the Karachi calendar day — the same resolution the money verbs
 * apply when they stamp orders.business_date, so "today" here means the same
 * trading day the orders were filed under, not the server's midnight.
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
 * Every order filed under one business day — voided ones included. This is the
 * per-order record of a day's trade, and a report that quietly dropped voids
 * would hide exactly the rows an owner wants explained. The page strikes them
 * through, shows the reason, and keeps them out of the footer sums.
 */
export async function getDailyFoodSales(businessDate = null) {
    // Wants `reports`: a day's takings order by order are not floor reading.
    // Returned rather than thrown — production redacts thrown action errors.
    try {
        await requirePermission('reports')
    } catch (e) {
        return { error: e.message }
    }

    try {
        const day = DATE_RE.test(businessDate || '') ? businessDate : await defaultBusinessDay()

        const orders = serializeRows('orders', await query(
            `SELECT id, order_number, invoice_number, fbr_invoice_number, order_type,
                    table_number, waiter_name, subtotal, discount, charges_total,
                    tax, total, payment_mode, payment_status, status, cancel_reason,
                    created_at, paid_at
               FROM orders
              WHERE branch_id = 1 AND business_date = ?
              ORDER BY created_at`,
            [day],
        ))

        return { data: { businessDate: day, orders } }
    } catch (e) {
        console.error('daily-sales report failed', e)
        return { error: 'Could not load the daily sales report' }
    }
}

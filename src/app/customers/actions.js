'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

/*
 * The customer book. The till has been filling `customers` since the first
 * takeaway — name, phone, address, a running count and spend — and until now
 * there was nowhere to read it. Which means nobody could answer "has this
 * number ordered before, and what did they order?" while the caller was still
 * on the line, which is the whole reason a delivery counter asks for a number.
 *
 * Read-only by design. The row is written by the sale (recordCustomer), so a
 * screen that let someone edit the totals would be editing a summary of money
 * that is recorded elsewhere. The address and name are corrected by taking the
 * next order, which is how they got there.
 */

// Enough to scan an evening's callers, short enough to stay one query.
const PAGE = 50;

export async function listCustomers(search = '') {
    try {
        await requirePermission('orders')
        const term = String(search || '').trim()
        // Phones are typed with and without spaces and dashes, so the phone
        // side of the search compares digits to digits. A name is matched as
        // written.
        const digits = term.replace(/\D/g, '')
        const rows = term
            ? await query(
                `SELECT id, name, phone, address, total_orders, total_spent, created_at, updated_at
                   FROM customers
                  WHERE name LIKE ?
                     ${digits ? "OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') LIKE ?" : ''}
                  ORDER BY updated_at DESC
                  LIMIT ?`,
                digits ? [`%${term}%`, `%${digits}%`, PAGE] : [`%${term}%`, PAGE],
            )
            : await query(
                `SELECT id, name, phone, address, total_orders, total_spent, created_at, updated_at
                   FROM customers ORDER BY updated_at DESC LIMIT ?`,
                [PAGE],
            )
        return { data: rows }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * One customer's bills. Matched on the phone stamped on the order rather than
 * a foreign key, because that is what the order actually stores — and it is
 * the right join anyway: the history is of the number that ordered.
 */
export async function getCustomerOrders(phone) {
    try {
        await requirePermission('orders')
        if (!phone) return { data: [] }
        const orders = await query(
            `SELECT id, order_number, order_type, total, payment_mode, payment_status,
                    business_date, created_at, paid_at, status
               FROM orders
              WHERE customer_phone = ?
              ORDER BY created_at DESC
              LIMIT 30`,
            [phone],
        )
        // What they order, not just what they spent — the question a counter
        // actually asks a returning caller is "the usual?".
        const favourites = await query(
            `SELECT oi.name, SUM(oi.qty) AS qty
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
              WHERE o.customer_phone = ?
              GROUP BY oi.name
              ORDER BY qty DESC
              LIMIT 5`,
            [phone],
        )
        return { data: { orders, favourites } }
    } catch (e) {
        return { error: e.message }
    }
}

'use server'

import { query } from '@/lib/db/pool.mjs'
import { requireAdmin } from '@/lib/db/auth.mjs'

// The calendar day in Asia/Karachi (fixed UTC+5, no DST) — the last-resort
// default when neither business_days nor orders can name a trading day.
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

// DATE columns come back as midnight-UTC Dates; the calendar day is the value.
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

const num = (v) => Number(v) || 0

/*
 * The day the picker should open on: the open business day if day-close is in
 * use, else the most recent day that actually traded, else today in Karachi.
 */
const defaultBusinessDate = async () => {
    const open = await query(
        `SELECT business_date FROM business_days
         WHERE closed_at IS NULL ORDER BY business_date DESC LIMIT 1`,
    )
    if (open.length > 0) return ymd(open[0].business_date)
    const last = await query('SELECT MAX(business_date) AS d FROM orders')
    return last[0]?.d ? ymd(last[0].d) : karachiDay()
}

/*
 * The nightly one-pager: everything the closing manager hands the owner, for
 * one trading day, computed in SQL over business_date so a 1am bill counts
 * toward the night it belongs to.
 */
export async function getHandoverReport(businessDate = null) {
    try {
        await requireAdmin()

        if (businessDate != null && !YMD_RE.test(String(businessDate))) {
            return { error: 'Pick a valid date' }
        }
        const date = businessDate ?? await defaultBusinessDate()

        // Sales spine: every non-cancelled order of the day, paid or not.
        // Gross is food money asked for; net is after discounts; revenue is
        // the billed totals including charges and tax.
        const [sales] = await query(
            `SELECT COUNT(*) AS bills,
                    COALESCE(SUM(subtotal), 0) AS gross,
                    COALESCE(SUM(discount), 0) AS discounts,
                    COALESCE(SUM(charges_total), 0) AS charges,
                    COALESCE(SUM(tax), 0) AS tax,
                    COALESCE(SUM(total), 0) AS revenue
             FROM orders
             WHERE business_date = ? AND status <> 'cancelled'`,
            [date],
        )

        const [items] = await query(
            `SELECT COALESCE(SUM(oi.qty), 0) AS itemsSold
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE o.business_date = ? AND o.status <> 'cancelled'`,
            [date],
        )

        const orderTypes = await query(
            `SELECT order_type AS type, COUNT(*) AS \`count\`, COALESCE(SUM(total), 0) AS revenue
             FROM orders
             WHERE business_date = ? AND status <> 'cancelled'
             GROUP BY order_type
             ORDER BY revenue DESC`,
            [date],
        )

        // Money actually taken, from the payments ledger rather than order
        // columns — void reversals are the negative rows, reported as refunds
        // instead of quietly shrinking the takings.
        const payments = await query(
            `SELECT p.method,
                    COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount END), 0) AS amount,
                    COALESCE(SUM(p.amount > 0), 0) AS \`count\`,
                    COALESCE(SUM(CASE WHEN p.amount < 0 THEN p.amount END), 0) AS refunds,
                    COALESCE(SUM(p.amount < 0), 0) AS refundCount
             FROM payments p
             JOIN orders o ON o.id = p.order_id
             WHERE o.business_date = ?
             GROUP BY p.method
             ORDER BY amount DESC`,
            [date],
        )

        // Tax split by how the bill settled — the ICT differential means cash
        // and card tax are filed as different lines. Cancelled orders are
        // excluded: their tax was reversed with the payment.
        const taxByMode = await query(
            `SELECT payment_mode AS mode, COALESCE(SUM(tax), 0) AS tax
             FROM orders
             WHERE business_date = ? AND payment_status = 'paid' AND status <> 'cancelled'
             GROUP BY payment_mode
             ORDER BY tax DESC`,
            [date],
        )

        const voidedOrders = await query(
            `SELECT order_number, cancel_reason, cancelled_by, total
             FROM orders
             WHERE business_date = ? AND status = 'cancelled'
             ORDER BY cancelled_at`,
            [date],
        )

        const [expenseTotal] = await query(
            'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE business_date = ?',
            [date],
        )
        const expenseCats = await query(
            `SELECT COALESCE(ec.name, 'Uncategorised') AS category, SUM(e.amount) AS amount
             FROM expenses e
             LEFT JOIN expense_categories ec ON ec.id = e.category_id
             WHERE e.business_date = ?
             GROUP BY COALESCE(ec.name, 'Uncategorised')
             ORDER BY amount DESC`,
            [date],
        )

        const drawerSessions = (await query(
            `SELECT cashier_role, opening_float, expected_amount, counted_amount,
                    variance, opened_at, closed_at
             FROM drawer_sessions
             WHERE business_date = ?
             ORDER BY opened_at`,
            [date],
        )).map((s) => ({
            cashier_role: s.cashier_role,
            opening_float: num(s.opening_float),
            // Null until the drawer is counted at close — the page renders the
            // gap as "still open" rather than a fake zero.
            expected: s.expected_amount == null ? null : Number(s.expected_amount),
            counted: s.counted_amount == null ? null : Number(s.counted_amount),
            variance: s.variance == null ? null : Number(s.variance),
            opened_at: s.opened_at ? s.opened_at.toISOString() : null,
            closed_at: s.closed_at ? s.closed_at.toISOString() : null,
        }))

        // COGS: what the paid food cost to make. Recipe cost is priced at the
        // current moving-average ingredient cost; the LEFT JOIN means a dish
        // with no recipe yet contributes zero rather than dropping the order.
        const [cogsRow] = await query(
            `SELECT COALESCE(SUM(oi.qty * COALESCE(rc.cost, 0)), 0) AS cogs
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             LEFT JOIN (
                 SELECT rl.menu_item_id, SUM(rl.qty * ii.avg_cost) AS cost
                 FROM recipe_lines rl
                 JOIN inventory_items ii ON ii.id = rl.inventory_item_id
                 GROUP BY rl.menu_item_id
             ) rc ON rc.menu_item_id = oi.menu_item_id
             WHERE o.business_date = ? AND o.payment_status = 'paid' AND o.status <> 'cancelled'`,
            [date],
        )

        const gross = num(sales.gross)
        const discounts = num(sales.discounts)
        const net = gross - discounts
        const cogs = num(cogsRow.cogs)
        const expensesTotal = num(expenseTotal.total)
        const grossProfit = net - cogs

        return {
            data: {
                businessDate: date,
                sales: {
                    bills: num(sales.bills),
                    itemsSold: num(items.itemsSold),
                    gross,
                    discounts,
                    net,
                    charges: num(sales.charges),
                    tax: num(sales.tax),
                    revenue: num(sales.revenue),
                },
                orderTypes: orderTypes.map((t) => ({
                    type: t.type, count: num(t.count), revenue: num(t.revenue),
                })),
                payments: payments.map((p) => ({
                    method: p.method,
                    amount: num(p.amount),
                    count: num(p.count),
                    refunds: num(p.refunds),
                    refundCount: num(p.refundCount),
                })),
                taxByMode: taxByMode.map((t) => ({ mode: t.mode, tax: num(t.tax) })),
                voided: {
                    count: voidedOrders.length,
                    amount: voidedOrders.reduce((sum, o) => sum + num(o.total), 0),
                    orders: voidedOrders.map((o) => ({
                        order_number: o.order_number,
                        cancel_reason: o.cancel_reason,
                        cancelled_by: o.cancelled_by,
                        total: num(o.total),
                    })),
                },
                expenses: {
                    total: expensesTotal,
                    byCategory: expenseCats.map((c) => ({
                        category: c.category, amount: num(c.amount),
                    })),
                },
                drawerSessions,
                profit: {
                    cogs,
                    grossProfit,
                    netProfit: grossProfit - expensesTotal,
                },
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

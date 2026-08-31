'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The calendar day in Asia/Karachi (fixed UTC+5, no DST); en-CA emits ISO order.
const karachiDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

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

// One rollup node: every level of the tree carries the same four numbers.
const bump = (node, qty, gross, discount) => {
    node.qty += qty
    node.gross += gross
    node.discount += discount
}

/*
 * Category → item → variant rollup over a business-date range.
 *
 * Sourced from order_items — the canonical lines — not the orders' JSON
 * snapshot. Category comes through the line's menu_item_id; a line whose dish
 * was deleted (the FK is a convenience, the bill is the record) lands under
 * 'Uncategorized' rather than vanishing from the day's food story.
 */
export async function getItemWiseSales(from = null, to = null) {
    // Wants `reports`. Returned rather than thrown — production redacts thrown
    // action errors.
    try {
        await requirePermission('reports')
    } catch (e) {
        return { error: e.message }
    }

    try {
        const day = await defaultBusinessDay()
        let start = DATE_RE.test(from || '') ? from : day
        let end = DATE_RE.test(to || '') ? to : start
        // ISO date strings order lexically, so a reversed range is just a swap.
        if (end < start) [start, end] = [end, start]

        const lines = await query(
            `SELECT oi.name, oi.variant, oi.qty, oi.line_total,
                    o.subtotal AS order_subtotal, o.discount AS order_discount,
                    COALESCE(c.name, 'Uncategorized') AS category
               FROM order_items oi
               JOIN orders o        ON o.id = oi.order_id
               LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
               LEFT JOIN categories c  ON c.id = mi.category_id
              WHERE o.branch_id = 1
                AND o.business_date >= ? AND o.business_date <= ?
                AND o.status <> 'cancelled'`,
            [start, end],
        )

        // What the orders themselves say the range sold — the reconciliation
        // target the page holds the item rollup against.
        const [ordersAgg] = await query(
            `SELECT COUNT(*) AS orders_count,
                    COALESCE(SUM(subtotal), 0) AS subtotal,
                    COALESCE(SUM(discount), 0) AS discount
               FROM orders
              WHERE branch_id = 1
                AND business_date >= ? AND business_date <= ?
                AND status <> 'cancelled'`,
            [start, end],
        )

        const catMap = new Map()
        for (const line of lines) {
            const qty = Number(line.qty) || 0
            const gross = Number(line.line_total) || 0

            /*
             * The order's rupee discount, prorated onto its lines by their share
             * of the subtotal. Full float precision is kept through the sums and
             * rounding happens only at display, so the grand total reconciles
             * with SUM(orders.discount) instead of drifting a rupee per order.
             */
            const orderSubtotal = Number(line.order_subtotal) || 0
            const discount = orderSubtotal > 0
                ? (Number(line.order_discount) || 0) * (gross / orderSubtotal)
                : 0

            let cat = catMap.get(line.category)
            if (!cat) {
                cat = { name: line.category, qty: 0, gross: 0, discount: 0, items: new Map() }
                catMap.set(line.category, cat)
            }
            let item = cat.items.get(line.name)
            if (!item) {
                item = { name: line.name, qty: 0, gross: 0, discount: 0, variants: new Map() }
                cat.items.set(line.name, item)
            }
            const variantKey = line.variant || ''
            let variant = item.variants.get(variantKey)
            if (!variant) {
                variant = { name: line.variant || null, qty: 0, gross: 0, discount: 0 }
                item.variants.set(variantKey, variant)
            }

            bump(cat, qty, gross, discount)
            bump(item, qty, gross, discount)
            bump(variant, qty, gross, discount)
        }

        // Sorted by gross at every level: the report reads money-first, the
        // way Blink's item-wise summary leads with what earned most.
        const withNet = (node) => ({ ...node, net: node.gross - node.discount })
        const byGross = (a, b) => b.gross - a.gross

        const categories = [...catMap.values()]
            .map((cat) => ({
                ...withNet(cat),
                items: [...cat.items.values()]
                    .map((item) => ({
                        ...withNet(item),
                        variants: [...item.variants.values()].map(withNet).sort(byGross),
                    }))
                    .sort(byGross),
            }))
            .sort(byGross)

        const grand = categories.reduce(
            (acc, cat) => ({
                qty: acc.qty + cat.qty,
                gross: acc.gross + cat.gross,
                discount: acc.discount + cat.discount,
                net: acc.net + cat.net,
            }),
            { qty: 0, gross: 0, discount: 0, net: 0 },
        )

        return {
            data: {
                from: start,
                to: end,
                categories,
                grand,
                orders: {
                    count: Number(ordersAgg.orders_count) || 0,
                    subtotal: Number(ordersAgg.subtotal) || 0,
                    discount: Number(ordersAgg.discount) || 0,
                },
            },
        }
    } catch (e) {
        console.error('item-wise report failed', e)
        return { error: 'Could not load the item-wise report' }
    }
}

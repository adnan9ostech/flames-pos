
'use server'

import { query } from '@/lib/db/pool.mjs'
import { serializeRows } from '@/lib/db/serialize.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { currentBranchId } from '@/lib/db/branch.mjs'

/*
 * Orders are selected and day-bucketed by business_date — the trading day
 * stamped on the order at creation — not by wall-clock created_at. A ticket
 * rung at 1am belongs to the previous evening's service: its created_at says
 * the 28th, its business_date says the 27th, and the 27th is where its money
 * must land or the dashboard disagrees with that night's till count.
 * business_date arrives as 'YYYY-MM-DD' on the Karachi calendar, so range
 * bounds are plain date strings compared in SQL — no timezone conversion at
 * selection time. Only the hour-of-day chart still reads created_at (a clock
 * hour is a clock hour, whichever trading day it falls in), and that
 * conversion stays on the restaurant's clock rather than the server's,
 * because these actions run wherever the host happens to be — UTC in
 * production.
 */
const KARACHI_TZ = 'Asia/Karachi'

// 'YYYY-MM-DD' of an instant on the Karachi calendar (en-CA emits ISO order)
const karachiDateStr = (date) => date.toLocaleDateString('en-CA', { timeZone: KARACHI_TZ })

// 'YYYY-MM-DD' plus/minus whole days. Parsed at UTC midnight so the
// arithmetic can never straddle a DST jump (and PKT has none anyway).
const shiftYmd = (ymd, days) => {
    const d = new Date(`${ymd}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
}

// Inclusive day count of a ['YYYY-MM-DD', 'YYYY-MM-DD'] window
const spanDays = (fromYmd, toYmd) =>
    Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86_400_000) + 1

// 0–23 hour of an instant on the Karachi clock (h23 so midnight is 0, not 24)
const karachiHour = (isoString) => Number(
    new Date(isoString).toLocaleString('en-US', { timeZone: KARACHI_TZ, hour: '2-digit', hourCycle: 'h23' })
)

// 'Aug 27' — chart bucket label for a 'YYYY-MM-DD' business date
const dayLabel = (ymd) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: '2-digit' })

/*
 * An open tab is food fired, not money taken. Every revenue-shaped number
 * counts settled orders only; what the floor still owes is reported alongside
 * as its own figure instead of being folded into takings that could then
 * shrink when a tab is voided — or double when it settles.
 */
const isSettled = (order) => order.payment_status !== 'unpaid'

// Aggregate a set of orders into the numbers the dashboard needs.
function summarize(orders) {
    const settled = orders.filter(isSettled)
    const open = orders.filter(o => !isSettled(o))
    const totalRevenue = settled.reduce((sum, order) => sum + (order.total || 0), 0)
    const totalOrders = settled.length
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0

    const itemCounts = {}
    settled.forEach(order => {
        if (order.items && Array.isArray(order.items)) {
            order.items.forEach(item => {
                const name = item.name
                if (!itemCounts[name]) {
                    itemCounts[name] = { name, count: 0, revenue: 0 }
                }
                itemCounts[name].count += item.qty || 1
                itemCounts[name].revenue += (item.price * (item.qty || 1))
            })
        }
    })

    /*
     * The figures below come from columns that were already being stored and
     * simply weren't reported on: payment_mode, waiter_name, tax, discount and
     * the timestamp. No new data collection, so they work retroactively over
     * whatever history already exists.
     */

    // Total tax collected — needed for filing, and previously nowhere on screen.
    const totalTax = settled.reduce((sum, order) => sum + (Number(order.tax) || 0), 0)
    const totalDiscount = settled.reduce((sum, order) => sum + (Number(order.discount) || 0), 0)

    /*
     * Cash vs card, plus what's still owed on open tabs. Counted by amount and
     * by order, because "half the orders were card" and "half the money was
     * card" are different questions and a till gets asked both.
     *
     * Orders with no payment_mode recorded get their own bucket rather than
     * being folded into cash. Plenty of history predates the field, and
     * reporting an unknown as cash would state something untrue about where the
     * money went.
     */
    const paymentMix = {
        cash: { amount: 0, count: 0 },
        card: { amount: 0, count: 0 },
        unpaid: { amount: 0, count: 0 },
        unrecorded: { amount: 0, count: 0 },
    }
    orders.forEach(order => {
        let bucket
        if (order.payment_status === 'unpaid') bucket = 'unpaid'
        else if (order.payment_mode === 'card') bucket = 'card'
        else if (order.payment_mode === 'cash') bucket = 'cash'
        else bucket = 'unrecorded'

        paymentMix[bucket].amount += Number(order.total) || 0
        paymentMix[bucket].count += 1
    })

    // Takings by hour of day, for staffing decisions. Every hour is present even
    // at zero, so the shape of a service is readable rather than inferred from
    // gaps.
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, label: hourLabel(hour), revenue: 0, orders: 0 }))
    settled.forEach(order => {
        const hour = karachiHour(order.created_at)
        hourly[hour].revenue += Number(order.total) || 0
        hourly[hour].orders += 1
    })

    // Per-server takings. waiter_name is denormalised onto the order, so this
    // still attributes correctly after someone leaves.
    const waiterTotals = {}
    settled.forEach(order => {
        const name = order.waiter_name
        if (!name) return
        if (!waiterTotals[name]) waiterTotals[name] = { name, revenue: 0, orders: 0 }
        waiterTotals[name].revenue += Number(order.total) || 0
        waiterTotals[name].orders += 1
    })

    return {
        totalRevenue, totalOrders, avgOrderValue, itemCounts,
        totalTax, totalDiscount, paymentMix, hourly,
        waiters: Object.values(waiterTotals).sort((a, b) => b.revenue - a.revenue),
        openTabs: {
            count: open.length,
            amount: open.reduce((sum, order) => sum + (Number(order.total) || 0), 0),
        },
    }
}

// 12-hour labels, matching how times read everywhere else in the app
function hourLabel(hour) {
    const period = hour < 12 ? 'AM' : 'PM'
    const twelve = hour % 12 === 0 ? 12 : hour % 12
    return `${twelve} ${period}`
}

// % change from `previous` to `current`. Null when there is no baseline to
// compare against (avoids a misleading "+∞%" or "+100%" off a zero start).
function trendPct(current, previous) {
    if (!previous) return null
    return ((current - previous) / previous) * 100
}

/*
 * The range control's answer as inclusive business_date bounds: "today" is the
 * trading day still in progress, and a date picked in the filter means that
 * trading day — not the server's timezone rendering of it.
 *
 * Shared by both actions on this page. The tiles and the report previews are
 * read as one screen, so they must never be answering two different windows.
 */
function resolveRange(range, endDateStr) {
    const todayYmd = karachiDateStr(new Date())
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (dateRegex.test(range)) {
        return {
            startYmd: range,
            endYmd: endDateStr && dateRegex.test(endDateStr) ? endDateStr : range,
        }
    }
    if (range === '7days') return { startYmd: shiftYmd(todayYmd, -7), endYmd: todayYmd }
    if (range === '30days') return { startYmd: shiftYmd(todayYmd, -30), endYmd: todayYmd }
    return { startYmd: todayYmd, endYmd: todayYmd }
}

export async function getDashboardStats(range = 'today', endDateStr = null) {
    // Wants `reports`: takings and per-waiter figures are not floor reading.
    // Returned rather than thrown — production redacts thrown action errors.
    let branchId
    try {
        const user = await requirePermission('reports')
        branchId = await currentBranchId(user)
    } catch (e) {
        return { error: e.message }
    }

    const { startYmd, endYmd } = resolveRange(range, endDateStr)

    // The immediately preceding run of trading days, equal in length, used for
    // trend %s — e.g. "7 Days" compares against the 7 days before that.
    const prevEndYmd = shiftYmd(startYmd, -1)
    const prevStartYmd = shiftYmd(prevEndYmd, -(spanDays(startYmd, endYmd) - 1))

    // Bound on business_date — DATE against 'YYYY-MM-DD' strings, so a 1am
    // ticket stays with its evening — then serialized so the aggregation below
    // sees the same ISO-string shapes PostgREST used to send.
    const fetchOrders = async (fromYmd, toYmd) =>
        serializeRows('orders', await query(
            // Scoped to the outlet being looked at. Without the branch these
            // tiles stated the whole company's takings as this restaurant's —
            // and contradicted the report cards directly beneath them on the
            // same screen, which were scoped.
            `SELECT * FROM orders
             WHERE branch_id = ? AND business_date >= ? AND business_date <= ?
               AND status <> 'cancelled'`,
            [branchId, fromYmd, toYmd],
        ))

    let orders, prevOrders
    try {
        [orders, prevOrders] = await Promise.all([
            fetchOrders(startYmd, endYmd),
            fetchOrders(prevStartYmd, prevEndYmd)
        ])
    } catch (error) {
        console.error('Error fetching stats:', error)
        return { error: 'Failed to fetch stats' }
    }

    const current = summarize(orders)
    const previous = summarize(prevOrders)

    // Chart Data: Sales over time. Settled money only, on business days —
    // matching the revenue tile the chart sits under. Keyed by the raw
    // 'YYYY-MM-DD' so the sort is chronological, labelled for the axis.
    const salesByDate = {}
    orders.filter(isSettled).forEach(order => {
        const ymd = order.business_date
        if (!salesByDate[ymd]) {
            salesByDate[ymd] = { date: dayLabel(ymd), sales: 0, orders: 0 }
        }
        salesByDate[ymd].sales += order.total || 0
        salesByDate[ymd].orders += 1
    })
    const chartData = Object.keys(salesByDate).sort().map(ymd => salesByDate[ymd])

    // Top Selling Items — highest volume this period
    const topItems = Object.values(current.itemCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)

    // Trending Items — biggest increase in units sold vs. the prior period.
    // Distinct from "top selling": a low-volume item climbing fast still
    // shows up here even if it doesn't crack the top 5 by raw count.
    const trendingItems = Object.values(current.itemCounts)
        .map(item => {
            const prevCount = previous.itemCounts[item.name]?.count || 0
            return { ...item, prevCount, growth: item.count - prevCount }
        })
        .filter(item => item.growth > 0)
        .sort((a, b) => b.growth - a.growth)
        .slice(0, 5)

    return {
        totalRevenue: current.totalRevenue,
        totalOrders: current.totalOrders,
        avgOrderValue: current.avgOrderValue,
        chartData,
        topItems,
        trendingItems,
        totalTax: current.totalTax,
        totalDiscount: current.totalDiscount,
        openTabs: current.openTabs,
        paymentMix: current.paymentMix,
        // Trimmed to the trading part of the day so the chart isn't mostly empty
        // bars, but kept whole if the kitchen genuinely ran round the clock.
        hourly: current.hourly.filter(h => h.orders > 0).length
            ? current.hourly.slice(
                Math.min(...current.hourly.filter(h => h.orders > 0).map(h => h.hour)),
                Math.max(...current.hourly.filter(h => h.orders > 0).map(h => h.hour)) + 1
            )
            : [],
        waiters: current.waiters,
        trends: {
            revenue: trendPct(current.totalRevenue, previous.totalRevenue),
            orders: trendPct(current.totalOrders, previous.totalOrders),
            avgOrderValue: trendPct(current.avgOrderValue, previous.avgOrderValue)
        }
    }
}

/* ------------------------------------------------------------------------ *
 * Report previews — the hub's card grid.
 * ------------------------------------------------------------------------ */

// A DATE column arrives as a midnight-UTC Date (the pool pins the session to
// UTC); the calendar day is the whole of the value.
const ymdOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))

const num = (v) => Number(v) || 0

/*
 * One call, every card. Six cards each firing their own action would mean six
 * round trips and six chances for the grid to disagree with itself while they
 * landed, so the page asks once and the cards read from the answer.
 *
 * Each figure is computed the way the report it links to computes it — same
 * business_date bounds, same exclusions — so a headline here is never a
 * different number from the one the reader finds after clicking. That is why
 * the definitions vary between cards rather than being unified: Handover and
 * Daily Food Sales bill every non-cancelled order, while Menu Analytics and
 * Gross Profit count settled money only.
 *
 * branch_id is pinned to 1 as the other report actions pin it — one branch
 * trades, and the column is a forward-looking default rather than a live axis.
 */
export async function getReportPreviews(range = 'today', endDateStr = null) {
    // Wants `reports`, like every other action on this screen. Returned rather
    // than thrown — production redacts thrown action errors.
    let branchId
    try {
        const user = await requirePermission('reports')
        branchId = await currentBranchId(user)
    } catch (e) {
        return { error: e.message }
    }

    const { startYmd, endYmd } = resolveRange(range, endDateStr)

    try {
        const [dayRows, hourRows, itemRows, categoryRows, [profitRow]] = await Promise.all([
            // Handover + Daily Food Sales: both report every non-cancelled
            // order of a trading day, paid or not — an open tab is still a bill
            // the day has to account for. Grouped by day so the two cards can
            // draw the shape of the range as well as name its total.
            query(
                `SELECT business_date AS day,
                        COUNT(*) AS bills,
                        COALESCE(SUM(total), 0) AS revenue
                   FROM orders
                  WHERE branch_id = ?
                    AND business_date >= ? AND business_date <= ?
                    AND status <> 'cancelled'
                  GROUP BY business_date
                  ORDER BY business_date`,
                [branchId, startYmd, endYmd],
            ),
            // Hourly Sales buckets an order into the hour it was paid, falling
            // back to when it was rung in for a tab still open. Karachi is a
            // fixed UTC+5 with no DST and the DATETIMEs are stored UTC, so the
            // shift is arithmetic — no CONVERT_TZ, which needs the tz tables
            // loaded on the host.
            query(
                `SELECT HOUR(COALESCE(paid_at, created_at) + INTERVAL 5 HOUR) AS hour,
                        COALESCE(SUM(total), 0) AS total
                   FROM orders
                  WHERE branch_id = ?
                    AND business_date >= ? AND business_date <= ?
                    AND status <> 'cancelled'
                  GROUP BY hour
                  ORDER BY hour`,
                [branchId, startYmd, endYmd],
            ),
            // Item-wise reads order_items, the canonical lines, not the order's
            // JSON snapshot. Ranked by units because the card's question is
            // "what leaves the kitchen most", and the report itself opens on
            // the same set of dishes.
            query(
                `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total) AS gross
                   FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                  WHERE o.branch_id = ?
                    AND o.business_date >= ? AND o.business_date <= ?
                    AND o.status <> 'cancelled'
                  GROUP BY oi.name
                  ORDER BY qty DESC, gross DESC
                  LIMIT 5`,
                [branchId, startYmd, endYmd],
            ),
            // Menu Analytics counts sold, i.e. settled: an open tab is food
            // fired, not money taken, and a mix that counted it would shrink
            // when the tab voids. A line whose dish was deleted keeps its money
            // under 'Uncategorised' instead of vanishing.
            query(
                `SELECT COALESCE(c.name, 'Uncategorised') AS name,
                        COALESCE(SUM(oi.line_total), 0) AS amount
                   FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                   LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
                   LEFT JOIN categories c ON c.id = mi.category_id
                  WHERE o.branch_id = ?
                    AND o.business_date >= ? AND o.business_date <= ?
                    AND o.status <> 'cancelled'
                    AND o.payment_status <> 'unpaid'
                  GROUP BY name
                  ORDER BY amount DESC`,
                [branchId, startYmd, endYmd],
            ),
            /*
             * Gross profit prices each dish at its recipe: Σ recipe_lines.qty ×
             * inventory_items.avg_cost. The LEFT JOIN is the load-bearing part
             * — a dish with no recipe yet contributes zero cost rather than
             * dropping its sale from the report, so a margin taken over ALL
             * revenue would be flattered by every uncosted plate. Hence the
             * margin below is over costed revenue only, and uncostedCount
             * comes back so the card can say so out loud.
             */
            query(
                `SELECT COALESCE(SUM(oi.line_total), 0) AS revenue,
                        COALESCE(SUM(CASE WHEN rc.unit_cost IS NOT NULL
                                          THEN oi.line_total END), 0) AS costed_revenue,
                        COALESCE(SUM(CASE WHEN rc.unit_cost IS NOT NULL
                                          THEN oi.qty * rc.unit_cost END), 0) AS cogs,
                        COUNT(DISTINCT CASE WHEN rc.unit_cost IS NULL
                                            THEN COALESCE(mi.name, oi.name) END) AS uncosted
                   FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                   LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
                   LEFT JOIN (
                       SELECT rl.menu_item_id, SUM(rl.qty * ii.avg_cost) AS unit_cost
                         FROM recipe_lines rl
                         JOIN inventory_items ii ON ii.id = rl.inventory_item_id
                        GROUP BY rl.menu_item_id
                   ) rc ON rc.menu_item_id = oi.menu_item_id
                  WHERE o.branch_id = ?
                    AND o.business_date >= ? AND o.business_date <= ?
                    AND o.status <> 'cancelled'
                    AND o.payment_status <> 'unpaid'`,
                [branchId, startYmd, endYmd],
            ),
        ])

        // One per-day series serves both cards: Handover plots the money, Daily
        // Food Sales the bill count, and they are the same set of orders.
        const days = dayRows.map((r) => ({
            date: ymdOf(r.day), orders: num(r.bills), revenue: num(r.revenue),
        }))
        const bills = days.reduce((sum, d) => sum + d.orders, 0)
        const dayRevenue = days.reduce((sum, d) => sum + d.revenue, 0)

        // Every hour in the traded window, zero-filled, then trimmed to it: the
        // sparkline should show the shape of a service, not 24 slots mostly
        // empty, and a gap hour must read as a trough rather than close up.
        const hours = Array.from({ length: 24 }, () => 0)
        for (const r of hourRows) hours[Number(r.hour)] += num(r.total)
        const traded = hours.map((total, hour) => ({ hour, total })).filter((h) => h.total !== 0)
        const series = traded.length
            ? hours
                .map((total, hour) => ({ hour, total }))
                .slice(traded[0].hour, traded[traded.length - 1].hour + 1)
            : []
        const peak = series.reduce(
            (best, h) => (best === null || h.total > best.total ? h : best),
            null,
        )

        const categories = categoryRows.map((r) => ({ name: r.name, amount: num(r.amount) }))

        const costedRevenue = num(profitRow.costed_revenue)
        const cogs = num(profitRow.cogs)

        return {
            data: {
                range: { from: startYmd, to: endYmd },
                handover: { revenue: dayRevenue, bills, days },
                dailySales: { revenue: dayRevenue, orders: bills, days },
                hourly: {
                    peakHour: peak ? peak.hour : null,
                    peakRevenue: peak ? peak.total : 0,
                    series,
                },
                itemWise: {
                    topItems: itemRows.map((r) => ({ name: r.name, qty: num(r.qty) })),
                },
                menuAnalytics: {
                    topCategory: categories.length ? categories[0].name : null,
                    categories,
                },
                grossProfit: {
                    // Null, not zero: nothing sold has a costed recipe, so the
                    // range has no margin to state and the card says as much.
                    marginPct: costedRevenue > 0 ? ((costedRevenue - cogs) / costedRevenue) * 100 : null,
                    cogs,
                    revenue: num(profitRow.revenue),
                    margin: costedRevenue - cogs,
                    uncostedCount: num(profitRow.uncosted),
                },
            },
        }
    } catch (e) {
        console.error('Report previews failed', e)
        return { error: 'Could not load the report previews' }
    }
}

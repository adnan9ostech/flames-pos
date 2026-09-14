'use client'

import { useState, useEffect } from 'react'
import styles from './daily-sales.module.css'
import { getDailyFoodSales } from './actions'
import { formatClockTime } from '@/lib/timeFormat'
import {
    BarChart, Bar, XAxis, YAxis, Tooltip, LabelList, ResponsiveContainer
} from 'recharts'
import {
    CalendarRange, FileDown, Loader2, ClipboardList, AlertTriangle
} from 'lucide-react'
/*
 * Chart ink, themed. Recharts writes these into SVG presentation attributes
 * (fill, stroke), which resolve CSS custom properties — so the chart follows
 * the light/dark switch on the same repaint as the rest of the page. SERIES is
 * the palette slot a single-series chart takes so the data does not read as
 * brand chrome.
 */
import { SERIES, AXIS_TEXT, LABEL_TEXT, CURSOR_FILL } from '@/lib/reports/chartTheme.mjs'
import PrintButton from '@/components/Reports/PrintButton'

const TYPE_LABEL = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }

const STATUS_LABEL = {
    new: 'New', preparing: 'Preparing', ready: 'Ready',
    completed: 'Completed', cancelled: 'Voided',
}

const PAYMENT_LABEL = { cash: 'Cash', card: 'Card', city_ledger: 'City Ledger' }

// An open tab has no payment mode yet; saying "Unpaid" outright beats a dash
// the reader has to interpret.
const paymentLabel = (order) =>
    order.payment_status === 'unpaid' ? 'Unpaid' : (PAYMENT_LABEL[order.payment_mode] || '—')

// Money renders like the orders page: en-PK grouping, no decimals on screen.
const rs = (x) => Math.round(Number(x) || 0).toLocaleString('en-PK')

const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

function StatTile({ label, value, sub }) {
    return (
        <div className={styles.statTile}>
            <span className={styles.statLabel}>{label}</span>
            <span className={styles.statValue}>{value}</span>
            {sub && <span className={styles.statSub}>{sub}</span>}
        </div>
    )
}

function TypeTooltip({ active, payload }) {
    if (!active || !payload?.length) return null
    const row = payload[0].payload
    return (
        <div className={styles.tooltip}>
            <div className={styles.tooltipHead}>{row.label}</div>
            <div className={styles.tooltipRow}>
                <span>Revenue</span>
                <span className={styles.tooltipValue}>Rs. {rs(row.revenue)}</span>
            </div>
            <div className={styles.tooltipRow}>
                <span>Bills</span>
                <span className={styles.tooltipValue}>{row.bills}</span>
            </div>
            <div className={styles.tooltipRow}>
                <span>Share of day</span>
                <span className={styles.tooltipValue}>{row.share}%</span>
            </div>
        </div>
    )
}

export default function DailySalesPage() {
    // The picked day stays separate from the resolved one: '' means "let the
    // server resolve the open business day", and writing the answer back into
    // the input must not retrigger the fetch it answered.
    const [pickedDay, setPickedDay] = useState('')
    const [report, setReport] = useState(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        getDailyFoodSales(pickedDay || null).then((res) => {
            if (cancelled) return
            if (res.error) {
                setError(res.error)
            } else {
                setError('')
                setReport(res.data)
            }
            setLoading(false)
        })
        return () => { cancelled = true }
    }, [pickedDay])

    const orders = report?.orders || []
    const voidedCount = orders.filter((o) => o.status === 'cancelled').length
    const sold = orders.filter((o) => o.status !== 'cancelled')

    // Footer sums exclude voided rows: a void is on the page to be seen, not
    // to count towards the day's sales.
    const sums = sold
        .reduce((acc, o) => ({
            subtotal: acc.subtotal + (Number(o.subtotal) || 0),
            discount: acc.discount + (Number(o.discount) || 0),
            charges: acc.charges + (Number(o.charges_total) || 0),
            tax: acc.tax + (Number(o.tax) || 0),
            total: acc.total + (Number(o.total) || 0),
            items: acc.items + (Number(o.item_count) || 0),
        }), { subtotal: 0, discount: 0, charges: 0, tax: 0, total: 0, items: 0 })

    /*
     * Revenue by order type, from the rows already on the page rather than a
     * second trip to the server. Only the types that actually traded get a bar,
     * so a house that never delivers is not told every day that it took nothing
     * on delivery.
     */
    const typeTotals = new Map()
    for (const o of sold) {
        // A bill with no type is a data fault, not a fourth channel; it still
        // gets a bar so its money is never quietly missing from the split.
        const key = o.order_type || 'unspecified'
        const label = TYPE_LABEL[key] || (o.order_type ? key : 'Unspecified')
        const row = typeTotals.get(key) || { key, label, revenue: 0, bills: 0 }
        row.revenue += Number(o.total) || 0
        row.bills += 1
        typeTotals.set(key, row)
    }
    const byType = [...typeTotals.values()]
        .map((row) => ({
            ...row,
            share: sums.total > 0 ? Math.round((row.revenue / sums.total) * 100) : 0,
            // Precomputed so the direct label is a plain string on the datum;
            // no formatter has to run inside the SVG.
            moneyLabel: `Rs. ${rs(row.revenue)}`,
        }))
        // Sorted by value so the bars read top-heavy, biggest first.
        .sort((a, b) => b.revenue - a.revenue)

    const exportCsv = () => {
        if (!report) return
        const header = [
            'Order #', 'Invoice #', 'FBR Invoice #', 'Type', 'Table', 'Waiter',
            'Subtotal', 'Discount', 'Charges', 'Tax', 'Total', 'Payment', 'Status', 'Void reason',
        ]
        const lines = orders.map((o) => [
            o.order_number, o.invoice_number || '', o.fbr_invoice_number || '',
            TYPE_LABEL[o.order_type] || o.order_type, o.table_number || '', o.waiter_name || '',
            Number(o.subtotal).toFixed(2), Number(o.discount).toFixed(2),
            Number(o.charges_total).toFixed(2), Number(o.tax).toFixed(2), Number(o.total).toFixed(2),
            paymentLabel(o), STATUS_LABEL[o.status] || o.status, o.cancel_reason || '',
        ])
        const footer = [
            'TOTAL (excl. voided)', '', '', '', '', '',
            sums.subtotal.toFixed(2), sums.discount.toFixed(2), sums.charges.toFixed(2),
            sums.tax.toFixed(2), sums.total.toFixed(2), '', '', '',
        ]
        const csv = [header, ...lines, footer]
            .map((row) => row.map(csvCell).join(','))
            .join('\n')

        // Built and downloaded entirely client-side; no round trip, no deps.
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `daily-sales-${report.businessDate}.csv`
        a.click()
        URL.revokeObjectURL(url)
    }

    return (
        <div className={`${styles.container} print-root`}>
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Daily Sales</h1>
                    {report && (
                        <span className={styles.dayNote}>Business day {report.businessDate}</span>
                    )}
                </div>
                <PrintButton />
            </div>

            <div className={styles.toolbar}>
                <label className={styles.control}>
                    <CalendarRange size={14} aria-hidden="true" />
                    <input
                        type="date"
                        className={styles.dateInput}
                        value={pickedDay || report?.businessDate || ''}
                        onChange={(e) => setPickedDay(e.target.value)}
                        aria-label="Business day"
                    />
                </label>

                <button
                    type="button"
                    className={styles.csvBtn}
                    onClick={exportCsv}
                    disabled={loading || orders.length === 0}
                >
                    <FileDown size={14} aria-hidden="true" />
                    CSV
                </button>

                <div className={styles.resultCount}>
                    {orders.length === 0
                        ? 'No orders'
                        : `${orders.length} orders${voidedCount ? ` · ${voidedCount} voided` : ''}`}
                </div>
            </div>

            {loading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading daily sales…</p>
                </div>
            ) : error ? (
                <div className={styles.stateBlock}>
                    <AlertTriangle size={32} />
                    <p>{error}</p>
                </div>
            ) : orders.length === 0 ? (
                <div className={styles.stateBlock}>
                    <ClipboardList size={32} />
                    <p>No orders on this business day.</p>
                </div>
            ) : (
                <>
                    <div className={styles.statRow}>
                        <StatTile
                            label="Bills"
                            value={sold.length}
                            sub={voidedCount > 0
                                ? `${voidedCount} voided, excluded`
                                : 'No voids'}
                        />
                        <StatTile label="Items" value={sums.items} sub="Units sold" />
                        <StatTile label="Gross" value={`Rs. ${rs(sums.subtotal)}`} sub="Before discount" />
                        <StatTile label="Discounts" value={`Rs. ${rs(sums.discount)}`} sub="Given away" />
                        <StatTile
                            label="Net"
                            value={`Rs. ${rs(sums.subtotal - sums.discount)}`}
                            sub="Gross less discount"
                        />
                        <StatTile label="Tax" value={`Rs. ${rs(sums.tax)}`} sub="Collected for FBR" />
                        <StatTile
                            label="Revenue"
                            value={`Rs. ${rs(sums.total)}`}
                            /* Charges are the gap between net + tax and what was
                               billed, so the tile names them rather than leaving
                               the reader to find a sum that does not add up. */
                            sub={sums.charges > 0
                                ? `Includes Rs. ${rs(sums.charges)} of charges`
                                : 'What the day billed'}
                        />
                    </div>

                    <div className={styles.chartCard}>
                        <div className={styles.chartHead}>
                            <h2 className={styles.chartTitle}>Revenue by order type</h2>
                            <span className={styles.chartNote}>Voids excluded</span>
                        </div>

                        {byType.length === 0 ? (
                            <div className={styles.chartEmpty}>
                                Every bill on this day was voided, so there is no revenue to
                                split across dine-in, takeaway and delivery.
                            </div>
                        ) : (
                            <ResponsiveContainer width="100%" height={byType.length * 40 + 24}>
                                <BarChart
                                    layout="vertical"
                                    data={byType}
                                    margin={{ top: 0, right: 108, left: 0, bottom: 0 }}
                                    barCategoryGap={2}
                                >
                                    {/* No value axis and no gridlines: every bar
                                        carries its own money label, which is the
                                        more direct reading of the same numbers. */}
                                    <XAxis type="number" hide />
                                    <YAxis
                                        type="category"
                                        dataKey="label"
                                        width={84}
                                        tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                                        axisLine={false}
                                        tickLine={false}
                                    />
                                    <Tooltip
                                        cursor={CURSOR_FILL}
                                        content={<TypeTooltip />}
                                    />
                                    <Bar
                                        dataKey="revenue"
                                        fill={SERIES}
                                        radius={[0, 4, 4, 0]}
                                        maxBarSize={22}
                                    >
                                        {/* Two to four bars, so every one is
                                            directly labelled and no legend is
                                            needed — the title names the measure. */}
                                        <LabelList
                                            dataKey="moneyLabel"
                                            position="right"
                                            fill={LABEL_TEXT}
                                            fontSize={12}
                                        />
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        )}
                    </div>

                    <div className={styles.listWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Order #</th>
                                    <th>Time</th>
                                    <th>Invoice #</th>
                                    <th>FBR Inv #</th>
                                    <th>Type</th>
                                    <th>Table</th>
                                    <th>Waiter</th>
                                    <th className={styles.alignRight}>Subtotal</th>
                                    <th className={styles.alignRight}>Discount</th>
                                    <th className={styles.alignRight}>Charges</th>
                                    <th className={styles.alignRight}>Tax</th>
                                    <th className={styles.alignRight}>Total</th>
                                    <th>Payment</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {orders.map((o) => {
                                    const voided = o.status === 'cancelled'
                                    // Struck per cell rather than on the row, so the
                                    // void reason in the status cell stays readable.
                                    const struck = voided ? styles.struck : ''
                                    return (
                                        <tr key={o.id} className={voided ? styles.voidedRow : ''}>
                                            <td className={`${styles.cellStrong} ${struck}`}>#{o.order_number}</td>
                                            <td className={`${styles.cellMuted} ${struck}`}>
                                                {formatClockTime(new Date(o.paid_at || o.created_at))}
                                            </td>
                                            <td className={struck}>{o.invoice_number || '—'}</td>
                                            <td className={`${styles.cellMuted} ${struck}`}>{o.fbr_invoice_number || '—'}</td>
                                            <td className={struck}>{TYPE_LABEL[o.order_type] || o.order_type}</td>
                                            <td className={`${styles.cellMuted} ${struck}`}>{o.table_number || '—'}</td>
                                            <td className={`${styles.cellMuted} ${struck}`}>{o.waiter_name || '—'}</td>
                                            <td className={`${styles.alignRight} ${struck}`}>{rs(o.subtotal)}</td>
                                            <td className={`${styles.alignRight} ${struck}`}>{rs(o.discount)}</td>
                                            <td className={`${styles.alignRight} ${struck}`}>{rs(o.charges_total)}</td>
                                            <td className={`${styles.alignRight} ${struck}`}>{rs(o.tax)}</td>
                                            <td className={`${styles.alignRight} ${styles.cellStrong} ${struck}`}>{rs(o.total)}</td>
                                            <td className={struck}>{paymentLabel(o)}</td>
                                            <td>
                                                <span className={`${styles.statusBadge} ${styles[`status_${o.status}`] || ''}`}>
                                                    {STATUS_LABEL[o.status] || o.status}
                                                </span>
                                                {voided && o.cancel_reason && (
                                                    <div className={styles.voidReason}>{o.cancel_reason}</div>
                                                )}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                            <tfoot>
                                <tr className={styles.tfootRow}>
                                    <td colSpan={7}>
                                        Totals: {orders.length - voidedCount} orders
                                        {voidedCount > 0 && `, ${voidedCount} voided excluded`}
                                    </td>
                                    <td className={styles.alignRight}>{rs(sums.subtotal)}</td>
                                    <td className={styles.alignRight}>{rs(sums.discount)}</td>
                                    <td className={styles.alignRight}>{rs(sums.charges)}</td>
                                    <td className={styles.alignRight}>{rs(sums.tax)}</td>
                                    <td className={styles.alignRight}>{rs(sums.total)}</td>
                                    <td colSpan={2}></td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </>
            )}
        </div>
    )
}

'use client'

import { useState, useEffect } from 'react'
import styles from './hourly.module.css'
import { getHourlySales } from './actions'
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { CalendarRange, Loader2, Clock3, AlertTriangle } from 'lucide-react'

/*
 * Chart ink. These live as literals rather than CSS custom properties because
 * recharts writes them into SVG presentation attributes, where a var() is not
 * reliably resolved. They are the same values as --foreground / --border /
 * --muted-foreground, and #d95926 is the palette slot a single-series chart
 * takes so the data does not read as brand chrome.
 */
const SERIES = '#d95926'
const GRID = '#332c27'
const AXIS_TEXT = '#a39a92'

// Money renders like the orders page: en-PK grouping, no decimals on screen.
const rs = (x) => Math.round(Number(x) || 0).toLocaleString('en-PK')

// Axis money is abbreviated: eight ticks reading "12,500" turn the y-axis into
// a wall of digits, and on an axis the magnitude is the whole point.
const rsAxis = (v) => {
    const n = Math.round(Number(v) || 0)
    const trim = (s) => s.replace(/\.0$/, '')
    if (n < 1000) return `Rs ${n}`
    if (n < 100000) return `Rs ${trim((n / 1000).toFixed(1))}k`
    if (n < 1000000) return `Rs ${Math.round(n / 1000)}k`
    return `Rs ${trim((n / 1000000).toFixed(1))}m`
}

// "6 pm" — the compact form 24 columns need. The app's uppercase clock style
// is for receipts and rows; under every third column it shouts.
const hourTick = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`

// A column is an hour of trade, not an instant — the tooltip says so.
const hourRange = (h) => `${hourTick(h)} – ${hourTick((h + 1) % 24)}`

function HourTooltip({ active, payload }) {
    if (!active || !payload?.length) return null
    const h = payload[0].payload
    return (
        <div className={styles.tooltip}>
            <div className={styles.tooltipHead}>{hourRange(h.hour)}</div>
            <div className={styles.tooltipRow}>
                <span>Revenue</span>
                <span className={styles.tooltipValue}>Rs. {rs(h.revenue)}</span>
            </div>
            <div className={styles.tooltipRow}>
                <span>Bills</span>
                <span className={styles.tooltipValue}>{h.bills}</span>
            </div>
        </div>
    )
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

export default function HourlySalesPage() {
    // '' means "let the server resolve the open business day"; writing the
    // resolved day back into the input must not retrigger the fetch.
    const [pickedDay, setPickedDay] = useState('')
    const [report, setReport] = useState(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        getHourlySales(pickedDay || null).then((res) => {
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

    /*
     * All 24 hours go to the chart, dead ones included: the shape of a service
     * is the answer this report exists to give, and a gap between two rushes is
     * as much a staffing fact as the rushes are. The table below carries only
     * the hours that traded, where a zero row would be a blank line.
     */
    const hours = report?.hours || []
    const totals = report?.totals || { bills: 0, revenue: 0 }
    const tableRows = hours.filter((h) => h.bills > 0)

    const peak = hours.reduce(
        (best, h) => (best === null || h.revenue > best.revenue ? h : best),
        null,
    )
    const busiest = hours.reduce(
        (best, h) => (best === null || h.bills > best.bills ? h : best),
        null,
    )
    const avgBill = totals.bills > 0 ? totals.revenue / totals.bills : 0

    // A day can have bills and no money (everything comped or voided to zero),
    // so the peak tile keys off revenue rather than off the bill count.
    const hasRevenue = peak !== null && peak.revenue > 0

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Hourly Sales</h1>
                    {report && (
                        <span className={styles.dayNote}>Business day {report.businessDate}</span>
                    )}
                </div>
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
            </div>

            {loading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading hourly sales…</p>
                </div>
            ) : error ? (
                <div className={styles.stateBlock}>
                    <AlertTriangle size={32} />
                    <p>{error}</p>
                </div>
            ) : totals.bills === 0 ? (
                <div className={styles.stateBlock}>
                    <Clock3 size={32} />
                    <p>No sales on this business day.</p>
                </div>
            ) : (
                <div className={styles.scroll}>
                    <div className={styles.statRow}>
                        <StatTile
                            label="Peak hour"
                            value={hasRevenue ? hourRange(peak.hour) : '—'}
                            sub={hasRevenue
                                ? `Rs. ${rs(peak.revenue)} · ${peak.bills} ${peak.bills === 1 ? 'bill' : 'bills'}`
                                : 'No revenue taken'}
                        />
                        <StatTile
                            label="Busiest hour"
                            value={busiest && busiest.bills > 0 ? hourRange(busiest.hour) : '—'}
                            sub={busiest && busiest.bills > 0
                                ? `${busiest.bills} ${busiest.bills === 1 ? 'bill' : 'bills'} rung`
                                : 'No bills rung'}
                        />
                        <StatTile label="Revenue" value={`Rs. ${rs(totals.revenue)}`} sub="Voids excluded" />
                        <StatTile
                            label="Average bill"
                            value={`Rs. ${rs(avgBill)}`}
                            sub={`Across ${totals.bills} ${totals.bills === 1 ? 'bill' : 'bills'}`}
                        />
                    </div>

                    {/*
                     * Two panels, not one chart with two axes: bills and rupees
                     * are different scales, and putting them on a shared y makes
                     * the smaller of them a flat line that says nothing. They are
                     * a small multiple instead — same x, same plot width, so a
                     * column lines up with the column above it — and the hour
                     * labels are drawn once, under the pair.
                     */}
                    <div className={styles.chartCard}>
                        <div className={styles.chartHead}>
                            <h2 className={styles.chartTitle}>Revenue by hour</h2>
                            <span className={styles.chartNote}>Asia/Karachi · voids excluded</span>
                        </div>

                        {/* Bills without money — everything comped, say — would
                            draw an axis frame with nothing in it, which reads as
                            a broken chart rather than as a fact. */}
                        {hasRevenue ? (
                            <ResponsiveContainer width="100%" height={260}>
                                <BarChart
                                    data={hours}
                                    margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                                    barCategoryGap={2}
                                >
                                    <CartesianGrid stroke={GRID} vertical={false} />
                                    <XAxis dataKey="hour" hide />
                                    <YAxis
                                        width={64}
                                        tickFormatter={rsAxis}
                                        tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                                        axisLine={false}
                                        tickLine={false}
                                    />
                                    <Tooltip
                                        cursor={{ fill: 'rgba(248, 244, 238, 0.06)' }}
                                        content={<HourTooltip />}
                                    />
                                    <Bar
                                        dataKey="revenue"
                                        fill={SERIES}
                                        radius={[4, 4, 0, 0]}
                                        maxBarSize={22}
                                    />
                                </BarChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className={styles.chartEmpty} style={{ height: 260 }}>
                                Rupees taken in each hour of the day would be plotted here.
                                This day rang {totals.bills} {totals.bills === 1 ? 'bill' : 'bills'} and
                                no revenue.
                            </div>
                        )}

                        <h3 className={styles.smallChartTitle}>Bills per hour</h3>
                        <ResponsiveContainer width="100%" height={110}>
                            <BarChart
                                data={hours}
                                margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
                                barCategoryGap={2}
                            >
                                <CartesianGrid stroke={GRID} vertical={false} />
                                <XAxis
                                    dataKey="hour"
                                    interval={2}
                                    tickFormatter={hourTick}
                                    tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                                    axisLine={false}
                                    tickLine={false}
                                />
                                <YAxis
                                    width={64}
                                    allowDecimals={false}
                                    tickCount={3}
                                    tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                                    axisLine={false}
                                    tickLine={false}
                                />
                                <Tooltip
                                    cursor={{ fill: 'rgba(248, 244, 238, 0.06)' }}
                                    content={<HourTooltip />}
                                />
                                <Bar
                                    dataKey="bills"
                                    fill={SERIES}
                                    radius={[4, 4, 0, 0]}
                                    maxBarSize={22}
                                />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>

                    <div className={styles.tableCard}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Hour</th>
                                    <th className={styles.alignRight}>Bills</th>
                                    <th className={styles.alignRight}>Revenue</th>
                                    <th className={styles.alignRight}>Average bill</th>
                                    <th className={styles.alignRight}>Share of day</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tableRows.map((h) => (
                                    <tr key={h.hour}>
                                        <td className={styles.cellStrong}>{hourRange(h.hour)}</td>
                                        <td className={styles.alignRight}>{h.bills}</td>
                                        <td className={`${styles.alignRight} ${styles.cellStrong}`}>
                                            {rs(h.revenue)}
                                        </td>
                                        <td className={`${styles.alignRight} ${styles.cellMuted}`}>
                                            {rs(h.revenue / h.bills)}
                                        </td>
                                        <td className={`${styles.alignRight} ${styles.cellMuted}`}>
                                            {totals.revenue > 0
                                                ? `${Math.round((h.revenue / totals.revenue) * 100)}%`
                                                : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className={styles.tfootRow}>
                                    <td>
                                        Totals — {tableRows.length} trading{' '}
                                        {tableRows.length === 1 ? 'hour' : 'hours'}
                                    </td>
                                    <td className={styles.alignRight}>{totals.bills}</td>
                                    <td className={styles.alignRight}>{rs(totals.revenue)}</td>
                                    <td className={styles.alignRight}>{rs(avgBill)}</td>
                                    <td className={styles.alignRight}>100%</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}
        </div>
    )
}

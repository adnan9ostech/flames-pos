'use client'

import { useState, useEffect } from 'react'
import styles from './hourly.module.css'
import { getHourlySales } from './actions'
import { CalendarRange, Loader2, Clock3, AlertTriangle } from 'lucide-react'

// Money renders like the orders page: en-PK grouping, no decimals on screen.
const rs = (x) => Math.round(Number(x) || 0).toLocaleString('en-PK')

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
     * Trimmed to the trading part of the day, zeros inside the window kept: a
     * dead 2 PM between two busy services is information, sixteen empty
     * overnight rows are not. Same call the dashboard already made.
     */
    const busy = (report?.hours || []).filter((h) => h.bills > 0)
    const rows = busy.length
        ? report.hours.slice(
            Math.min(...busy.map((h) => h.hour)),
            Math.max(...busy.map((h) => h.hour)) + 1,
        )
        : []
    const maxRevenue = Math.max(...rows.map((h) => h.revenue), 1)

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

                {report && (
                    <div className={styles.resultCount}>
                        {report.totals.bills} bills · Rs. {rs(report.totals.revenue)}
                    </div>
                )}
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
            ) : rows.length === 0 ? (
                <div className={styles.stateBlock}>
                    <Clock3 size={32} />
                    <p>No sales on this business day.</p>
                </div>
            ) : (
                /*
                 * Plain CSS divs rather than recharts (which the dashboard uses):
                 * a single-series 24-row list needs no axes, tooltips or resize
                 * plumbing — the numbers sit right on each row, which a chart
                 * would hide behind hover. Divs also print cleanly and follow
                 * the app's color tokens for free.
                 */
                <div className={styles.card}>
                    <div className={styles.barList}>
                        {rows.map((h) => (
                            <div key={h.hour} className={`${styles.barRow} ${h.bills === 0 ? styles.quietRow : ''}`}>
                                <div className={styles.barLabel}>{h.label}</div>
                                <div className={styles.barTrack}>
                                    <div
                                        className={styles.barFill}
                                        style={{ width: `${(h.revenue / maxRevenue) * 100}%` }}
                                    />
                                </div>
                                <div className={styles.barMeta}>
                                    <span className={styles.barRevenue}>Rs. {rs(h.revenue)}</span>
                                    <span className={styles.barBills}>
                                        {h.bills} {h.bills === 1 ? 'bill' : 'bills'}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className={styles.totalsRow}>
                        <span>Total</span>
                        <span className={styles.totalsMoney}>
                            Rs. {rs(report.totals.revenue)}
                            <span className={styles.barBills}>{report.totals.bills} bills</span>
                        </span>
                    </div>
                </div>
            )}
        </div>
    )
}

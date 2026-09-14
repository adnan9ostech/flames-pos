'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import styles from './reports.module.css'
import { getInventoryReports, getItemLedger } from './actions'
import { formatDateTime, formatWeekdayDate } from '@/lib/timeFormat'
import {
    Boxes, History, Scale, TrendingDown, CalendarClock,
    AlertTriangle, Loader2, ChevronLeft, PackageSearch,
} from 'lucide-react'

const TABS = [
    { key: 'stock', label: 'Current Stock', Icon: Boxes },
    { key: 'ledger', label: 'Item Ledger', Icon: History },
    { key: 'variance', label: 'Variance', Icon: Scale },
    { key: 'depleting', label: 'Depleting', Icon: TrendingDown },
    { key: 'forecast', label: 'Forecast', Icon: CalendarClock },
]

const rupees = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
const qtyFmt = (n) => Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 3 })
const signedQty = (n) => (Number(n) > 0 ? `+${qtyFmt(n)}` : qtyFmt(n))

// business_date arrives as 'YYYY-MM-DD'; parsed at local midnight so the
// label can't slip a day on a machine set away from PKT.
const dayLabel = (d) => (d ? formatWeekdayDate(new Date(`${d}T00:00:00`)) : '—')

const SOURCE_LABEL = {
    receiving: 'Receiving', transfer: 'Transfer', adjustment: 'Adjustment',
    count: 'Count', misc: 'Misc use', sale: 'Sale', void: 'Void',
}

// Sale rows reference an order UUID; a doc reference still has to fit its column.
const sourceDoc = (r) => {
    const ref = String(r.source_id)
    const short = ref.length > 10 ? `${ref.slice(0, 8)}…` : ref
    return `${SOURCE_LABEL[r.source_type] || r.source_type} #${short}`
}

export default function InventoryReportsPage() {
    const [tab, setTab] = useState('stock')
    const [data, setData] = useState(null)
    const [loadError, setLoadError] = useState('')

    // Item Ledger is the one on-demand tab: its history can be long, so it
    // is fetched per item rather than riding along with everything else.
    const [ledgerItemId, setLedgerItemId] = useState('')
    const [ledger, setLedger] = useState(null)
    const [ledgerBusy, setLedgerBusy] = useState(false)
    const [ledgerError, setLedgerError] = useState('')

    // Forecast horizon, kept as the raw input string so half-typed numbers
    // aren't normalised under the cursor.
    const [coverDays, setCoverDays] = useState('7')

    useEffect(() => {
        getInventoryReports().then((res) => {
            if (res.error) setLoadError(res.error)
            else setData(res.data)
        })
    }, [])

    useEffect(() => {
        if (!ledgerItemId) return
        let stale = false
        setLedgerBusy(true)
        setLedgerError('')
        getItemLedger(Number(ledgerItemId)).then((res) => {
            if (stale) return
            if (res.error) {
                setLedgerError(res.error)
                setLedger(null)
            } else {
                setLedger(res.data)
            }
            setLedgerBusy(false)
        })
        return () => { stale = true }
    }, [ledgerItemId])

    // The reorder flag reads the item's TOTAL across warehouses — a shortage
    // is a purchasing fact, not a per-warehouse one.
    const itemTotals = useMemo(() => {
        const totals = new Map()
        for (const r of data?.stock ?? []) {
            totals.set(r.item_id, (totals.get(r.item_id) || 0) + Number(r.qty))
        }
        return totals
    }, [data])

    const stockValue = useMemo(
        () => (data?.stock ?? []).reduce((sum, r) => sum + Number(r.qty) * Number(r.avg_cost), 0),
        [data],
    )

    const consumption = useMemo(() => {
        if (!data) return []
        return data.consumption.map((r) => ({
            ...r,
            avgDaily: Number(r.consumed) / data.window.days,
        }))
    }, [data])

    const depleting = useMemo(
        () => consumption.filter(
            (r) => Number(r.reorder_level) > 0 && Number(r.current_qty) <= Number(r.reorder_level),
        ),
        [consumption],
    )

    const horizon = Math.min(60, Math.max(1, Number(coverDays) || 7))

    // Suggested order = what the horizon will consume, less what's on the
    // shelf. Sorted by the rupee value of the suggestion — quantities mix
    // units (kg against pieces), money doesn't — so the biggest buy leads.
    const forecast = useMemo(() => (
        consumption
            .map((r) => {
                const need = r.avgDaily * horizon
                const suggested = Math.max(0, need - Number(r.current_qty))
                return { ...r, need, suggested, suggestedValue: suggested * Number(r.avg_cost) }
            })
            .sort((a, b) => (b.suggestedValue - a.suggestedValue) || a.name.localeCompare(b.name))
    ), [consumption, horizon])

    if (loadError) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.errorNote}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {loadError}
                </div>
            </div>
        )
    }

    if (!data) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Reading the ledger…</p>
                </div>
            </div>
        )
    }

    const empty = (text) => (
        <div className={styles.stateBlock}>
            <PackageSearch size={32} />
            <p>{text}</p>
        </div>
    )

    /* ===== Current Stock ===== */

    const renderStock = () => {
        if (data.stock.length === 0) return empty('No stock movements yet. The report starts at the first receiving.')
        const seen = new Set()
        return (
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Warehouse</th>
                        <th className={styles.alignRight}>On hand</th>
                        <th className={styles.alignRight}>Avg cost</th>
                        <th className={styles.alignRight}>Value</th>
                    </tr>
                </thead>
                <tbody>
                    {data.stock.map((r) => {
                        const first = !seen.has(r.item_id)
                        seen.add(r.item_id)
                        const total = itemTotals.get(r.item_id) ?? 0
                        const low = Number(r.reorder_level) > 0 && total <= Number(r.reorder_level)
                        return (
                            <tr key={`${r.item_id}-${r.warehouse_id}`}>
                                <td className={styles.cellStrong}>
                                    {first ? r.name : <span className={styles.cellFaint}>{r.name}</span>}
                                    {first && low && (
                                        <span className={styles.lowChip}>
                                            <AlertTriangle size={11} aria-hidden="true" />
                                            low
                                        </span>
                                    )}
                                </td>
                                <td className={styles.cellMuted}>{r.warehouse_name}</td>
                                <td className={`${styles.alignRight} ${styles.num}`}>
                                    {qtyFmt(r.qty)} {r.unit_abbrev}
                                </td>
                                <td className={`${styles.alignRight} ${styles.num}`}>{rupees(r.avg_cost)}</td>
                                <td className={`${styles.alignRight} ${styles.num}`}>
                                    {rupees(Number(r.qty) * Number(r.avg_cost))}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        )
    }

    /* ===== Item Ledger ===== */

    const renderLedger = () => {
        if (ledgerError) {
            return (
                <div className={styles.errorNote}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {ledgerError}
                </div>
            )
        }
        if (!ledgerItemId) return empty('Pick an item to trace its movements.')
        if (ledgerBusy && !ledger) {
            return (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Tracing movements…</p>
                </div>
            )
        }
        if (!ledger) return null
        if (ledger.rows.length === 0) return empty('This item has never moved.')
        return (
            <>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>When</th>
                            <th>Document</th>
                            <th>Warehouse</th>
                            <th className={styles.alignRight}>Qty</th>
                            <th className={styles.alignRight}>Unit cost</th>
                            <th className={styles.alignRight}>Balance</th>
                        </tr>
                    </thead>
                    <tbody>
                        {ledger.rows.map((r) => (
                            <tr key={r.id}>
                                <td className={styles.cellMuted}>{formatDateTime(new Date(r.at))}</td>
                                <td className={styles.cellStrong}>{sourceDoc(r)}</td>
                                <td className={styles.cellMuted}>{r.warehouse_name}</td>
                                <td className={`${styles.alignRight} ${styles.num} ${Number(r.delta) >= 0 ? styles.posDelta : styles.negDelta}`}>
                                    {signedQty(r.delta)} {ledger.item.unit_abbrev}
                                </td>
                                <td className={`${styles.alignRight} ${styles.num}`}>
                                    {r.unit_cost === null ? '—' : rupees(r.unit_cost)}
                                </td>
                                <td className={`${styles.alignRight} ${styles.num}`}>
                                    {qtyFmt(r.running)} {ledger.item.unit_abbrev}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {ledger.truncated && (
                    <p className={styles.truncNote}>
                        Showing the newest {ledger.rows.length} movements; older history is in the ledger, not on this screen.
                    </p>
                )}
            </>
        )
    }

    /* ===== Variance ===== */

    const renderVariance = () => {
        if (data.variance.length === 0) return empty('No stock counts posted yet.')
        return (
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>Count</th>
                        <th>Item</th>
                        <th className={styles.alignRight}>Counted</th>
                        <th className={styles.alignRight}>System at count</th>
                        <th className={styles.alignRight}>Variance</th>
                        <th className={styles.alignRight}>Value</th>
                    </tr>
                </thead>
                <tbody>
                    {data.variance.map((r) => {
                        const variance = Number(r.variance_qty)
                        // The count row was written as counted − system, so
                        // system-at-count falls straight out of the ledger.
                        const system = Number(r.counted) - variance
                        // Valued at today's average cost — the honest
                        // approximation until costs are snapshotted per count.
                        const value = variance * Number(r.avg_cost)
                        return (
                            <tr key={`${r.doc_id}-${r.item_id}`}>
                                <td>
                                    <span className={styles.cellStrong}>#{r.doc_id}</span>
                                    <span className={styles.cellSub}>
                                        {dayLabel(r.business_date)} · {r.warehouse_name}
                                        {r.reason ? ` · ${r.reason}` : ''}
                                    </span>
                                </td>
                                <td className={styles.cellStrong}>{r.item_name}</td>
                                <td className={`${styles.alignRight} ${styles.num}`}>
                                    {qtyFmt(r.counted)} {r.unit_abbrev}
                                </td>
                                <td className={`${styles.alignRight} ${styles.num}`}>
                                    {qtyFmt(system)} {r.unit_abbrev}
                                </td>
                                <td className={`${styles.alignRight} ${styles.num} ${variance > 0 ? styles.posDelta : variance < 0 ? styles.negDelta : ''}`}>
                                    {variance === 0 ? '—' : `${signedQty(variance)} ${r.unit_abbrev}`}
                                </td>
                                <td className={`${styles.alignRight} ${styles.num} ${variance > 0 ? styles.posDelta : variance < 0 ? styles.negDelta : ''}`}>
                                    {variance === 0 ? '—' : rupees(value)}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        )
    }

    /* ===== Depleting ===== */

    const daysOfStock = (r) => {
        if (r.avgDaily <= 0) return '∞'
        if (Number(r.current_qty) <= 0) return '0'
        return (Number(r.current_qty) / r.avgDaily).toFixed(1)
    }

    const renderDepleting = () => {
        if (depleting.length === 0) return empty('Nothing at or below its reorder level.')
        return (
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>Item</th>
                        <th className={styles.alignRight}>On hand</th>
                        <th className={styles.alignRight}>Reorder at</th>
                        <th className={styles.alignRight}>Avg daily use</th>
                        <th className={styles.alignRight}>Days of stock</th>
                    </tr>
                </thead>
                <tbody>
                    {depleting.map((r) => (
                        <tr key={r.id}>
                            <td className={styles.cellStrong}>{r.name}</td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {qtyFmt(r.current_qty)} {r.unit_abbrev}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {qtyFmt(r.reorder_level)} {r.unit_abbrev}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {r.avgDaily > 0 ? `${qtyFmt(r.avgDaily)} ${r.unit_abbrev}` : '—'}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>{daysOfStock(r)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )
    }

    /* ===== Procurement Forecast ===== */

    const renderForecast = () => {
        if (consumption.length === 0) return empty('No active stock items yet.')
        return (
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>Item</th>
                        <th className={styles.alignRight}>Avg daily use</th>
                        <th className={styles.alignRight}>On hand</th>
                        <th className={styles.alignRight}>{horizon}-day need</th>
                        <th className={styles.alignRight}>Suggested order</th>
                        <th className={styles.alignRight}>Est. cost</th>
                    </tr>
                </thead>
                <tbody>
                    {forecast.map((r) => (
                        <tr key={r.id}>
                            <td className={styles.cellStrong}>{r.name}</td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {r.avgDaily > 0 ? `${qtyFmt(r.avgDaily)} ${r.unit_abbrev}` : '—'}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {qtyFmt(r.current_qty)} {r.unit_abbrev}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {r.need > 0 ? `${qtyFmt(r.need)} ${r.unit_abbrev}` : '—'}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num} ${r.suggested > 0 ? styles.cellStrong : ''}`}>
                                {r.suggested > 0 ? `${qtyFmt(r.suggested)} ${r.unit_abbrev}` : '—'}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {r.suggested > 0 ? rupees(r.suggestedValue) : '—'}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )
    }

    return (
        <div className={styles.container}>
            <PageHeader />

            <div className={styles.toolbar}>
                <div className={styles.tabs}>
                    {TABS.map(({ key, label, Icon }) => (
                        <button
                            key={key}
                            type="button"
                            className={`${styles.tab} ${tab === key ? styles.activeTab : ''}`}
                            onClick={() => setTab(key)}
                        >
                            <Icon size={15} aria-hidden="true" />
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'ledger' && (
                    <label className={styles.control}>
                        <select
                            className={styles.inputSelect}
                            value={ledgerItemId}
                            onChange={(e) => setLedgerItemId(e.target.value)}
                            aria-label="Item to trace"
                        >
                            <option value="" disabled>Pick an item…</option>
                            {data.items.map((i) => (
                                <option key={i.id} value={i.id}>{i.name} ({i.unit_abbrev})</option>
                            ))}
                        </select>
                        {ledgerBusy && <Loader2 className={styles.inlineSpinner} size={14} />}
                    </label>
                )}

                {tab === 'forecast' && (
                    <label className={styles.control}>
                        <span className={styles.controlLabel}>Cover</span>
                        <input
                            type="number"
                            className={styles.numInput}
                            min="1"
                            max="60"
                            inputMode="numeric"
                            value={coverDays}
                            onChange={(e) => setCoverDays(e.target.value)}
                            aria-label="Days of cover to order for"
                        />
                        <span className={styles.controlLabel}>days</span>
                    </label>
                )}

                <span className={styles.rangeNote}>
                    {tab === 'stock' && `As of ${data.asOf} · stock value ${rupees(stockValue)}`}
                    {(tab === 'depleting' || tab === 'forecast') &&
                        `Consumption averaged over the last ${data.window.days} days (${data.window.from} → ${data.asOf})`}
                    {tab === 'variance' && 'Posted counts, newest first'}
                </span>
            </div>

            <div className={styles.tableWrap}>
                {tab === 'stock' && renderStock()}
                {tab === 'ledger' && renderLedger()}
                {tab === 'variance' && renderVariance()}
                {tab === 'depleting' && renderDepleting()}
                {tab === 'forecast' && renderForecast()}
            </div>
        </div>
    )
}

function PageHeader() {
    return (
        <div className={styles.header}>
            <div>
                <Link href="/inventory" className={styles.backLink}>
                    <ChevronLeft size={15} aria-hidden="true" />
                    Inventory
                </Link>
                <h1 className={styles.title}>Stock Reports</h1>
                <p className={styles.subtitle}>
                    What&apos;s on hand, how it moved, where counts disagreed, and what to buy next.
                </p>
            </div>
        </div>
    )
}

'use client'

import { useState, useEffect } from 'react'
import styles from './item-wise.module.css'
import { getItemWiseSales } from './actions'
import { formatDateTime } from '@/lib/timeFormat'
import {
    CalendarRange, FileDown, Printer, Loader2, UtensilsCrossed,
    AlertTriangle, ChevronRight, ChevronDown
} from 'lucide-react'

// Money renders like the orders page: en-PK grouping, no decimals on screen.
const rs = (x) => Math.round(Number(x) || 0).toLocaleString('en-PK')

const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

// Variant rows earn their place only when they say something: a single
// nameless variant is just the item again.
const hasVariants = (item) =>
    item.variants.length > 1 || (item.variants[0] && item.variants[0].name)

/*
 * printReceipt.js's measured-@page technique, restated here rather than
 * imported: that module is the receipt's printer and this is the report's,
 * but the mechanism is identical because the reason is — Chrome has no
 * working "80mm by as-long-as-it-takes" page size, so the rendered strip is
 * measured and exactly that height is requested. See printReceipt.js for the
 * full account of why the obvious CSS declarations all fail.
 *
 * The strip mounts under id="receipt-print-root" deliberately: that id is
 * what the global print stylesheet keys on to blank the app and surface one
 * 80mm subtree, so reusing it buys all of that machinery unchanged.
 */
const PX_PER_MM = 96 / 25.4
const TAIL_MM = 6
const FALLBACK_HEIGHT_MM = 297
const STYLE_ID = 'itemwise-page-size'

const printThermal = () => {
    if (typeof window === 'undefined') return
    try {
        const root = document.getElementById('receipt-print-root')
        const heightMm = root?.scrollHeight
            ? Math.ceil(root.scrollHeight / PX_PER_MM) + TAIL_MM
            : FALLBACK_HEIGHT_MM

        let style = document.getElementById(STYLE_ID)
        if (!style) {
            style = document.createElement('style')
            style.id = STYLE_ID
            document.head.appendChild(style)
        }
        style.textContent = `@page { size: 80mm ${heightMm}mm; margin: 0; }`

        window.print()

        // window.print() blocks until the dialog closes; removing the rule now
        // keeps later prints from any screen off the 80mm roll size.
        style.remove()
    } catch (error) {
        console.error('Could not print the item-wise summary', error)
    }
}

export default function ItemWiseSalesPage() {
    // '' means "let the server default to the open business day"; the resolved
    // range is echoed back in the response and shown in the inputs.
    const [fromPick, setFromPick] = useState('')
    const [toPick, setToPick] = useState('')
    const [report, setReport] = useState(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)
    const [expanded, setExpanded] = useState(() => new Set())
    const [printOpen, setPrintOpen] = useState(false)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        getItemWiseSales(fromPick || null, toPick || null).then((res) => {
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
    }, [fromPick, toPick])

    const toggleCategory = (name) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(name)) next.delete(name)
            else next.add(name)
            return next
        })
    }

    const categories = report?.categories || []
    const grand = report?.grand
    const rangeLabel = report
        ? (report.from === report.to ? report.from : `${report.from} to ${report.to}`)
        : ''

    /*
     * The rollup and the orders table describe the same money from two sides;
     * when they disagree (an order whose stored subtotal no longer matches its
     * lines) the difference is worth a flag, not a silent absorb.
     */
    const grossDelta = report ? Math.round(report.grand.gross - report.orders.subtotal) : 0

    const exportCsv = () => {
        if (!report) return
        const rows = [['Category', 'Item', 'Variant', 'Qty', 'Gross', 'Discount', 'Net']]
        for (const cat of categories) {
            for (const item of cat.items) {
                for (const v of item.variants) {
                    rows.push([
                        cat.name, item.name, v.name || '', v.qty,
                        v.gross.toFixed(2), v.discount.toFixed(2), v.net.toFixed(2),
                    ])
                }
            }
        }
        rows.push([
            'GRAND TOTAL', '', '', grand.qty,
            grand.gross.toFixed(2), grand.discount.toFixed(2), grand.net.toFixed(2),
        ])
        const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')

        // Built and downloaded entirely client-side; no round trip, no deps.
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `item-wise-${report.from}-to-${report.to}.csv`
        a.click()
        URL.revokeObjectURL(url)
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Item-Wise Sales</h1>
                    {report && <span className={styles.dayNote}>{rangeLabel}</span>}
                </div>
            </div>

            <div className={styles.toolbar}>
                <label className={styles.control}>
                    <CalendarRange size={14} aria-hidden="true" />
                    <input
                        type="date"
                        className={styles.dateInput}
                        value={fromPick || report?.from || ''}
                        max={toPick || undefined}
                        onChange={(e) => setFromPick(e.target.value)}
                        aria-label="From date"
                    />
                </label>
                <span className={styles.dateSep}>to</span>
                <label className={styles.control}>
                    <input
                        type="date"
                        className={styles.dateInput}
                        value={toPick || report?.to || ''}
                        min={fromPick || undefined}
                        onChange={(e) => setToPick(e.target.value)}
                        aria-label="To date"
                    />
                </label>

                <button
                    type="button"
                    className={styles.toolBtn}
                    onClick={exportCsv}
                    disabled={loading || categories.length === 0}
                >
                    <FileDown size={14} aria-hidden="true" />
                    CSV
                </button>

                <button
                    type="button"
                    className={styles.toolBtn}
                    onClick={() => setPrintOpen(true)}
                    disabled={loading || categories.length === 0}
                >
                    <Printer size={14} aria-hidden="true" />
                    Thermal Print
                </button>

                {report && (
                    <div className={styles.resultCount}>
                        {report.orders.count} orders · {grand.qty} items
                    </div>
                )}
            </div>

            {loading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading item-wise sales…</p>
                </div>
            ) : error ? (
                <div className={styles.stateBlock}>
                    <AlertTriangle size={32} />
                    <p>{error}</p>
                </div>
            ) : categories.length === 0 ? (
                <div className={styles.stateBlock}>
                    <UtensilsCrossed size={32} />
                    <p>No items sold in this range.</p>
                </div>
            ) : (
                <div className={styles.listWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Category / Item</th>
                                <th className={styles.alignRight}>Qty</th>
                                <th className={styles.alignRight}>Gross</th>
                                <th className={styles.alignRight}>Discount</th>
                                <th className={styles.alignRight}>Net</th>
                            </tr>
                        </thead>
                        <tbody>
                            {categories.map((cat) => {
                                const open = expanded.has(cat.name)
                                return [
                                    <tr
                                        key={cat.name}
                                        className={styles.catRow}
                                        onClick={() => toggleCategory(cat.name)}
                                    >
                                        <td className={styles.catCell}>
                                            {open
                                                ? <ChevronDown size={15} aria-hidden="true" />
                                                : <ChevronRight size={15} aria-hidden="true" />}
                                            {cat.name}
                                            <span className={styles.itemCount}>
                                                {cat.items.length} {cat.items.length === 1 ? 'item' : 'items'}
                                            </span>
                                        </td>
                                        <td className={styles.alignRight}>{cat.qty}</td>
                                        <td className={styles.alignRight}>{rs(cat.gross)}</td>
                                        <td className={styles.alignRight}>{rs(cat.discount)}</td>
                                        <td className={`${styles.alignRight} ${styles.cellStrong}`}>{rs(cat.net)}</td>
                                    </tr>,
                                    ...(open
                                        ? cat.items.flatMap((item) => [
                                            <tr key={`${cat.name}:${item.name}`}>
                                                <td className={styles.itemCell}>{item.name}</td>
                                                <td className={styles.alignRight}>{item.qty}</td>
                                                <td className={styles.alignRight}>{rs(item.gross)}</td>
                                                <td className={styles.alignRight}>{rs(item.discount)}</td>
                                                <td className={styles.alignRight}>{rs(item.net)}</td>
                                            </tr>,
                                            ...(hasVariants(item)
                                                ? item.variants.map((v) => (
                                                    <tr
                                                        key={`${cat.name}:${item.name}:${v.name || 'std'}`}
                                                        className={styles.variantRow}
                                                    >
                                                        <td className={styles.variantCell}>{v.name || '—'}</td>
                                                        <td className={styles.alignRight}>{v.qty}</td>
                                                        <td className={styles.alignRight}>{rs(v.gross)}</td>
                                                        <td className={styles.alignRight}>{rs(v.discount)}</td>
                                                        <td className={styles.alignRight}>{rs(v.net)}</td>
                                                    </tr>
                                                ))
                                                : []),
                                        ])
                                        : []),
                                ]
                            })}
                        </tbody>
                        <tfoot>
                            <tr className={styles.tfootRow}>
                                <td>Grand total</td>
                                <td className={styles.alignRight}>{grand.qty}</td>
                                <td className={styles.alignRight}>{rs(grand.gross)}</td>
                                <td className={styles.alignRight}>{rs(grand.discount)}</td>
                                <td className={styles.alignRight}>{rs(grand.net)}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}

            {!loading && !error && report && (
                <p className={styles.reconcile}>
                    Reconciles to {report.orders.count} orders — subtotal Rs. {rs(report.orders.subtotal)},
                    discounts Rs. {rs(report.orders.discount)}.
                    {grossDelta !== 0 && (
                        <span className={styles.reconcileWarn}>
                            {' '}Item lines differ from order subtotals by Rs. {rs(Math.abs(grossDelta))}.
                        </span>
                    )}
                </p>
            )}

            {/* 80mm summary. The preview is the printable width exactly — the
                measurement that sizes the page is of this very strip. */}
            {printOpen && report && (
                <div className={styles.overlay} onClick={() => setPrintOpen(false)}>
                    <div className={styles.printModal} onClick={(e) => e.stopPropagation()}>
                        <div id="receipt-print-root" className={styles.receipt}>
                            <div className={styles.rHeader}>
                                <h2>FLAMES BY THE INDUS</h2>
                                <p>Item-Wise Sales Summary</p>
                                <p>{rangeLabel}</p>
                                <p>Printed {formatDateTime(new Date())}</p>
                            </div>
                            <div className={styles.rRule} />
                            {categories.map((cat) => (
                                <div key={cat.name} className={styles.rCat}>
                                    <div className={styles.rCatHead}>
                                        <span>{cat.name}</span>
                                        <span>{rs(cat.net)}</span>
                                    </div>
                                    {cat.items.map((item) => (
                                        <div key={item.name}>
                                            <div className={styles.rLine}>
                                                <span>{item.qty} x {item.name}</span>
                                                <span>{rs(item.net)}</span>
                                            </div>
                                            {hasVariants(item) && item.variants.map((v) => (
                                                <div key={v.name || 'std'} className={styles.rVariant}>
                                                    <span>{v.qty} x {v.name || '—'}</span>
                                                    <span>{rs(v.net)}</span>
                                                </div>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            ))}
                            <div className={styles.rRule} />
                            <div className={styles.rLine}>
                                <span>Items sold</span><span>{grand.qty}</span>
                            </div>
                            <div className={styles.rLine}>
                                <span>Gross</span><span>Rs. {rs(grand.gross)}</span>
                            </div>
                            <div className={styles.rLine}>
                                <span>Discounts</span><span>- Rs. {rs(grand.discount)}</span>
                            </div>
                            <div className={styles.rTotal}>
                                <span>Net sales</span><span>Rs. {rs(grand.net)}</span>
                            </div>
                        </div>

                        <div className={styles.printActions}>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setPrintOpen(false)}
                            >
                                Close
                            </button>
                            <button type="button" className={styles.primaryBtn} onClick={printThermal}>
                                <Printer size={14} aria-hidden="true" />
                                Print
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

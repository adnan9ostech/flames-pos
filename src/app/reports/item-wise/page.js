'use client'

import { useState, useEffect, useMemo } from 'react'
import styles from './item-wise.module.css'
import { getItemWiseSales } from './actions'
import { formatDateTime } from '@/lib/timeFormat'
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LabelList, ResponsiveContainer,
} from 'recharts'
import {
    CalendarRange, FileDown, Printer, Loader2, UtensilsCrossed,
    AlertTriangle, ChevronRight, ChevronDown
} from 'lucide-react'

// Money renders like the orders page: en-PK grouping, no decimals on screen.
const rs = (x) => Math.round(Number(x) || 0).toLocaleString('en-PK')

const TOP_N = 10

/*
 * Slot 2 of the app's validated categorical palette rather than the brand
 * orange: --primary is chrome (buttons, active tabs), and data painted in it
 * reads as another control.
 */
const SERIES = '#d95926'

// Bar ends and the money axis are abbreviated so ten of them fit; the exact
// rupee figure lives in the tooltip.
const rsShort = (x) => {
    const n = Math.round(Number(x) || 0)
    const abs = Math.abs(n)
    // 999_500 rather than a million: anything that would print as "Rs 1000k"
    // belongs in the next unit up.
    if (abs >= 999_500) return `Rs ${Number((n / 1_000_000).toFixed(2))}M`
    if (abs < 1000) return `Rs ${n.toLocaleString('en-PK')}`
    const k = n / 1000
    return `Rs ${abs >= 100_000 ? Math.round(k) : Number(k.toFixed(1))}k`
}

// A dish name has to survive a 150px axis gutter; the tooltip carries it whole.
const TICK_MAX = 22
const shortName = (s) => (String(s).length > TICK_MAX ? `${String(s).slice(0, TICK_MAX - 1)}…` : String(s))

/*
 * A category axis is keyed by the label, so two rows sharing one — the same
 * dish sold under two categories — would land on the same band and one bar
 * would sit on top of the other. Clashes take their category as a suffix;
 * anything still identical after that gets trailing space, which the axis
 * doesn't show but the scale counts.
 */
const dedupeNames = (list, suffixOf) => {
    const counts = new Map()
    for (const r of list) counts.set(r.name, (counts.get(r.name) || 0) + 1)
    const used = new Set()
    return list.map((r) => {
        let name = r.name
        if (counts.get(name) > 1) {
            const suffix = suffixOf(r)
            if (suffix) name = `${name} · ${suffix}`
        }
        while (used.has(name)) name += ' '
        used.add(name)
        return name === r.name ? r : { ...r, name }
    })
}

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

/*
 * Recharts' default tooltip can only list the plotted series; this one names
 * the item, says which category it came from, and shows the qty and both
 * money figures — the context the single bar can't carry.
 */
function ItemTooltip({ active, payload }) {
    if (!active || !payload || payload.length === 0) return null
    const d = payload[0].payload
    return (
        <div className={styles.tip}>
            <p className={styles.tipName}>{d.name}</p>
            <p className={styles.tipSub}>{d.category}</p>
            <p className={styles.tipRow}><span>Qty</span><span>{d.qty.toLocaleString('en-PK')}</span></p>
            <p className={styles.tipRow}><span>Gross</span><span>Rs. {rs(d.gross)}</span></p>
            <p className={styles.tipRow}><span>Discount</span><span>Rs. {rs(d.discount)}</span></p>
            <p className={styles.tipRow}><span>Net</span><span>Rs. {rs(d.net)}</span></p>
        </div>
    )
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

    // Memoised only so the empty-state `[]` keeps its identity between
    // renders; the chart's rollup below hangs off it.
    const categories = useMemo(() => report?.categories || [], [report])
    const grand = report?.grand
    const rangeLabel = report
        ? (report.from === report.to ? report.from : `${report.from} to ${report.to}`)
        : ''

    /*
     * The table is a tree; the chart is the same money flattened. Ranked by
     * net — what the range actually earned after the prorated discount — and
     * the heading says so, because gross and net can order differently.
     */
    const allItems = useMemo(() => {
        const flat = []
        for (const cat of categories) {
            for (const item of cat.items) {
                flat.push({
                    name: item.name,
                    category: cat.name,
                    qty: item.qty,
                    gross: item.gross,
                    discount: item.discount,
                    net: item.net,
                })
            }
        }
        return flat.sort((a, b) => b.net - a.net)
    }, [categories])

    // Descending, so the longest bar sits at the top: recharts draws data[0]
    // first on a vertical-layout category axis.
    const chartRows = useMemo(
        () => dedupeNames(allItems.slice(0, TOP_N), (r) => r.category),
        [allItems],
    )
    const rankLabel = allItems.length > TOP_N
        ? `Top ${TOP_N} of ${allItems.length}`
        : `All ${allItems.length} ${allItems.length === 1 ? 'item' : 'items'}`
    // Explicit height: ResponsiveContainer collapses to nothing inside an
    // auto-height parent, and a row-count-driven height keeps three bars from
    // ballooning into three slabs.
    const chartHeight = Math.max(150, chartRows.length * 26 + 34)

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

            {!loading && !error && report && (
                <>
                    <div className={styles.statRow}>
                        <div className={styles.statTile}>
                            <span className={styles.statLabel}>Items sold</span>
                            <span className={styles.statValue}>{grand.qty.toLocaleString('en-PK')}</span>
                        </div>
                        <div className={styles.statTile}>
                            <span className={styles.statLabel}>Gross</span>
                            <span className={styles.statValue}>Rs. {rs(grand.gross)}</span>
                        </div>
                        <div className={styles.statTile}>
                            <span className={styles.statLabel}>Discount</span>
                            <span className={styles.statValue}>Rs. {rs(grand.discount)}</span>
                        </div>
                        <div className={styles.statTile}>
                            <span className={styles.statLabel}>Net</span>
                            <span className={`${styles.statValue} ${styles.statStrong}`}>Rs. {rs(grand.net)}</span>
                        </div>
                    </div>

                    <section className={styles.chartCard}>
                        <div className={styles.chartHead}>
                            <h2 className={styles.chartTitle}>Top items by net sales</h2>
                            {allItems.length > 0 && (
                                <span className={styles.chartMeta}>{rankLabel}</span>
                            )}
                        </div>

                        {chartRows.length === 0 ? (
                            /* A bordered placeholder rather than an empty axis frame:
                               it says what would be here, not that the chart broke. */
                            <div className={styles.chartEmpty}>
                                The best-selling items of the range will be ranked here once it has sales.
                            </div>
                        ) : (
                            <div style={{ height: chartHeight }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart
                                        layout="vertical"
                                        data={chartRows}
                                        margin={{ top: 0, right: 72, bottom: 0, left: 0 }}
                                        barCategoryGap={4}
                                    >
                                        {/* Only the value axis gets rules; the category
                                            side is already spelled out in words. */}
                                        <CartesianGrid horizontal={false} stroke="#332c27" strokeDasharray="3 3" />
                                        <XAxis
                                            type="number"
                                            domain={[0, 'dataMax']}
                                            allowDecimals={false}
                                            tickFormatter={rsShort}
                                            tick={{ fill: '#a39a92', fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            type="category"
                                            dataKey="name"
                                            width={150}
                                            tickFormatter={shortName}
                                            tick={{ fill: '#f8f4ee', fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <Tooltip
                                            cursor={{ fill: 'rgba(248, 244, 238, 0.04)' }}
                                            content={<ItemTooltip />}
                                        />
                                        <Bar
                                            dataKey="net"
                                            fill={SERIES}
                                            radius={[0, 4, 4, 0]}
                                            maxBarSize={22}
                                            isAnimationActive={false}
                                        >
                                            <LabelList
                                                dataKey="net"
                                                position="right"
                                                offset={8}
                                                formatter={rsShort}
                                                fill="#f8f4ee"
                                                fontSize={11}
                                            />
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </section>
                </>
            )}

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

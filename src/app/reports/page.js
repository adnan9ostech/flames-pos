
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { formatDateTime, formatDayMonth } from '@/lib/timeFormat'
import { getDashboardStats, getReportPreviews } from './actions'
import {
    AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import {
    SERIES, GRID, AXIS_TEXT, SURFACE, CURSOR_FILL,
    TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM,
} from '@/lib/reports/chartTheme.mjs'
import LiveClock from '@/components/Layout/LiveClock'
import {
    DollarSign, ShoppingBag, TrendingUp, TrendingDown, Minus, Calendar,
    Loader2, FileDown, Flame, Receipt, ArrowRight, ClipboardList, CalendarDays,
    Clock, ListOrdered, Utensils, Percent
} from 'lucide-react'
import styles from './reports.module.css'

const RANGE_LABEL = { today: 'Today', '7days': 'the last 7 days', '30days': 'the last 30 days' }

/*
 * Chart chrome comes from the shared theme module: SERIES is slot 2 of the
 * validated categorical palette, because every chart on this page is
 * single-series and a single series must not be drawn in --primary or it reads
 * as chrome — the same orange is on the active tab and the buttons three inches
 * above it.
 *
 * Only geometry stays local. These tooltips sit over 76px preview cards, where
 * recharts' default padding and an inherited body size crowd the one number the
 * tooltip exists to show; no colour is set here.
 */
const TOOLTIP_BOX = { ...TOOLTIP_STYLE, fontSize: 12, padding: '6px 10px' }
const TOOLTIP_LABEL_BOX = { ...TOOLTIP_LABEL, marginBottom: 2 }

// Money on screen: en-PK grouping, no decimals — rupees are counted in whole
// notes here and the .00 is noise on every screen in the app.
const rs = (x) => Math.round(Number(x) || 0).toLocaleString('en-PK')

// Money on an axis is abbreviated. Five repetitions of "12500" is five times
// the ink for one fact the reader already has from the tooltip.
const rsAxis = (v) => {
    const n = Number(v) || 0
    const trim = (s) => s.replace(/\.0$/, '')
    if (Math.abs(n) >= 1_000_000) return `Rs ${trim((n / 1_000_000).toFixed(1))}m`
    if (Math.abs(n) >= 1_000) return `Rs ${trim((n / 1_000).toFixed(1))}k`
    return `Rs ${Math.round(n)}`
}

// 12-hour labels, matching how times read everywhere else in the app
const hourLabel = (hour) => {
    const period = hour < 12 ? 'AM' : 'PM'
    const twelve = hour % 12 === 0 ? 12 : hour % 12
    return `${twelve} ${period}`
}

/*
 * '2026-08-27' → '27 Aug'. Parsed at UTC noon rather than UTC midnight: the
 * browser renders it on its own clock, and a midnight instant would slide back
 * a day for any reader west of Greenwich.
 */
const dayMonth = (ymd) => formatDayMonth(new Date(`${ymd}T12:00:00Z`))

const plural = (n, one, many) => `${Number(n).toLocaleString('en-PK')} ${n === 1 ? one : many}`

// Small up/down/flat indicator comparing this period to the one before it
function TrendBadge({ value }) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return <span className="trend-badge trend-flat"><Minus className="h-3 w-3" />No prior data</span>
    }
    const rounded = Math.round(value * 10) / 10
    if (Math.abs(rounded) < 0.1) {
        return <span className="trend-badge trend-flat"><Minus className="h-3 w-3" />Flat vs. prior period</span>
    }
    const up = rounded > 0
    const Icon = up ? TrendingUp : TrendingDown
    return (
        <span className={`trend-badge ${up ? 'trend-up' : 'trend-down'}`}>
            <Icon className="h-3 w-3" />
            {up ? '+' : ''}{rounded}% vs. prior period
        </span>
    )
}

/*
 * Card previews: a glance at the shape behind the headline, not a chart to
 * read values off. No axes and no legend at this size — the tooltip carries
 * the numbers, and the card's own text says what the series is.
 */
function MiniBars({ data, labelKey, valueKey, name, format }) {
    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap={4}>
                <XAxis dataKey={labelKey} hide />
                <YAxis hide domain={[0, 'dataMax']} />
                <Tooltip
                    cursor={CURSOR_FILL}
                    contentStyle={TOOLTIP_BOX}
                    labelStyle={TOOLTIP_LABEL_BOX}
                    itemStyle={TOOLTIP_ITEM}
                    formatter={(value) => [format(value), name]}
                />
                {/* Rounded on the data end only — a bar's baseline is square. */}
                <Bar dataKey={valueKey} fill={SERIES} radius={[4, 4, 0, 0]} />
            </BarChart>
        </ResponsiveContainer>
    )
}

function MiniArea({ data, labelKey, valueKey, name, format }) {
    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
                <defs>
                    <linearGradient id="previewFade" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={SERIES} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={SERIES} stopOpacity={0} />
                    </linearGradient>
                </defs>
                <XAxis dataKey={labelKey} hide />
                <YAxis hide />
                <Tooltip
                    cursor={{ stroke: GRID }}
                    contentStyle={TOOLTIP_BOX}
                    labelStyle={TOOLTIP_LABEL_BOX}
                    itemStyle={TOOLTIP_ITEM}
                    formatter={(value) => [format(value), name]}
                />
                <Area
                    type="monotone"
                    dataKey={valueKey}
                    stroke={SERIES}
                    strokeWidth={2}
                    fill="url(#previewFade)"
                    dot={false}
                    activeDot={{ r: 4, fill: SERIES, stroke: SURFACE, strokeWidth: 2 }}
                />
            </AreaChart>
        </ResponsiveContainer>
    )
}

/*
 * One card per report. Each answers a question in plain English, states this
 * range's answer as a headline, and links to the report that shows the working.
 * Built from a single previews payload — six cards fetching for themselves
 * would be six round trips and six chances to disagree with each other.
 */
function buildCards(previews) {
    const handover = previews?.handover || { revenue: 0, bills: 0, days: [] }
    const dailySales = previews?.dailySales || { revenue: 0, orders: 0, days: [] }
    const hourly = previews?.hourly || { peakHour: null, peakRevenue: 0, series: [] }
    const itemWise = previews?.itemWise || { topItems: [] }
    const menu = previews?.menuAnalytics || { topCategory: null, categories: [] }
    const profit = previews?.grossProfit || { marginPct: null, cogs: 0, revenue: 0, margin: 0, uncostedCount: 0 }

    // A month of slivers is not a preview: the last week of trading is the
    // shape a reader can actually take in at 76px.
    const recentDays = handover.days.slice(-7).map((d) => ({ ...d, label: dayMonth(d.date) }))
    const hourSeries = hourly.series.map((h) => ({ ...h, label: hourLabel(h.hour) }))
    const topItems = itemWise.topItems.map((i) => ({ ...i, label: i.name }))
    const topCategories = menu.categories.slice(0, 5)
    const categoryTotal = menu.categories.reduce((sum, c) => sum + c.amount, 0)
    const topShare = categoryTotal > 0 && menu.categories.length
        ? Math.round((menu.categories[0].amount / categoryTotal) * 100)
        : null
    // Cost against what the costed dishes kept: two slices of one whole, so
    // bars rather than a pie, and one series so one colour.
    const profitSplit = [
        { label: 'Recipe cost', amount: profit.cogs },
        { label: 'Gross margin', amount: Math.max(profit.margin, 0) },
    ]

    return [
        {
            key: 'handover',
            href: '/reports/handover',
            Icon: ClipboardList,
            title: 'Handover',
            blurb: 'What the closing manager hands the owner: takings, payment split, voids, expenses and the drawer count.',
            value: `Rs ${rs(handover.revenue)}`,
            unit: 'billed',
            // "Billed", not "taken": the handover counts an open tab, which the
            // revenue tile above deliberately leaves out. Saying so here stops
            // the two figures reading as a contradiction.
            sub: `${plural(handover.bills, 'bill', 'bills')} incl. open tabs, over ${plural(handover.days.length, 'day', 'days')}`,
            preview: recentDays.length > 0 && (
                <MiniBars data={recentDays} labelKey="label" valueKey="revenue"
                    name="Billed" format={(v) => `Rs ${rs(v)}`} />
            ),
            empty: 'No bills in this range. A day’s takings appear here once orders are rung up.',
        },
        {
            key: 'daily-sales',
            href: '/reports/daily-sales',
            Icon: CalendarDays,
            title: 'Daily Food Sales',
            blurb: 'Every order of a trading day, line by line. Voids struck through with their reason, not hidden.',
            value: `${dailySales.orders.toLocaleString('en-PK')}`,
            unit: dailySales.orders === 1 ? 'order' : 'orders',
            sub: `Rs ${rs(dailySales.revenue)} across the range`,
            preview: recentDays.length > 0 && (
                <MiniBars data={recentDays} labelKey="label" valueKey="orders"
                    name="Orders" format={(v) => `${v}`} />
            ),
            empty: 'No orders in this range yet.',
        },
        {
            key: 'hourly',
            href: '/reports/hourly',
            Icon: Clock,
            title: 'Hourly Sales',
            blurb: 'When the money actually comes in, hour by hour. The shape a rota gets written against.',
            value: `Rs ${rs(hourly.peakRevenue)}`,
            unit: 'in the busiest hour',
            sub: hourly.peakHour === null
                ? 'No hour has taken money yet'
                : `Peak at ${hourLabel(hourly.peakHour)}`,
            preview: hourSeries.length > 0 && (
                <MiniArea data={hourSeries} labelKey="label" valueKey="total"
                    name="Taken" format={(v) => `Rs ${rs(v)}`} />
            ),
            empty: 'No takings yet. The shape of a service appears here hour by hour.',
        },
        {
            key: 'item-wise',
            href: '/reports/item-wise',
            Icon: ListOrdered,
            title: 'Item-wise Sale',
            blurb: 'Which dishes left the kitchen, rolled up category → item → portion, against the orders they came from.',
            value: topItems.length ? topItems[0].qty.toLocaleString('en-PK') : '—',
            unit: 'sold',
            sub: topItems.length
                ? `${topItems[0].name} leads the range`
                : 'Nothing sold in this range',
            preview: topItems.length > 0 && (
                <MiniBars data={topItems} labelKey="label" valueKey="qty"
                    name="Sold" format={(v) => `${v}`} />
            ),
            empty: 'No item lines in this range.',
        },
        {
            key: 'menu-analytics',
            href: '/reports/menu-analytics',
            Icon: Utensils,
            title: 'Menu Analytics',
            blurb: 'The product mix: which categories carry the menu, which modifiers get chosen, what gets voided.',
            value: topShare === null ? '—' : `${topShare}%`,
            unit: 'of settled sales',
            sub: menu.topCategory
                ? `${menu.topCategory} is the biggest category`
                : 'No settled sales to break down',
            preview: topCategories.length > 0 && (
                <MiniBars data={topCategories} labelKey="name" valueKey="amount"
                    name="Sold" format={(v) => `Rs ${rs(v)}`} />
            ),
            empty: 'Nothing settled in this range, so there is no mix to break down.',
        },
        {
            key: 'gross-profit',
            href: '/reports/gross-profit',
            Icon: Percent,
            title: 'Gross Profit',
            blurb: 'What each dish earns after its recipe costs. Priced at today’s moving-average ingredient cost.',
            value: profit.marginPct === null ? '—' : `${profit.marginPct.toFixed(1)}%`,
            unit: 'margin',
            /*
             * A dish with no recipe costs nothing to make as far as the join is
             * concerned, so the margin is taken over costed revenue only and
             * the card says so. Folding the uncosted plates in would report a
             * fatter margin than the kitchen is earning.
             */
            sub: profit.marginPct === null
                ? 'No dish sold here has a costed recipe yet'
                : profit.uncostedCount > 0
                    ? `Rs ${rs(profit.cogs)} COGS: excl. ${plural(profit.uncostedCount, 'item', 'items')} without recipes`
                    : `Rs ${rs(profit.cogs)} COGS on Rs ${rs(profit.revenue)} sold`,
            preview: profit.marginPct !== null && (
                <MiniBars data={profitSplit} labelKey="label" valueKey="amount"
                    name="Amount" format={(v) => `Rs ${rs(v)}`} />
            ),
            empty: 'Cost against margin appears here once a sold dish has a recipe.',
        },
    ]
}

export default function ReportsPage() {
    const [range, setRange] = useState('7days')
    const [fromDate, setFromDate] = useState('')
    const [toDate, setToDate] = useState('')
    const [stats, setStats] = useState(null)
    const [previews, setPreviews] = useState(null)
    const [previewError, setPreviewError] = useState('')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        // Deliberate: this effect re-runs whenever the date range changes, and the
        // spinner has to come back while the new range is fetched. Without it the
        // screen keeps showing the previous range's figures as though they were
        // the answer to the range just picked.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLoading(true)
        let cancelled = false
        // Both halves of the screen describe one window, so they are asked for
        // together and land together — no half-updated dashboard in between.
        const args = fromDate ? [fromDate, toDate || fromDate] : [range]
        Promise.all([getDashboardStats(...args), getReportPreviews(...args)])
            .then(([statsRes, previewRes]) => {
                if (cancelled) return
                setStats(statsRes)
                setPreviews(previewRes?.data || null)
                // The grid survives a failed preview: the cards still link out,
                // they just say they have no figures rather than showing zeros
                // that would read as a quiet day.
                setPreviewError(previewRes?.error || '')
                setLoading(false)
            })
            .catch(() => {
                if (cancelled) return
                setStats({ error: 'Could not reach the server' })
                setLoading(false)
            })
        return () => { cancelled = true }
    }, [range, fromDate, toDate])

    const handlePresetClick = (preset) => {
        setRange(preset)
        setFromDate('')
        setToDate('')
    }

    const isCustomRange = fromDate !== ''

    const periodLabel = isCustomRange
        ? `${fromDate} to ${toDate || fromDate}`
        : RANGE_LABEL[range] || range

    const handleExportPdf = () => {
        // Printing to PDF (rather than a canvas-rasterised download) keeps the
        // chart crisp and text selectable, and needs no extra dependency.
        window.print()
    }

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-page">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
            </div>
        )
    }

    if (stats?.error) {
        return <div className="p-8 text-destructive bg-page min-h-screen">Error loading stats: {stats.error}</div>
    }

    const cards = buildCards(previews).map((card) => (previews ? card : {
        ...card,
        value: '—',
        unit: '',
        sub: 'Figures unavailable for this range',
        preview: null,
        empty: 'This preview could not be loaded.',
    }))

    return (
        <div className="w-full px-4 sm:px-6 lg:px-10 py-6 sm:py-8 space-y-8 bg-page min-h-screen text-foreground" id="report-root">

            {/* Print-only masthead: the interactive header below is hidden when printing */}
            <div className="report-print-header hidden">
                <div className="flex items-center gap-3">
                    <Flame className="h-7 w-7" />
                    <h1 className="text-2xl font-bold">Flames by the Indus. Analytics Report</h1>
                </div>
                <p className="text-sm text-muted mt-1">
                    Period: {periodLabel} · Generated {formatDateTime(new Date())}
                </p>
            </div>

            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 no-print">
                <div className="min-w-0">
                    <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground whitespace-nowrap">Analytics Dashboard</h1>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-muted-foreground text-sm sm:text-base">
                        <span>Overview of your store&apos;s performance</span>
                        <span className="hidden sm:inline text-border">·</span>
                        <LiveClock className="hidden sm:inline-flex items-center gap-1.5 text-muted-foreground text-sm font-medium" showSeconds={false} iconSize={14} />
                    </div>
                </div>

                {/* Filter Controls */}
                <div className="flex flex-wrap items-stretch sm:items-center gap-3">
                    {/* Preset Buttons */}
                    <div className="flex bg-surface-translucent backdrop-blur-sm rounded-xl shadow-lg border border-border p-1.5">
                        {[
                            { key: 'today', label: 'Today' },
                            { key: '7days', label: '7 Days' },
                            { key: '30days', label: '30 Days' }
                        ].map((preset) => (
                            <button
                                key={preset.key}
                                onClick={() => handlePresetClick(preset.key)}
                                className={`px-4 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${!isCustomRange && range === preset.key
                                    ? 'bg-gradient-to-r from-primary to-primary-hover text-primary-foreground shadow-lg shadow-primary-soft-strong'
                                    : 'text-muted-foreground hover:text-card-foreground hover:bg-surface-raise'
                                    }`}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>

                    {/* Custom Date Range */}
                    <div className={`flex items-center gap-3 bg-surface-translucent backdrop-blur-sm rounded-xl shadow-lg border p-3 transition-all duration-200 ${isCustomRange ? 'border-primary ring-1 ring-primary-soft-strong' : 'border-border'
                        }`}>
                        <Calendar className={`h-4 w-4 flex-shrink-0 ${isCustomRange ? 'text-primary' : 'text-muted'}`} />
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                value={fromDate}
                                onChange={(e) => setFromDate(e.target.value)}
                                max={toDate || new Date().toISOString().split('T')[0]}
                                className="w-[130px] px-2 py-1.5 rounded-lg text-sm font-medium bg-surface-raise border border-border text-foreground transition-all focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft-strong"
                            />
                            <span className="text-muted text-xs font-medium">→</span>
                            <input
                                type="date"
                                value={toDate}
                                onChange={(e) => setToDate(e.target.value)}
                                min={fromDate}
                                max={new Date().toISOString().split('T')[0]}
                                className="w-[130px] px-2 py-1.5 rounded-lg text-sm font-medium bg-surface-raise border border-border text-foreground transition-all focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft-strong"
                            />
                        </div>
                        {isCustomRange && (
                            <button
                                onClick={() => handlePresetClick('7days')}
                                className="ml-1 p-1 rounded-md hover:bg-surface-raise-strong text-muted hover:text-foreground transition-colors"
                                title="Clear custom range"
                            >
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        )}
                    </div>

                    <button
                        onClick={handleExportPdf}
                        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-surface-translucent backdrop-blur-sm border border-border text-foreground hover:text-card-foreground hover:border-primary transition-all duration-200 shadow-lg"
                        title="Export this report as a PDF"
                    >
                        <FileDown className="h-4 w-4" />
                        Export PDF
                    </button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-1">Total Revenue</p>
                        <h3 className="text-2xl font-bold text-card-foreground">Rs. {rs(stats.totalRevenue)}</h3>
                        <div className="mt-2"><TrendBadge value={stats.trends?.revenue} /></div>
                    </div>
                    <div className="h-12 w-12 bg-success-soft rounded-full flex items-center justify-center flex-shrink-0">
                        <DollarSign className="h-6 w-6 text-success" />
                    </div>
                </div>

                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-1">Total Orders</p>
                        <h3 className="text-2xl font-bold text-card-foreground">{stats.totalOrders}</h3>
                        <div className="mt-2"><TrendBadge value={stats.trends?.orders} /></div>
                    </div>
                    <div className="h-12 w-12 bg-info-soft rounded-full flex items-center justify-center flex-shrink-0">
                        <ShoppingBag className="h-6 w-6 text-info" />
                    </div>
                </div>

                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-1">Average Order Value</p>
                        <h3 className="text-2xl font-bold text-card-foreground">Rs. {rs(stats.avgOrderValue)}</h3>
                        <div className="mt-2"><TrendBadge value={stats.trends?.avgOrderValue} /></div>
                    </div>
                    {/* The one tile with no status meaning — it was purple, and the
                        token system has no purple. Slot 6 of the validated chart
                        palette is the violet, so it carries the hue in both themes
                        instead of a hardcoded one that only works on black. */}
                    <div className="h-12 w-12 bg-chart-6-soft rounded-full flex items-center justify-center flex-shrink-0">
                        <TrendingUp className="h-6 w-6 text-chart-6" />
                    </div>
                </div>

                {/* Money the floor still owes. Deliberately its own tile rather
                    than part of revenue: an open tab can still be voided, and
                    folding it in would overstate takings — the audit's biggest
                    reporting finding. */}
                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-1">Open Tabs</p>
                        <h3 className="text-2xl font-bold text-card-foreground">Rs. {rs(stats.openTabs?.amount)}</h3>
                        <p className="mt-2 text-xs text-muted">
                            {stats.openTabs?.count || 0} unpaid {(stats.openTabs?.count || 0) === 1 ? 'tab' : 'tabs'}, not in revenue
                        </p>
                    </div>
                    <div className="h-12 w-12 bg-warning-soft rounded-full flex items-center justify-center flex-shrink-0">
                        <Receipt className="h-6 w-6 text-accent" />
                    </div>
                </div>
            </div>

            {/* Hero chart: the money over time, one series, on the range above. */}
            <div className="bg-surface p-6 rounded-xl shadow-sm border border-border report-card">
                <h3 className="text-lg font-semibold text-card-foreground">Revenue by trading day</h3>
                <p className="text-sm text-muted-foreground mt-1 mb-6">Settled bills only: open tabs are counted in their own tile above.</p>
                <div className="h-[300px] w-full">
                    {stats.chartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={stats.chartData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="heroFade" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor={SERIES} stopOpacity={0.32} />
                                        <stop offset="100%" stopColor={SERIES} stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                {/* Recessive, horizontal only: a time axis needs no vertical rules. */}
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID} />
                                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: AXIS_TEXT, fontSize: 12 }} dy={10} />
                                <YAxis axisLine={false} tickLine={false} tick={{ fill: AXIS_TEXT, fontSize: 12 }} tickFormatter={rsAxis} width={64} />
                                <Tooltip
                                    cursor={{ stroke: GRID }}
                                    contentStyle={TOOLTIP_BOX}
                                    labelStyle={TOOLTIP_LABEL_BOX}
                                    itemStyle={TOOLTIP_ITEM}
                                    formatter={(value, key) => key === 'sales'
                                        ? [`Rs ${rs(value)}`, 'Revenue']
                                        : [value, 'Orders']}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="sales"
                                    stroke={SERIES}
                                    strokeWidth={2}
                                    fill="url(#heroFade)"
                                    // Marked points only while they are countable;
                                    // a month of dots is a dotted line.
                                    dot={stats.chartData.length <= 10 ? { r: 4, fill: SERIES, strokeWidth: 0 } : false}
                                    activeDot={{ r: 5, fill: SERIES, stroke: SURFACE, strokeWidth: 2 }}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="h-full flex items-center justify-center text-center px-6 rounded-lg border border-dashed border-border text-muted text-sm">
                            No settled sales in this range. Revenue per trading day will plot here once a bill is paid.
                        </div>
                    )}
                </div>
            </div>

            {/* The report library. Navigation, so it stays off the printed PDF. */}
            <section className={`${styles.section} no-print`} aria-labelledby="reports-heading">
                <div className={styles.sectionHead}>
                    <h2 id="reports-heading" className={styles.sectionTitle}>Reports</h2>
                    <p className={styles.sectionHint}>
                        {previewError
                            ? `Previews unavailable: ${previewError}`
                            : `Each one answers a different question about ${periodLabel}. The figures below match the report they open.`}
                    </p>
                </div>

                <div className={styles.grid}>
                    {cards.map(({ key, href, Icon, title, blurb, value, unit, sub, preview, empty }) => (
                        <Link key={key} href={href} className={styles.card}>
                            <div className={styles.cardHead}>
                                <span className={styles.icon}><Icon className="h-4 w-4" /></span>
                                <span className={styles.title}>{title}</span>
                                <ArrowRight className={`${styles.arrow} h-4 w-4`} aria-hidden="true" />
                            </div>
                            <p className={styles.blurb}>{blurb}</p>
                            <div>
                                <div className={styles.headline}>
                                    <span className={styles.value}>{value}</span>
                                    <span className={styles.unit}>{unit}</span>
                                </div>
                                <p className={styles.sub} title={sub}>{sub}</p>
                            </div>
                            {preview
                                ? <div className={styles.preview}>{preview}</div>
                                : <div className={styles.previewEmpty}>{empty}</div>}
                        </Link>
                    ))}
                </div>
            </section>

            {/* Money breakdown. All of this comes from columns the till was
                already writing and nothing reported on. */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border report-card">
                    <p className="text-sm font-medium text-muted-foreground mb-4">Payment mix</p>
                    <div className="space-y-3">
                        {[
                            { key: 'cash', label: 'Cash', color: 'bg-success' },
                            { key: 'card', label: 'Card', color: 'bg-info' },
                            { key: 'unpaid', label: 'Open tabs', color: 'bg-accent' },
                            // Only shown when there is some: history from before the
                            // field existed, and not worth a permanent empty row.
                            { key: 'unrecorded', label: 'Not recorded', color: 'bg-chart-other' },
                        ].filter(({ key }) => key !== 'unrecorded' || (stats.paymentMix?.unrecorded?.count || 0) > 0)
                            .map(({ key, label, color }) => {
                                const row = stats.paymentMix?.[key] || { amount: 0, count: 0 }
                                // Share of all money in the mix (settled + open tabs);
                                // totalRevenue no longer contains the unpaid bucket.
                                const mixTotal = Object.values(stats.paymentMix || {})
                                    .reduce((sum, r) => sum + (r?.amount || 0), 0)
                                const share = mixTotal > 0
                                    ? Math.round((row.amount / mixTotal) * 100)
                                    : 0
                                return (
                                    <div key={key}>
                                        <div className="flex items-baseline justify-between text-sm">
                                            <span className="text-foreground">{label}</span>
                                            <span className="text-card-foreground font-semibold tabular-nums">
                                                Rs. {rs(row.amount)}
                                                <span className="ml-2 text-xs font-normal text-muted">
                                                    {row.count} {row.count === 1 ? 'order' : 'orders'}
                                                </span>
                                            </span>
                                        </div>
                                        {/* The track is --surface-raise-strong, not
                                            --surface-sunken: this bar sits ON a card, and
                                            on the dark theme the card is already near-black,
                                            so a sunken wash would hide the unfilled part of
                                            the bar entirely. Raise lifts on dark and darkens
                                            on light, which is a visible track in both. */}
                                        <div className="mt-1.5 h-1.5 w-full rounded-full bg-surface-raise-strong overflow-hidden">
                                            <div className={`h-full ${color}`} style={{ width: `${share}%` }} />
                                        </div>
                                    </div>
                                )
                            })}
                    </div>
                </div>

                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border report-card flex items-center justify-between">
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-1">Tax collected</p>
                        <h3 className="text-2xl font-bold text-card-foreground">Rs. {rs(stats.totalTax)}</h3>
                        <p className="mt-2 text-xs text-muted">
                            {Math.round(stats.totalDiscount || 0) > 0
                                ? `After Rs. ${rs(stats.totalDiscount)} of discounts given`
                                : 'No discounts given this period'}
                        </p>
                    </div>
                    <div className="h-12 w-12 bg-primary-soft rounded-full flex items-center justify-center flex-shrink-0">
                        <Receipt className="h-6 w-6 text-primary" />
                    </div>
                </div>

                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border report-card">
                    <p className="text-sm font-medium text-muted-foreground mb-4">Takings by server</p>
                    {stats.waiters?.length ? (
                        <div className="space-y-2.5">
                            {stats.waiters.slice(0, 5).map(w => (
                                <div key={w.name} className="flex items-baseline justify-between text-sm">
                                    <span className="text-foreground truncate mr-3">{w.name}</span>
                                    <span className="text-card-foreground font-semibold tabular-nums whitespace-nowrap">
                                        Rs. {rs(w.revenue)}
                                        <span className="ml-2 text-xs font-normal text-muted">{w.orders}</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-muted">No orders had a server assigned.</p>
                    )}
                </div>
            </div>

            {/* Sales by hour — the shape of a service, for staffing */}
            {stats.hourly?.length > 0 && (
                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border report-card">
                    <h3 className="text-lg font-semibold text-card-foreground mb-6">Busiest hours</h3>
                    <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={stats.hourly} barCategoryGap={4}>
                            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                            <XAxis dataKey="label" stroke={AXIS_TEXT} fontSize={11} tickLine={false} />
                            <YAxis stroke={AXIS_TEXT} fontSize={11} tickLine={false} axisLine={false} tickFormatter={rsAxis} width={64} />
                            <Tooltip
                                cursor={CURSOR_FILL}
                                contentStyle={TOOLTIP_BOX}
                                labelStyle={TOOLTIP_LABEL_BOX}
                                itemStyle={TOOLTIP_ITEM}
                                formatter={(value, key) => key === 'revenue'
                                    ? [`Rs ${rs(value)}`, 'Sales']
                                    : [value, 'Orders']}
                            />
                            <Bar dataKey="revenue" fill={SERIES} radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Top Items */}
                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border report-card">
                    <h3 className="text-lg font-semibold text-card-foreground mb-6">Top Selling Items</h3>
                    <div className="space-y-4">
                        {stats.topItems.length > 0 ? (
                            stats.topItems.map((item, idx) => (
                                <div key={idx} className="flex items-center justify-between pb-4 border-b border-border last:border-0 last:pb-0">
                                    <div className="flex items-center gap-3">
                                        <div className="h-8 w-8 rounded-full bg-primary-soft flex items-center justify-center font-bold text-primary text-xs">
                                            #{idx + 1}
                                        </div>
                                        <div>
                                            <p className="font-medium text-foreground text-sm">{item.name}</p>
                                            <p className="text-xs text-muted-foreground">{item.count} orders</p>
                                        </div>
                                    </div>
                                    <span className="font-semibold text-foreground text-sm">Rs. {rs(item.revenue)}</span>
                                </div>
                            ))
                        ) : (
                            <div className="text-center text-muted py-10">
                                No items sold yet
                            </div>
                        )}
                    </div>
                </div>

                {/* Trending Items — biggest movers vs. the prior period, not just top volume */}
                <div className="bg-surface p-6 rounded-xl shadow-sm border border-border report-card">
                    <div className="flex items-center gap-2 mb-6">
                        <TrendingUp className="h-5 w-5 text-primary" />
                        <h3 className="text-lg font-semibold text-card-foreground">Trending Now</h3>
                        <span className="text-xs text-muted font-normal">fastest-growing items vs. the previous period</span>
                    </div>
                    {stats.trendingItems && stats.trendingItems.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {stats.trendingItems.map((item, idx) => (
                                <div key={idx} className="bg-surface-raise border border-border rounded-lg p-4">
                                    <p className="font-medium text-foreground text-sm truncate" title={item.name}>{item.name}</p>
                                    <div className="flex items-center gap-1.5 mt-2 text-success-text text-sm font-semibold">
                                        <TrendingUp className="h-3.5 w-3.5" />
                                        +{item.growth} sold
                                    </div>
                                    <p className="text-xs text-muted mt-1">{item.prevCount} → {item.count} units</p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center text-muted py-6">
                            Not enough history yet to detect trends for this period
                        </div>
                    )}
                </div>
            </div>

            {/* Print-only styling: hides interactive chrome, forces a light,
                paginated layout suited to a physical/PDF report. */}
            <style jsx global>{`
                @media print {
                    body { background: white !important; }
                    .no-print { display: none !important; }
                    .report-print-header.hidden { display: block !important; }
                    #report-root {
                        background: white !important;
                        color: #111 !important;
                        max-width: 100% !important;
                        padding: 0 !important;
                    }
                    .report-card {
                        background: white !important;
                        border: 1px solid #ddd !important;
                        color: #111 !important;
                        box-shadow: none !important;
                        break-inside: avoid;
                    }
                    .report-card * { color: #111 !important; }
                    .trend-badge { color: #444 !important; }
                }
                .trend-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25rem;
                    font-size: 0.75rem;
                    font-weight: 600;
                }
                .trend-up { color: var(--trend-up); }
                .trend-down { color: var(--trend-down); }
                .trend-flat { color: var(--trend-flat); }
            `}</style>
        </div>
    )
}

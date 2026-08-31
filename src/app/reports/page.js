
'use client'

import { useState, useEffect } from 'react'
import { formatDateTime } from '@/lib/timeFormat'
import { getDashboardStats } from './actions'
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import LiveClock from '@/components/Layout/LiveClock'
import {
    DollarSign, ShoppingBag, TrendingUp, TrendingDown, Minus, Calendar,
    Loader2, FileDown, Flame, Receipt
} from 'lucide-react'

const RANGE_LABEL = { today: 'Today', '7days': 'the last 7 days', '30days': 'the last 30 days' }

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

export default function ReportsPage() {
    const [range, setRange] = useState('7days')
    const [fromDate, setFromDate] = useState('')
    const [toDate, setToDate] = useState('')
    const [stats, setStats] = useState(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        // Deliberate: this effect re-runs whenever the date range changes, and the
        // spinner has to come back while the new range is fetched. Without it the
        // screen keeps showing the previous range's figures as though they were
        // the answer to the range just picked.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLoading(true)
        // If custom date range is set, use it
        if (fromDate) {
            getDashboardStats(fromDate, toDate || fromDate).then(data => {
                setStats(data)
                setLoading(false)
            })
        } else {
            getDashboardStats(range).then(data => {
                setStats(data)
                setLoading(false)
            })
        }
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
            <div className="flex h-screen items-center justify-center bg-gray-950">
                <Loader2 className="h-10 w-10 animate-spin text-orange-500" />
            </div>
        )
    }

    if (stats?.error) {
        return <div className="p-8 text-red-500 bg-gray-950 min-h-screen">Error loading stats: {stats.error}</div>
    }

    return (
        <div className="w-full px-4 sm:px-6 lg:px-10 py-6 sm:py-8 space-y-8 bg-gray-950 min-h-screen text-gray-100" id="report-root">

            {/* Print-only masthead: the interactive header below is hidden when printing */}
            <div className="report-print-header hidden">
                <div className="flex items-center gap-3">
                    <Flame className="h-7 w-7" />
                    <h1 className="text-2xl font-bold">Flames by the Indus — Analytics Report</h1>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                    Period: {periodLabel} · Generated {formatDateTime(new Date())}
                </p>
            </div>

            {/* The report library — each page owns one question the business
                asks; this dashboard stays the at-a-glance overview. */}
            <div className="flex flex-wrap gap-2 no-print">
                {[
                    ['/reports/handover', 'Handover'],
                    ['/reports/daily-sales', 'Daily Food Sales'],
                    ['/reports/hourly', 'Hourly Sales'],
                    ['/reports/item-wise', 'Item-wise Sale'],
                    ['/reports/menu-analytics', 'Menu Analytics'],
                    ['/reports/gross-profit', 'Gross Profit'],
                ].map(([href, label]) => (
                    <a
                        key={href}
                        href={href}
                        className="px-3.5 py-2 rounded-lg bg-gray-900/80 border border-gray-800/60 text-sm text-gray-300 hover:text-white hover:border-orange-600/50 transition-colors"
                    >
                        {label}
                    </a>
                ))}
            </div>

            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 no-print">
                <div className="min-w-0">
                    <h1 className="text-2xl sm:text-3xl font-bold text-white whitespace-nowrap">Analytics Dashboard</h1>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-gray-400 text-sm sm:text-base">
                        <span>Overview of your store&apos;s performance</span>
                        <span className="hidden sm:inline text-gray-700">·</span>
                        <LiveClock className="hidden sm:inline-flex items-center gap-1.5 text-gray-400 text-sm font-medium" showSeconds={false} iconSize={14} />
                    </div>
                </div>

                {/* Filter Controls */}
                <div className="flex flex-wrap items-stretch sm:items-center gap-3">
                    {/* Preset Buttons */}
                    <div className="flex bg-gray-900/80 backdrop-blur-sm rounded-xl shadow-lg border border-gray-800/50 p-1.5">
                        {[
                            { key: 'today', label: 'Today' },
                            { key: '7days', label: '7 Days' },
                            { key: '30days', label: '30 Days' }
                        ].map((preset) => (
                            <button
                                key={preset.key}
                                onClick={() => handlePresetClick(preset.key)}
                                className={`px-4 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${!isCustomRange && range === preset.key
                                        ? 'bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-lg shadow-orange-500/25'
                                        : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                                    }`}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>

                    {/* Custom Date Range */}
                    <div className={`flex items-center gap-3 bg-gray-900/80 backdrop-blur-sm rounded-xl shadow-lg border p-3 transition-all duration-200 ${isCustomRange ? 'border-orange-500/50 ring-1 ring-orange-500/20' : 'border-gray-800/50'
                        }`}>
                        <Calendar className={`h-4 w-4 flex-shrink-0 ${isCustomRange ? 'text-orange-500' : 'text-gray-500'}`} />
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                value={fromDate}
                                onChange={(e) => setFromDate(e.target.value)}
                                max={toDate || new Date().toISOString().split('T')[0]}
                                className="w-[130px] px-2 py-1.5 rounded-lg text-sm font-medium bg-gray-800/50 border border-gray-700/50 text-gray-300 transition-all focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 [color-scheme:dark]"
                            />
                            <span className="text-gray-600 text-xs font-medium">→</span>
                            <input
                                type="date"
                                value={toDate}
                                onChange={(e) => setToDate(e.target.value)}
                                min={fromDate}
                                max={new Date().toISOString().split('T')[0]}
                                className="w-[130px] px-2 py-1.5 rounded-lg text-sm font-medium bg-gray-800/50 border border-gray-700/50 text-gray-300 transition-all focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 [color-scheme:dark]"
                            />
                        </div>
                        {isCustomRange && (
                            <button
                                onClick={() => handlePresetClick('7days')}
                                className="ml-1 p-1 rounded-md hover:bg-gray-700/50 text-gray-500 hover:text-gray-300 transition-colors"
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
                        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-gray-900/80 backdrop-blur-sm border border-gray-800/50 text-gray-300 hover:text-white hover:border-orange-500/50 transition-all duration-200 shadow-lg"
                        title="Export this report as a PDF"
                    >
                        <FileDown className="h-4 w-4" />
                        Export PDF
                    </button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-gray-400 mb-1">Total Revenue</p>
                        <h3 className="text-2xl font-bold text-white">Rs. {stats.totalRevenue.toLocaleString()}</h3>
                        <div className="mt-2"><TrendBadge value={stats.trends?.revenue} /></div>
                    </div>
                    <div className="h-12 w-12 bg-green-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <DollarSign className="h-6 w-6 text-green-500" />
                    </div>
                </div>

                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-gray-400 mb-1">Total Orders</p>
                        <h3 className="text-2xl font-bold text-white">{stats.totalOrders}</h3>
                        <div className="mt-2"><TrendBadge value={stats.trends?.orders} /></div>
                    </div>
                    <div className="h-12 w-12 bg-blue-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <ShoppingBag className="h-6 w-6 text-blue-500" />
                    </div>
                </div>

                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-gray-400 mb-1">Average Order Value</p>
                        <h3 className="text-2xl font-bold text-white">Rs. {Math.round(stats.avgOrderValue).toLocaleString()}</h3>
                        <div className="mt-2"><TrendBadge value={stats.trends?.avgOrderValue} /></div>
                    </div>
                    <div className="h-12 w-12 bg-purple-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <TrendingUp className="h-6 w-6 text-purple-500" />
                    </div>
                </div>

                {/* Money the floor still owes. Deliberately its own tile rather
                    than part of revenue: an open tab can still be voided, and
                    folding it in would overstate takings — the audit's biggest
                    reporting finding. */}
                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 flex items-center justify-between report-card">
                    <div>
                        <p className="text-sm font-medium text-gray-400 mb-1">Open Tabs</p>
                        <h3 className="text-2xl font-bold text-white">Rs. {Math.round(stats.openTabs?.amount || 0).toLocaleString()}</h3>
                        <p className="mt-2 text-xs text-gray-500">
                            {stats.openTabs?.count || 0} unpaid {(stats.openTabs?.count || 0) === 1 ? 'tab' : 'tabs'} — not in revenue
                        </p>
                    </div>
                    <div className="h-12 w-12 bg-amber-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <Receipt className="h-6 w-6 text-amber-500" />
                    </div>
                </div>
            </div>

            {/* Money breakdown. All of this comes from columns the till was
                already writing and nothing reported on. */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 report-card">
                    <p className="text-sm font-medium text-gray-400 mb-4">Payment mix</p>
                    <div className="space-y-3">
                        {[
                            { key: 'cash', label: 'Cash', color: 'bg-green-500' },
                            { key: 'card', label: 'Card', color: 'bg-blue-500' },
                            { key: 'unpaid', label: 'Open tabs', color: 'bg-amber-500' },
                            // Only shown when there is some: history from before the
                            // field existed, and not worth a permanent empty row.
                            { key: 'unrecorded', label: 'Not recorded', color: 'bg-gray-500' },
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
                                        <span className="text-gray-300">{label}</span>
                                        <span className="text-white font-semibold tabular-nums">
                                            Rs. {Math.round(row.amount).toLocaleString()}
                                            <span className="ml-2 text-xs font-normal text-gray-500">
                                                {row.count} {row.count === 1 ? 'order' : 'orders'}
                                            </span>
                                        </span>
                                    </div>
                                    <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
                                        <div className={`h-full ${color}`} style={{ width: `${share}%` }} />
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>

                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 report-card flex items-center justify-between">
                    <div>
                        <p className="text-sm font-medium text-gray-400 mb-1">Tax collected</p>
                        <h3 className="text-2xl font-bold text-white">
                            Rs. {Math.round(stats.totalTax || 0).toLocaleString()}
                        </h3>
                        <p className="mt-2 text-xs text-gray-500">
                            {Math.round(stats.totalDiscount || 0) > 0
                                ? `After Rs. ${Math.round(stats.totalDiscount).toLocaleString()} of discounts given`
                                : 'No discounts given this period'}
                        </p>
                    </div>
                    <div className="h-12 w-12 bg-orange-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <Receipt className="h-6 w-6 text-orange-500" />
                    </div>
                </div>

                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 report-card">
                    <p className="text-sm font-medium text-gray-400 mb-4">Takings by server</p>
                    {stats.waiters?.length ? (
                        <div className="space-y-2.5">
                            {stats.waiters.slice(0, 5).map(w => (
                                <div key={w.name} className="flex items-baseline justify-between text-sm">
                                    <span className="text-gray-300 truncate mr-3">{w.name}</span>
                                    <span className="text-white font-semibold tabular-nums whitespace-nowrap">
                                        Rs. {Math.round(w.revenue).toLocaleString()}
                                        <span className="ml-2 text-xs font-normal text-gray-500">{w.orders}</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-gray-500">No orders had a server assigned.</p>
                    )}
                </div>
            </div>

            {/* Sales by hour — the shape of a service, for staffing */}
            {stats.hourly?.length > 0 && (
                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 report-card">
                    <h3 className="text-lg font-semibold text-white mb-6">Busiest hours</h3>
                    <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={stats.hourly}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#332c27" vertical={false} />
                            <XAxis dataKey="label" stroke="#a39a92" fontSize={11} tickLine={false} />
                            <YAxis stroke="#a39a92" fontSize={11} tickLine={false} axisLine={false} />
                            <Tooltip
                                contentStyle={{ background: '#15120f', border: '1px solid #332c27', borderRadius: 8 }}
                                labelStyle={{ color: '#f8f4ee' }}
                                formatter={(value, name) => name === 'revenue'
                                    ? [`Rs. ${Math.round(value).toLocaleString()}`, 'Sales']
                                    : [value, 'Orders']}
                            />
                            <Bar dataKey="revenue" fill="#F26513" radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}

            {/* Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* Sales Chart */}
                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 lg:col-span-2 report-card">
                    <h3 className="text-lg font-semibold text-white mb-6">Sales Trend</h3>
                    <div className="h-[300px] w-full">
                        {stats.chartData.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={stats.chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#332c27" />
                                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#a39a92', fontSize: 12 }} dy={10} />
                                    <YAxis axisLine={false} tickLine={false} tick={{ fill: '#a39a92', fontSize: 12 }} />
                                    <Tooltip
                                        cursor={{ fill: '#332c27' }}
                                        contentStyle={{ backgroundColor: '#15120f', borderRadius: '8px', border: '1px solid #332c27', color: '#f8f4ee' }}
                                        itemStyle={{ color: '#f8f4ee' }}
                                        labelStyle={{ color: '#a39a92' }}
                                    />
                                    <Bar dataKey="sales" fill="#F26513" radius={[4, 4, 0, 0]} barSize={40} />
                                </BarChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="h-full flex items-center justify-center text-gray-500">
                                No sales data for this period
                            </div>
                        )}
                    </div>
                </div>

                {/* Top Items */}
                <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 report-card">
                    <h3 className="text-lg font-semibold text-white mb-6">Top Selling Items</h3>
                    <div className="space-y-4">
                        {stats.topItems.length > 0 ? (
                            stats.topItems.map((item, idx) => (
                                <div key={idx} className="flex items-center justify-between pb-4 border-b border-gray-800 last:border-0 last:pb-0">
                                    <div className="flex items-center gap-3">
                                        <div className="h-8 w-8 rounded-full bg-orange-900/20 flex items-center justify-center font-bold text-orange-500 text-xs">
                                            #{idx + 1}
                                        </div>
                                        <div>
                                            <p className="font-medium text-gray-200 text-sm">{item.name}</p>
                                            <p className="text-xs text-gray-400">{item.count} orders</p>
                                        </div>
                                    </div>
                                    <span className="font-semibold text-gray-300 text-sm">Rs. {item.revenue.toLocaleString()}</span>
                                </div>
                            ))
                        ) : (
                            <div className="text-center text-gray-500 py-10">
                                No items sold yet
                            </div>
                        )}
                    </div>
                </div>

            </div>

            {/* Trending Items — biggest movers vs. the prior period, not just top volume */}
            <div className="bg-gray-900 p-6 rounded-xl shadow-sm border border-gray-800 report-card">
                <div className="flex items-center gap-2 mb-6">
                    <TrendingUp className="h-5 w-5 text-orange-500" />
                    <h3 className="text-lg font-semibold text-white">Trending Now</h3>
                    <span className="text-xs text-gray-500 font-normal">— fastest-growing items vs. the previous period</span>
                </div>
                {stats.trendingItems && stats.trendingItems.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                        {stats.trendingItems.map((item, idx) => (
                            <div key={idx} className="bg-gray-800/50 border border-gray-800 rounded-lg p-4">
                                <p className="font-medium text-gray-200 text-sm truncate" title={item.name}>{item.name}</p>
                                <div className="flex items-center gap-1.5 mt-2 text-green-400 text-sm font-semibold">
                                    <TrendingUp className="h-3.5 w-3.5" />
                                    +{item.growth} sold
                                </div>
                                <p className="text-xs text-gray-500 mt-1">{item.prevCount} → {item.count} units</p>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-center text-gray-500 py-6">
                        Not enough history yet to detect trends for this period
                    </div>
                )}
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
                .trend-up { color: #4ade80; }
                .trend-down { color: #f87171; }
                .trend-flat { color: #9ca3af; }
            `}</style>
        </div>
    )
}

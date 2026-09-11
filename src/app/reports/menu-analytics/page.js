'use client';
import { useState, useEffect, useMemo } from 'react';
import styles from './menuAnalytics.module.css';
import { productMix } from './actions';
import {
    BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LabelList,
    ResponsiveContainer,
} from 'recharts';
import {
    UtensilsCrossed, CalendarRange, Download, Loader2, AlertTriangle,
} from 'lucide-react';
/*
 * SERIES is slot 2 of the app's validated categorical palette: a one-series
 * chart uses it rather than the brand orange, which belongs to buttons and
 * tabs. SLOTS is that palette in its fixed slot order — six is the whole of
 * it, and a seventh category folds into the neutral OTHER rather than getting
 * a seventh hue.
 */
import {
    SLOTS, SERIES, OTHER, GRID, AXIS_TEXT, LABEL_TEXT, CURSOR_FILL,
} from '@/lib/reports/chartTheme.mjs';
import PrintButton from '@/components/Reports/PrintButton';

/*
 * All dates here are business dates on the Karachi calendar — the trading
 * day the order belongs to, matching orders.business_date exactly. The
 * browser's own timezone never gets a say.
 */
const KARACHI_TZ = 'Asia/Karachi';
const karachiDay = (date = new Date()) =>
    date.toLocaleDateString('en-CA', { timeZone: KARACHI_TZ });
const karachiDaysAgo = (n) => karachiDay(new Date(Date.now() - n * 86_400_000));

const PERIODS = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'week', label: 'Last 7 days' },
    { key: 'month', label: 'Last 30 days' },
    { key: 'custom', label: 'Custom range' },
];

const resolvePeriod = (period, customFrom, customTo) => {
    switch (period) {
        case 'today': return { from: karachiDay(), to: karachiDay() };
        case 'yesterday': return { from: karachiDaysAgo(1), to: karachiDaysAgo(1) };
        case 'week': return { from: karachiDaysAgo(6), to: karachiDay() };
        case 'month': return { from: karachiDaysAgo(29), to: karachiDay() };
        case 'custom': {
            // A single date means that whole day rather than an empty window.
            const from = customFrom || customTo;
            const to = customTo || customFrom;
            return from ? { from, to } : { from: null, to: null };
        }
        default: return { from: null, to: null };
    }
};

const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK')}`;
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;
const num = (n) => Number(n || 0).toLocaleString('en-PK');
const itemLabel = (r) => (r.variant ? `${r.name} (${r.variant})` : r.name);

/* ===== Charts =====
 *
 * Every tab here is a ranking, so every tab gets the same picture of it: a
 * horizontal bar chart of the ten biggest rows, longest bar first. Ten is a
 * hard cap — the header states "Top 10 of N" so a trimmed ranking can never
 * be misread as the whole range.
 */
const TOP_N = 10;

// Bar ends and the money axis are abbreviated so ten of them fit; the exact
// figure is a hover away.
const moneyShort = (x) => {
    const n = Math.round(Number(x) || 0);
    const abs = Math.abs(n);
    // 999_500 rather than a million: anything that would print as "Rs 1000k"
    // belongs in the next unit up.
    if (abs >= 999_500) return `Rs ${Number((n / 1_000_000).toFixed(2))}M`;
    if (abs < 1000) return `Rs ${n.toLocaleString('en-PK')}`;
    const k = n / 1000;
    return `Rs ${abs >= 100_000 ? Math.round(k) : Number(k.toFixed(1))}k`;
};

// A dish name has to survive the axis gutter; the tooltip carries it whole.
const TICK_MAX = 20;
const shortName = (s) => (String(s).length > TICK_MAX ? `${String(s).slice(0, TICK_MAX - 1)}…` : String(s));

/*
 * A category axis is keyed by the label, so two rows sharing one — the same
 * dish grouped under two categories — would land on the same band and one bar
 * would sit on top of the other. Clashes take their category as a suffix;
 * anything still identical after that gets trailing space, which the axis
 * doesn't show but the scale counts.
 */
const dedupeNames = (list, suffixOf) => {
    const counts = new Map();
    for (const r of list) counts.set(r.name, (counts.get(r.name) || 0) + 1);
    const used = new Set();
    return list.map((r) => {
        let name = r.name;
        if (counts.get(name) > 1) {
            const suffix = suffixOf(r);
            if (suffix) name = `${name} · ${suffix}`;
        }
        while (used.has(name)) name += ' ';
        used.add(name);
        return name === r.name ? r : { ...r, name };
    });
};

/*
 * One spec per tab, beside COLUMNS and for the same reason: the chart, its
 * heading and its tooltip all read the row through the same accessors, so
 * they cannot drift from each other or from the table.
 *
 * `value` is what the bar measures — and it is not always what the table is
 * sorted by. Top Items arrives ordered by quantity; ranked by revenue it
 * answers a different and more useful question, so the heading names the
 * measure rather than leaving it to be inferred from the order.
 */
const CHARTS = {
    mix: {
        title: 'Top items by qty sold',
        value: (r) => r.qty,
        label: itemLabel,
        format: num,
        sub: (r) => r.category,
        // What disambiguates two rows that share a name on the axis
        clash: (r) => r.category,
        rows: (r) => [
            ['Qty', num(r.qty)],
            ['% of qty', pct(r.qtyPct)],
            ['Revenue', money(r.revenue)],
        ],
    },
    items: {
        title: 'Top items by revenue',
        value: (r) => r.revenue,
        label: itemLabel,
        format: moneyShort,
        sub: (r) => r.category,
        clash: (r) => r.category,
        rows: (r) => [
            ['Revenue', money(r.revenue)],
            ['Qty', num(r.qty)],
        ],
    },
    modifiers: {
        title: 'Top modifiers by times chosen',
        value: (r) => r.count,
        label: (r) => r.name,
        format: num,
        sub: () => null,
        // Modifiers are grouped by name, so a clash can't happen
        clash: () => null,
        rows: (r) => [
            ['Times chosen', num(r.count)],
            ['Add-on revenue', money(r.revenue)],
        ],
    },
    voided: {
        title: 'Top voided items by qty',
        value: (r) => r.qty,
        label: itemLabel,
        format: num,
        sub: (r) => r.reasons || null,
        // Void reasons are the subtitle, never an axis suffix
        clash: () => null,
        rows: (r) => [
            ['Qty voided', num(r.qty)],
            ['Value', money(r.value)],
        ],
    },
};

const EMPTY_CHART = {
    mix: 'The range’s best sellers will be ranked here once something sells.',
    items: 'The range’s best sellers will be ranked here once something sells.',
    modifiers: 'Add-ons chosen in this range will be ranked here.',
    voided: 'Voided items will be ranked here — an empty chart is the good outcome.',
};

// "Top 10 of 34", or "All 7 rows" when nothing was left out.
const rankLabel = (shown, total) => (total > shown
    ? `Top ${shown} of ${total}`
    : `All ${total} ${total === 1 ? 'row' : 'rows'}`);

// Ten bars at 24px plus room for the axis; ResponsiveContainer collapses to
// nothing without a definite height on its parent.
const chartHeight = (count) => Math.max(150, count * 24 + 34);

/*
 * The default tooltip can only describe the plotted series. This one names
 * the row, keeps its category (or its void reasons) attached, and prints
 * every figure already formatted — never a raw float.
 */
function RankTooltip({ active, payload }) {
    if (!active || !payload || payload.length === 0) return null;
    const d = payload[0].payload;
    return (
        <div className={styles.tip}>
            <p className={styles.tipName}>{d.name}</p>
            {d.sub && <p className={styles.tipSub}>{d.sub}</p>}
            {d.tipRows.map(([label, value]) => (
                <p key={label} className={styles.tipRow}>
                    <span>{label}</span><span>{value}</span>
                </p>
            ))}
        </div>
    );
}

function ShareTooltip({ active, payload }) {
    if (!active || !payload || payload.length === 0) return null;
    const d = payload[0].payload;
    return (
        <div className={styles.tip}>
            <p className={styles.tipName}>{d.name}</p>
            {d.folded > 0 && (
                <p className={styles.tipSub}>
                    {d.folded} smaller {d.folded === 1 ? 'category' : 'categories'} folded in
                </p>
            )}
            <p className={styles.tipRow}><span>Revenue</span><span>{money(d.revenue)}</span></p>
            <p className={styles.tipRow}><span>Share</span><span>{pct(d.share)}</span></p>
        </div>
    );
}

/*
 * One column spec drives both the on-screen table and the CSV, so they can
 * never show different numbers. `value` is the raw figure (what a
 * spreadsheet wants); `display` is how the screen renders it.
 */
const COLUMNS = {
    mix: [
        { label: '#', value: (r, i) => i + 1 },
        { label: 'Item', value: itemLabel },
        { label: 'Category', value: (r) => r.category },
        { label: 'Qty', num: true, value: (r) => r.qty },
        { label: '% of qty', num: true, value: (r) => r.qtyPct.toFixed(1), display: (r) => pct(r.qtyPct) },
        { label: 'Revenue', num: true, value: (r) => r.revenue, display: (r) => money(r.revenue) },
        { label: '% of revenue', num: true, value: (r) => r.revenuePct.toFixed(1), display: (r) => pct(r.revenuePct) },
    ],
    items: [
        { label: '#', value: (r, i) => i + 1 },
        { label: 'Item', value: itemLabel },
        { label: 'Category', value: (r) => r.category },
        { label: 'Qty', num: true, value: (r) => r.qty },
        { label: 'Revenue', num: true, value: (r) => r.revenue, display: (r) => money(r.revenue) },
    ],
    modifiers: [
        { label: '#', value: (r, i) => i + 1 },
        { label: 'Modifier', value: (r) => r.name },
        { label: 'Times chosen', num: true, value: (r) => r.count },
        { label: 'Add-on revenue', num: true, value: (r) => r.revenue, display: (r) => money(r.revenue) },
    ],
    voided: [
        { label: '#', value: (r, i) => i + 1 },
        { label: 'Item', value: itemLabel },
        { label: 'Qty voided', num: true, value: (r) => r.qty },
        { label: 'Value', num: true, value: (r) => r.value, display: (r) => money(r.value) },
        { label: 'Reasons', value: (r) => r.reasons || '—', wrap: true },
    ],
};

const TABS = [
    { key: 'mix', label: 'Product Mix', rows: (d) => d.mix },
    { key: 'items', label: 'Top Items', rows: (d) => d.topItems },
    { key: 'modifiers', label: 'Top Modifiers', rows: (d) => d.topModifiers },
    { key: 'voided', label: 'Top Voided', rows: (d) => d.topVoided },
];

// Client-built CSV, downloaded via a Blob link — no deps, no round trip.
const downloadCsv = (filename, headers, rows) => {
    const esc = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
};

export default function MenuAnalyticsPage() {
    const [tab, setTab] = useState('mix');
    const [period, setPeriod] = useState('today');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isFetching, setIsFetching] = useState(false);

    const { from, to } = resolvePeriod(period, customFrom, customTo);

    // One fetch feeds all four tabs, so switching tabs is instant and every
    // tab describes the same range.
    useEffect(() => {
        if (!from || !to) return;
        let stale = false;
        setIsFetching(true);
        setError('');
        productMix(from, to)
            // Actions return {error} rather than throwing; a rejection here
            // means the request itself never made it.
            .catch(() => ({ error: 'Could not reach the server' }))
            .then((res) => {
                if (stale) return;
                if (res.error) setError(res.error);
                else setData(res.data);
                setIsLoading(false);
                setIsFetching(false);
            });
        return () => { stale = true; };
    }, [from, to]);

    const activeTab = TABS.find((t) => t.key === tab);
    const columns = COLUMNS[tab];
    const rows = useMemo(
        () => (data ? activeTab.rows(data) : []),
        [data, activeTab],
    );

    /*
     * The chart's own ordering, not the table's: a bar chart whose longest bar
     * is third from the top is a broken chart. Mapped before sorting so the
     * table's rows are never reordered underneath it.
     */
    const chartSpec = CHARTS[tab];
    const chartRows = useMemo(() => dedupeNames(
        rows
            .map((r) => ({
                name: chartSpec.label(r),
                sub: chartSpec.sub(r),
                clash: chartSpec.clash(r),
                value: chartSpec.value(r),
                tipRows: chartSpec.rows(r),
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, TOP_N),
        (r) => r.clash,
    ), [rows, chartSpec]);

    /*
     * Revenue share by category — bars rather than a pie, because a kitchen
     * runs to more than three categories and a pie stops being readable at
     * four. Everything past the palette's six slots folds into one neutral
     * "Other" rather than inventing hues nobody validated.
     */
    const categoryShare = useMemo(() => {
        if (tab !== 'mix' || !data) return [];
        const totals = new Map();
        for (const r of data.mix) {
            totals.set(r.category, (totals.get(r.category) || 0) + r.revenue);
        }
        const all = [...totals.entries()]
            .map(([name, revenue]) => ({ name, revenue }))
            .sort((a, b) => b.revenue - a.revenue);
        const total = all.reduce((s, c) => s + c.revenue, 0);
        const tail = all.slice(SLOTS.length);
        const shown = tail.length > 0
            ? [
                ...all.slice(0, SLOTS.length),
                {
                    name: 'Other',
                    revenue: tail.reduce((s, c) => s + c.revenue, 0),
                    folded: tail.length,
                },
            ]
            : all;
        return shown.map((c, i) => ({
            ...c,
            folded: c.folded || 0,
            share: total > 0 ? (c.revenue / total) * 100 : 0,
            color: c.folded ? OTHER : SLOTS[i],
        }));
    }, [tab, data]);

    const exportCsv = () => {
        if (!data) return;
        downloadCsv(
            `menu-${tab}-${data.range.from}-to-${data.range.to}.csv`,
            columns.map((c) => c.label),
            rows.map((r, i) => columns.map((c) => c.value(r, i))),
        );
    };

    return (
        <div className={`${styles.container} print-root`}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Menu Analytics</h1>
                    <p className={styles.subtitle}>
                        What sold, what rode along with it, and what got voided — settled orders only.
                    </p>
                </div>

                <PrintButton />

                <div className={styles.filters}>
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            className={`${styles.filterTab} ${tab === t.key ? styles.active : ''}`}
                            onClick={() => setTab(t.key)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className={styles.toolbar}>
                <label className={styles.control}>
                    <CalendarRange size={14} aria-hidden="true" />
                    <select
                        className={styles.select}
                        value={period}
                        onChange={(e) => setPeriod(e.target.value)}
                        aria-label="Business-date period"
                    >
                        {PERIODS.map((p) => (
                            <option key={p.key} value={p.key}>{p.label}</option>
                        ))}
                    </select>
                </label>

                {period === 'custom' && (
                    <div className={styles.dateRange}>
                        <input
                            type="date"
                            className={styles.dateInput}
                            value={customFrom}
                            max={customTo || undefined}
                            onChange={(e) => setCustomFrom(e.target.value)}
                            aria-label="From business date"
                        />
                        <span className={styles.dateSep}>to</span>
                        <input
                            type="date"
                            className={styles.dateInput}
                            value={customTo}
                            min={customFrom || undefined}
                            onChange={(e) => setCustomTo(e.target.value)}
                            aria-label="To business date"
                        />
                    </div>
                )}

                {data && (
                    <span className={styles.rangeNote}>
                        {data.range.from === data.range.to
                            ? data.range.from
                            : `${data.range.from} → ${data.range.to}`}
                        {' · '}{data.totals.qty.toLocaleString('en-PK')} items
                        {' · '}{money(data.totals.revenue)}
                    </span>
                )}

                <div className={styles.toolbarRight}>
                    {isFetching && !isLoading && <Loader2 className={styles.inlineSpinner} size={13} />}
                    <button
                        type="button"
                        className={styles.exportBtn}
                        onClick={exportCsv}
                        disabled={!data || rows.length === 0}
                    >
                        <Download size={13} aria-hidden="true" />
                        Export CSV
                    </button>
                </div>
            </div>

            {!error && !isLoading && data && (
                <div
                    className={[
                        styles.chartRow,
                        tab === 'mix' ? styles.chartRowSplit : '',
                        isFetching ? styles.stale : '',
                    ].join(' ').trim()}
                >
                    <section className={styles.chartCard}>
                        <div className={styles.chartHead}>
                            <h2 className={styles.chartTitle}>{chartSpec.title}</h2>
                            {rows.length > 0 && (
                                <span className={styles.chartMeta}>
                                    {rankLabel(TOP_N, rows.length)}
                                </span>
                            )}
                        </div>

                        {chartRows.length === 0 ? (
                            /* A bordered placeholder, not an empty axis frame: it
                               says what would be here rather than looking broken. */
                            <div className={styles.chartEmpty}>{EMPTY_CHART[tab]}</div>
                        ) : (
                            <div style={{ height: chartHeight(chartRows.length) }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart
                                        layout="vertical"
                                        data={chartRows}
                                        margin={{ top: 0, right: 68, bottom: 0, left: 0 }}
                                        barCategoryGap={4}
                                    >
                                        {/* Rules only on the value axis; the category
                                            side is already spelled out in words. */}
                                        <CartesianGrid horizontal={false} stroke={GRID} strokeDasharray="3 3" />
                                        <XAxis
                                            type="number"
                                            domain={[0, 'dataMax']}
                                            allowDecimals={false}
                                            tickFormatter={chartSpec.format}
                                            tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            type="category"
                                            dataKey="name"
                                            width={140}
                                            tickFormatter={shortName}
                                            tick={{ fill: LABEL_TEXT, fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <Tooltip
                                            cursor={CURSOR_FILL}
                                            content={<RankTooltip />}
                                        />
                                        <Bar
                                            dataKey="value"
                                            fill={SERIES}
                                            radius={[0, 4, 4, 0]}
                                            maxBarSize={20}
                                            isAnimationActive={false}
                                        >
                                            <LabelList
                                                dataKey="value"
                                                position="right"
                                                offset={8}
                                                formatter={chartSpec.format}
                                                fill={LABEL_TEXT}
                                                fontSize={11}
                                            />
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </section>

                    {tab === 'mix' && (
                        <section className={styles.chartCard}>
                            <div className={styles.chartHead}>
                                <h2 className={styles.chartTitle}>Revenue share by category</h2>
                                {categoryShare.length > 0 && (
                                    <span className={styles.chartMeta}>
                                        {categoryShare.some((c) => c.folded > 0)
                                            ? `Top ${SLOTS.length} + Other`
                                            : `All ${categoryShare.length} ${categoryShare.length === 1 ? 'category' : 'categories'}`}
                                    </span>
                                )}
                            </div>

                            {categoryShare.length === 0 ? (
                                <div className={styles.chartEmpty}>
                                    Each category’s share of the range’s revenue will appear here.
                                </div>
                            ) : (
                                <>
                                    <div style={{ height: chartHeight(categoryShare.length) }}>
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart
                                                layout="vertical"
                                                data={categoryShare}
                                                margin={{ top: 0, right: 56, bottom: 0, left: 0 }}
                                                barCategoryGap={4}
                                            >
                                                <CartesianGrid horizontal={false} stroke={GRID} strokeDasharray="3 3" />
                                                <XAxis
                                                    type="number"
                                                    domain={[0, 'dataMax']}
                                                    allowDecimals={false}
                                                    tickFormatter={(v) => `${Math.round(v)}%`}
                                                    tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                                                    tickLine={false}
                                                    axisLine={false}
                                                />
                                                <YAxis
                                                    type="category"
                                                    dataKey="name"
                                                    width={140}
                                                    tickFormatter={shortName}
                                                    tick={{ fill: LABEL_TEXT, fontSize: 11 }}
                                                    tickLine={false}
                                                    axisLine={false}
                                                />
                                                <Tooltip
                                                    cursor={CURSOR_FILL}
                                                    content={<ShareTooltip />}
                                                />
                                                <Bar
                                                    dataKey="share"
                                                    radius={[0, 4, 4, 0]}
                                                    maxBarSize={20}
                                                    isAnimationActive={false}
                                                >
                                                    {categoryShare.map((c) => (
                                                        <Cell key={c.name} fill={c.color} />
                                                    ))}
                                                    <LabelList
                                                        dataKey="share"
                                                        position="right"
                                                        offset={8}
                                                        formatter={pct}
                                                        fill={LABEL_TEXT}
                                                        fontSize={11}
                                                    />
                                                </Bar>
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>

                                    {/* Six or fewer series, so they get a legend and
                                        their labels: the swatch ties the two together. */}
                                    <ul className={styles.legend}>
                                        {categoryShare.map((c) => (
                                            <li key={c.name} className={styles.legendItem}>
                                                <span
                                                    className={styles.swatch}
                                                    style={{ background: c.color }}
                                                    aria-hidden="true"
                                                />
                                                {c.name}
                                                {c.folded > 0 && (
                                                    <span className={styles.legendNote}>
                                                        {c.folded} more
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                        </section>
                    )}
                </div>
            )}

            {error ? (
                <div className={styles.stateBlock}>
                    <AlertTriangle size={32} />
                    <p>{error}</p>
                </div>
            ) : isLoading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Crunching the menu…</p>
                </div>
            ) : rows.length === 0 ? (
                <div className={styles.stateBlock}>
                    <UtensilsCrossed size={32} />
                    <p>
                        {tab === 'voided'
                            ? 'Nothing voided in this range.'
                            : 'Nothing sold in this range.'}
                    </p>
                </div>
            ) : (
                <div className={`${styles.listWrap} ${isFetching ? styles.stale : ''}`}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                {columns.map((c) => (
                                    <th key={c.label} className={c.num ? styles.alignRight : undefined}>
                                        {c.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r, i) => (
                                <tr key={`${itemLabel(r)}-${i}`}>
                                    {columns.map((c) => (
                                        <td
                                            key={c.label}
                                            className={[
                                                c.num ? styles.alignRight : '',
                                                c.wrap ? styles.cellWrap : '',
                                                c.label === '#' ? styles.cellMuted : '',
                                            ].join(' ').trim() || undefined}
                                        >
                                            {(c.display || c.value)(r, i)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

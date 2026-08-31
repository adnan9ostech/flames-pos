'use client';
import { useState, useEffect, useMemo } from 'react';
import styles from './menuAnalytics.module.css';
import { productMix } from './actions';
import {
    UtensilsCrossed, CalendarRange, Download, Loader2, AlertTriangle,
} from 'lucide-react';

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
const itemLabel = (r) => (r.variant ? `${r.name} (${r.variant})` : r.name);

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

    const exportCsv = () => {
        if (!data) return;
        downloadCsv(
            `menu-${tab}-${data.range.from}-to-${data.range.to}.csv`,
            columns.map((c) => c.label),
            rows.map((r, i) => columns.map((c) => c.value(r, i))),
        );
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Menu Analytics</h1>
                    <p className={styles.subtitle}>
                        What sold, what rode along with it, and what got voided — settled orders only.
                    </p>
                </div>

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

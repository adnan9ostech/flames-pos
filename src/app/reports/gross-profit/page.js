'use client';
import { useState, useEffect } from 'react';
import styles from './grossProfit.module.css';
import { grossProfit } from './actions';
import {
    UtensilsCrossed, CalendarRange, Loader2, AlertTriangle,
} from 'lucide-react';

/*
 * Business dates on the Karachi calendar, matching orders.business_date —
 * the browser's own timezone never gets a say.
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
// Recipe costs carry paisa; whole rupees would round a Rs. 12.40 naan to 12.
const cost = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

export default function GrossProfitPage() {
    const [period, setPeriod] = useState('today');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isFetching, setIsFetching] = useState(false);

    const { from, to } = resolvePeriod(period, customFrom, customTo);

    useEffect(() => {
        if (!from || !to) return;
        let stale = false;
        setIsFetching(true);
        setError('');
        grossProfit(from, to)
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

    const items = data?.items || [];
    const totals = data?.totals;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Gross Profit</h1>
                    <p className={styles.subtitle}>
                        Revenue against recipe cost per dish, worst margin first — settled orders only.
                    </p>
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
                    </span>
                )}

                <div className={styles.toolbarRight}>
                    {isFetching && !isLoading && <Loader2 className={styles.inlineSpinner} size={13} />}
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
                    <p>Costing the menu…</p>
                </div>
            ) : items.length === 0 ? (
                <div className={styles.stateBlock}>
                    <UtensilsCrossed size={32} />
                    <p>Nothing sold in this range.</p>
                </div>
            ) : (
                <>
                    {totals.uncostedCount > 0 && (
                        <div className={styles.coverageNote}>
                            <AlertTriangle size={14} aria-hidden="true" />
                            {totals.uncostedCount} {totals.uncostedCount === 1 ? 'dish has' : 'dishes have'} no
                            recipe — {money(totals.uncostedRevenue)} of revenue is uncosted and sits outside
                            the COGS and margin figures below.
                        </div>
                    )}

                    <div className={`${styles.listWrap} ${isFetching ? styles.stale : ''}`}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Item</th>
                                    <th className={styles.alignRight}>Qty sold</th>
                                    <th className={styles.alignRight}>Revenue</th>
                                    <th className={styles.alignRight}>Cost each</th>
                                    <th className={styles.alignRight}>Total cost</th>
                                    <th className={styles.alignRight}>Margin</th>
                                    <th className={styles.alignRight}>Margin %</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((item) => (
                                    <tr key={item.name}>
                                        <td className={styles.cellStrong}>{item.name}</td>
                                        <td className={styles.alignRight}>{item.qtySold.toLocaleString('en-PK')}</td>
                                        <td className={styles.alignRight}>{money(item.revenue)}</td>
                                        {item.hasRecipe ? (
                                            <>
                                                <td className={styles.alignRight}>{cost(item.unitCost)}</td>
                                                <td className={styles.alignRight}>{cost(item.totalCost)}</td>
                                                <td className={`${styles.alignRight} ${item.margin < 0 ? styles.negative : ''}`}>
                                                    {money(item.margin)}
                                                </td>
                                                <td className={`${styles.alignRight} ${item.margin < 0 ? styles.negative : ''}`}>
                                                    {item.marginPct === null ? '—' : pct(item.marginPct)}
                                                </td>
                                            </>
                                        ) : (
                                            <>
                                                <td className={styles.alignRight}>
                                                    <span className={styles.noRecipe}>no recipe</span>
                                                </td>
                                                <td className={`${styles.alignRight} ${styles.cellMuted}`}>—</td>
                                                <td className={`${styles.alignRight} ${styles.cellMuted}`}>—</td>
                                                <td className={`${styles.alignRight} ${styles.cellMuted}`}>—</td>
                                            </>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr>
                                    <td>Totals</td>
                                    <td className={styles.alignRight}>{totals.qtySold.toLocaleString('en-PK')}</td>
                                    <td className={styles.alignRight}>{money(totals.revenue)}</td>
                                    <td className={styles.alignRight}></td>
                                    <td className={styles.alignRight}>{cost(totals.cogs)}</td>
                                    <td className={`${styles.alignRight} ${totals.margin < 0 ? styles.negative : ''}`}>
                                        {money(totals.margin)}
                                    </td>
                                    <td className={`${styles.alignRight} ${totals.margin < 0 ? styles.negative : ''}`}>
                                        {totals.marginPct === null ? '—' : pct(totals.marginPct)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}

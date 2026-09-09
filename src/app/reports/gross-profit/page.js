'use client';
import { useState, useEffect } from 'react';
import styles from './grossProfit.module.css';
import { grossProfit } from './actions';
import {
    BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
    UtensilsCrossed, CalendarRange, Loader2, AlertTriangle,
} from 'lucide-react';
/* Chart tokens. Single series, so slot 2 of the categorical palette — the
   brand orange is chrome, and a chart drawn in it reads as a button. */
import { SERIES, AXIS_TEXT, GRID, LABEL_TEXT, CURSOR_FILL } from '@/lib/reports/chartTheme.mjs';

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

// The owner acts on a handful of dishes, not on a hundred.
const CHART_ROWS = 10;

// Dish names run long; the axis truncates, the tooltip shows the whole thing.
const shortName = (s) => (String(s).length > 22 ? `${String(s).slice(0, 21)}…` : String(s));

/*
 * Hover shows the whole costing for the bar, formatted — a bare margin
 * percentage is the one number that can't be checked without the others.
 */
function MarginTooltip({ active, payload }) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
        <div className={styles.tooltip}>
            <div className={styles.tooltipName}>{d.name}</div>
            <div className={styles.tooltipRow}><span>Margin</span><span>{pct(d.marginPct)}</span></div>
            <div className={styles.tooltipRow}><span>Margin value</span><span>{money(d.margin)}</span></div>
            <div className={styles.tooltipRow}><span>Revenue</span><span>{money(d.revenue)}</span></div>
            <div className={styles.tooltipRow}><span>Recipe cost</span><span>{cost(d.totalCost)}</span></div>
            <div className={styles.tooltipRow}>
                <span>Sold</span><span>{Number(d.qtySold || 0).toLocaleString('en-PK')}</span>
            </div>
        </div>
    );
}

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

    /*
     * The chart plots margins, so only dishes that HAVE a margin can be on it:
     * a dish with no recipe has an unknown cost, not a zero one, and drawing it
     * at 100% would be the most flattering lie on the page. Same for a dish
     * that sold for nothing (comped) — there is no revenue to take a
     * percentage of. Both are counted in the footnote instead.
     * Rows arrive worst-margin first, so the head of the list is the chart.
     */
    const costedItems = items.filter((i) => i.hasRecipe && i.marginPct !== null);
    const chartItems = costedItems.slice(0, CHART_ROWS);
    const excludedNoRecipe = items.filter((i) => !i.hasRecipe).length;
    const excludedNoRevenue = items.length - costedItems.length - excludedNoRecipe;
    const chartHeight = Math.max(140, chartItems.length * 30 + 24);

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

                    <div className={`${styles.summary} ${isFetching ? styles.stale : ''}`}>
                        <div className={styles.tiles}>
                            <div className={styles.tile}>
                                <span className={styles.tileLabel}>Revenue</span>
                                <span className={styles.tileValue}>{money(totals.revenue)}</span>
                                <span className={styles.tileSub}>
                                    {totals.qtySold.toLocaleString('en-PK')} items sold
                                </span>
                            </div>
                            <div className={styles.tile}>
                                <span className={styles.tileLabel}>COGS</span>
                                <span className={styles.tileValue}>{cost(totals.cogs)}</span>
                                <span className={styles.tileSub}>recipes at today&apos;s ingredient cost</span>
                            </div>
                            <div className={styles.tile}>
                                <span className={styles.tileLabel}>Gross profit</span>
                                <span className={`${styles.tileValue} ${totals.margin < 0 ? styles.negative : ''}`}>
                                    {money(totals.margin)}
                                </span>
                                <span className={styles.tileSub}>
                                    {/* Null, not zero, when nothing costed sold — never 0/0. */}
                                    {totals.marginPct === null
                                        ? 'no costed sales to measure'
                                        : `${pct(totals.marginPct)} margin on costed sales`}
                                </span>
                            </div>
                        </div>

                        <div className={styles.chartCard}>
                            <h2 className={styles.chartTitle}>
                                Worst margins
                                {chartItems.length > 0 && (
                                    <span className={styles.chartTitleNote}>
                                        {chartItems.length === 1
                                            ? 'the thinnest costed dish'
                                            : `the ${chartItems.length} thinnest costed dishes`}
                                    </span>
                                )}
                            </h2>

                            {chartItems.length === 0 ? (
                                <div className={styles.chartEmpty}>
                                    Margin by dish appears here once a dish that sold has a recipe costed.
                                </div>
                            ) : (
                                <ResponsiveContainer width="100%" height={chartHeight}>
                                    <BarChart
                                        data={chartItems}
                                        layout="vertical"
                                        margin={{ top: 4, right: 60, bottom: 4, left: 0 }}
                                    >
                                        {/* Value runs across, so the grid does too; no horizontal rules
                                            between bars, they only fence the categories in. */}
                                        <CartesianGrid horizontal={false} stroke={GRID} />
                                        <XAxis
                                            type="number"
                                            tickFormatter={(v) => `${v}%`}
                                            tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                                            axisLine={false}
                                            tickLine={false}
                                        />
                                        <YAxis
                                            type="category"
                                            dataKey="name"
                                            width={150}
                                            tickFormatter={shortName}
                                            tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                                            axisLine={false}
                                            tickLine={false}
                                        />
                                        <Tooltip cursor={CURSOR_FILL} content={<MarginTooltip />} />
                                        {/* No entry animation: recharts holds the value
                                            labels back until it finishes, and this chart is
                                            re-rendered on every change of period. */}
                                        <Bar
                                            dataKey="marginPct"
                                            barSize={14}
                                            radius={[0, 4, 4, 0]}
                                            isAnimationActive={false}
                                        >
                                            {chartItems.map((i, idx) => (
                                                // A loss-making dish grows leftward, so the rounded end
                                                // has to follow the data rather than sit on the baseline.
                                                // Keyed by position: two menu items can share a name.
                                                <Cell
                                                    key={`${i.name}-${idx}`}
                                                    fill={SERIES}
                                                    radius={i.marginPct < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0]}
                                                />
                                            ))}
                                            <LabelList
                                                dataKey="marginPct"
                                                position="right"
                                                formatter={(v) => pct(v)}
                                                fill={LABEL_TEXT}
                                                fontSize={11}
                                            />
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            )}

                            {(excludedNoRecipe > 0 || excludedNoRevenue > 0) && (
                                <p className={styles.chartFootnote}>
                                    {excludedNoRecipe > 0 && (
                                        <>
                                            {excludedNoRecipe} {excludedNoRecipe === 1 ? 'dish is' : 'dishes are'} left
                                            off this chart for having no recipe — an uncosted dish has an unknown
                                            margin, not a 100% one.
                                        </>
                                    )}
                                    {excludedNoRecipe > 0 && excludedNoRevenue > 0 && ' '}
                                    {excludedNoRevenue > 0 && (
                                        <>
                                            {excludedNoRevenue} more sold for nothing, so there is no revenue to take a
                                            percentage of.
                                        </>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>

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

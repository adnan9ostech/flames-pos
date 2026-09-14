'use client';
import { useState, useEffect, useRef } from 'react';
import { useBrand } from '@/components/Layout/BrandProvider';
import styles from './handover.module.css';
import { getHandoverReport } from './actions';
import { formatDateTime, formatClockTime } from '@/lib/timeFormat';
import {
    BarChart, Bar, Cell, LabelList, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { AlertTriangle, Flame, Loader2, Printer, FileDown } from 'lucide-react';
/* The categorical palette in its fixed slot order — never re-ordered, never
   cycled. GAIN/LOSS below are slots 3 and 5, kept for the bottom line. */
import { SLOTS, GAIN, LOSS, AXIS_TEXT, LABEL_TEXT, CURSOR_FILL } from '@/lib/reports/chartTheme.mjs';

const TYPE_LABEL = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
const METHOD_LABEL = { cash: 'Cash', card: 'Card', city_ledger: 'City Ledger' };

const money = (x) => `Rs. ${Number(x || 0).toLocaleString('en-PK')}`;
// A minus sign rather than a hyphen, and never "Rs. -1,200" mid-string.
const signedMoney = (x) => (Number(x) < 0 ? `− ${money(Math.abs(x))}` : money(x));

/* Explicit pixel heights: the charts are sized in JS from these, and print
   inherits the same numbers. Both stay under the 160px the one-pager can
   spare. */
const PAY_CHART_H = 108;
const PROFIT_CHART_H = 132;

// Bar labels are abbreviated; the exact rupees are in the rows above them.
const compactMoney = (n) => {
    // Whole rupees first, so 999.60 doesn't print "Rs 1000" next to "Rs 1k".
    const v = Math.round(Math.abs(Number(n) || 0));
    const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
    if (v >= 1_000_000) return `Rs ${trim(v / 1_000_000)}m`;
    if (v >= 1_000) return `Rs ${trim(v / 1_000)}k`;
    return `Rs ${Math.round(v)}`;
};
const signedCompact = (n) => (Number(n) < 0 ? `− ${compactMoney(n)}` : compactMoney(n));

function ChartTooltip({ active, payload }) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
        <div className={styles.chartTip}>
            <span className={styles.chartTipLabel}>{d.label}</span>
            <span className={styles.chartTipValue}>{signedMoney(d.value)}</span>
        </div>
    );
}

/*
 * One compact horizontal bar per row, each labelled with its own amount, so
 * the chart reads the same in colour on screen and in black ink on paper.
 *
 * Bar length is the SIZE of the amount and the label carries the sign: a
 * four-step profit walk with one negative step would otherwise spend half its
 * width on an axis nobody reads at this size. There is no value axis for the
 * same reason — the labels are the axis.
 */
function MiniBars({ rows, height, yWidth = 74 }) {
    return (
        // Inline px, not a percentage: a ResponsiveContainer in a box of
        // unknown height renders nothing at all, on screen or on paper.
        <div className={`${styles.chartBox} handover-chart`} style={{ height }}>
            <ResponsiveContainer width="100%" height={height}>
                <BarChart data={rows} layout="vertical" margin={{ top: 2, right: 66, bottom: 2, left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis
                        type="category"
                        dataKey="label"
                        width={yWidth}
                        tick={{ fill: AXIS_TEXT, fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                    />
                    <Tooltip cursor={CURSOR_FILL} content={<ChartTooltip />} />
                    {/* No entry animation: the bars must be fully drawn the
                        moment someone hits Print. */}
                    <Bar dataKey="magnitude" barSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                        {rows.map((row) => <Cell key={row.label} fill={row.fill} />)}
                        <LabelList
                            dataKey="value"
                            position="right"
                            formatter={signedCompact}
                            fill={LABEL_TEXT}
                            fontSize={10}
                        />
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}

// "Sunday, 31 August 2026" — the report is ABOUT this date, so it reads in full
const formatBusinessDay = (ymd) =>
    new Date(`${ymd}T00:00:00`).toLocaleDateString('en-PK', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

/*
 * The CSV is the flat numbers only — one metric per row, raw values, no
 * currency formatting — so it can be pasted straight into the owner's sheet.
 */
const buildCsv = (r) => {
    const rows = [
        ['metric', 'value'],
        ['business_date', r.businessDate],
        ['bills', r.sales.bills],
        ['items_sold', r.sales.itemsSold],
        ['gross_sales', r.sales.gross],
        ['discounts', r.sales.discounts],
        ['net_sales', r.sales.net],
        ['charges', r.sales.charges],
        ['tax', r.sales.tax],
        ['revenue', r.sales.revenue],
    ];
    r.orderTypes.forEach((t) => {
        rows.push([`orders_${t.type}_count`, t.count], [`orders_${t.type}_revenue`, t.revenue]);
    });
    r.payments.forEach((p) => {
        rows.push([`paid_${p.method}_amount`, p.amount], [`paid_${p.method}_count`, p.count]);
        if (p.refunds !== 0) rows.push([`refunds_${p.method}`, p.refunds]);
    });
    r.taxByMode.forEach((t) => rows.push([`tax_${t.mode || 'unrecorded'}`, t.tax]));
    rows.push(['voided_count', r.voided.count], ['voided_amount', r.voided.amount]);
    rows.push(['expenses_total', r.expenses.total]);
    r.expenses.byCategory.forEach((c) => rows.push([`expenses_${c.category}`, c.amount]));
    r.drawerSessions.forEach((s, i) => {
        const key = `drawer_${s.cashier_role}_${i + 1}`;
        rows.push(
            [`${key}_expected`, s.expected ?? ''],
            [`${key}_counted`, s.counted ?? ''],
            [`${key}_variance`, s.variance ?? ''],
        );
    });
    rows.push(
        ['cogs', r.profit.cogs],
        ['gross_profit', r.profit.grossProfit],
        ['net_profit', r.profit.netProfit],
    );
    const escape = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return rows.map((row) => row.map(escape).join(',')).join('\n');
};

function StatRow({ label, sub, value, big = false, tone = '' }) {
    return (
        <div className={`${styles.statRow} ${big ? styles.bigRow : ''}`}>
            <span className={styles.statLabel}>
                {label}
                {sub && <span className={styles.statSub}>{sub}</span>}
            </span>
            <span className={`${styles.statValue} ${tone ? styles[tone] : ''}`}>{value}</span>
        </div>
    );
}

export default function HandoverReportPage() {
    const brand = useBrand();
    const [report, setReport] = useState(null);
    const [date, setDate] = useState('');
    const [loading, setLoading] = useState(true);
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState('');

    // First load asks the server which day to show (the open business day);
    // after that the picker drives the query. The ref remembers what was
    // last fetched so seeding the picker doesn't refetch the same day.
    const fetchedFor = useRef(undefined);

    useEffect(() => {
        if (fetchedFor.current === date) return;
        let cancelled = false;
        setFetching(true);
        getHandoverReport(date || null).then((res) => {
            if (cancelled) return;
            if (res.error) {
                setError(res.error);
            } else {
                setError('');
                setReport(res.data);
                fetchedFor.current = res.data.businessDate;
                if (!date) setDate(res.data.businessDate);
            }
            setLoading(false);
            setFetching(false);
        });
        return () => { cancelled = true; };
    }, [date]);

    const handleCsv = () => {
        if (!report) return;
        const blob = new Blob([buildCsv(report)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `handover-${report.businessDate}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    if (loading) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading handover report…</p>
                </div>
            </div>
        );
    }

    if (error && !report) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <AlertTriangle size={32} />
                    <p>{error}</p>
                </div>
            </div>
        );
    }

    const r = report;
    const paymentsNet = r.payments.reduce((sum, p) => sum + p.amount + p.refunds, 0);

    /*
     * Takings by method, biggest first, palette slots handed out in that
     * order. Reversals are not netted off here — the card lists them as their
     * own rows, and a bar that quietly shrank would disagree with it.
     * `method` is a three-value enum, so the slots can never run out.
     */
    const paymentBars = r.payments
        .filter((p) => p.amount > 0)
        .map((p) => ({
            label: METHOD_LABEL[p.method] || p.method,
            value: p.amount,
            magnitude: p.amount,
        }))
        .sort((a, b) => b.value - a.value)
        .map((row, i) => ({ ...row, fill: SLOTS[Math.min(i, SLOTS.length - 1)] }));

    // Net sales, minus what the food cost, minus what the day cost to run.
    const profitSteps = [
        { label: 'Net sales', value: r.sales.net, fill: SLOTS[0] },
        { label: 'COGS', value: -r.profit.cogs, fill: SLOTS[1] },
        { label: 'Expenses', value: -r.expenses.total, fill: SLOTS[1] },
        // Colour is the second cue only; the label is signed either way.
        { label: 'Net profit', value: r.profit.netProfit, fill: r.profit.netProfit < 0 ? LOSS : GAIN },
    ].map((s) => ({ ...s, magnitude: Math.abs(s.value) }));
    const dayTraded = profitSteps.some((s) => s.magnitude > 0);

    return (
        <div className={styles.container} id="handover-root">
            <div className={`${styles.toolbar} no-print`}>
                <div>
                    <h1 className={styles.title}>Handover Report</h1>
                    <p className={styles.subtitle}>The night&apos;s numbers on one page, ready to print or export.</p>
                </div>
                <div className={styles.controls}>
                    {fetching && <Loader2 className={styles.inlineSpinner} size={16} aria-hidden="true" />}
                    <input
                        type="date"
                        className={styles.dateInput}
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        aria-label="Business day"
                    />
                    <button type="button" className={styles.toolBtn} onClick={() => window.print()}>
                        <Printer size={15} aria-hidden="true" />
                        Print
                    </button>
                    <button type="button" className={styles.toolBtn} onClick={handleCsv}>
                        <FileDown size={15} aria-hidden="true" />
                        CSV
                    </button>
                </div>
            </div>

            {error && (
                <div className={styles.stateBlock}>
                    <AlertTriangle size={20} />
                    <p>{error}</p>
                </div>
            )}

            <div className={fetching ? styles.stale : undefined}>
                <div className={styles.masthead}>
                    <div className={styles.mastheadName}>
                        <Flame size={20} aria-hidden="true" />
                        {brand.name}. Handover
                    </div>
                    <div className={styles.mastheadMeta}>
                        {formatBusinessDay(r.businessDate)} · Generated {formatDateTime(new Date())}
                    </div>
                </div>

                <div className={styles.statGrid}>
                    {/* Sales */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Sales</h2>
                        <StatRow label="Bills" value={r.sales.bills} />
                        <StatRow label="Items sold" value={r.sales.itemsSold} />
                        <StatRow label="Gross sales" value={money(r.sales.gross)} />
                        <StatRow label="Discounts" value={`− ${money(r.sales.discounts)}`} tone={r.sales.discounts > 0 ? 'negative' : ''} />
                        <StatRow label="Net sales" value={money(r.sales.net)} />
                        <StatRow label="Charges" value={money(r.sales.charges)} />
                        <StatRow label="Tax" value={money(r.sales.tax)} />
                        <StatRow label="Revenue" sub="billed totals, paid and open" value={money(r.sales.revenue)} big />
                    </div>

                    {/* Order types */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Order Types</h2>
                        {r.orderTypes.length === 0 ? (
                            <p className={styles.emptyNote}>No orders on this day.</p>
                        ) : r.orderTypes.map((t) => (
                            <StatRow
                                key={t.type}
                                label={TYPE_LABEL[t.type] || t.type}
                                sub={`${t.count} order${t.count === 1 ? '' : 's'}`}
                                value={money(t.revenue)}
                            />
                        ))}
                    </div>

                    {/* Payments */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Payments Taken</h2>
                        {r.payments.length === 0 ? (
                            <p className={styles.emptyNote}>Nothing settled on this day.</p>
                        ) : (
                            <>
                                {r.payments.map((p) => (
                                    <StatRow
                                        key={p.method}
                                        label={METHOD_LABEL[p.method] || p.method}
                                        sub={`${p.count} payment${p.count === 1 ? '' : 's'}`}
                                        value={money(p.amount)}
                                    />
                                ))}
                                {r.payments.filter((p) => p.refunds !== 0).map((p) => (
                                    <StatRow
                                        key={`${p.method}-refunds`}
                                        label={`${METHOD_LABEL[p.method] || p.method} refunds`}
                                        sub={`${p.refundCount} reversal${p.refundCount === 1 ? '' : 's'}`}
                                        value={money(p.refunds)}
                                        tone="negative"
                                    />
                                ))}
                                <StatRow label="Net collected" value={money(paymentsNet)} big />
                                {paymentBars.length === 0 ? (
                                    <p className={styles.chartEmpty}>
                                        The split by method appears here once money is taken.
                                    </p>
                                ) : (
                                    <MiniBars rows={paymentBars} height={PAY_CHART_H} />
                                )}
                            </>
                        )}
                    </div>

                    {/* Tax by payment mode */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Tax by Payment Mode</h2>
                        {r.taxByMode.length === 0 ? (
                            <p className={styles.emptyNote}>No settled tax on this day.</p>
                        ) : r.taxByMode.map((t) => (
                            <StatRow
                                key={t.mode || 'unrecorded'}
                                label={METHOD_LABEL[t.mode] || t.mode || 'Unrecorded'}
                                value={money(t.tax)}
                            />
                        ))}
                    </div>

                    {/* Voided orders */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Voided Orders</h2>
                        <StatRow label="Voids" sub={money(r.voided.amount)} value={r.voided.count} />
                        {r.voided.orders.length > 0 && (
                            <div className={styles.tableWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Order</th>
                                            <th>Reason</th>
                                            <th>By</th>
                                            <th className={styles.alignRight}>Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {r.voided.orders.map((v, idx) => (
                                            <tr key={`${v.order_number}-${idx}`}>
                                                <td>#{v.order_number}</td>
                                                <td className={styles.cellMuted}>{v.cancel_reason || '—'}</td>
                                                <td className={styles.cellMuted}>{v.cancelled_by || '—'}</td>
                                                <td className={styles.alignRight}>{money(v.total)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Expenses */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Expenses</h2>
                        {r.expenses.byCategory.length === 0 ? (
                            <p className={styles.emptyNote}>No expenses recorded.</p>
                        ) : r.expenses.byCategory.map((c) => (
                            <StatRow key={c.category} label={c.category} value={money(c.amount)} />
                        ))}
                        <StatRow label="Total expenses" value={money(r.expenses.total)} big />
                    </div>

                    {/* Drawer sessions */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Drawer Sessions</h2>
                        {r.drawerSessions.length === 0 ? (
                            <p className={styles.emptyNote}>No drawer sessions on this day.</p>
                        ) : (
                            <div className={styles.tableWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Cashier</th>
                                            <th>Opened</th>
                                            <th className={styles.alignRight}>Expected</th>
                                            <th className={styles.alignRight}>Counted</th>
                                            <th className={styles.alignRight}>Variance</th>
                                            <th className={styles.alignRight}>Handed over</th>
                                            <th className={styles.alignRight}>Left in till</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {r.drawerSessions.map((s, idx) => (
                                            <tr key={idx}>
                                                <td>{s.cashier_role}</td>
                                                <td className={styles.cellMuted}>
                                                    {s.opened_at ? formatClockTime(new Date(s.opened_at)) : '—'}
                                                    {!s.closed_at && ' · open'}
                                                </td>
                                                <td className={styles.alignRight}>
                                                    {s.expected == null ? '—' : money(s.expected)}
                                                </td>
                                                <td className={styles.alignRight}>
                                                    {s.counted == null ? '—' : money(s.counted)}
                                                </td>
                                                <td className={`${styles.alignRight} ${s.variance ? (s.variance < 0 ? styles.negative : styles.positive) : ''}`}>
                                                    {s.variance == null ? '—' : money(s.variance)}
                                                </td>
                                                <td className={styles.alignRight}>
                                                    {s.handover == null ? '—' : money(s.handover)}
                                                </td>
                                                <td className={styles.alignRight}>
                                                    {s.carry_forward == null ? '—' : money(s.carry_forward)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Profit — the bottom line the handover exists to state */}
                    <div className={`${styles.card} handover-card`}>
                        <h2 className={styles.cardTitle}>Profit</h2>
                        <StatRow label="Net sales" value={money(r.sales.net)} />
                        <StatRow label="Cost of goods sold" sub="recipes × ingredient avg cost" value={`− ${money(r.profit.cogs)}`} />
                        <StatRow label="Gross profit" value={money(r.profit.grossProfit)} />
                        <StatRow label="Expenses" value={`− ${money(r.expenses.total)}`} />
                        <StatRow
                            label="Net profit"
                            value={money(r.profit.netProfit)}
                            big
                            tone={r.profit.netProfit < 0 ? 'negative' : 'positive'}
                        />
                        {dayTraded ? (
                            <MiniBars rows={profitSteps} height={PROFIT_CHART_H} />
                        ) : (
                            <p className={styles.chartEmpty}>
                                Sales, cost and expenses appear here once the day trades.
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Print-only styling: hides the app chrome and forces a light A4
                layout — the same idiom the analytics report uses. */}
            <style jsx global>{`
                @media print {
                    body { background: white !important; }
                    .no-print { display: none !important; }
                    aside { display: none !important; }
                    main {
                        margin-left: 0 !important;
                        width: 100% !important;
                    }
                    #handover-root {
                        max-width: 100% !important;
                        padding: 0 !important;
                        color: #111 !important;
                    }
                    #handover-root * { color: #111 !important; }
                    .handover-card {
                        background: white !important;
                        border: 1px solid #ddd !important;
                        box-shadow: none !important;
                        break-inside: avoid;
                    }
                    /* recharts measures its box on screen and writes the SVG's
                       width and height as attributes; the print pass does not
                       wait for a re-measure. So the printed box must never be
                       given a percentage height (it would collapse to nothing)
                       and must never clip — the height comes in as an inline
                       pixel value and the box stays overflow: visible, which
                       lets the drawn SVG print exactly as it stands. */
                    .handover-chart,
                    .handover-chart .recharts-wrapper,
                    .handover-chart svg {
                        overflow: visible !important;
                    }
                    .handover-chart {
                        break-inside: avoid;
                        /* Bars are ink, not decoration; don't let the driver
                           drop them as "background graphics". */
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }
                    /* The page forces black type, but SVG text takes fill,
                       not color — without this the labels print white. */
                    #handover-root svg text { fill: #111 !important; }
                    @page { size: A4; margin: 12mm; }
                }
            `}</style>
        </div>
    );
}

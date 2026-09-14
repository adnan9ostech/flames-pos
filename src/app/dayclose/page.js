'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import styles from './dayclose.module.css';
import { getDayCloseState, closeBusinessDay, startBusinessDay } from './actions';
import { formatDateTime } from '@/lib/timeFormat';
import {
    AlertTriangle, Bike, CalendarDays, CheckCircle2, History, Loader2,
    Lock, Receipt, ShoppingBag, UtensilsCrossed, Wallet, ArrowRightLeft,
} from 'lucide-react';
import { formatRupees } from '@/lib/money';
// The same arithmetic the close itself runs, not a mirror of it — the confirm
// dialog names tomorrow before the close mints it, and a copy that drifted
// would promise a date the server then did not open.
import { nextCalendarDay } from '@/lib/day/karachi.mjs';

const money = (n) => (n === null || n === undefined ? '—' : formatRupees(n, 0));

const signedMoney = (n) => {
    const v = Number(n || 0);
    return `${v < 0 ? '-' : '+'}${formatRupees(Math.abs(v), 0)}`;
};

const ORDER_TYPE = {
    'dine-in': { label: 'Dine-in', Icon: UtensilsCrossed },
    'takeaway': { label: 'Takeaway', Icon: ShoppingBag },
    'delivery': { label: 'Delivery', Icon: Bike },
};

// timeFormat's date helpers stop at "Wed, 5 Aug"; the headline of this screen
// IS the date, so it carries the full weekday and year.
const formatBusinessDay = (ymd) =>
    new Date(`${ymd}T00:00:00`).toLocaleDateString('en-PK', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

export default function DayClosePage() {
    const [state, setState] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [note, setNote] = useState('');

    const [confirming, setConfirming] = useState(false);
    const [forceAck, setForceAck] = useState(false);
    const [closing, setClosing] = useState(false);
    const [closeError, setCloseError] = useState('');

    const load = useCallback(async () => {
        const res = await getDayCloseState();
        if (res.error) setLoadError(res.error);
        else setState(res.data);
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    // The success note clears on its own; errors stay until the next attempt.
    useEffect(() => {
        if (!note) return;
        const timer = setTimeout(() => setNote(''), 6000);
        return () => clearTimeout(timer);
    }, [note]);

    const pending = state?.pendingBills ?? [];
    const openDay = state?.openDay;
    const ledgerGaps = Number(state?.ledgerGaps ?? 0);
    const cash = state?.cash ?? null;
    const openDrawer = cash?.openSession ?? null;
    // Either gate can hold the close; one tick overrides whichever applies,
    // and the audit row records which.
    const needsForce = pending.length > 0 || Boolean(openDrawer);

    const [starting, setStarting] = useState(false);

    const openConfirm = () => {
        setCloseError('');
        setForceAck(false);
        setConfirming(true);
    };

    const submitStart = async () => {
        setStarting(true);
        setCloseError('');
        const res = await startBusinessDay({});
        if (res.error) {
            setCloseError(res.error);
        } else {
            setState(res.data);
            setNote(`${formatBusinessDay(res.data.openDay.business_date)} is open: tonight's orders land on it.`);
        }
        setStarting(false);
    };

    const submitClose = async () => {
        setClosing(true);
        setCloseError('');
        const res = await closeBusinessDay({ force: needsForce && forceAck });
        if (res.error) {
            setCloseError(res.error);
        } else {
            setState(res.data);
            setConfirming(false);
            setForceAck(false);
            setNote(`Day closed: ${formatBusinessDay(res.data.openDay.business_date)} is now the open business day.`);
        }
        setClosing(false);
    };

    if (loading) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading day close…</p>
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <AlertTriangle size={32} />
                    <p>{loadError}</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Day Close</h1>
                <p className={styles.subtitle}>
                    Close tonight&apos;s books and open the next business day. Orders taken after
                    midnight still belong to the day being closed.
                </p>
            </div>

            {note && (
                <div className={styles.successNote} role="status" aria-live="polite">
                    <CheckCircle2 size={16} aria-hidden="true" />
                    {note}
                </div>
            )}

            {/* Current business day — the ChowPOS "system date" panel */}
            <div className={styles.dayCard}>
                <div>
                    {openDay.state === 'open' ? (
                        <span className={styles.openChip}>
                            <CalendarDays size={13} aria-hidden="true" />
                            Open
                        </span>
                    ) : (
                        <span className={styles.implicitChip}>
                            <CalendarDays size={13} aria-hidden="true" />
                            Calendar day
                        </span>
                    )}
                    <div className={styles.dayLabel}>Current business day</div>
                    <div className={styles.dayDate}>{formatBusinessDay(openDay.business_date)}</div>
                    <div className={styles.dayMeta}>
                        {openDay.state === 'open'
                            ? `Opened ${formatDateTime(new Date(openDay.opened_at))}`
                            : 'No day has been started yet. Orders follow the Karachi calendar day until you start one.'}
                    </div>
                    {openDay.stale && (
                        <div className={styles.staleNote}>
                            <AlertTriangle size={14} aria-hidden="true" />
                            This day is behind today. Start today&apos;s day so tonight&apos;s orders land on the right date.
                        </div>
                    )}
                    {/* Soft warning only: the ledger never blocks a settle, so it
                        never blocks a close. The accountant reposts from Health. */}
                    {ledgerGaps > 0 && (
                        <div className={styles.staleNote} role="status">
                            <AlertTriangle size={14} aria-hidden="true" />
                            <span>
                                {ledgerGaps} settled bill{ledgerGaps === 1 ? '' : 's'} from this day{' '}
                                {ledgerGaps === 1 ? 'has' : 'have'} not reached the ledger.{' '}
                                see <Link href="/accounts/health">Posting Health</Link>.
                            </span>
                        </div>
                    )}
                </div>
                <div className={styles.dayActions}>
                    {/* Starting is offered when no day is open (the first ever)
                        and when the open one has gone stale after a closure. */}
                    {(openDay.state === 'implicit' || openDay.stale) && (
                        <button type="button" className={styles.startBtn} onClick={submitStart} disabled={starting}>
                            {starting ? <Loader2 size={18} className={styles.spinner} aria-hidden="true" /> : <CalendarDays size={18} aria-hidden="true" />}
                            Start Day
                        </button>
                    )}
                    <button type="button" className={styles.closeBtn} onClick={openConfirm} disabled={closing}>
                        <Lock size={18} aria-hidden="true" />
                        Close Day
                    </button>
                </div>
            </div>

            {/* The day's cash, read from the frozen drawer rows: what the till
                opened on, what was counted out of it, and what is being left
                for tomorrow. This is the chain — yesterday's carry forward is
                today's opening float — so a break in it shows here first. */}
            <div className={styles.cashCard}>
                <div className={styles.cashHead}>
                    <h2 className={styles.cardTitle}>
                        <Wallet size={16} aria-hidden="true" />
                        Cash for this day
                    </h2>
                    <Link href="/drawer" className={styles.cashLink}>Open the drawer screen</Link>
                </div>

                {!cash || cash.sessions === 0 ? (
                    <p className={styles.cashEmpty}>
                        No drawer has been opened on this day, so there is no cash to reconcile.
                        Card-only trading is a legitimate reason; a till nobody opened is not.
                    </p>
                ) : (
                    <>
                        <div className={styles.cashGrid}>
                            <div className={styles.cashStat}>
                                <span className={styles.cashLabel}>Opened with</span>
                                <span className={styles.cashValue}>{money(cash.opening)}</span>
                            </div>
                            <div className={styles.cashStat}>
                                <span className={styles.cashLabel}>Expected at close</span>
                                <span className={styles.cashValue}>
                                    {cash.closedSessions > 0 ? money(cash.expected) : '—'}
                                </span>
                            </div>
                            <div className={styles.cashStat}>
                                <span className={styles.cashLabel}>Counted</span>
                                <span className={styles.cashValue}>
                                    {cash.closedSessions > 0 ? money(cash.counted) : '—'}
                                </span>
                            </div>
                            <div className={styles.cashStat}>
                                <span className={styles.cashLabel}>Over / short</span>
                                <span className={`${styles.cashValue} ${
                                    cash.closedSessions === 0 ? ''
                                        : cash.variance < 0 ? styles.short
                                            : cash.variance > 0 ? styles.over : styles.balanced}`}
                                >
                                    {cash.closedSessions > 0 ? signedMoney(cash.variance) : '—'}
                                </span>
                            </div>
                            <div className={styles.cashStat}>
                                <span className={styles.cashLabel}>Handed over</span>
                                <span className={styles.cashValue}>
                                    {cash.closedSessions > 0 ? money(cash.handover) : '—'}
                                </span>
                            </div>
                            <div className={`${styles.cashStat} ${styles.cashStatAccent}`}>
                                <span className={styles.cashLabel}>Left for tomorrow</span>
                                <span className={styles.cashValue}>{money(cash.carryForward)}</span>
                            </div>
                        </div>

                        {cash.carryForward !== null && (
                            <p className={styles.cashChain}>
                                <ArrowRightLeft size={14} aria-hidden="true" />
                                <span>
                                    <strong>{money(cash.carryForward)}</strong> stays in the till, and
                                    that is the opening balance the next drawer will propose.
                                </span>
                            </p>
                        )}
                    </>
                )}

                {openDrawer && (
                    <div className={styles.cashWarn} role="status">
                        <AlertTriangle size={16} aria-hidden="true" />
                        <span>
                            The <strong>{openDrawer.cashier_role}</strong> drawer is still open
                            (since {formatDateTime(new Date(openDrawer.opened_at))}). Count and close
                            it so this day&apos;s cash is recorded before you close the day.
                        </span>
                    </div>
                )}
            </div>

            <div className={styles.grid2}>
                {/* The gate: what stands between now and a clean close */}
                <div className={styles.card}>
                    <h2 className={styles.cardTitle}>
                        <Receipt size={18} aria-hidden="true" />
                        Pending Restaurant Bills
                        {pending.length > 0 && <span className={styles.countBadge}>{pending.length}</span>}
                    </h2>
                    {pending.length === 0 ? (
                        <div className={styles.clearNote}>
                            <CheckCircle2 size={16} aria-hidden="true" />
                            No unpaid bills: the day is clear to close.
                        </div>
                    ) : (
                        <div className={styles.tableWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Order</th>
                                        <th>Type / Table</th>
                                        <th>Placed</th>
                                        <th className={styles.alignRight}>Total</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pending.map((bill, idx) => {
                                        const type = ORDER_TYPE[bill.order_type];
                                        return (
                                            <tr key={`${bill.order_number}-${idx}`}>
                                                <td className={styles.cellStrong}>#{bill.order_number}</td>
                                                <td>
                                                    <span className={styles.cellInline}>
                                                        {type && <type.Icon size={14} aria-hidden="true" />}
                                                        {type?.label || bill.order_type}
                                                        {bill.table_number && ` · ${bill.table_number}`}
                                                    </span>
                                                </td>
                                                <td className={styles.cellMuted}>
                                                    {formatDateTime(new Date(bill.created_at))}
                                                </td>
                                                <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                                    Rs. {Number(bill.total).toLocaleString('en-PK')}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Close history */}
                <div className={styles.card}>
                    <h2 className={styles.cardTitle}>
                        <History size={18} aria-hidden="true" />
                        Recent Closes
                    </h2>
                    {state.history.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <p>No closes yet: tonight&apos;s will be the first.</p>
                        </div>
                    ) : (
                        <div className={styles.tableWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Business day</th>
                                        <th>Closed</th>
                                        <th>By</th>
                                        <th className={styles.alignRight}>Opened with</th>
                                        <th className={styles.alignRight}>Left in till</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {state.history.map((row) => (
                                        <tr key={row.business_date}>
                                            <td className={styles.cellStrong}>{row.business_date}</td>
                                            <td className={styles.cellMuted}>
                                                {row.closed_at ? formatDateTime(new Date(row.closed_at)) : '—'}
                                            </td>
                                            <td className={styles.cellMuted}>
                                                {row.closed_by_role
                                                    ? row.closed_by_role.charAt(0).toUpperCase() + row.closed_by_role.slice(1)
                                                    : '—'}
                                            </td>
                                            <td className={`${styles.cellMuted} ${styles.alignRight}`}>
                                                {money(row.opening_cash)}
                                            </td>
                                            <td className={`${styles.cellMuted} ${styles.alignRight}`}>
                                                {money(row.closing_cash)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {/* Confirm: restates the pending-bills gate, and the force path is
                a deliberate tick, never the default. */}
            {confirming && (
                <div className={styles.modalOverlay} onClick={() => !closing && setConfirming(false)}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <h3 className={styles.modalTitle}>
                            <Lock size={18} aria-hidden="true" />
                            Close {formatBusinessDay(openDay.business_date)}?
                        </h3>
                        <p className={styles.modalBody}>
                            This stamps tonight&apos;s books and opens{' '}
                            <strong>{formatBusinessDay(nextCalendarDay(openDay.business_date))}</strong> as the new
                            business day. Every order taken from then on lands on the new day. A close cannot be undone.
                        </p>

                        {cash?.carryForward !== null && cash?.carryForward !== undefined && (
                            <div className={styles.clearNote}>
                                <ArrowRightLeft size={16} aria-hidden="true" />
                                <span>
                                    {money(cash.carryForward)} stays in the till as tomorrow&apos;s
                                    opening balance.
                                </span>
                            </div>
                        )}

                        {needsForce ? (
                            <label className={styles.forceRow}>
                                <input
                                    type="checkbox"
                                    checked={forceAck}
                                    onChange={(e) => setForceAck(e.target.checked)}
                                    disabled={closing}
                                />
                                <span>
                                    {pending.length > 0 && (
                                        <>
                                            <strong>{pending.length} unpaid bill{pending.length === 1 ? '' : 's'}</strong>{' '}
                                            still open.{' '}
                                        </>
                                    )}
                                    {openDrawer && (
                                        <>
                                            The <strong>{openDrawer.cashier_role} drawer is still open</strong>,
                                            so this day&apos;s cash was never counted.{' '}
                                        </>
                                    )}
                                    Deal with that first, or tick here to close anyway, which is
                                    recorded in the audit trail.
                                </span>
                            </label>
                        ) : (
                            <div className={styles.clearNote}>
                                <CheckCircle2 size={16} aria-hidden="true" />
                                No unpaid bills, drawer counted. Clear to close.
                            </div>
                        )}

                        {closeError && <p className={styles.modalError}>{closeError}</p>}

                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.modalCancel}
                                onClick={() => setConfirming(false)}
                                disabled={closing}
                            >
                                Keep day open
                            </button>
                            <button
                                type="button"
                                className={styles.modalConfirm}
                                onClick={submitClose}
                                disabled={closing || (pending.length > 0 && !forceAck)}
                            >
                                {closing
                                    ? <Loader2 size={14} className={styles.inlineSpinner} aria-hidden="true" />
                                    : <Lock size={14} aria-hidden="true" />}
                                {closing ? 'Closing…' : 'Close day'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

'use client';
import { useState, useEffect, useCallback } from 'react';
import styles from './drawer.module.css';
import {
    getDrawerState, openDrawer, recordMovement, closeDrawer, listSessions,
} from './actions';
import { useRole } from '@/components/Layout/AppLayout';
import LiveClock from '@/components/Layout/LiveClock';
import { formatDateTime, formatClockTime } from '@/lib/timeFormat';
import {
    Wallet, Loader2, Lock, History, AlertTriangle, CheckCircle2,
    ArrowDownToLine, ArrowUpFromLine, Banknote,
} from 'lucide-react';

const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK')}`;

// Signed for variance lines: the sign is the finding, so it never gets elided.
const signedMoney = (n) => {
    const v = Number(n || 0);
    return `${v < 0 ? '-' : '+'}${money(Math.abs(v))}`;
};

export default function DrawerPage() {
    const role = useRole();
    const [state, setState] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [pageError, setPageError] = useState('');

    // Open-drawer card
    const [floatInput, setFloatInput] = useState('');
    const [opening, setOpening] = useState(false);
    const [openError, setOpenError] = useState('');

    // Add-movement form
    const [mvType, setMvType] = useState('paid_in');
    const [mvAmount, setMvAmount] = useState('');
    const [mvReason, setMvReason] = useState('');
    const [mvBusy, setMvBusy] = useState(false);
    const [mvError, setMvError] = useState('');

    // Close flow
    const [closePanel, setClosePanel] = useState(false);
    const [countedInput, setCountedInput] = useState('');
    const [closeNotes, setCloseNotes] = useState('');
    const [closeBusy, setCloseBusy] = useState(false);
    const [closeError, setCloseError] = useState('');
    // The frozen row from the last close, shown once so the cashier sees the
    // final numbers rather than the screen just snapping back to "no drawer".
    const [closedResult, setClosedResult] = useState(null);

    // History (admin)
    const [history, setHistory] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [histFrom, setHistFrom] = useState('');
    const [histTo, setHistTo] = useState('');

    const load = useCallback(async () => {
        const res = await getDrawerState();
        if (res.error) {
            setPageError(res.error);
        } else {
            setPageError('');
            setState(res.data);
        }
        setIsLoading(false);
    }, []);

    const loadHistory = useCallback(async () => {
        setHistoryLoading(true);
        const res = await listSessions({ from: histFrom || undefined, to: histTo || undefined });
        if (!res.error) setHistory(res.data);
        setHistoryLoading(false);
    }, [histFrom, histTo]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (role === 'admin') loadHistory();
    }, [role, loadHistory]);

    const submitOpen = async () => {
        setOpening(true);
        setOpenError('');
        const res = await openDrawer({ opening_float: Number(floatInput) || 0 });
        if (res.error) {
            setOpenError(res.error);
        } else {
            setFloatInput('');
            setClosedResult(null);
            await load();
            if (role === 'admin') loadHistory();
        }
        setOpening(false);
    };

    const submitMovement = async () => {
        setMvBusy(true);
        setMvError('');
        const res = await recordMovement({
            type: mvType, amount: Number(mvAmount), reason: mvReason,
        });
        if (res.error) {
            setMvError(res.error);
        } else {
            setMvAmount('');
            setMvReason('');
            await load();
        }
        setMvBusy(false);
    };

    // Refresh on the way in so the expected the cashier compares against is
    // current, not the number from whenever the page last loaded.
    const startClose = async () => {
        setCountedInput('');
        setCloseNotes('');
        setCloseError('');
        setClosePanel(true);
        await load();
    };

    const submitClose = async () => {
        setCloseBusy(true);
        setCloseError('');
        const res = await closeDrawer({
            counted_amount: Number(countedInput), notes: closeNotes,
        });
        if (res.error) {
            setCloseError(res.error);
        } else {
            setClosePanel(false);
            setClosedResult(res.data);
            await load();
            if (role === 'admin') loadHistory();
        }
        setCloseBusy(false);
    };

    // Live preview: counted against the running expected. The close recomputes
    // authoritatively inside its transaction; this is the cashier's early look.
    const countedNum = countedInput === '' ? null : Number(countedInput);
    const previewVariance = state && countedNum !== null && Number.isFinite(countedNum)
        ? Math.round((countedNum - state.expected) * 100) / 100
        : null;

    const varianceClass = (v) =>
        v < 0 ? styles.short : v > 0 ? styles.over : styles.balanced;

    const varianceWord = (v) =>
        v < 0 ? `Short by ${money(Math.abs(v))}` : v > 0 ? `Over by ${money(v)}` : 'Balanced';

    const session = state?.session;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Drawer</h1>
                    <LiveClock className={styles.clock} />
                </div>
                {session && (
                    <span className={styles.openChip}>
                        <Wallet size={14} aria-hidden="true" />
                        Open since {formatClockTime(new Date(session.opened_at))}
                    </span>
                )}
            </div>

            {pageError && (
                <div className={styles.errorBanner} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    {pageError}
                </div>
            )}

            {closedResult && (
                <div className={styles.closedNote} role="status">
                    <CheckCircle2 size={16} aria-hidden="true" />
                    Drawer closed — expected {money(closedResult.expected_amount)}, counted{' '}
                    {money(closedResult.counted_amount)},{' '}
                    <span className={varianceClass(Number(closedResult.variance))}>
                        {varianceWord(Number(closedResult.variance))}
                    </span>
                </div>
            )}

            {isLoading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading drawer…</p>
                </div>
            ) : !session ? (
                /* ===== No open session: the float goes in first ===== */
                <div className={styles.openCard}>
                    <div className={styles.openIcon}>
                        <Wallet size={26} aria-hidden="true" />
                    </div>
                    <h2 className={styles.openTitle}>No drawer open</h2>
                    <p className={styles.openHint}>
                        Count the float into the till, enter it, and open the drawer.
                        Cash sales and movements from then on count against this session.
                    </p>
                    <div className={styles.openForm}>
                        <div className={styles.amountField}>
                            <span className={styles.amountPrefix}>Rs.</span>
                            <input
                                type="number"
                                min="0"
                                step="any"
                                inputMode="decimal"
                                className={styles.amountInput}
                                placeholder="Opening float"
                                value={floatInput}
                                onChange={(e) => { setFloatInput(e.target.value); setOpenError(''); }}
                                aria-label="Opening float"
                            />
                        </div>
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={submitOpen}
                            disabled={opening || floatInput === ''}
                        >
                            {opening
                                ? <Loader2 size={15} className={styles.inlineSpinner} />
                                : <Wallet size={15} aria-hidden="true" />}
                            {opening ? 'Opening…' : 'Open Drawer'}
                        </button>
                    </div>
                    {openError && <p className={styles.fieldError}>{openError}</p>}
                </div>
            ) : (
                /* ===== Live session ===== */
                <>
                    <div className={styles.card}>
                        <div className={styles.cardHead}>
                            <div>
                                <h2 className={styles.cardTitle}>Current session</h2>
                                <p className={styles.cardSub}>
                                    Opened {formatDateTime(new Date(session.opened_at))}
                                    {' · '}business day {session.business_date}
                                    {' · '}{session.cashier_role} till
                                </p>
                            </div>
                            <button type="button" className={styles.closeBtn} onClick={startClose}>
                                <Lock size={15} aria-hidden="true" />
                                Close Drawer
                            </button>
                        </div>

                        <div className={styles.statGrid}>
                            <div className={styles.stat}>
                                <span className={styles.statLabel}>Opening float</span>
                                <span className={styles.statValue}>{money(session.opening_float)}</span>
                            </div>
                            <div className={styles.stat}>
                                <span className={styles.statLabel}>Cash sales</span>
                                <span className={styles.statValue}>{money(state.cashSales)}</span>
                            </div>
                            <div className={styles.stat}>
                                <span className={styles.statLabel}>Paid in</span>
                                <span className={styles.statValue}>{money(state.paidIn)}</span>
                            </div>
                            <div className={styles.stat}>
                                <span className={styles.statLabel}>Paid out</span>
                                <span className={styles.statValue}>{money(state.paidOut)}</span>
                            </div>
                            <div className={styles.stat}>
                                <span className={styles.statLabel}>Drawer expenses</span>
                                <span className={styles.statValue}>{money(state.drawerExpenses)}</span>
                            </div>
                            <div className={`${styles.stat} ${styles.statAccent}`}>
                                <span className={styles.statLabel}>Expected in drawer</span>
                                <span className={styles.statValue}>{money(state.expected)}</span>
                            </div>
                        </div>
                    </div>

                    <div className={styles.card}>
                        <div className={styles.cardHead}>
                            <div>
                                <h2 className={styles.cardTitle}>Cash movements</h2>
                                <p className={styles.cardSub}>
                                    Money in or out of the drawer that isn&apos;t a sale — a change
                                    top-up in, a supplier paid out.
                                </p>
                            </div>
                        </div>

                        <div className={styles.moveForm}>
                            <div className={styles.typeToggle}>
                                {[['paid_in', 'Paid in', ArrowDownToLine], ['paid_out', 'Paid out', ArrowUpFromLine]]
                                    .map(([value, label, Icon]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            aria-pressed={mvType === value}
                                            className={`${styles.typeBtn} ${mvType === value ? styles.typeActive : ''}`}
                                            onClick={() => setMvType(value)}
                                        >
                                            <Icon size={14} aria-hidden="true" />
                                            {label}
                                        </button>
                                    ))}
                            </div>
                            <div className={styles.amountField}>
                                <span className={styles.amountPrefix}>Rs.</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    inputMode="decimal"
                                    className={styles.amountInput}
                                    placeholder="Amount"
                                    value={mvAmount}
                                    onChange={(e) => { setMvAmount(e.target.value); setMvError(''); }}
                                    aria-label="Movement amount"
                                />
                            </div>
                            <input
                                type="text"
                                className={styles.reasonInput}
                                placeholder="Reason (change top-up, milk run, rider float)"
                                value={mvReason}
                                maxLength={191}
                                onChange={(e) => { setMvReason(e.target.value); setMvError(''); }}
                                aria-label="Movement reason"
                            />
                            <button
                                type="button"
                                className={styles.primaryBtn}
                                onClick={submitMovement}
                                disabled={mvBusy || mvAmount === '' || !mvReason.trim()}
                            >
                                {mvBusy
                                    ? <Loader2 size={15} className={styles.inlineSpinner} />
                                    : <Banknote size={15} aria-hidden="true" />}
                                {mvBusy ? 'Saving…' : 'Add'}
                            </button>
                        </div>
                        {mvError && <p className={styles.fieldError}>{mvError}</p>}

                        {state.movements.length === 0 ? (
                            <p className={styles.emptyMoves}>No movements this session.</p>
                        ) : (
                            <div className={styles.moveList}>
                                {state.movements.map((m) => (
                                    <div key={m.id} className={styles.moveRow}>
                                        {m.type === 'paid_in'
                                            ? <ArrowDownToLine size={15} className={styles.moveInIcon} aria-hidden="true" />
                                            : <ArrowUpFromLine size={15} className={styles.moveOutIcon} aria-hidden="true" />}
                                        <span className={styles.moveReason}>{m.reason}</span>
                                        <span className={styles.moveTime}>
                                            {formatClockTime(new Date(m.at))}
                                        </span>
                                        <span className={m.type === 'paid_in' ? styles.moveInAmt : styles.moveOutAmt}>
                                            {m.type === 'paid_in' ? '+' : '-'}{money(m.amount)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* ===== Close flow: variance shown before the confirm ===== */}
            {closePanel && session && (
                <div className={styles.modalOverlay} onClick={() => !closeBusy && setClosePanel(false)}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <h3 className={styles.modalTitle}>
                            <Lock size={18} aria-hidden="true" />
                            Close drawer
                        </h3>
                        <p className={styles.modalBody}>
                            Count everything in the till — float included — and enter the total.
                            The expected balance freezes on the session when you confirm.
                        </p>

                        <div className={styles.expectedRow}>
                            <span>Expected in drawer</span>
                            <strong>{money(state.expected)}</strong>
                        </div>

                        <div className={styles.amountField}>
                            <span className={styles.amountPrefix}>Rs.</span>
                            <input
                                type="number"
                                min="0"
                                step="any"
                                inputMode="decimal"
                                className={styles.amountInput}
                                placeholder="Counted amount"
                                value={countedInput}
                                onChange={(e) => { setCountedInput(e.target.value); setCloseError(''); }}
                                autoFocus
                                disabled={closeBusy}
                                aria-label="Counted amount"
                            />
                        </div>

                        {previewVariance !== null && (
                            <div className={`${styles.varianceRow} ${varianceClass(previewVariance)}`}>
                                {previewVariance < 0 && <AlertTriangle size={15} aria-hidden="true" />}
                                {varianceWord(previewVariance)}
                                {previewVariance !== 0 && ` (${signedMoney(previewVariance)})`}
                            </div>
                        )}

                        <input
                            type="text"
                            className={styles.modalInput}
                            placeholder="Notes (why short/over, denominations, handover)"
                            value={closeNotes}
                            maxLength={191}
                            onChange={(e) => setCloseNotes(e.target.value)}
                            disabled={closeBusy}
                        />

                        {closeError && <p className={styles.fieldError}>{closeError}</p>}

                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.modalCancel}
                                onClick={() => setClosePanel(false)}
                                disabled={closeBusy}
                            >
                                Keep open
                            </button>
                            <button
                                type="button"
                                className={styles.modalConfirm}
                                onClick={submitClose}
                                disabled={closeBusy || countedInput === ''}
                            >
                                {closeBusy
                                    ? <Loader2 size={14} className={styles.inlineSpinner} />
                                    : <Lock size={14} aria-hidden="true" />}
                                {closeBusy ? 'Closing…' : 'Confirm close'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ===== History: variance across roles is a management read ===== */}
            {role === 'admin' && (
                <div className={styles.card}>
                    <div className={styles.cardHead}>
                        <div>
                            <h2 className={styles.cardTitle}>
                                <History size={17} aria-hidden="true" />
                                Session history
                            </h2>
                            <p className={styles.cardSub}>Every drawer session, all roles.</p>
                        </div>
                        <div className={styles.dateRange}>
                            <input
                                type="date"
                                className={styles.dateInput}
                                value={histFrom}
                                max={histTo || undefined}
                                onChange={(e) => setHistFrom(e.target.value)}
                                aria-label="From date"
                            />
                            <span className={styles.dateSep}>to</span>
                            <input
                                type="date"
                                className={styles.dateInput}
                                value={histTo}
                                min={histFrom || undefined}
                                onChange={(e) => setHistTo(e.target.value)}
                                aria-label="To date"
                            />
                        </div>
                    </div>

                    {historyLoading ? (
                        <div className={styles.stateBlock}>
                            <Loader2 className={styles.spinner} size={24} />
                        </div>
                    ) : history.length === 0 ? (
                        <p className={styles.emptyMoves}>No sessions in this range.</p>
                    ) : (
                        <div className={styles.tableWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Day</th>
                                        <th>Role</th>
                                        <th>Opened</th>
                                        <th>Closed</th>
                                        <th className={styles.alignRight}>Float</th>
                                        <th className={styles.alignRight}>Expected</th>
                                        <th className={styles.alignRight}>Counted</th>
                                        <th className={styles.alignRight}>Variance</th>
                                        <th>Notes</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {history.map((s) => (
                                        <tr key={s.id}>
                                            <td className={styles.cellStrong}>{s.business_date}</td>
                                            <td>{s.cashier_role}</td>
                                            <td className={styles.cellMuted}>
                                                {formatClockTime(new Date(s.opened_at))}
                                            </td>
                                            <td className={styles.cellMuted}>
                                                {s.closed_at
                                                    ? formatClockTime(new Date(s.closed_at))
                                                    : <span className={styles.openTag}>Open</span>}
                                            </td>
                                            <td className={styles.alignRight}>{money(s.opening_float)}</td>
                                            <td className={styles.alignRight}>
                                                {s.closed_at ? money(s.expected_amount) : '—'}
                                            </td>
                                            <td className={styles.alignRight}>
                                                {s.closed_at ? money(s.counted_amount) : '—'}
                                            </td>
                                            <td className={`${styles.alignRight} ${styles.cellStrong}`}>
                                                {s.closed_at ? (
                                                    <span className={varianceClass(Number(s.variance))}>
                                                        {Number(s.variance) === 0 ? '0' : signedMoney(s.variance)}
                                                    </span>
                                                ) : '—'}
                                            </td>
                                            <td className={styles.cellMuted}>{s.notes || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

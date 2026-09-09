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
    ArrowDownToLine, ArrowUpFromLine, Banknote, ArrowRightLeft, Coins,
} from 'lucide-react';
import { formatRupees } from '@/lib/money';
import {
    PKR_DENOMINATIONS, round2, varianceOf, needsReason,
} from '@/lib/cash/drawer.mjs';

const money = (n) => formatRupees(n, 0);

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
    // null means the cashier has not typed yet, so the box can show the
    // carried-forward figure without an effect copying it into state — the
    // proposal is a default, and touching the box makes it an answer.
    const [floatInput, setFloatInput] = useState(null);
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
    // Note-by-note. Empty object = counted as a lump sum, which is still
    // allowed — a breakdown is the better habit, not a gate on shutting the
    // till at 1am.
    const [denoms, setDenoms] = useState({});
    const [carryInput, setCarryInput] = useState('');
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
        return res.error ? null : res.data;
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
        const res = await openDrawer({ opening_float: Number(floatValue) || 0 });
        if (res.error) {
            setOpenError(res.error);
        } else {
            setFloatInput(null);
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
        setDenoms({});
        setCloseNotes('');
        setCloseError('');
        setClosePanel(true);
        const fresh = await load();
        // Propose the standing float as tomorrow's opener; zero is a real
        // answer (the owner empties the till), so it is proposed and not
        // assumed.
        const std = Number(fresh?.defaultFloat ?? state?.defaultFloat ?? 0);
        setCarryInput(std > 0 ? String(std) : '');
    };

    const submitClose = async () => {
        setCloseBusy(true);
        setCloseError('');
        const res = await closeDrawer({
            counted_amount: counted,
            carry_forward: carryInput === '' ? 0 : Number(carryInput),
            notes: closeNotes,
            denominations: anyDenoms ? denoms : null,
        });
        if (res.error) {
            setCloseError(res.error);
        } else {
            setClosePanel(false);
            setDenoms({});
            setCarryInput('');
            setClosedResult(res.data);
            await load();
            if (role === 'admin') loadHistory();
        }
        setCloseBusy(false);
    };

    /*
     * The count, from whichever way it was made. A breakdown wins over the
     * typed total whenever one exists — you cannot half-count a drawer.
     */
    const anyDenoms = PKR_DENOMINATIONS.some((d) => String(denoms[d] ?? '') !== '');
    const denomTotal = PKR_DENOMINATIONS
        .reduce((t, d) => t + d * (Number(denoms[d]) || 0), 0);
    const typedTotal = countedInput.trim() === '' ? null : Number(countedInput);
    const counted = anyDenoms
        ? round2(denomTotal)
        : (typedTotal !== null && Number.isFinite(typedTotal) ? round2(typedTotal) : null);

    /*
     * Blind until the count is in. Showing the expected first is how a drawer
     * that is short by two hundred rupees gets closed for exactly the right
     * amount — the number to beat is right there on the screen. It appears
     * the moment the count does, which is when it becomes useful instead of
     * suggestive.
     */
    const revealed = counted !== null;
    const previewVariance = state?.session && revealed
        ? varianceOf(counted, state.expected)
        : null;

    const carryNum = carryInput.trim() === '' ? null : Number(carryInput);
    const carryValid = carryNum !== null && Number.isFinite(carryNum)
        && carryNum >= 0 && counted !== null && carryNum <= counted;
    const handover = carryValid ? round2(counted - carryNum) : null;
    const reasonNeeded = previewVariance !== null
        && needsReason(previewVariance, state?.tolerance ?? 0);
    const closeReady = revealed && carryValid && (!reasonNeeded || closeNotes.trim() !== '');

    const varianceClass = (v) =>
        v < 0 ? styles.short : v > 0 ? styles.over : styles.balanced;

    const varianceWord = (v) =>
        v < 0 ? `Short by ${money(Math.abs(v))}` : v > 0 ? `Over by ${money(v)}` : 'Balanced';

    const session = state?.session;
    const floatValue = floatInput === null
        ? (state && !state.session && state.suggestedFloat > 0 ? String(state.suggestedFloat) : '')
        : floatInput;

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
                    <span>
                        Drawer closed — expected {money(closedResult.expected_amount)}, counted{' '}
                        {money(closedResult.counted_amount)},{' '}
                        <span className={varianceClass(Number(closedResult.variance))}>
                            {varianceWord(Number(closedResult.variance))}
                        </span>
                        {closedResult.carry_forward !== null && (
                            <>
                                {'. '}
                                <strong>{money(closedResult.carry_forward)}</strong> left in the
                                drawer for tomorrow, {money(closedResult.handover_amount)} handed over.
                            </>
                        )}
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
                        Count what is in the till, enter it, and open the drawer.
                        Cash sales and movements from then on count against this session.
                    </p>

                    {state?.lastClose?.carry_forward !== null && state?.lastClose && (
                        <div className={styles.carryNote}>
                            <ArrowRightLeft size={15} aria-hidden="true" />
                            <span>
                                <strong>{money(state.lastClose.carry_forward)}</strong> was left in
                                this drawer at the {state.lastClose.business_date} close
                                {' — '}that is what it should hold now. Count it and correct the
                                figure if it differs.
                            </span>
                        </div>
                    )}
                    {state && !state.lastClose && state.suggestedFloat > 0 && (
                        <div className={styles.carryNote}>
                            <Coins size={15} aria-hidden="true" />
                            <span>
                                No previous close to carry forward from — proposing the standing
                                float of <strong>{money(state.suggestedFloat)}</strong>.
                            </span>
                        </div>
                    )}
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
                                value={floatValue}
                                onChange={(e) => { setFloatInput(e.target.value); setOpenError(''); }}
                                aria-label="Opening float"
                            />
                        </div>
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={submitOpen}
                            disabled={opening || floatValue === ''}
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
                            Count everything in the till — float included. Enter it note by note,
                            or type the total straight in. The expected balance appears once you
                            have counted, so the count is yours and not the screen&apos;s.
                        </p>

                        {/* ---- 1. the count ---- */}
                        <div className={styles.denomGrid}>
                            {PKR_DENOMINATIONS.map((d) => {
                                const n = Number(denoms[d]) || 0;
                                return (
                                    <div key={d} className={styles.denomRow}>
                                        <span className={styles.denomFace}>{money(d)}</span>
                                        <span className={styles.denomTimes}>×</span>
                                        <input
                                            type="number"
                                            min="0"
                                            step="1"
                                            inputMode="numeric"
                                            className={styles.denomInput}
                                            value={denoms[d] ?? ''}
                                            placeholder="0"
                                            disabled={closeBusy}
                                            aria-label={`Number of Rs. ${d} notes`}
                                            onChange={(e) => {
                                                setCloseError('');
                                                setDenoms((prev) => ({ ...prev, [d]: e.target.value }));
                                            }}
                                        />
                                        <span className={styles.denomSub}>
                                            {n > 0 ? money(d * n) : ''}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        <div className={styles.countedRow}>
                            <span>Counted in drawer</span>
                            {anyDenoms ? (
                                <strong>{money(denomTotal)}</strong>
                            ) : (
                                <div className={styles.amountField}>
                                    <span className={styles.amountPrefix}>Rs.</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="any"
                                        inputMode="decimal"
                                        className={styles.amountInput}
                                        placeholder="Total counted"
                                        value={countedInput}
                                        onChange={(e) => { setCountedInput(e.target.value); setCloseError(''); }}
                                        autoFocus
                                        disabled={closeBusy}
                                        aria-label="Counted amount"
                                    />
                                </div>
                            )}
                        </div>

                        {/* ---- 2. what it should have been ---- */}
                        {!revealed ? (
                            <p className={styles.blindHint}>
                                The expected figure appears when the count is in.
                            </p>
                        ) : (
                            <>
                                <div className={styles.expectedRow}>
                                    <span>Expected in drawer</span>
                                    <strong>{money(state.expected)}</strong>
                                </div>
                                <div className={`${styles.varianceRow} ${varianceClass(previewVariance)}`}>
                                    {previewVariance < 0 && <AlertTriangle size={15} aria-hidden="true" />}
                                    {varianceWord(previewVariance)}
                                    {previewVariance !== 0 && ` (${signedMoney(previewVariance)})`}
                                </div>
                            </>
                        )}

                        {/* ---- 3. the split: what stays, what leaves ---- */}
                        <div className={styles.splitBlock}>
                            <label className={styles.splitLabel} htmlFor="carry-forward">
                                Leave in the drawer for tomorrow
                            </label>
                            <div className={styles.amountField}>
                                <span className={styles.amountPrefix}>Rs.</span>
                                <input
                                    id="carry-forward"
                                    type="number"
                                    min="0"
                                    step="any"
                                    inputMode="decimal"
                                    className={styles.amountInput}
                                    placeholder="0"
                                    value={carryInput}
                                    onChange={(e) => { setCarryInput(e.target.value); setCloseError(''); }}
                                    disabled={closeBusy}
                                />
                            </div>
                            {carryNum !== null && counted !== null && carryNum > counted ? (
                                <p className={styles.fieldError}>
                                    You cannot leave more in the drawer than you counted.
                                </p>
                            ) : (
                                <p className={styles.splitHint}>
                                    {handover === null
                                        ? 'This becomes tomorrow\u2019s opening float.'
                                        : <>Handing over <strong>{money(handover)}</strong>. The rest stays as tomorrow&apos;s opening float.</>}
                                </p>
                            )}
                        </div>

                        <input
                            type="text"
                            className={styles.modalInput}
                            placeholder={reasonNeeded
                                ? 'Why is it short/over? (required)'
                                : 'Notes (optional)'}
                            value={closeNotes}
                            maxLength={191}
                            onChange={(e) => setCloseNotes(e.target.value)}
                            disabled={closeBusy}
                            aria-invalid={reasonNeeded && closeNotes.trim() === ''}
                        />
                        {reasonNeeded && closeNotes.trim() === '' && (
                            <p className={styles.fieldError}>
                                A difference has to be explained before the drawer closes.
                            </p>
                        )}

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
                                disabled={closeBusy || !closeReady}
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

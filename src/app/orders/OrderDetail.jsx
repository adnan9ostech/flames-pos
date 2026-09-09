'use client';
import { useState, useEffect, useCallback } from 'react';
import { getOrderDetail } from './actions';
import { bumpOrder } from '@/lib/dataClient';
import { formatRupees, formatNumber } from '@/lib/money';
import { formatDateTime, formatClockTime } from '@/lib/timeFormat';
import { getOrderNumber, formatOrderDate } from '@/lib/orderDisplay';
import styles from './orderDetail.module.css';
import {
    X, UtensilsCrossed, ShoppingBag, Bike, Armchair, UserRound, ChefHat,
    Wallet, Printer, Ban, ArrowRight, Loader2, History, Layers, StickyNote,
    AlertTriangle, CheckCircle2
} from 'lucide-react';

/*
 * One order, opened.
 *
 * The gap this fills: /orders was a list with a "next status" button and
 * nothing behind it, so "is this bill paid?" and "has the kitchen finished
 * it?" — two independent facts — collapsed into one word on a row. The panel
 * states them separately and never merges them.
 *
 * It holds NO copy of the row it was opened with. `refreshKey` is bumped by
 * the list every time its 4s version poll refetches, and this reloads with
 * it: a KDS bump moves orders.updated_at, which moves the version, which
 * lands here without anyone pressing anything.
 */

const ORDER_TYPE = {
    'dine-in': { label: 'Dine-in', Icon: UtensilsCrossed },
    'takeaway': { label: 'Takeaway', Icon: ShoppingBag },
    'delivery': { label: 'Delivery', Icon: Bike },
};

// The kitchen's four stages, in the order a ticket walks them.
const FLOW = ['new', 'preparing', 'ready', 'completed'];

const KITCHEN_LABEL = {
    new: 'New',
    preparing: 'Preparing',
    ready: 'Ready',
    completed: 'Completed',
    cancelled: 'Voided',
};

const PAYMENT_LABEL = { unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid' };

const METHOD_LABEL = { cash: 'Cash', card: 'Card', city_ledger: 'City ledger' };

const methodName = (m) => METHOD_LABEL[m] || m || '—';

/*
 * 0.16 → "16", 0.055 → "5.5". A rate is not money, so it does not go through
 * the rupee formatter; it only has to avoid printing 15.999999999999998.
 */
const ratePercent = (rate) => String(Number((rate * 100).toFixed(2)));

/*
 * The trail in plain language. audit_log stores a verb and a JSON blob; a
 * floor manager reads sentences. Anything unmapped still renders — its verb
 * de-underscored — because a trail that silently drops rows is worse than one
 * that reads awkwardly.
 */
const describeTrail = (entry) => {
    const d = entry.details || {};
    switch (entry.action) {
        case 'create_order':
            return {
                title: 'Order taken',
                note: [d.type, d.total != null && formatRupees(d.total)].filter(Boolean).join(' · '),
            };
        case 'append_round':
            return {
                title: `Round ${d.round ?? '?'} sent to the kitchen`,
                note: d.total != null ? `Bill now ${formatRupees(d.total)}` : '',
            };
        case 'settle_order':
            return {
                title: `Settled — ${methodName(d.method)}`,
                note: [d.total != null && formatRupees(d.total), d.invoice].filter(Boolean).join(' · '),
            };
        case 'void_order':
            return {
                title: `Voided — ${d.reason || 'no reason recorded'}`,
                note: [d.by && `by ${d.by}`, d.was_paid && 'the bill had been settled']
                    .filter(Boolean).join(' · '),
            };
        case 'gl_post_order':
            return {
                title: 'Posted to the ledger',
                note: (d.vouchers || []).map((v) => v.voucher_no).filter(Boolean).join(' · '),
            };
        default:
            return { title: entry.action.replace(/_/g, ' '), note: '' };
    }
};

// The modifiers column holds the cart's selectedModifiers object — the same
// shape the list flattens, read straight off the stored line.
const lineModifiers = (line) => {
    const mods = line.modifiers;
    if (!mods || typeof mods !== 'object') return '';
    return Object.values(mods).flat().map((m) => m?.name).filter(Boolean).join(', ');
};

export default function OrderDetail({
    orderId, refreshKey, canVoid, onClose, onReprint, onVoid, onChanged,
}) {
    const [detail, setDetail] = useState(null);
    const [error, setError] = useState('');
    const [bumpError, setBumpError] = useState('');
    const [bumping, setBumping] = useState(false);

    // Only the FIRST load blanks the panel. A refetch driven by the version
    // poll keeps the rendered detail in place — a spinner over the whole panel
    // every four seconds would be unreadable.
    const loading = !detail && !error;

    const load = useCallback(async () => {
        const res = await getOrderDetail(orderId);
        if (res?.error) {
            setError(res.error);
            setDetail(null);
        } else {
            setDetail(res.data);
            setError('');
        }
    }, [orderId]);

    // A new order clears the old one first, so the panel can never show one
    // bill's lines under another bill's header while the read is in flight.
    useEffect(() => {
        setDetail(null);
        setError('');
        setBumpError('');
    }, [orderId]);

    // orderId OR refreshKey: opening, and every time the list refetches.
    useEffect(() => { load(); }, [load, refreshKey]);

    // Escape closes, the way every other overlay in the app behaves.
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const order = detail?.order || null;
    const status = order?.status;
    const nextStatus = status && FLOW.indexOf(status) >= 0 && FLOW.indexOf(status) < FLOW.length - 1
        ? FLOW[FLOW.indexOf(status) + 1]
        : null;

    const advance = async () => {
        if (!order || !nextStatus) return;
        setBumping(true);
        setBumpError('');
        try {
            await bumpOrder(order.id, order.status, nextStatus);
            // Both: this panel redraws now, and the list behind it follows.
            await load();
            onChanged?.();
        } catch (e) {
            setBumpError(e.message || 'Could not update the kitchen status');
        } finally {
            setBumping(false);
        }
    };

    const type = order && ORDER_TYPE[order.order_type];
    const cancelled = status === 'cancelled';
    const charges = Array.isArray(order?.charges) ? order.charges : [];
    const taxRate = order?.tax_rate == null ? null : Number(order.tax_rate);
    // Money still owed. Never negative on screen: a bill over-collected is a
    // refund question, and this panel deliberately offers no money actions.
    const owed = Math.max(0, Math.round(detail?.balance ?? 0));
    const voidable = canVoid && order && !cancelled && order.payment_status !== 'paid';

    return (
        <div className={styles.overlay} onClick={onClose}>
            <aside
                className={styles.drawer}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={order ? `Order ${getOrderNumber(order)}` : 'Order details'}
            >
                <header className={styles.header}>
                    <div className={styles.headerMain}>
                        <h2 className={styles.orderNo}>
                            {order ? `Order #${getOrderNumber(order)}` : 'Order'}
                        </h2>
                        {order && (
                            <p className={styles.sub}>
                                {formatOrderDate(order.created_at)}
                                {order.invoice_number && ` · Invoice ${order.invoice_number}`}
                            </p>
                        )}
                    </div>
                    <button
                        type="button"
                        className={styles.closeBtn}
                        onClick={onClose}
                        aria-label="Close order details"
                    >
                        <X size={18} />
                    </button>
                </header>

                {loading ? (
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={26} />
                        <p>Opening order…</p>
                    </div>
                ) : error ? (
                    <div className={styles.stateBlock}>
                        <AlertTriangle size={26} />
                        <p>{error}</p>
                    </div>
                ) : order && (
                    <>
                        <div className={styles.body}>
                            {/* ===== Who, where, and the TWO states ===== */}
                            <section className={styles.section}>
                                <div className={styles.metaRow}>
                                    {type && (
                                        <span className={styles.metaChip}>
                                            <type.Icon size={13} aria-hidden="true" />
                                            {type.label}
                                        </span>
                                    )}
                                    {order.table_number && (
                                        <span className={styles.metaChip}>
                                            <Armchair size={13} aria-hidden="true" />
                                            Table {order.table_number}
                                        </span>
                                    )}
                                    {order.waiter_name && (
                                        <span className={styles.metaChip}>
                                            <UserRound size={13} aria-hidden="true" />
                                            {order.waiter_name}
                                        </span>
                                    )}
                                    {(order.round_count || 1) > 1 && (
                                        <span className={styles.metaChip}>
                                            <Layers size={13} aria-hidden="true" />
                                            {order.round_count} rounds
                                        </span>
                                    )}
                                </div>

                                {/*
                                 * Two chips, never one. The kitchen finishing a dish
                                 * does not take payment and settling does not cook it,
                                 * so the panel labels each state by name — this is the
                                 * confusion the owner asked to have cleared up.
                                 */}
                                <div className={styles.stateRow}>
                                    <div className={styles.stateCell}>
                                        <span className={styles.stateLabel}>
                                            <ChefHat size={13} aria-hidden="true" />
                                            Kitchen
                                        </span>
                                        <span className={`${styles.stateChip} ${styles[`kitchen_${status}`] || ''}`}>
                                            {KITCHEN_LABEL[status] || status}
                                        </span>
                                    </div>
                                    <div className={styles.stateCell}>
                                        <span className={styles.stateLabel}>
                                            <Wallet size={13} aria-hidden="true" />
                                            Payment
                                        </span>
                                        <span className={`${styles.stateChip} ${styles[`pay_${order.payment_status}`] || ''}`}>
                                            {PAYMENT_LABEL[order.payment_status] || order.payment_status}
                                            {order.payment_status !== 'unpaid' && order.payment_mode
                                                && ` · ${methodName(order.payment_mode)}`}
                                        </span>
                                    </div>
                                </div>

                                {(order.customer_name || order.customer_phone) && (
                                    <p className={styles.customer}>
                                        {[order.customer_name, order.customer_phone].filter(Boolean).join(' · ')}
                                    </p>
                                )}

                                {order.notes && (
                                    <p className={styles.orderNote}>
                                        <StickyNote size={13} aria-hidden="true" />
                                        {order.notes}
                                    </p>
                                )}
                            </section>

                            {/* ===== The kitchen's progress ===== */}
                            <section className={styles.section}>
                                <h3 className={styles.sectionTitle}>Kitchen progress</h3>

                                {cancelled ? (
                                    <p className={styles.voidBanner}>
                                        <Ban size={14} aria-hidden="true" />
                                        Voided{order.cancel_reason ? ` — ${order.cancel_reason}` : ''}
                                        {order.cancelled_by ? ` · by ${order.cancelled_by}` : ''}
                                    </p>
                                ) : (
                                    <>
                                        <ol className={styles.stepper}>
                                            {FLOW.map((step) => {
                                                const at = FLOW.indexOf(status);
                                                const here = FLOW.indexOf(step);
                                                const state = here < at ? 'done' : here === at ? 'current' : 'todo';
                                                return (
                                                    <li
                                                        key={step}
                                                        className={`${styles.step} ${styles[`step_${state}`]}`}
                                                        aria-current={state === 'current' ? 'step' : undefined}
                                                    >
                                                        <span className={styles.stepDot} aria-hidden="true">
                                                            {state === 'done' && <CheckCircle2 size={12} />}
                                                        </span>
                                                        {KITCHEN_LABEL[step]}
                                                    </li>
                                                );
                                            })}
                                        </ol>

                                        {nextStatus && (
                                            <button
                                                type="button"
                                                className={styles.advanceBtn}
                                                onClick={advance}
                                                disabled={bumping}
                                            >
                                                {bumping
                                                    ? <Loader2 size={15} className={styles.spinner} />
                                                    : <ArrowRight size={15} aria-hidden="true" />}
                                                Mark {KITCHEN_LABEL[nextStatus].toLowerCase()}
                                            </button>
                                        )}
                                        {bumpError && <p className={styles.inlineError}>{bumpError}</p>}
                                    </>
                                )}
                            </section>

                            {/* ===== The lines, as they were rung ===== */}
                            <section className={styles.section}>
                                <h3 className={styles.sectionTitle}>Items</h3>

                                {detail.rounds.length === 0 && (
                                    <p className={styles.moneyState}>
                                        No lines are stored against this order.
                                    </p>
                                )}

                                {detail.rounds.map((round) => (
                                    <div key={round.round_no} className={styles.round}>
                                        <div className={styles.roundHead}>
                                            <span className={styles.roundName}>Round {round.round_no}</span>
                                            <span className={styles.roundMeta}>
                                                {round.fired_at
                                                    ? `sent ${formatClockTime(new Date(round.fired_at))}`
                                                    : 'send time not recorded'}
                                                {' · '}
                                                {formatRupees(round.subtotal)}
                                            </span>
                                        </div>

                                        <table className={styles.table}>
                                            <thead>
                                                <tr>
                                                    <th>Item</th>
                                                    <th className={styles.alignRight}>Qty</th>
                                                    <th className={styles.alignRight}>Price</th>
                                                    <th className={styles.alignRight}>Amount</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {round.items.map((line) => {
                                                    const mods = lineModifiers(line);
                                                    /*
                                                     * The stored name usually already carries the
                                                     * size — "Aloo Gosht (Full)" — so repeating
                                                     * "Full" under it is noise. Shown only when
                                                     * the name does not say it.
                                                     */
                                                    const variant = line.variant
                                                        && !line.name.includes(line.variant)
                                                        ? line.variant : '';
                                                    return (
                                                        <tr key={line.id}>
                                                            <td>
                                                                <span className={styles.lineName}>{line.name}</span>
                                                                {variant && (
                                                                    <span className={styles.lineVariant}>{variant}</span>
                                                                )}
                                                                {mods && <span className={styles.lineMods}>{mods}</span>}
                                                                {line.notes && (
                                                                    <span className={styles.lineNote}>“{line.notes}”</span>
                                                                )}
                                                            </td>
                                                            <td className={styles.alignRight}>{line.qty}</td>
                                                            <td className={styles.alignRight}>{formatNumber(line.unit_price)}</td>
                                                            <td className={`${styles.alignRight} ${styles.lineTotal}`}>
                                                                {formatNumber(line.line_total)}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                ))}
                            </section>

                            {/* ===== The money ===== */}
                            <section className={styles.section}>
                                <h3 className={styles.sectionTitle}>The bill</h3>

                                <dl className={styles.money}>
                                    <div className={styles.moneyRow}>
                                        <dt>Subtotal</dt>
                                        <dd>{formatRupees(order.subtotal)}</dd>
                                    </div>

                                    {Number(order.discount) > 0 && (
                                        <div className={styles.moneyRow}>
                                            <dt>
                                                Discount
                                                {order.discount_reason && (
                                                    <span className={styles.moneyNote}>{order.discount_reason}</span>
                                                )}
                                            </dt>
                                            <dd className={styles.discount}>
                                                −{formatRupees(order.discount)}
                                            </dd>
                                        </div>
                                    )}

                                    {charges.map((charge, idx) => (
                                        <div key={`${charge.name}-${idx}`} className={styles.moneyRow}>
                                            <dt>{charge.name}</dt>
                                            <dd>{formatRupees(charge.amount)}</dd>
                                        </div>
                                    ))}

                                    <div className={styles.moneyRow}>
                                        {/*
                                         * The rate stamped on the ORDER, not today's setting:
                                         * cash and card are taxed differently, and a bill
                                         * settled last month must still read at the rate it
                                         * was charged at. Null on a pre-migration bill — no
                                         * percentage beats a wrong one.
                                         */}
                                        <dt>
                                            Tax
                                            {order.include_tax && taxRate != null
                                                && ` (${ratePercent(taxRate)}%)`}
                                            {!order.include_tax && (
                                                <span className={styles.moneyNote}>not charged on this bill</span>
                                            )}
                                        </dt>
                                        <dd>{formatRupees(order.tax)}</dd>
                                    </div>

                                    <div className={`${styles.moneyRow} ${styles.moneyTotal}`}>
                                        <dt>Total</dt>
                                        <dd>{formatRupees(order.total)}</dd>
                                    </div>
                                </dl>

                                {detail.payments.length > 0 ? (
                                    <ul className={styles.payments}>
                                        {detail.payments.map((p) => (
                                            <li key={p.id} className={styles.payment}>
                                                <span className={styles.paymentMethod}>
                                                    <Wallet size={13} aria-hidden="true" />
                                                    {methodName(p.method)}
                                                    {p.amount < 0 && (
                                                        <span className={styles.reversal}>reversal</span>
                                                    )}
                                                </span>
                                                <span className={styles.paymentTime}>
                                                    {formatDateTime(new Date(p.paid_at))}
                                                </span>
                                                <span className={styles.paymentAmount}>
                                                    {formatRupees(p.amount)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className={styles.moneyState}>Nothing has been taken against this bill yet.</p>
                                )}

                                {/* Plainly, in words: the number is no use if the
                                    reader has to work out what it means. */}
                                {cancelled ? (
                                    <p className={styles.moneyState}>
                                        This order was voided — it counts towards nothing.
                                    </p>
                                ) : owed > 0 ? (
                                    <p className={`${styles.moneyState} ${styles.owed}`}>
                                        Unpaid — {formatRupees(owed)} still owed.
                                    </p>
                                ) : (
                                    <p className={`${styles.moneyState} ${styles.settled}`}>
                                        Settled in full.
                                    </p>
                                )}
                            </section>

                            {/* ===== Who did what ===== */}
                            <section className={styles.section}>
                                <h3 className={styles.sectionTitle}>
                                    <History size={14} aria-hidden="true" />
                                    Trail
                                </h3>

                                {detail.trail.length === 0 ? (
                                    <p className={styles.moneyState}>Nothing recorded against this order.</p>
                                ) : (
                                    <ol className={styles.trail}>
                                        {detail.trail.map((entry) => {
                                            const { title, note } = describeTrail(entry);
                                            return (
                                                <li key={entry.id} className={styles.trailItem}>
                                                    <span className={styles.trailTime}>
                                                        {formatDateTime(new Date(entry.at))}
                                                    </span>
                                                    <span className={styles.trailTitle}>{title}</span>
                                                    {(note || entry.actor) && (
                                                        <span className={styles.trailNote}>
                                                            {[note, entry.actor && `— ${entry.actor}`]
                                                                .filter(Boolean).join(' ')}
                                                        </span>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ol>
                                )}
                            </section>
                        </div>

                        {/*
                         * Actions the order screen already owns, and nothing more.
                         * Taking money is the till's job — a detail view that could
                         * settle a bill would be a second, unwatched payment path.
                         */}
                        <footer className={styles.footer}>
                            <button
                                type="button"
                                className={styles.footerBtn}
                                onClick={() => onReprint(order)}
                            >
                                <Printer size={15} aria-hidden="true" />
                                Reprint receipt
                            </button>
                            {voidable && (
                                <button
                                    type="button"
                                    className={`${styles.footerBtn} ${styles.voidBtn}`}
                                    onClick={() => onVoid(order)}
                                >
                                    <Ban size={15} aria-hidden="true" />
                                    Void order
                                </button>
                            )}
                        </footer>
                    </>
                )}
            </aside>
        </div>
    );
}

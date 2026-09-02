'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import styles from '../accounts.module.css'
import { getPostingHealth, repostAll, repostOrder } from './actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import { formatDateTime } from '@/lib/timeFormat'
import {
    AlertTriangle, CheckCircle2, HeartPulse, Loader2, RefreshCw, RotateCcw, Scale,
} from 'lucide-react'

/*
 * Posting Health — not a ChowPOS screen; ours. The engine never blocks a
 * settle, so what it could not book has to be visible somewhere, and this is
 * the somewhere: four lists that should all be empty, and the button that
 * empties the first two. Nothing here is a queue; every row is derived from
 * the orders, payments, journals and expenses tables as they stand right
 * now. The fourth list — expenses typed on the Expenses screen — cannot be
 * reposted: those rows never reach the ledger, and are named here so they
 * can be re-entered as vouchers.
 */

const rupees = (n) =>
    `Rs. ${Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

const METHOD = { cash: 'Cash', card: 'Card', city_ledger: 'City ledger' }
const PAID_FROM = { drawer: 'Drawer', bank: 'Bank', other: 'Other' }

export default function PostingHealthPage() {
    const { can } = usePermissions()
    const canRepost = can('accounts_admin')

    const [data, setData] = useState(null)
    const [isLoading, setIsLoading] = useState(true)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState(null)          // order id being reposted, or 'all'
    const [outcomes, setOutcomes] = useState(null)  // the last Repost-all's per-order results

    const load = useCallback(async () => {
        const res = await getPostingHealth()
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setData(res.data)
        setIsLoading(false)
    }, [])

    useEffect(() => { load() }, [load])

    useEffect(() => {
        if (message.type !== 'success') return
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 6000)
        return () => clearTimeout(t)
    }, [message])

    const repost = async (orderId, invoice) => {
        setBusy(orderId)
        setMessage({ type: '', text: '' })
        const res = await repostOrder(orderId)
        if (res.error) {
            setMessage({ type: 'error', text: `${invoice}: ${res.error}` })
        } else if (res.data.status === 'skipped') {
            setMessage({ type: 'warn', text: `${invoice}: nothing posted — ${res.data.reason}` })
        } else {
            const n = res.data.vouchers.length
            setMessage({
                type: 'success',
                text: n === 0
                    ? `${invoice}: already in the ledger — nothing more to post`
                    : `${invoice}: posted ${n} voucher${n === 1 ? '' : 's'} (${res.data.vouchers.map((v) => v.voucher_no).join(', ')})`,
            })
        }
        setBusy(null)
        await load()
    }

    const repostEverything = async () => {
        setBusy('all')
        setMessage({ type: '', text: '' })
        setOutcomes(null)
        const res = await repostAll()
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
        } else {
            const d = res.data
            setOutcomes(d.outcomes.filter((o) => o.status !== 'posted' || o.vouchers === 0))
            setMessage({
                type: d.failed > 0 ? 'error' : d.skipped > 0 ? 'warn' : 'success',
                text: `${d.attempted} bill${d.attempted === 1 ? '' : 's'} tried: ${d.vouchers} voucher${d.vouchers === 1 ? '' : 's'} posted`
                    + (d.skipped ? `, ${d.skipped} skipped` : '')
                    + (d.failed ? `, ${d.failed} still failing` : ''),
            })
        }
        setBusy(null)
        await load()
    }

    const legacy = data?.expenses ?? []
    const legacyTotal = legacy.reduce((s, e) => s + Number(e.amount), 0)
    const gapCount = data ? data.orders.length + data.payments.length + data.journals.length + legacy.length : 0
    const repostable = data ? new Set([...data.orders.map((o) => o.id), ...data.payments.map((p) => p.order_id)]).size : 0

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Posting Health</h1>
                    <p className={styles.subtitle}>
                        Sales post themselves after every settle and never hold up the till. Anything
                        that did not make it into the ledger shows here, and Repost runs the same
                        posting again — safe to press twice.
                    </p>
                </div>
                <div className={styles.headerActions}>
                    <button type="button" className={styles.secondaryBtn} onClick={() => { setIsLoading(true); load() }} disabled={busy != null}>
                        <RefreshCw size={15} /> Refresh
                    </button>
                    {canRepost && (
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={repostEverything}
                            disabled={busy != null || repostable === 0}
                            title={repostable === 0 ? 'Nothing to repost' : `Repost ${repostable} bill${repostable === 1 ? '' : 's'}`}
                        >
                            {busy === 'all' ? <Loader2 size={16} className={styles.spinner} /> : <RotateCcw size={16} />}
                            Repost all{repostable > 0 ? ` (${repostable})` : ''}
                        </button>
                    )}
                </div>
            </div>

            {message.type && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`${styles.note} ${message.type === 'error' ? styles.noteError : message.type === 'warn' ? styles.noteWarn : styles.noteSuccess}`}
                >
                    {message.type === 'success'
                        ? <CheckCircle2 size={16} aria-hidden="true" />
                        : <AlertTriangle size={16} aria-hidden="true" />}
                    {message.text}
                </div>
            )}

            {data && !data.postingEnabled && (
                <div className={`${styles.note} ${styles.noteWarn}`} role="status">
                    <AlertTriangle size={16} aria-hidden="true" />
                    Posting is switched off in the ledger settings — new settles are not being booked, and Repost will skip them.
                </div>
            )}

            {outcomes && outcomes.length > 0 && (
                <div className={styles.listWrap} style={{ marginBottom: '1.25rem' }}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Bill</th>
                                <th>Outcome</th>
                                <th>Why</th>
                            </tr>
                        </thead>
                        <tbody>
                            {outcomes.map((o) => (
                                <tr key={o.order_id}>
                                    <td className={styles.cellCode}>{o.invoice_number}</td>
                                    <td>
                                        <span className={`${styles.chip} ${o.status === 'failed' ? styles.chipDanger : o.status === 'skipped' ? styles.chipWarn : styles.chipSuccess}`}>
                                            {o.status === 'posted' ? 'already posted' : o.status}
                                        </span>
                                    </td>
                                    <td className={styles.cellWrap}>{o.reason || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {isLoading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={28} />
                    <p>Checking the ledger…</p>
                </div>
            ) : !data ? null : gapCount === 0 ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <HeartPulse size={28} />
                        <p>
                            Every settled bill since {data.startDate ?? 'the ledger started'} is in the ledger.
                            Every payment has its settlement journal, every journal balances, and every expense
                            since then came in as a voucher.
                        </p>
                    </div>
                </div>
            ) : (
                <>
                    {/* 1. Settled bills with no sale journal */}
                    <p className={styles.cardSection} style={{ marginBottom: '0.6rem' }}>
                        Settled bills not in the ledger · {data.orders.length}
                    </p>
                    <div className={styles.listWrap} style={{ marginBottom: '1.5rem' }}>
                        {data.orders.length === 0 ? (
                            <div className={styles.stateBlock}>
                                <CheckCircle2 size={22} />
                                <p>Every settled bill since {data.startDate} has its sale journal.</p>
                            </div>
                        ) : (
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Invoice</th>
                                        <th>Day</th>
                                        <th>Order</th>
                                        <th>Settled</th>
                                        <th className={styles.alignRight}>Total</th>
                                        <th>Gap</th>
                                        {canRepost && <th></th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.orders.map((o) => (
                                        <tr key={o.id}>
                                            <td className={styles.cellCode}>{o.invoice_number}</td>
                                            <td className={styles.cellMuted}>{o.business_date}</td>
                                            <td className={styles.cellName}>
                                                <span className={styles.cellStrong}>
                                                    #{o.order_number} · {o.order_type}{o.table_number ? ` · ${o.table_number}` : ''}
                                                </span>
                                                <span className={styles.cellSub}>
                                                    {METHOD[o.payment_mode] ?? o.payment_mode ?? '—'}
                                                    {o.status === 'cancelled' ? ' · voided' : ''}
                                                </span>
                                            </td>
                                            <td className={styles.cellMuted}>{o.paid_at ? formatDateTime(new Date(o.paid_at)) : '—'}</td>
                                            <td className={`${styles.cellNum} ${styles.cellStrong}`}>{rupees(o.total)}</td>
                                            <td><span className={`${styles.chip} ${styles.chipWarn}`}>{o.gap}</span></td>
                                            {canRepost && (
                                                <td className={styles.alignRight}>
                                                    <button
                                                        type="button"
                                                        className={styles.secondaryBtn}
                                                        onClick={() => repost(o.id, o.invoice_number)}
                                                        disabled={busy != null}
                                                    >
                                                        {busy === o.id ? <Loader2 size={14} className={styles.spinner} /> : <RotateCcw size={14} />}
                                                        Repost
                                                    </button>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* 2. Payments rows with no settlement journal */}
                    <p className={styles.cardSection} style={{ marginBottom: '0.6rem' }}>
                        Payments without a settlement journal · {data.payments.length}
                    </p>
                    <div className={styles.listWrap} style={{ marginBottom: '1.5rem' }}>
                        {data.payments.length === 0 ? (
                            <div className={styles.stateBlock}>
                                <CheckCircle2 size={22} />
                                <p>Every payment since {data.startDate} has its settlement journal.</p>
                            </div>
                        ) : (
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Invoice</th>
                                        <th>Day</th>
                                        <th>Method</th>
                                        <th>Taken</th>
                                        <th className={styles.alignRight}>Amount</th>
                                        {canRepost && <th></th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.payments.map((p) => (
                                        <tr key={p.id}>
                                            <td className={styles.cellCode}>{p.invoice_number}</td>
                                            <td className={styles.cellMuted}>{p.business_date}</td>
                                            <td>
                                                {METHOD[p.method] ?? p.method}
                                                {p.amount < 0 && <span className={styles.cellSub}>void reversal</span>}
                                            </td>
                                            <td className={styles.cellMuted}>{p.paid_at ? formatDateTime(new Date(p.paid_at)) : '—'}</td>
                                            <td className={`${styles.cellNum} ${styles.cellStrong} ${p.amount < 0 ? styles.negative : ''}`}>
                                                {rupees(p.amount)}
                                            </td>
                                            {canRepost && (
                                                <td className={styles.alignRight}>
                                                    <button
                                                        type="button"
                                                        className={styles.secondaryBtn}
                                                        onClick={() => repost(p.order_id, p.invoice_number)}
                                                        disabled={busy != null}
                                                    >
                                                        {busy === p.order_id ? <Loader2 size={14} className={styles.spinner} /> : <RotateCcw size={14} />}
                                                        Repost
                                                    </button>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* 3. Journals whose header and lines disagree */}
                    <p className={styles.cardSection} style={{ marginBottom: '0.6rem' }}>
                        Journals that do not balance · {data.journals.length}
                    </p>
                    <div className={styles.listWrap} style={{ marginBottom: '1.5rem' }}>
                        {data.journals.length === 0 ? (
                            <div className={styles.stateBlock}>
                                <Scale size={22} />
                                <p>Every posted journal balances, and its header agrees with its lines.</p>
                            </div>
                        ) : (
                            <>
                                <div className={`${styles.note} ${styles.noteError}`} style={{ margin: '1rem', marginBottom: 0 }} role="alert">
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    These should be impossible. A journal is never edited; correct one with a contra voucher
                                    from <Link href="/accounts/journals/new">Add Transaction</Link> and note the voucher number here.
                                </div>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Voucher</th>
                                            <th>Day</th>
                                            <th>Description</th>
                                            <th className={styles.alignRight}>Header Dr</th>
                                            <th className={styles.alignRight}>Header Cr</th>
                                            <th className={styles.alignRight}>Lines Dr</th>
                                            <th className={styles.alignRight}>Lines Cr</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.journals.map((j) => (
                                            <tr key={j.id}>
                                                <td className={styles.cellCode}>
                                                    <Link href={`/accounts/journals/${j.id}`}>{j.voucher_no}</Link>
                                                </td>
                                                <td className={styles.cellMuted}>{j.business_date}</td>
                                                <td className={styles.cellWrap}>
                                                    {j.description}
                                                    {j.line_count === 0 && <span className={styles.cellSub}>no lines at all</span>}
                                                </td>
                                                <td className={styles.cellNum}>{rupees(j.debit_total)}</td>
                                                <td className={styles.cellNum}>{rupees(j.credit_total)}</td>
                                                <td className={`${styles.cellNum} ${j.line_debit !== j.debit_total ? styles.negative : ''}`}>{rupees(j.line_debit)}</td>
                                                <td className={`${styles.cellNum} ${j.line_credit !== j.credit_total ? styles.negative : ''}`}>{rupees(j.line_credit)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        )}
                    </div>

                    {/* 4. Expenses typed outside the voucher screen: never in the ledger */}
                    <p className={styles.cardSection} style={{ marginBottom: '0.6rem' }}>
                        Expenses typed on the Expenses screen · {legacy.length}
                    </p>
                    <div className={styles.listWrap}>
                        {legacy.length === 0 ? (
                            <div className={styles.stateBlock}>
                                <CheckCircle2 size={22} />
                                <p>Every expense since {data.startDate} came in as an expense voucher, so it is in the ledger.</p>
                            </div>
                        ) : (
                            <>
                                <div className={`${styles.note} ${styles.noteWarn}`} style={{ margin: '1rem', marginBottom: 0 }} role="status">
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    These were typed on the <Link href="/expenses">Expenses</Link> screen, which lowers the drawer&apos;s
                                    expected cash but writes nothing to the ledger — GL cash sits {rupees(legacyTotal)} above the drawer
                                    until each is re-entered as an <Link href="/accounts/expense-vouchers/new">expense voucher</Link> and
                                    deleted there.
                                </div>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Day</th>
                                            <th>Category</th>
                                            <th>Description</th>
                                            <th>Payee</th>
                                            <th>Paid from</th>
                                            <th>Status</th>
                                            <th className={styles.alignRight}>Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {legacy.map((e) => (
                                            <tr key={e.id}>
                                                <td className={styles.cellMuted}>{e.business_date}</td>
                                                <td className={styles.cellMuted}>{e.category || '—'}</td>
                                                <td className={styles.cellWrap}>{e.description}</td>
                                                <td className={styles.cellMuted}>{e.payee || '—'}</td>
                                                <td>{PAID_FROM[e.paid_from] ?? e.paid_from}</td>
                                                <td>
                                                    <span className={`${styles.chip} ${e.status === 'paid' ? styles.chipSuccess : styles.chipWarn}`}>
                                                        {e.status}
                                                    </span>
                                                </td>
                                                <td className={`${styles.cellNum} ${styles.cellStrong}`}>{rupees(e.amount)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot className={styles.tfoot}>
                                        <tr>
                                            <td colSpan={6}>Not in the ledger · {legacy.length} row{legacy.length === 1 ? '' : 's'}</td>
                                            <td className={styles.cellNum}>{rupees(legacyTotal)}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    )
}

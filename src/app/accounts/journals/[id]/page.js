'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import styles from '../../accounts.module.css'
import own from './voucher.module.css'
import { getJournal, reverseJournal } from '../actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import { formatDateTime } from '@/lib/timeFormat'
import {
    Files, Loader2, AlertTriangle, CheckCircle2, Printer, ArrowLeft, Undo2, X,
} from 'lucide-react'

/*
 * One voucher as a document: the header, its lines, the totals. The only
 * action is Reverse — a contra JV dated the open business day — offered
 * once per voucher, and only for a voucher a person wrote: an engine
 * journal is undone from its document (void the bill, reverse the expense
 * voucher), and the engine's own contra is linked here when it exists.
 */

const rs = (n) => {
    const v = Math.round((Number(n) || 0) * 100) / 100
    return v === 0 ? '' : v.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}
const rsTotal = (n) => (Math.round((Number(n) || 0) * 100) / 100)
    .toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

const STATUS_CLASS = { draft: 'statusDraft', posted: 'statusPosted', void: 'statusVoid' }

/* Where a machine posting came from, in words. */
const SOURCE_LABEL = {
    order_sale: 'Sale of bill',
    order_settlement: 'Settlement of bill',
    order_sale_reversal: 'Void of bill',
    expense_voucher: 'Expense voucher',
    expense_payment: 'Expense voucher payment',
    expense_voucher_reversal: 'Reversal of expense voucher',
    expense_payment_reversal: 'Reversal of expense payment',
    cl_receipt: 'City-ledger receipt',
    supplier_payment: 'Supplier payment',
    stock_receiving: 'Goods received',
    drawer_variance: 'Drawer variance',
    manual: 'Manual entry',
    reversal: 'Reversal',
}

/* How a machine posting is undone — never from this page. */
const correctionHint = (sourceType) => {
    const t = String(sourceType || '')
    if (t.startsWith('order_')) return 'Posted automatically from the bill. To undo it, void the bill: the ledger writes the contra journal itself.'
    if (t.startsWith('expense_')) return 'Posted automatically from the expense voucher. To undo it, reverse the voucher under Expense Vouchers: the ledger writes the contra journals itself.'
    return 'Posted automatically. To correct it, post a contra voucher from Add Transaction.'
}

export default function VoucherPage() {
    const { id } = useParams()
    const { can } = usePermissions()
    const canReverse = can('accounts_admin')

    const [journal, setJournal] = useState(null)
    const [isLoading, setIsLoading] = useState(true)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [confirming, setConfirming] = useState(false)
    const [reversing, setReversing] = useState(false)

    // State moves only in the response callback, never synchronously in the effect.
    const load = useCallback(() => getJournal(id).then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setJournal(res.data)
        setIsLoading(false)
    }), [id])

    useEffect(() => { load() }, [load])

    useEffect(() => {
        if (message.type !== 'success') return
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const doReverse = async () => {
        setReversing(true)
        const res = await reverseJournal(id)
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
        } else {
            setMessage({ type: 'success', text: `Reversed by ${res.data.voucher_no} on ${res.data.business_date}` })
        }
        setConfirming(false)
        setReversing(false)
        await load()
    }

    const showReverse = journal && journal.status === 'posted' && journal.is_manual && !journal.reversal && canReverse

    return (
        <div className={styles.container} id="ledger-root">
            <div className={styles.header}>
                <div>
                    <div className={own.titleRow}>
                        <h1 className={styles.title}>{journal ? journal.voucher_no : 'Voucher'}</h1>
                        {journal && (
                            <span className={`${styles.status} ${styles[STATUS_CLASS[journal.status] || 'statusDraft']}`}>
                                {journal.status}
                            </span>
                        )}
                    </div>
                    <p className={styles.subtitle}>
                        {journal ? `${journal.voucher_type_label} voucher · ${journal.description}` : 'One journal, as it was posted.'}
                    </p>
                </div>
                <div className={`${styles.headerActions} no-print`}>
                    <Link href="/accounts/journals" className={styles.secondaryBtn}>
                        <ArrowLeft size={15} /> Vouchers
                    </Link>
                    <button type="button" className={styles.secondaryBtn} onClick={() => window.print()} disabled={!journal}>
                        <Printer size={15} /> Print / Save as PDF
                    </button>
                    {showReverse && (
                        <button
                            type="button"
                            className={`${styles.secondaryBtn} ${styles.dangerOutline}`}
                            onClick={() => setConfirming(true)}
                        >
                            <Undo2 size={15} /> Reverse
                        </button>
                    )}
                </div>
            </div>

            {message.type && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`${styles.note} ${message.type === 'error' ? styles.noteError : styles.noteSuccess} no-print`}
                >
                    {message.type === 'error'
                        ? <AlertTriangle size={16} aria-hidden="true" />
                        : <CheckCircle2 size={16} aria-hidden="true" />}
                    {message.text}
                </div>
            )}

            {isLoading ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={28} />
                        <p>Loading the voucher…</p>
                    </div>
                </div>
            ) : !journal ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <Files size={28} />
                        <p>This voucher could not be found.</p>
                    </div>
                </div>
            ) : (
                <div className={own.doc}>
                    <div className={styles.card}>
                        <div className={own.meta}>
                            <div>
                                <span className={own.metaLabel}>Date</span>
                                <div className={own.metaValue}>{journal.business_date}</div>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Type</span>
                                <div className={own.metaValue}>{journal.voucher_type} · {journal.voucher_type_label}</div>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Reference</span>
                                <div className={`${own.metaValue} ${own.metaMono}`}>{journal.reference || '—'}</div>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Source</span>
                                <div className={own.metaValue}>
                                    {SOURCE_LABEL[journal.source_type] || journal.source_type}
                                    <span className={styles.cellSub}>
                                        {journal.is_manual ? 'Manual' : 'Posted automatically'}
                                        {journal.source_type !== 'reversal' && journal.source_type !== 'manual' ? ` · ${journal.source_type} ${journal.source_id}` : ''}
                                    </span>
                                </div>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Posted by</span>
                                <div className={own.metaValue}>
                                    {journal.created_by_name || (journal.created_by ? 'A former user' : 'System')}
                                    <span className={styles.cellSub}>{journal.created_at ? formatDateTime(new Date(journal.created_at)) : ''}</span>
                                </div>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Description</span>
                                <div className={own.metaValue}>{journal.description}</div>
                            </div>
                        </div>

                        {(journal.reversal || journal.reverses) && (
                            <div className={own.relation}>
                                <Undo2 size={14} aria-hidden="true" />
                                {journal.reversal && (
                                    <span>
                                        Reversed by{' '}
                                        <Link href={`/accounts/journals/${journal.reversal.id}`}>{journal.reversal.voucher_no}</Link>
                                        {' '}on {journal.reversal.business_date}
                                    </span>
                                )}
                                {journal.reverses && (
                                    <span>
                                        Reverses{' '}
                                        <Link href={`/accounts/journals/${journal.reverses.id}`}>{journal.reverses.voucher_no}</Link>
                                        {' '}of {journal.reverses.business_date}
                                    </span>
                                )}
                            </div>
                        )}
                        {!journal.is_manual && journal.status === 'posted' && !journal.reversal && canReverse && (
                            <p className={`${styles.hint} no-print`}>{correctionHint(journal.source_type)}</p>
                        )}
                    </div>

                    <div className={styles.listWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Account #</th>
                                    <th>Account</th>
                                    <th>Memo</th>
                                    <th className={styles.alignRight}>Debit</th>
                                    <th className={styles.alignRight}>Credit</th>
                                </tr>
                            </thead>
                            <tbody>
                                {journal.lines.map((l) => (
                                    <tr key={l.id}>
                                        <td className={styles.cellCode}>{l.account_number}</td>
                                        <td className={styles.cellStrong}>{l.account_name}</td>
                                        <td className={`${styles.cellMuted} ${styles.cellWrap}`} style={{ whiteSpace: 'normal' }}>{l.memo || ''}</td>
                                        <td className={styles.cellNum}>{rs(l.debit)}</td>
                                        <td className={styles.cellNum}>{rs(l.credit)}</td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot className={styles.tfoot}>
                                <tr>
                                    <td colSpan={3}>Total · {journal.lines.length} line{journal.lines.length === 1 ? '' : 's'}</td>
                                    <td className={styles.cellNum}>{rsTotal(journal.debit_total)}</td>
                                    <td className={styles.cellNum}>{rsTotal(journal.credit_total)}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}

            {confirming && journal && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="reverse-title">
                    <div className={styles.modal}>
                        <h2 className={styles.modalTitle} id="reverse-title">Reverse {journal.voucher_no}?</h2>
                        <p className={styles.modalBody}>
                            A new JV will post today with every line swapped — debits become credits and credits become debits —
                            for {rsTotal(journal.debit_total)}. {journal.voucher_no} itself stays on the books unchanged; the pair nets to zero.
                            This cannot be undone except by reversing the reversal.
                        </p>
                        <div className={styles.modalActions}>
                            <button type="button" className={styles.secondaryBtn} onClick={() => setConfirming(false)} disabled={reversing}>
                                <X size={15} /> Keep it
                            </button>
                            <button type="button" className={styles.primaryBtn} onClick={doReverse} disabled={reversing}>
                                {reversing ? <Loader2 size={16} className={styles.spinner} /> : <Undo2 size={16} />}
                                Post the reversal
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style jsx global>{`
                @media print {
                    body { background: white !important; }
                    .no-print, aside { display: none !important; }
                    main { margin-left: 0 !important; width: 100% !important; }
                    #ledger-root, #ledger-root * { color: #111 !important; }
                    @page { size: A4; margin: 12mm; }
                }
            `}</style>
        </div>
    )
}

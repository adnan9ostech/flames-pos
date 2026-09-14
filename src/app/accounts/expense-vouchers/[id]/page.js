'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import styles from '../../accounts.module.css'
import own from '../voucher.module.css'
import VoucherEditor from '../VoucherEditor'
import { getVoucher, getVoucherFormData, addPayment, reverseVoucher } from '../actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import { fmtDay } from '../../reports/ReportTools'
import { formatDateTime } from '@/lib/timeFormat'
import {
    ReceiptText, Loader2, AlertTriangle, CheckCircle2, Printer, ArrowLeft, Undo2, X, Wallet, Plus,
} from 'lucide-react'

/*
 * One expense voucher. A draft is the editor; a posted or void voucher is
 * the document read-only — its lines, its payments, the journals it wrote —
 * with the two verbs that remain: Add payment (for what is still owed) and
 * Reverse (accounts_admin: contra journals on the open day, the projection
 * withdrawn from the Expenses screen and the drawer).
 */

const rupees = (n) => (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/* The one-line confirmation the /new page left for us, shown once. */
const takeFlash = () => {
    try {
        const flash = sessionStorage.getItem('ev-flash')
        if (flash) sessionStorage.removeItem('ev-flash')
        return flash || ''
    } catch { return '' }
}

const STATUS_CLASS = { draft: 'statusDraft', posted: 'statusPosted', void: 'statusVoid' }
const TYPE_LABEL = { EV: 'Expense', PV: 'Payment' }

export default function ExpenseVoucherPage() {
    const { id } = useParams()
    const router = useRouter()
    const { can } = usePermissions()
    const canReverse = can('accounts_admin')

    const [voucher, setVoucher] = useState(null)
    const [formData, setFormData] = useState(null)
    const [isLoading, setIsLoading] = useState(true)
    const [message, setMessage] = useState({ type: '', text: '' })

    const [paying, setPaying] = useState(false)
    const [payment, setPayment] = useState({ account_id: '', amount: '', paid_on: '', reference: '' })
    const [payBusy, setPayBusy] = useState(false)
    const [payError, setPayError] = useState('')

    const [confirming, setConfirming] = useState(false)
    const [reason, setReason] = useState('')
    const [reversing, setReversing] = useState(false)

    useEffect(() => {
        let cancelled = false
        Promise.all([getVoucher(id), getVoucherFormData()]).then(([v, f]) => {
            if (cancelled) return
            const flash = takeFlash()
            if (v.error) setMessage({ type: 'error', text: v.error })
            else {
                setVoucher(v.data)
                if (flash) setMessage({ type: 'success', text: flash })
            }
            if (f.error) setMessage({ type: 'error', text: f.error })
            else setFormData(f.data)
            setIsLoading(false)
        })
        return () => { cancelled = true }
    }, [id])

    useEffect(() => {
        if (message.type !== 'success') return
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 6000)
        return () => clearTimeout(t)
    }, [message])

    const done = async (kind, data) => {
        if (kind === 'delete') {
            try { sessionStorage.setItem('ev-flash', `${data.voucher_no} deleted`) } catch { /* fine */ }
            router.push('/accounts/expense-vouchers')
            return
        }
        setVoucher(data)
        setMessage({
            type: 'success',
            text: kind === 'post'
                ? `${data.voucher_no} posted: journal ${data.journals.map((j) => j.voucher_no).join(', ')}`
                : `${data.voucher_no} saved`,
        })
        window.scrollTo({ top: 0 })
    }

    const openPay = () => {
        setPayment({
            account_id: formData?.payAccounts?.[0] ? String(formData.payAccounts[0].id) : '',
            amount: String(voucher.owed),
            paid_on: formData?.today || voucher.business_date,
            reference: '',
        })
        setPayError('')
        setPaying(true)
    }

    const submitPay = async (e) => {
        e.preventDefault()
        setPayBusy(true)
        setPayError('')
        const res = await addPayment(voucher.id, payment)
        setPayBusy(false)
        if (res.error) { setPayError(res.error); return }
        setPaying(false)
        setVoucher(res.data)
        setMessage({ type: 'success', text: `Payment recorded: journal ${res.data.journal.voucher_no}. ${res.data.owed > 0 ? `Rs. ${rupees(res.data.owed)} still owed.` : 'Paid in full.'}` })
    }

    const doReverse = async () => {
        setReversing(true)
        const res = await reverseVoucher(voucher.id, reason)
        setReversing(false)
        setConfirming(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setVoucher(res.data)
        setMessage({ type: 'success', text: `${res.data.voucher_no} reversed by ${res.data.reversal.map((j) => j.voucher_no).join(', ')}: its lines are off the Expenses screen` })
    }

    const isDraft = voucher?.status === 'draft'
    const isPosted = voucher?.status === 'posted'
    const projectedPaid = voucher ? voucher.expenses.filter((e) => e.status === 'paid').length : 0

    return (
        <div className={styles.container} id="expense-voucher-root">
            <div className={styles.header}>
                <div>
                    <div className={own.titleRow}>
                        <h1 className={styles.title}>{voucher ? voucher.voucher_no : 'Expense Voucher'}</h1>
                        {voucher && (
                            <span className={`${styles.status} ${styles[STATUS_CLASS[voucher.status] || 'statusDraft']}`}>
                                {voucher.status}
                            </span>
                        )}
                    </div>
                    <p className={styles.subtitle}>
                        {!voucher ? 'One expense voucher.'
                            : isDraft ? 'A draft: not in the books until you post it.'
                                : isPosted ? `Posted ${voucher.posted_at ? formatDateTime(new Date(voucher.posted_at)) : ''} · ${voucher.owed > 0 ? `Rs. ${rupees(voucher.owed)} still owed` : 'paid in full'}`
                                    : 'Reversed. The contra journals below cancel it; nothing of it remains on the Expenses screen.'}
                    </p>
                </div>
                <div className={`${styles.headerActions} no-print`}>
                    <Link href="/accounts/expense-vouchers" className={styles.secondaryBtn}>
                        <ArrowLeft size={15} /> Vouchers
                    </Link>
                    {voucher && !isDraft && (
                        <button type="button" className={styles.secondaryBtn} onClick={() => window.print()}>
                            <Printer size={15} /> Print / Save as PDF
                        </button>
                    )}
                    {isPosted && voucher.owed > 0 && formData && (
                        <button type="button" className={styles.primaryBtn} onClick={openPay}>
                            <Wallet size={15} /> Add payment
                        </button>
                    )}
                    {isPosted && canReverse && (
                        <button
                            type="button"
                            className={`${styles.secondaryBtn} ${styles.dangerOutline}`}
                            onClick={() => { setReason(''); setConfirming(true) }}
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
            ) : !voucher ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <ReceiptText size={28} />
                        <p>This voucher could not be found.</p>
                    </div>
                </div>
            ) : isDraft ? (
                formData && <VoucherEditor key={voucher.id} voucher={voucher} formData={formData} onDone={done} />
            ) : (
                <div className={own.doc}>
                    <div className={styles.card}>
                        <div className={own.meta}>
                            <div>
                                <span className={own.metaLabel}>Date</span>
                                <span className={own.metaValue}>{fmtDay(voucher.business_date)}</span>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Total</span>
                                <span className={own.metaValue}>Rs. {rupees(voucher.total)}</span>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Paid</span>
                                <span className={own.metaValue}>Rs. {rupees(voucher.paid_total)}</span>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Owed</span>
                                <span className={`${own.metaValue} ${voucher.owed > 0 && isPosted ? styles.negative : ''}`}>
                                    Rs. {rupees(voucher.owed)}
                                </span>
                            </div>
                            <div>
                                <span className={own.metaLabel}>Remarks</span>
                                <span className={own.metaValue}>{voucher.remarks || <span className={styles.cellMuted}>—</span>}</span>
                            </div>
                        </div>
                    </div>

                    <div className={styles.listWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th colSpan={4}>Expenses</th>
                                    <th className={styles.alignRight}>Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {voucher.lines.map((l) => (
                                    <tr key={l.id}>
                                        <td className={styles.cellCode}>{l.code}</td>
                                        <td className={styles.cellName}>
                                            <span className={styles.cellStrong}>{l.description || l.code_name}</span>
                                            <span className={styles.cellSub}>{l.code_name}{l.category_name ? ` · ${l.category_name}` : ''}</span>
                                        </td>
                                        <td className={styles.cellMuted}>Dr {l.account_number} {l.account_name}</td>
                                        <td className={styles.cellMuted}>
                                            {l.payable_account_name ? `Cr ${l.payable_account_name} while unpaid` : ''}
                                        </td>
                                        <td className={styles.cellNum}>{rupees(l.amount)}</td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot className={styles.tfoot}>
                                <tr>
                                    <td colSpan={4}>Total</td>
                                    <td className={styles.cellNum}>{rupees(voucher.total)}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>

                    <div className={styles.listWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Payments</th>
                                    <th>Paid on</th>
                                    <th>Reference</th>
                                    <th className={styles.alignRight}>Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {voucher.payments.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} className={styles.cellMuted}>
                                            No payments: the whole voucher is booked as a payable.
                                        </td>
                                    </tr>
                                ) : voucher.payments.map((p) => (
                                    <tr key={p.id}>
                                        <td className={styles.cellName}>
                                            <span className={styles.cellStrong}>{p.account_name}</span>
                                            <span className={styles.cellSub}>{p.account_number}</span>
                                        </td>
                                        <td className={styles.cellMuted}>{fmtDay(p.paid_on)}</td>
                                        <td className={styles.cellMuted}>{p.reference || '—'}</td>
                                        <td className={styles.cellNum}>{rupees(p.amount)}</td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot className={styles.tfoot}>
                                <tr>
                                    <td colSpan={3}>
                                        Paid
                                        {isPosted && voucher.owed > 0 && formData && (
                                            <button type="button" className={`${styles.secondaryBtn} no-print`} onClick={openPay} style={{ marginLeft: '0.75rem', minHeight: 32, padding: '0.3rem 0.7rem' }}>
                                                <Plus size={14} /> Add payment
                                            </button>
                                        )}
                                    </td>
                                    <td className={styles.cellNum}>{rupees(voucher.paid_total)}</td>
                                </tr>
                                {voucher.owed > 0 && (
                                    <tr>
                                        <td colSpan={3}>Owed</td>
                                        <td className={`${styles.cellNum} ${isPosted ? styles.negative : ''}`}>{rupees(voucher.owed)}</td>
                                    </tr>
                                )}
                            </tfoot>
                        </table>
                    </div>

                    <div className={styles.listWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Journal</th>
                                    <th>Type</th>
                                    <th>Date</th>
                                    <th>Description</th>
                                    <th className={styles.alignRight}>Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {voucher.journals.length === 0 ? (
                                    <tr><td colSpan={5} className={styles.cellMuted}>Nothing in the ledger.</td></tr>
                                ) : voucher.journals.map((j) => (
                                    <tr key={j.id}>
                                        <td className={styles.cellCode}>
                                            <Link href={`/accounts/journals/${j.id}`} className={own.journalLink}>{j.voucher_no}</Link>
                                        </td>
                                        <td>
                                            <span className={`${styles.chip} ${j.source_type.endsWith('_reversal') ? styles.chipDanger : styles.chipPrimary}`}>
                                                {j.source_type.endsWith('_reversal') ? 'Reversal' : TYPE_LABEL[j.voucher_type] || j.voucher_type}
                                            </span>
                                        </td>
                                        <td className={styles.cellMuted}>{fmtDay(j.business_date)}</td>
                                        <td className={styles.cellWrap}>{j.description}</td>
                                        <td className={styles.cellNum}>{rupees(j.amount)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <p className={`${styles.hint} no-print`}>
                        {voucher.status === 'void'
                            ? 'Its rows were removed from the Expenses screen when it was reversed; the journals above stay, as journals do.'
                            : `On the Expenses screen as ${voucher.expenses.length} row${voucher.expenses.length === 1 ? '' : 's'} (${projectedPaid} paid, ${voucher.expenses.length - projectedPaid} payable). A line paid from the drawer counts against that drawer's expected cash.`}
                    </p>
                </div>
            )}

            {paying && voucher && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="ev-pay-title">
                    <form className={styles.modal} onSubmit={submitPay}>
                        <h2 id="ev-pay-title" className={styles.modalTitle}>Pay {voucher.voucher_no}</h2>
                        <p className={styles.modalBody}>
                            Rs. {rupees(voucher.owed)} is owed. The payment posts a PV journal on the day you give, and the lines it clears move to paid on the Expenses screen.
                        </p>
                        {payError && (
                            <div role="alert" className={`${styles.note} ${styles.noteError}`} style={{ marginBottom: 0 }}>
                                <AlertTriangle size={16} aria-hidden="true" /> {payError}
                            </div>
                        )}
                        <label className={styles.field}>
                            <span className={`${styles.fieldLabel} ${styles.required}`}>Paid from</span>
                            <select
                                className={styles.input}
                                value={payment.account_id}
                                onChange={(e) => setPayment((p) => ({ ...p, account_id: e.target.value }))}
                                required
                            >
                                <option value="">Pick an account…</option>
                                {formData.payAccounts.map((a) => (
                                    <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                                ))}
                            </select>
                        </label>
                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Amount</span>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0.01"
                                    max={voucher.owed}
                                    step="0.01"
                                    className={`${styles.input} ${styles.inputNum}`}
                                    value={payment.amount}
                                    onChange={(e) => setPayment((p) => ({ ...p, amount: e.target.value }))}
                                    required
                                />
                            </label>
                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Paid on</span>
                                <input
                                    type="date"
                                    className={styles.input}
                                    value={payment.paid_on}
                                    onChange={(e) => setPayment((p) => ({ ...p, paid_on: e.target.value }))}
                                    required
                                />
                            </label>
                        </div>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Reference</span>
                            <input
                                type="text"
                                className={styles.input}
                                value={payment.reference}
                                onChange={(e) => setPayment((p) => ({ ...p, reference: e.target.value }))}
                                placeholder="Cheque no., transfer ref"
                                maxLength={64}
                            />
                        </label>
                        <div className={styles.modalActions}>
                            <button type="button" className={styles.secondaryBtn} onClick={() => setPaying(false)} disabled={payBusy}>
                                <X size={15} /> Cancel
                            </button>
                            <button type="submit" className={styles.primaryBtn} disabled={payBusy}>
                                {payBusy ? <Loader2 size={16} className={styles.spinner} /> : <CheckCircle2 size={16} />}
                                Record payment
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {confirming && voucher && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="ev-reverse-title">
                    <div className={styles.modal}>
                        <h2 id="ev-reverse-title" className={styles.modalTitle}>Reverse {voucher.voucher_no}?</h2>
                        <p className={styles.modalBody}>
                            A contra journal is written for each of its {voucher.journals.filter((j) => !j.source_type.endsWith('_reversal')).length} journal{voucher.journals.length === 1 ? '' : 's'}, dated the open business day; the originals stay. Its {voucher.expenses.length} row{voucher.expenses.length === 1 ? '' : 's'} come off the Expenses screen, so any drawer that counted them will expect more cash. The voucher becomes void and cannot be edited or re-posted. Enter a new one if it was merely wrong.
                        </p>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Reason</span>
                            <input
                                type="text"
                                className={styles.input}
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="Entered twice, wrong month…"
                                maxLength={120}
                            />
                        </label>
                        <div className={styles.modalActions}>
                            <button type="button" className={styles.secondaryBtn} onClick={() => setConfirming(false)} disabled={reversing}>
                                <X size={15} /> Keep it
                            </button>
                            <button type="button" className={`${styles.secondaryBtn} ${styles.dangerOutline}`} onClick={doReverse} disabled={reversing}>
                                {reversing ? <Loader2 size={15} className={styles.spinner} /> : <Undo2 size={15} />}
                                Reverse voucher
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
                    #expense-voucher-root, #expense-voucher-root * { color: #111 !important; }
                    @page { size: A4; margin: 12mm; }
                }
            `}</style>
        </div>
    )
}

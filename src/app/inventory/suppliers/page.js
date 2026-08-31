'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import styles from './suppliers.module.css'
import { listSupplierBalances, getSupplierLedger, recordSupplierPayment } from './actions'
import { formatDateTime, formatWeekdayDate } from '@/lib/timeFormat'
import {
    Wallet, Download, Loader2, AlertTriangle, CheckCircle2,
    ChevronLeft, Truck, Banknote, ReceiptText,
} from 'lucide-react'

const METHODS = [
    { key: 'cash', label: 'Cash' },
    { key: 'bank', label: 'Bank transfer' },
    { key: 'cheque', label: 'Cheque' },
]

const METHOD_LABEL = Object.fromEntries(METHODS.map((m) => [m.key, m.label]))

const EMPTY_PAY_FORM = { amount: '', method: 'cash', reference: '' }

const rupees = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

// business_date arrives as 'YYYY-MM-DD'; parsed at local midnight so the
// label can't slip a day on a machine set away from PKT.
const dayLabel = (d) => (d ? formatWeekdayDate(new Date(`${d}T00:00:00`)) : '—')

const karachiToday = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

const csvCell = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function SuppliersPage() {
    const [book, setBook] = useState(null)
    const [loadError, setLoadError] = useState('')

    const [supplierId, setSupplierId] = useState('')
    const [ledger, setLedger] = useState(null)
    const [ledgerBusy, setLedgerBusy] = useState(false)
    const [ledgerError, setLedgerError] = useState('')

    const [payForm, setPayForm] = useState(EMPTY_PAY_FORM)
    const [payBusy, setPayBusy] = useState(false)
    const [payNote, setPayNote] = useState({ type: '', text: '' })

    const load = useCallback(async () => {
        const res = await listSupplierBalances()
        if (res.error) setLoadError(res.error)
        else {
            setLoadError('')
            setBook(res.data)
        }
    }, [])

    const loadLedger = useCallback(async (id) => {
        setLedgerBusy(true)
        setLedgerError('')
        const res = await getSupplierLedger(Number(id))
        if (res.error) {
            setLedgerError(res.error)
            setLedger(null)
        } else {
            setLedger(res.data)
        }
        setLedgerBusy(false)
    }, [])

    useEffect(() => { load() }, [load])

    useEffect(() => {
        if (supplierId) loadLedger(supplierId)
        else setLedger(null)
    }, [supplierId, loadLedger])

    // Clear a success note on its own; errors stay until the next attempt.
    useEffect(() => {
        if (payNote.type !== 'success') return
        const timer = setTimeout(() => setPayNote({ type: '', text: '' }), 4000)
        return () => clearTimeout(timer)
    }, [payNote])

    const payables = useMemo(
        () => (book ?? []).filter((s) => s.balance > 0),
        [book],
    )

    const totals = useMemo(() => payables.reduce(
        (acc, s) => ({
            received: acc.received + s.received,
            paid: acc.paid + s.paid,
            balance: acc.balance + s.balance,
        }),
        { received: 0, paid: 0, balance: 0 },
    ), [payables])

    // Client-built CSV, downloaded via a Blob link — no deps, no round trip.
    // Raw numbers, not display strings: this file is headed for a spreadsheet.
    const exportPayables = () => {
        const rows = [
            ['Supplier', 'Received', 'Paid', 'Balance'],
            ...payables.map((s) => [s.name, s.received, s.paid, s.balance]),
            ['Total', totals.received, totals.paid, totals.balance],
        ]
        const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n')
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `supplier-payables-${karachiToday()}.csv`
        a.click()
        URL.revokeObjectURL(url)
    }

    const submitPayment = async (e) => {
        e.preventDefault()
        setPayBusy(true)
        setPayNote({ type: '', text: '' })
        const res = await recordSupplierPayment({
            supplierId: Number(supplierId),
            amount: Number(payForm.amount),
            method: payForm.method,
            reference: payForm.reference,
        })
        if (res.error) {
            setPayNote({ type: 'error', text: res.error })
        } else {
            setPayNote({
                type: 'success',
                text: `${rupees(res.data.amount)} paid by ${METHOD_LABEL[res.data.method].toLowerCase()}.`,
            })
            // Method survives the reset: a payment run is usually one cheque
            // book or one cash drawer, not a mix.
            setPayForm((prev) => ({ ...EMPTY_PAY_FORM, method: prev.method }))
            await Promise.all([load(), loadLedger(supplierId)])
        }
        setPayBusy(false)
    }

    if (loadError) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.errorNote}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {loadError}
                </div>
            </div>
        )
    }

    if (!book) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Adding up the accounts…</p>
                </div>
            </div>
        )
    }

    return (
        <div className={styles.container}>
            <PageHeader />

            {/* ===== Payables summary ===== */}
            <section className={styles.card}>
                <div className={styles.cardHeader}>
                    <h2 className={styles.cardTitle}>
                        <Wallet size={16} aria-hidden="true" />
                        Payables
                    </h2>
                    <button
                        type="button"
                        className={styles.exportBtn}
                        onClick={exportPayables}
                        disabled={payables.length === 0}
                    >
                        <Download size={13} aria-hidden="true" />
                        Export CSV
                    </button>
                </div>

                {payables.length === 0 ? (
                    <div className={styles.emptyBlock}>Nothing owed — every supplier account is settled.</div>
                ) : (
                    <div className={styles.tableWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Supplier</th>
                                    <th className={styles.alignRight}>Received</th>
                                    <th className={styles.alignRight}>Paid</th>
                                    <th className={styles.alignRight}>Balance</th>
                                </tr>
                            </thead>
                            <tbody>
                                {payables.map((s) => (
                                    <tr key={s.id}>
                                        <td className={styles.cellStrong}>
                                            {s.name}
                                            {!s.is_active && <span className={styles.inactiveChip}>inactive</span>}
                                        </td>
                                        <td className={`${styles.alignRight} ${styles.num}`}>{rupees(s.received)}</td>
                                        <td className={`${styles.alignRight} ${styles.num}`}>{rupees(s.paid)}</td>
                                        <td className={`${styles.alignRight} ${styles.num} ${styles.owed}`}>{rupees(s.balance)}</td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr>
                                    <td className={styles.cellStrong}>Total</td>
                                    <td className={`${styles.alignRight} ${styles.num}`}>{rupees(totals.received)}</td>
                                    <td className={`${styles.alignRight} ${styles.num}`}>{rupees(totals.paid)}</td>
                                    <td className={`${styles.alignRight} ${styles.num} ${styles.owed}`}>{rupees(totals.balance)}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}
            </section>

            {/* ===== Supplier ledger + payment ===== */}
            <section className={styles.card}>
                <div className={styles.cardHeader}>
                    <h2 className={styles.cardTitle}>
                        <ReceiptText size={16} aria-hidden="true" />
                        Supplier Ledger
                    </h2>
                    <label className={styles.control}>
                        <select
                            className={styles.inputSelect}
                            value={supplierId}
                            onChange={(e) => setSupplierId(e.target.value)}
                            aria-label="Supplier account"
                        >
                            <option value="" disabled>Pick a supplier…</option>
                            {book.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.name}{s.balance !== 0 ? ` — ${rupees(s.balance)}` : ''}
                                </option>
                            ))}
                        </select>
                        {ledgerBusy && <Loader2 className={styles.inlineSpinner} size={14} />}
                    </label>
                </div>

                {supplierId && (
                    <form className={styles.payForm} onSubmit={submitPayment}>
                        <span className={styles.payLabel}>
                            <Banknote size={15} aria-hidden="true" />
                            Record payment
                        </span>
                        <input
                            type="number"
                            className={`${styles.input} ${styles.amountInput}`}
                            min="0"
                            step="any"
                            inputMode="decimal"
                            placeholder="Amount"
                            value={payForm.amount}
                            onChange={(e) => setPayForm((prev) => ({ ...prev, amount: e.target.value }))}
                            aria-label="Payment amount"
                            required
                        />
                        <select
                            className={styles.inputSelect}
                            value={payForm.method}
                            onChange={(e) => setPayForm((prev) => ({ ...prev, method: e.target.value }))}
                            aria-label="Payment method"
                        >
                            {METHODS.map((m) => (
                                <option key={m.key} value={m.key}>{m.label}</option>
                            ))}
                        </select>
                        <input
                            className={styles.input}
                            placeholder="Reference (cheque no, slip…)"
                            maxLength={64}
                            value={payForm.reference}
                            onChange={(e) => setPayForm((prev) => ({ ...prev, reference: e.target.value }))}
                            aria-label="Payment reference"
                        />
                        <button type="submit" className={styles.payBtn} disabled={payBusy}>
                            {payBusy ? <Loader2 size={15} className={styles.spinner} /> : 'Pay'}
                        </button>
                    </form>
                )}

                {payNote.text && (
                    <div className={`${styles.note} ${payNote.type === 'error' ? styles.noteError : styles.noteSuccess}`}>
                        {payNote.type === 'error'
                            ? <AlertTriangle size={15} aria-hidden="true" />
                            : <CheckCircle2 size={15} aria-hidden="true" />}
                        {payNote.text}
                    </div>
                )}

                {ledgerError && (
                    <div className={styles.errorNote}>
                        <AlertTriangle size={16} aria-hidden="true" />
                        {ledgerError}
                    </div>
                )}

                {!supplierId ? (
                    <div className={styles.emptyBlock}>Pick a supplier to read their account.</div>
                ) : ledgerBusy && !ledger ? (
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={32} />
                        <p>Reading the account…</p>
                    </div>
                ) : ledger && ledger.entries.length === 0 ? (
                    <div className={styles.emptyBlock}>No receivings or payments on this account yet.</div>
                ) : ledger && (
                    <div className={styles.tableWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Entry</th>
                                    <th className={styles.alignRight}>Received</th>
                                    <th className={styles.alignRight}>Paid</th>
                                    <th className={styles.alignRight}>Balance</th>
                                </tr>
                            </thead>
                            <tbody>
                                {ledger.entries.map((e) => (
                                    <tr key={`${e.kind}-${e.id}`}>
                                        <td className={styles.cellMuted}>
                                            {e.kind === 'receiving'
                                                ? dayLabel(e.business_date)
                                                : formatDateTime(new Date(e.at))}
                                        </td>
                                        <td>
                                            {e.kind === 'receiving' ? (
                                                <>
                                                    <span className={styles.cellStrong}>
                                                        <Truck size={13} aria-hidden="true" className={styles.entryIcon} />
                                                        GRN #{e.id}
                                                        {e.invoice ? ` · Inv ${e.invoice}` : ''}
                                                    </span>
                                                    {e.notes && <span className={styles.cellSub}>{e.notes}</span>}
                                                </>
                                            ) : (
                                                <span className={styles.cellStrong}>
                                                    <Banknote size={13} aria-hidden="true" className={styles.entryIcon} />
                                                    Payment · {METHOD_LABEL[e.method] ?? e.method}
                                                    {e.reference ? ` · ${e.reference}` : ''}
                                                </span>
                                            )}
                                        </td>
                                        <td className={`${styles.alignRight} ${styles.num}`}>
                                            {e.debit > 0 ? rupees(e.debit) : '—'}
                                        </td>
                                        <td className={`${styles.alignRight} ${styles.num}`}>
                                            {e.credit > 0 ? rupees(e.credit) : '—'}
                                        </td>
                                        <td className={`${styles.alignRight} ${styles.num} ${e.balance > 0 ? styles.owed : ''}`}>
                                            {rupees(e.balance)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    )
}

function PageHeader() {
    return (
        <div className={styles.header}>
            <div>
                <Link href="/inventory" className={styles.backLink}>
                    <ChevronLeft size={15} aria-hidden="true" />
                    Inventory
                </Link>
                <h1 className={styles.title}>Supplier Ledger</h1>
                <p className={styles.subtitle}>
                    What each supplier has delivered, what they&apos;ve been paid, and the balance still owed.
                </p>
            </div>
        </div>
    )
}

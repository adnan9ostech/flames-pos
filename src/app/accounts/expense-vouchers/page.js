'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import styles from '../accounts.module.css'
import own from './voucher.module.css'
import { listVouchers } from './actions'
import { DateRange, fmtDay } from '../reports/ReportTools'
import { ReceiptText, Loader2, AlertTriangle, Plus } from 'lucide-react'

/*
 * Expense Voucher List — ChowPOS's, with the three numbers a bookkeeper
 * scans for: what the voucher came to, what has been paid, what is owed.
 * Status tabs and a date range; a row opens the document.
 */

const rupees = (n) => (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const TABS = [
    { key: 'all', label: 'All' },
    { key: 'draft', label: 'Draft' },
    { key: 'posted', label: 'Posted' },
    { key: 'owed', label: 'Owed' },
    { key: 'void', label: 'Void' },
]

const STATUS_CLASS = { draft: 'statusDraft', posted: 'statusPosted', void: 'statusVoid' }

const clipText = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export default function ExpenseVoucherListPage() {
    const router = useRouter()
    const [status, setStatus] = useState('all')
    const [from, setFrom] = useState('')
    const [to, setTo] = useState('')
    const [rows, setRows] = useState(null)
    const [error, setError] = useState('')
    // Which filter the rows on screen answer; while it lags the inputs, a
    // fetch is in flight. Derived, so the effect never sets state up front.
    const [answered, setAnswered] = useState('')
    const filterKey = `${status}|${from}|${to}`
    const isFetching = answered !== filterKey

    useEffect(() => {
        let cancelled = false
        listVouchers({ status, from: from || undefined, to: to || undefined }).then((res) => {
            if (cancelled) return
            if (res.error) setError(res.error)
            else { setError(''); setRows(res.data) }
            setAnswered(filterKey)
        })
        return () => { cancelled = true }
    }, [status, from, to, filterKey])

    const totals = useMemo(() => (rows || []).reduce((t, r) => {
        if (r.status === 'void') return t
        return { total: t.total + r.total, paid: t.paid + r.paid_total, owed: t.owed + r.owed }
    }, { total: 0, paid: 0, owed: 0 }), [rows])

    const open = (id) => router.push(`/accounts/expense-vouchers/${id}`)

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Expense Vouchers</h1>
                    <p className={styles.subtitle}>
                        Spending as documents: a draft is paperwork, a posted voucher is in the books and on the Expenses screen, and whatever its payments did not cover is owed.
                    </p>
                </div>
                <div className={styles.headerActions}>
                    <Link href="/accounts/expense-vouchers/new" className={styles.primaryBtn}>
                        <Plus size={16} /> New voucher
                    </Link>
                </div>
            </div>

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={styles.filterRow}>
                <div className={styles.filterTabs} role="tablist" aria-label="Voucher status">
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={status === t.key}
                            className={`${styles.filterTab} ${status === t.key ? styles.filterActive : ''}`}
                            onClick={() => setStatus(t.key)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
                {(from || to) && (
                    <button type="button" className={styles.filterTab} onClick={() => { setFrom(''); setTo('') }}>
                        Clear dates
                    </button>
                )}
                {isFetching && <Loader2 size={16} className={styles.spinner} aria-label="Loading" />}
            </div>

            <div className={styles.listWrap}>
                {!rows ? (
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The vouchers could not be read.' : 'Loading vouchers…'}</p>
                    </div>
                ) : rows.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <ReceiptText size={28} />
                        <p>No vouchers {status === 'all' ? 'yet' : `are ${status === 'owed' ? 'owed' : status}`}{from || to ? ' in this range' : ''}.</p>
                        <Link href="/accounts/expense-vouchers/new" className={styles.secondaryBtn}>
                            <Plus size={15} /> Record an expense
                        </Link>
                    </div>
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Voucher No</th>
                                <th>Date</th>
                                <th className={styles.alignRight}>Total</th>
                                <th className={styles.alignRight}>Paid</th>
                                <th className={styles.alignRight}>Owed</th>
                                <th>Status</th>
                                <th>Lines</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr
                                    key={r.id}
                                    className={`${styles.rowClickable} ${r.status === 'void' ? styles.rowInactive : ''}`}
                                    onClick={() => open(r.id)}
                                >
                                    <td className={styles.cellCode}>
                                        <Link
                                            href={`/accounts/expense-vouchers/${r.id}`}
                                            className={own.voucherLink}
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            {r.voucher_no}
                                        </Link>
                                    </td>
                                    <td className={styles.cellMuted}>{fmtDay(r.business_date)}</td>
                                    <td className={styles.cellNum}>{rupees(r.total)}</td>
                                    <td className={styles.cellNum}>{rupees(r.paid_total)}</td>
                                    <td className={`${styles.cellNum} ${r.owed > 0 && r.status === 'posted' ? styles.cellStrong : ''}`}>
                                        {r.owed > 0 ? rupees(r.owed) : <span className={styles.cellMuted}>—</span>}
                                    </td>
                                    <td>
                                        <span className={`${styles.status} ${styles[STATUS_CLASS[r.status] || 'statusDraft']}`}>
                                            {r.status}
                                        </span>
                                    </td>
                                    <td className={styles.cellWrap}>
                                        <span className={styles.cellSoft} title={r.lines_summary}>
                                            {r.line_count} line{r.line_count === 1 ? '' : 's'}
                                            {r.lines_summary ? ` · ${clipText(r.lines_summary)}` : ''}
                                        </span>
                                        {r.remarks && <span className={styles.cellSub}>{clipText(r.remarks, 60)}</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className={styles.tfoot}>
                            <tr>
                                <td colSpan={2}>{rows.length} voucher{rows.length === 1 ? '' : 's'} (void excluded from totals)</td>
                                <td className={styles.cellNum}>{rupees(totals.total)}</td>
                                <td className={styles.cellNum}>{rupees(totals.paid)}</td>
                                <td className={styles.cellNum}>{rupees(totals.owed)}</td>
                                <td colSpan={2} />
                            </tr>
                        </tfoot>
                    </table>
                )}
            </div>
        </div>
    )
}

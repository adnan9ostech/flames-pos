'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import styles from '../../accounts.module.css'
import own from '../../expense-vouchers/voucher.module.css'
import { getExpenseReport } from '../../expense-vouchers/actions'
import {
    ReportToolbar, PrintHeading, DateRange, downloadCsv,
    karachiToday, monthStart, periodLabel, fmtDay,
} from '../ReportTools'
import { Loader2, AlertTriangle, FileSpreadsheet } from 'lucide-react'

/*
 * Expense Report — ChowPOS's: a date range and a "Summarize" toggle. Every
 * line, or the same money rolled up by code and category. Read from the
 * one expense ledger, so a voucher's lines and a chit typed on the Expenses
 * screen sit together; the voucher ones carry their number and open it.
 */

const rupees = (n) => (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ExpenseReportPage() {
    const today = karachiToday()
    const [from, setFrom] = useState(monthStart(today))
    const [to, setTo] = useState(today)
    const [summarize, setSummarize] = useState(false)
    const [data, setData] = useState(null)
    const [error, setError] = useState('')
    // The range the report on screen answers; while it lags the pickers, a
    // fetch is in flight. Derived, so the effect never sets state up front.
    const [answered, setAnswered] = useState('')
    const rangeKey = `${from}|${to}`
    const isFetching = answered !== rangeKey

    useEffect(() => {
        if (!from || !to) return undefined
        let cancelled = false
        getExpenseReport({ from, to }).then((res) => {
            if (cancelled) return
            if (res.error) setError(res.error)
            else { setError(''); setData(res.data) }
            setAnswered(rangeKey)
        })
        return () => { cancelled = true }
    }, [from, to, rangeKey])

    const period = periodLabel(from, to)
    const excelHref = `/api/accounts/export?report=expenses&from=${from}&to=${to}${summarize ? '&summarize=1' : ''}`
    const lines = useMemo(() => data?.lines || [], [data])
    const summary = useMemo(() => data?.summary || [], [data])

    const exportCsv = () => {
        if (!data) return
        const rows = summarize
            ? [['Code', 'Code name', 'Category', 'Lines', 'Amount'],
                ...summary.map((g) => [g.code || '', g.code_name || '', g.category, g.lines, g.amount])]
            : [['Date', 'Voucher', 'Code', 'Category', 'Description', 'Status', 'Amount'],
                ...lines.map((l) => [l.business_date, l.voucher_no || '', l.code || '', l.category, l.description, l.status, l.amount])]
        rows.push(summarize ? ['TOTAL', '', '', lines.length, data.total] : ['TOTAL', '', '', '', '', '', data.total])
        downloadCsv(`expense-report_${from}_to_${to}${summarize ? '_summary' : ''}.csv`, rows)
    }

    return (
        <div className={styles.container} id="expense-report-root">
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Expense Report</h1>
                    <p className={styles.subtitle}>
                        Spending for the period, line by line or rolled up by code and category. Reversed vouchers do not appear.
                    </p>
                </div>
                <ReportToolbar onCsv={exportCsv} excelHref={excelHref} disabled={!data} />
            </div>

            <PrintHeading merchantName={data?.merchantName} title={`Expense Report${summarize ? ' (summary)' : ''}`} period={period} />

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={styles.filterRow}>
                <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
                {isFetching && <Loader2 size={16} className={styles.spinner} aria-label="Loading" />}
                <label className={styles.toggleLine}>
                    <input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)} />
                    Summarize by code and category
                </label>
            </div>

            <div className={styles.listWrap}>
                {!data ? (
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The report could not be read.' : 'Adding up the expenses…'}</p>
                    </div>
                ) : lines.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <FileSpreadsheet size={28} />
                        <p>No expenses were booked between {fmtDay(from)} and {fmtDay(to)}.</p>
                    </div>
                ) : summarize ? (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Code</th>
                                <th>Category</th>
                                <th className={styles.alignRight}>Lines</th>
                                <th className={styles.alignRight}>Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            {summary.map((g) => (
                                <tr key={`${g.code}|${g.category}`}>
                                    <td className={styles.cellName}>
                                        <span className={styles.cellStrong}>{g.code || '—'}</span>
                                        <span className={styles.cellSub}>{g.code_name || 'No expense code'}</span>
                                    </td>
                                    <td>{g.category}</td>
                                    <td className={styles.cellNum}>{g.lines}</td>
                                    <td className={styles.cellNum}>{rupees(g.amount)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className={styles.tfoot}>
                            <tr>
                                <td colSpan={2}>Total for {period}</td>
                                <td className={styles.cellNum}>{lines.length}</td>
                                <td className={styles.cellNum}>{rupees(data.total)}</td>
                            </tr>
                        </tfoot>
                    </table>
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Voucher</th>
                                <th>Code</th>
                                <th>Category</th>
                                <th>Description</th>
                                <th className={styles.alignRight}>Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            {lines.map((l) => (
                                <tr key={l.id}>
                                    <td className={styles.cellMuted}>{fmtDay(l.business_date)}</td>
                                    <td className={styles.cellCode}>
                                        {l.voucher_id
                                            ? <Link href={`/accounts/expense-vouchers/${l.voucher_id}`} className={own.voucherLink}>{l.voucher_no}</Link>
                                            : <span className={styles.cellMuted} title="Entered on the Expenses screen, not as a voucher">—</span>}
                                    </td>
                                    <td className={styles.cellCode}>{l.code || <span className={styles.cellMuted}>—</span>}</td>
                                    <td>{l.category}</td>
                                    <td className={styles.cellWrap}>
                                        {l.description}
                                        {l.status === 'payable' && <span className={`${styles.chip} ${styles.chipWarn}`} style={{ marginLeft: '0.4rem' }}>payable</span>}
                                    </td>
                                    <td className={styles.cellNum}>{rupees(l.amount)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className={styles.tfoot}>
                            <tr>
                                <td colSpan={5}>Total for {period} · {lines.length} line{lines.length === 1 ? '' : 's'}</td>
                                <td className={styles.cellNum}>{rupees(data.total)}</td>
                            </tr>
                        </tfoot>
                    </table>
                )}
            </div>

            <style jsx global>{`
                @media print {
                    body { background: white !important; }
                    .no-print, aside { display: none !important; }
                    main { margin-left: 0 !important; width: 100% !important; }
                    #expense-report-root, #expense-report-root * { color: #111 !important; }
                    @page { size: A4; margin: 12mm; }
                }
            `}</style>
        </div>
    )
}

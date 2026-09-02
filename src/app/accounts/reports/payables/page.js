'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import styles from '../../accounts.module.css'
import own from '../../expense-vouchers/voucher.module.css'
import { getPayablesReport } from '../../expense-vouchers/actions'
import { ReportToolbar, PrintHeading, downloadCsv, fmtDay } from '../ReportTools'
import { Loader2, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'

/*
 * Expense Payables Report — ChowPOS's: every posted voucher whose payments
 * fall short of its total, oldest first, with the days it has been waiting.
 * As-of the open business day; there is no range, because a payable is a
 * payable until it is paid.
 */

const rupees = (n) => (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const ageClass = (days) => (days >= 30 ? styles.chipDanger : days >= 7 ? styles.chipWarn : styles.chip)

export default function ExpensePayablesReportPage() {
    const [data, setData] = useState(null)
    const [error, setError] = useState('')
    const [refreshing, setRefreshing] = useState(false)
    const isFetching = (!data && !error) || refreshing

    const fetchReport = () => getPayablesReport().then((res) => {
        if (res.error) setError(res.error)
        else { setError(''); setData(res.data) }
    })

    useEffect(() => { fetchReport() }, [])

    const refresh = () => {
        setRefreshing(true)
        fetchReport().finally(() => setRefreshing(false))
    }

    const exportCsv = () => {
        if (!data) return
        downloadCsv(`expense-payables_${data.asOf}.csv`, [
            ['Voucher', 'Date', 'Payee / Remarks', 'Codes', 'Total', 'Paid', 'Owed', 'Days outstanding'],
            ...data.rows.map((r) => [r.voucher_no, r.business_date, r.remarks || '', r.codes, r.total, r.paid_total, r.owed, r.days_outstanding]),
            ['TOTAL', '', '', '', data.totals.total, data.totals.paid, data.totals.owed, ''],
        ])
    }

    return (
        <div className={styles.container} id="payables-report-root">
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Expense Payables Report</h1>
                    <p className={styles.subtitle}>
                        Posted vouchers not yet paid in full{data ? `, as of ${fmtDay(data.asOf)}` : ''}. Open one to record a payment.
                    </p>
                </div>
                <ReportToolbar onCsv={exportCsv} excelHref="/api/accounts/export?report=payables" disabled={!data} />
            </div>

            <PrintHeading merchantName={data?.merchantName} title="Expense Payables" period={data ? `as of ${fmtDay(data.asOf)}` : ''} />

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={styles.filterRow}>
                <button type="button" className={styles.filterTab} onClick={refresh} disabled={isFetching}>
                    <RefreshCw size={13} style={{ marginRight: 6, verticalAlign: '-2px' }} /> Refresh
                </button>
                {isFetching && <Loader2 size={16} className={styles.spinner} aria-label="Loading" />}
                {data && (
                    <span className={styles.reportMeta} style={{ marginLeft: 'auto' }}>
                        {data.rows.length} voucher{data.rows.length === 1 ? '' : 's'} · Rs. {rupees(data.totals.owed)} owed
                    </span>
                )}
            </div>

            <div className={styles.listWrap}>
                {!data ? (
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The report could not be read.' : 'Finding what is owed…'}</p>
                    </div>
                ) : data.rows.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <CheckCircle2 size={28} />
                        <p>Nothing is owed. Every posted voucher is paid in full.</p>
                    </div>
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Voucher</th>
                                <th>Date</th>
                                <th>Payee / Remarks</th>
                                <th className={styles.alignRight}>Total</th>
                                <th className={styles.alignRight}>Paid</th>
                                <th className={styles.alignRight}>Owed</th>
                                <th className={styles.alignRight}>Days outstanding</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.rows.map((r) => (
                                <tr key={r.id}>
                                    <td className={styles.cellCode}>
                                        <Link href={`/accounts/expense-vouchers/${r.id}`} className={own.voucherLink}>{r.voucher_no}</Link>
                                    </td>
                                    <td className={styles.cellMuted}>{fmtDay(r.business_date)}</td>
                                    <td className={styles.cellName}>
                                        <span className={styles.cellStrong}>{r.remarks || <span className={styles.cellMuted}>—</span>}</span>
                                        <span className={styles.cellSub}>{r.codes}</span>
                                    </td>
                                    <td className={styles.cellNum}>{rupees(r.total)}</td>
                                    <td className={styles.cellNum}>{rupees(r.paid_total)}</td>
                                    <td className={`${styles.cellNum} ${styles.cellStrong}`}>{rupees(r.owed)}</td>
                                    <td className={styles.cellNum}>
                                        <span className={`${styles.chip} ${ageClass(r.days_outstanding)}`}>
                                            {r.days_outstanding} day{r.days_outstanding === 1 ? '' : 's'}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className={styles.tfoot}>
                            <tr>
                                <td colSpan={3}>Total · {data.rows.length} voucher{data.rows.length === 1 ? '' : 's'}</td>
                                <td className={styles.cellNum}>{rupees(data.totals.total)}</td>
                                <td className={styles.cellNum}>{rupees(data.totals.paid)}</td>
                                <td className={styles.cellNum}>{rupees(data.totals.owed)}</td>
                                <td />
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
                    #payables-report-root, #payables-report-root * { color: #111 !important; }
                    @page { size: A4; margin: 12mm; }
                }
            `}</style>
        </div>
    )
}

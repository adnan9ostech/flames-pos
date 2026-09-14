'use client'

import { useEffect, useMemo, useState } from 'react'
import styles from '../../accounts.module.css'
import { getTrialBalance } from '../actions'
import { trialBalanceRows } from '../statementRows.mjs'
import {
    ReportToolbar, PrintHeading, DateRange, Money, downloadCsv,
    karachiToday, monthStart, periodLabel, rupees,
} from '../ReportTools'
import { Loader2, AlertTriangle, CheckCircle2, Scale } from 'lucide-react'

/*
 * Trial Balance — ChowPOS's columns: Account | Account # | Opening | Debit |
 * Credit | Closing, debit-positive, over a date range. The one statement
 * that exists to prove the books: the two movement totals are equal or the
 * ledger is broken, and the page says which in so many words.
 */
export default function TrialBalancePage() {
    const today = karachiToday()
    const [from, setFrom] = useState(monthStart(today))
    const [to, setTo] = useState(today)
    const [hideQuiet, setHideQuiet] = useState(true)
    const [data, setData] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!from || !to) return undefined
        let cancelled = false
        const key = `${from}|${to}`
        getTrialBalance({ from, to }).then((res) => {
            if (cancelled) return
            if (res.error) setError(res.error)
            else { setError(''); setData({ ...res.data, key }) }
        })
        return () => { cancelled = true }
    }, [from, to])

    // Loading is derived, not stored: the data on screen names the request
    // it answered, and anything newer than that is still in flight.
    const isFetching = !error && (!data || data.key !== `${from}|${to}`)

    const rows = useMemo(() => {
        if (!data) return []
        return hideQuiet
            ? data.accounts.filter((a) => a.opening !== 0 || a.debit !== 0 || a.credit !== 0)
            : data.accounts
    }, [data, hideQuiet])

    const period = periodLabel(from, to)
    const excelHref = `/api/accounts/export?report=trial-balance&from=${from}&to=${to}${hideQuiet ? '' : '&all=1'}`
    const exportCsv = () => data && downloadCsv(
        `trial-balance_${from}_to_${to}.csv`,
        trialBalanceRows(data, { includeQuiet: !hideQuiet }),
    )

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Trial Balance</h1>
                    <p className={styles.subtitle}>
                        Every account&apos;s opening balance, movement and closing balance for the period. Credits carry a minus sign.
                    </p>
                </div>
                <ReportToolbar onCsv={exportCsv} excelHref={excelHref} disabled={!data} />
            </div>

            <PrintHeading merchantName={data?.meta?.merchantName} title="Trial Balance" period={period} />

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={styles.filterRow}>
                <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
                {isFetching && <Loader2 size={16} className={styles.spinner} aria-label="Loading" />}
                <label className={styles.toggleLine}>
                    <input type="checkbox" checked={hideQuiet} onChange={(e) => setHideQuiet(e.target.checked)} />
                    Hide accounts with no activity
                </label>
            </div>

            {data && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`${styles.note} ${data.balanced ? styles.noteSuccess : styles.noteError}`}
                >
                    {data.balanced ? (
                        <>
                            <CheckCircle2 size={16} aria-hidden="true" />
                            <span className={styles.chip + ' ' + styles.chipSuccess}>Balanced</span>
                            Debits and credits both total Rs. {rupees(data.totals.debit)} for {period}.
                        </>
                    ) : (
                        <>
                            <AlertTriangle size={16} aria-hidden="true" />
                            <span className={styles.chip + ' ' + styles.chipDanger}>Out of balance</span>
                            Out of balance by Rs. {rupees(Math.abs(data.difference || data.totals.closing))}: a journal has been altered outside the poster. Check the ledger before relying on any statement.
                        </>
                    )}
                </div>
            )}

            <div className={styles.listWrap}>
                {!data ? (
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The trial balance could not be read.' : 'Adding up the ledger…'}</p>
                    </div>
                ) : rows.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <Scale size={28} />
                        <p>Nothing was posted in this period{hideQuiet ? ': untick the filter to list every account' : ''}.</p>
                    </div>
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Account</th>
                                <th>Account #</th>
                                <th className={styles.alignRight}>Opening</th>
                                <th className={styles.alignRight}>Debit</th>
                                <th className={styles.alignRight}>Credit</th>
                                <th className={styles.alignRight}>Closing</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((a) => (
                                <tr key={a.id} className={a.is_active ? '' : styles.rowInactive}>
                                    <td className={styles.cellName}>
                                        <span className={styles.cellStrong}>{a.name}</span>
                                        <span className={styles.cellSub}>{a.category}</span>
                                    </td>
                                    <td className={styles.cellCode}>{a.account_number}</td>
                                    <td className={styles.cellNum}><Money value={a.opening} blankZero /></td>
                                    <td className={styles.cellNum}><Money value={a.debit} blankZero /></td>
                                    <td className={styles.cellNum}><Money value={a.credit} blankZero /></td>
                                    <td className={styles.cellNum}><Money value={a.closing} strong /></td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className={styles.tfoot}>
                            <tr>
                                <td colSpan={2}>Total</td>
                                <td className={styles.cellNum}><Money value={data.totals.opening} /></td>
                                <td className={styles.cellNum}><Money value={data.totals.debit} /></td>
                                <td className={styles.cellNum}><Money value={data.totals.credit} /></td>
                                <td className={styles.cellNum}><Money value={data.totals.closing} /></td>
                            </tr>
                        </tfoot>
                    </table>
                )}
            </div>
        </div>
    )
}

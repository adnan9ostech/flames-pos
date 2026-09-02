'use client'

import { useEffect, useState } from 'react'
import styles from '../../accounts.module.css'
import { getBalanceSheet } from '../actions'
import { balanceSheetRows } from '../statementRows.mjs'
import {
    ReportToolbar, PrintHeading, Money, downloadCsv, karachiToday, fmtDay, rupees,
} from '../ReportTools'
import { Loader2, AlertTriangle, CheckCircle2, Landmark } from 'lucide-react'

/*
 * Balance Sheet as at one day: Assets by category, Liabilities by category,
 * Equity by category plus the computed earnings line that stands in for a
 * year-end close this ledger does not do. The page states whether
 * Assets = Liabilities + Equity holds rather than leaving it to be noticed.
 */
const Section = ({ title, groups, extra = [], total, emptyText }) => (
    <>
        <tr className={styles.rowSection}><td colSpan={3}>{title}</td></tr>
        {groups.length === 0 && extra.length === 0 && (
            <tr className={styles.rowIndent}><td colSpan={3} className={styles.cellMuted}>{emptyText}</td></tr>
        )}
        {groups.map((g) => (
            <SectionGroup key={g.category} group={g} />
        ))}
        {extra.map((l) => (
            <tr key={l.name} className={styles.rowIndent}>
                <td>{l.name}<span className={styles.cellSub}>computed — income less expenses, not yet closed to retained earnings</span></td>
                <td className={styles.cellMuted}>—</td>
                <td className={styles.cellNum}><Money value={l.amount} /></td>
            </tr>
        ))}
        <tr className={styles.rowGrand}>
            <td colSpan={2}>Total {title}</td>
            <td className={styles.cellNum}><Money value={total} /></td>
        </tr>
    </>
)

const SectionGroup = ({ group }) => (
    <>
        <tr>
            <td colSpan={3} className={styles.cellMuted} style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em' }}>
                {group.category}
            </td>
        </tr>
        {group.lines.map((l) => (
            <tr key={l.id} className={styles.rowIndent}>
                <td>{l.name}</td>
                <td className={styles.cellCode}>{l.account_number}</td>
                <td className={styles.cellNum}><Money value={l.amount} /></td>
            </tr>
        ))}
        {group.lines.length > 1 && (
            <tr className={styles.rowTotal}>
                <td colSpan={2} className={styles.cellMuted}>Total {group.category.toLowerCase()}</td>
                <td className={styles.cellNum}><Money value={group.total} /></td>
            </tr>
        )}
    </>
)

export default function BalanceSheetPage() {
    const [asAt, setAsAt] = useState(karachiToday())
    const [data, setData] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!asAt) return undefined
        let cancelled = false
        const key = asAt
        getBalanceSheet({ asAt }).then((res) => {
            if (cancelled) return
            if (res.error) setError(res.error)
            else { setError(''); setData({ ...res.data, key }) }
        })
        return () => { cancelled = true }
    }, [asAt])

    // Loading is derived, not stored: the data on screen names the request
    // it answered, and anything newer than that is still in flight.
    const isFetching = !error && (!data || data.key !== asAt)

    const period = `As at ${fmtDay(asAt)}`
    const excelHref = `/api/accounts/export?report=balance-sheet&asAt=${asAt}`
    const exportCsv = () => data && downloadCsv(`balance-sheet_as-at_${asAt}.csv`, balanceSheetRows(data))
    const empty = data && data.assets.length === 0 && data.liabilities.length === 0 && data.equity.length === 0
        && data.equityComputed.every((l) => l.amount === 0)

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Balance Sheet</h1>
                    <p className={styles.subtitle}>
                        What the restaurant owns, what it owes and what is left for the owner, as at the end of one business day.
                    </p>
                </div>
                <ReportToolbar onCsv={exportCsv} excelHref={excelHref} disabled={!data} />
            </div>

            <PrintHeading merchantName={data?.meta?.merchantName} title="Balance Sheet" period={period} />

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={styles.filterRow}>
                <div className={styles.dateRange}>
                    <span className={styles.dateSep}>As at</span>
                    <input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} aria-label="As-at date" />
                </div>
                {isFetching && <Loader2 size={16} className={styles.spinner} aria-label="Loading" />}
            </div>

            {data && !empty && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`${styles.note} ${data.balanced ? styles.noteSuccess : styles.noteError}`}
                >
                    {data.balanced ? (
                        <>
                            <CheckCircle2 size={16} aria-hidden="true" />
                            <span className={styles.chip + ' ' + styles.chipSuccess}>Balances</span>
                            Assets Rs. {rupees(data.assetsTotal)} = Liabilities Rs. {rupees(data.liabilitiesTotal)} + Equity Rs. {rupees(data.equityTotal)}.
                        </>
                    ) : (
                        <>
                            <AlertTriangle size={16} aria-hidden="true" />
                            <span className={styles.chip + ' ' + styles.chipDanger}>Does not balance</span>
                            Assets exceed liabilities plus equity by Rs. {rupees(data.difference)} — a journal has been altered outside the poster. Check the trial balance.
                        </>
                    )}
                </div>
            )}

            <div className={styles.listWrap}>
                {!data ? (
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The balance sheet could not be read.' : 'Adding up the ledger…'}</p>
                    </div>
                ) : empty ? (
                    <div className={styles.stateBlock}>
                        <Landmark size={28} />
                        <p>Nothing had been posted by {fmtDay(asAt)}.</p>
                    </div>
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Account</th>
                                <th>Account #</th>
                                <th className={styles.alignRight}>Amount (Rs.)</th>
                            </tr>
                        </thead>
                        <tbody>
                            <Section title="Assets" groups={data.assets} total={data.assetsTotal} emptyText="No asset balances" />
                            <Section title="Liabilities" groups={data.liabilities} total={data.liabilitiesTotal} emptyText="No liabilities" />
                            <Section title="Equity" groups={data.equity} extra={data.equityComputed} total={data.equityTotal} emptyText="No equity balances" />
                            <tr className={styles.rowGrand}>
                                <td colSpan={2}>Total Liabilities and Equity</td>
                                <td className={styles.cellNum}><Money value={data.liabilitiesAndEquity} /></td>
                            </tr>
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}

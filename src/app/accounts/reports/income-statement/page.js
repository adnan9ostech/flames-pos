'use client'

import { useEffect, useState } from 'react'
import styles from '../../accounts.module.css'
import { getIncomeStatement } from '../actions'
import { incomeStatementRows } from '../statementRows.mjs'
import {
    ReportToolbar, PrintHeading, DateRange, Money, downloadCsv,
    karachiToday, monthStart, periodLabel, rupees,
} from '../ReportTools'
import { Loader2, AlertTriangle, TrendingUp } from 'lucide-react'

/*
 * Income Statement in ChowPOS's shape: Revenue → Sub-Total, Cost of Sales →
 * Sub-Total, Gross Profit, Expenses → Sub-Total, Net Profit. Figures are
 * magnitudes the way an accountant reads them; the one negative line is
 * Discounts Allowed under revenue, which is a reduction of sales.
 */
const Section = ({ title, lines, subtotal, emptyText }) => (
    <>
        <tr className={styles.rowSection}><td colSpan={3}>{title}</td></tr>
        {lines.length === 0 ? (
            <tr className={styles.rowIndent}>
                <td colSpan={3} className={styles.cellMuted}>{emptyText}</td>
            </tr>
        ) : lines.map((l) => (
            <tr key={l.id} className={styles.rowIndent}>
                <td>{l.name}{l.contra && <span className={styles.cellSub}>reduces sales</span>}</td>
                <td className={styles.cellCode}>{l.account_number}</td>
                <td className={styles.cellNum}><Money value={l.amount} /></td>
            </tr>
        ))}
        <tr className={styles.rowTotal}>
            <td colSpan={2}>Sub-Total</td>
            <td className={styles.cellNum}><Money value={subtotal} /></td>
        </tr>
    </>
)

export default function IncomeStatementPage() {
    const today = karachiToday()
    const [from, setFrom] = useState(monthStart(today))
    const [to, setTo] = useState(today)
    const [data, setData] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!from || !to) return undefined
        let cancelled = false
        const key = `${from}|${to}`
        getIncomeStatement({ from, to }).then((res) => {
            if (cancelled) return
            if (res.error) setError(res.error)
            else { setError(''); setData({ ...res.data, key }) }
        })
        return () => { cancelled = true }
    }, [from, to])

    // Loading is derived, not stored: the data on screen names the request
    // it answered, and anything newer than that is still in flight.
    const isFetching = !error && (!data || data.key !== `${from}|${to}`)

    const period = periodLabel(from, to)
    const excelHref = `/api/accounts/export?report=income-statement&from=${from}&to=${to}`
    const exportCsv = () => data && downloadCsv(`income-statement_${from}_to_${to}.csv`, incomeStatementRows(data))
    const empty = data && data.revenue.length === 0 && data.costOfSales.length === 0 && data.expenses.length === 0

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Income Statement</h1>
                    <p className={styles.subtitle}>
                        What was earned and what it cost, for the period. Net sales less cost of sales is gross profit; less expenses is net profit.
                    </p>
                </div>
                <ReportToolbar onCsv={exportCsv} excelHref={excelHref} disabled={!data} />
            </div>

            <PrintHeading merchantName={data?.meta?.merchantName} title="Income Statement" period={period} />

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={styles.filterRow}>
                <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
                {isFetching && <Loader2 size={16} className={styles.spinner} aria-label="Loading" />}
                {data && (
                    <span className={`${styles.chip} ${data.netProfit >= 0 ? styles.chipSuccess : styles.chipDanger}`} style={{ marginLeft: 'auto' }}>
                        {data.netProfit >= 0 ? 'Net profit' : 'Net loss'} Rs. {rupees(Math.abs(data.netProfit))}
                    </span>
                )}
            </div>

            <div className={styles.listWrap}>
                {!data ? (
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The statement could not be read.' : 'Adding up the period…'}</p>
                    </div>
                ) : empty ? (
                    <div className={styles.stateBlock}>
                        <TrendingUp size={28} />
                        <p>No income or expense was posted in this period.</p>
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
                            <Section title="Revenue / Income" lines={data.revenue} subtotal={data.revenueTotal} emptyText="No sales in the period" />
                            <Section title="Cost of Sales" lines={data.costOfSales} subtotal={data.costOfSalesTotal} emptyText="No cost of goods sold posted" />
                            <tr className={styles.rowGrand}>
                                <td colSpan={2}>Gross Profit</td>
                                <td className={styles.cellNum}><Money value={data.grossProfit} /></td>
                            </tr>
                            <Section title="Expenses" lines={data.expenses} subtotal={data.expensesTotal} emptyText="No expenses posted" />
                            <tr className={styles.rowGrand}>
                                <td colSpan={2}>{data.netProfit < 0 ? 'Net Loss' : 'Net Profit'}</td>
                                <td className={styles.cellNum}><Money value={data.netProfit} /></td>
                            </tr>
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import styles from '../../accounts.module.css'
import { getCashRegister } from '../actions'
import { cashRegisterRows } from '../statementRows.mjs'
import {
    ReportToolbar, PrintHeading, DateRange, Money, downloadCsv,
    karachiToday, monthStart, periodLabel, fmtDay, rupees,
} from '../ReportTools'
import { VOUCHER_TYPES } from '@/lib/accounts/constants.mjs'
import { Loader2, AlertTriangle, Banknote } from 'lucide-react'

/*
 * Cash Register: every posted line on one cash or bank account, in order,
 * with a running balance from the opening figure. The account list is
 * whatever the chart says can both receive a settlement and pay an expense
 * (AR_PAID and AP_PAID); the default is the account the till's cash
 * settles into, read from the payment-method mapping.
 */
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`

export default function CashRegisterPage() {
    const today = karachiToday()
    const [from, setFrom] = useState(monthStart(today))
    const [to, setTo] = useState(today)
    const [accountId, setAccountId] = useState(null)
    const [data, setData] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!from || !to) return undefined
        let cancelled = false
        const key = `${from}|${to}|${accountId ?? ''}`
        getCashRegister({ from, to, accountId }).then((res) => {
            if (cancelled) return
            if (res.error) setError(res.error)
            else {
                setError('')
                setData({ ...res.data, key })
                // The first load resolves the default account server-side.
                if (accountId == null) setAccountId(res.data.account.id)
            }
        })
        return () => { cancelled = true }
    }, [from, to, accountId])

    // Loading is derived, not stored: the data on screen names the request
    // it answered, and anything newer than that is still in flight.
    const isFetching = !error && (!data || data.key !== `${from}|${to}|${accountId ?? ''}`)

    const period = periodLabel(from, to)
    const account = data?.account
    const title = account ? `Cash Register · ${account.account_number} ${account.name}` : 'Cash Register'
    const excelHref = `/api/accounts/export?report=cash-register&from=${from}&to=${to}${accountId ? `&account=${accountId}` : ''}`
    const exportCsv = () => data && downloadCsv(`cash-register_${account.account_number}_${from}_to_${to}.csv`, cashRegisterRows(data))

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Cash Register</h1>
                    <p className={styles.subtitle}>
                        Money in and money out of one cash or bank account, line by line, with the balance after each.
                    </p>
                </div>
                <ReportToolbar onCsv={exportCsv} excelHref={excelHref} disabled={!data} />
            </div>

            <PrintHeading merchantName={data?.meta?.merchantName} title={title} period={period} />

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={styles.filterRow}>
                <select
                    className={styles.input}
                    style={{ width: 'auto', minWidth: '16rem' }}
                    value={accountId ?? ''}
                    onChange={(e) => setAccountId(Number(e.target.value))}
                    aria-label="Cash or bank account"
                    disabled={!data}
                >
                    {(data?.accounts || []).map((a) => (
                        <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                    ))}
                </select>
                <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
                {isFetching && <Loader2 size={16} className={styles.spinner} aria-label="Loading" />}
                {data && (
                    <div className={styles.chipRow} style={{ marginLeft: 'auto' }}>
                        <span className={`${styles.chip} ${styles.chipSuccess}`}>In Rs. {rupees(data.moneyIn)}</span>
                        <span className={`${styles.chip} ${styles.chipDanger}`}>Out Rs. {rupees(data.moneyOut)}</span>
                        <span className={`${styles.chip} ${styles.chipPrimary}`}>Closing Rs. {rupees(data.closing)}</span>
                    </div>
                )}
            </div>

            <div className={styles.listWrap}>
                {!data ? (
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The register could not be read.' : 'Reading the register…'}</p>
                    </div>
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Voucher</th>
                                <th>Description</th>
                                <th className={styles.alignRight}>Money In</th>
                                <th className={styles.alignRight}>Money Out</th>
                                <th className={styles.alignRight}>Balance</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className={styles.rowTotal}>
                                <td className={styles.cellMuted}>{fmtDay(from)}</td>
                                <td></td>
                                <td>Opening balance</td>
                                <td></td>
                                <td></td>
                                <td className={styles.cellNum}><Money value={data.opening} /></td>
                            </tr>
                            {data.rows.length === 0 && (
                                <tr>
                                    <td colSpan={6}>
                                        <div className={styles.stateBlock}>
                                            <Banknote size={24} />
                                            <p>No movement on {account.name} in this period.</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                            {data.rows.map((r) => (
                                <tr key={r.line_id}>
                                    <td className={styles.cellMuted}>{fmtDay(r.business_date)}</td>
                                    <td className={styles.cellCode}>
                                        <Link href={`/accounts/journals?voucher=${encodeURIComponent(r.voucher_no)}`} title={VOUCHER_TYPES[r.voucher_type] || r.voucher_type}>
                                            {r.voucher_no}
                                        </Link>
                                    </td>
                                    <td className={styles.cellWrap}>
                                        {r.description}
                                        {r.memo && r.memo !== r.description && <span className={styles.cellSub}>{r.memo}</span>}
                                    </td>
                                    <td className={styles.cellNum}><Money value={r.money_in} blankZero /></td>
                                    <td className={styles.cellNum}><Money value={r.money_out} blankZero /></td>
                                    <td className={styles.cellNum}><Money value={r.balance} /></td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className={styles.tfoot}>
                            <tr>
                                <td className={styles.cellMuted}>{fmtDay(to)}</td>
                                <td></td>
                                <td>Closing balance</td>
                                <td className={styles.cellNum}><Money value={data.moneyIn} /></td>
                                <td className={styles.cellNum}><Money value={data.moneyOut} /></td>
                                <td className={styles.cellNum}><Money value={data.closing} /></td>
                            </tr>
                        </tfoot>
                    </table>
                )}
            </div>

            {data && data.byHour.length > 0 && (
                <div className={styles.listWrap} style={{ marginTop: '1.25rem' }}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Hour (Karachi)</th>
                                <th className={styles.alignRight}>Entries</th>
                                <th className={styles.alignRight}>Money In</th>
                                <th className={styles.alignRight}>Money Out</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.byHour.map((h) => (
                                <tr key={h.hour}>
                                    <td className={styles.cellCode}>{hourLabel(h.hour)}</td>
                                    <td className={styles.cellNum}>{h.count.toLocaleString('en-PK')}</td>
                                    <td className={styles.cellNum}><Money value={h.money_in} blankZero /></td>
                                    <td className={styles.cellNum}><Money value={h.money_out} blankZero /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

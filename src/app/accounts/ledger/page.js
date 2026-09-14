'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import styles from '../accounts.module.css'
import own from './ledger.module.css'
import { listLedgerLines, listAccountOptions } from '../journals/actions'
import { VOUCHER_TYPES } from '@/lib/accounts/constants.mjs'
import {
    ScrollText, Loader2, AlertTriangle, Printer, FileDown, ChevronDown,
} from 'lucide-react'

/*
 * ChowPOS's "GL Transaction": every posted line, flat, oldest first, with
 * the account beside it. Dr and Cr are two columns and a zero side is left
 * blank — the ledger never shows a negative number.
 */

const TYPE_TABS = [{ key: '', label: 'All' }, ...Object.entries(VOUCHER_TYPES).map(([key, label]) => ({ key, label: `${key} · ${label}` }))]

/* Paise-exact on the server; here only rounded for display. */
const rs = (n) => {
    const v = Math.round((Number(n) || 0) * 100) / 100
    return v === 0 ? '' : v.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}
const rsTotal = (n) => (Math.round((Number(n) || 0) * 100) / 100)
    .toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

// Client-built CSV, downloaded via a Blob link — no deps, no round trip.
const downloadCsv = (filename, headers, rows) => {
    const esc = (v) => {
        const s = String(v ?? '')
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}

const EXPORT_PAGE = 2000
const EXPORT_CAP = 20000

export default function GeneralLedgerPage() {
    // Blank dates mean "the current business day"; the server resolves them
    // and sends the range back, so the inputs show the day without a second
    // round trip and without the page guessing what day the till is on.
    const [filters, setFilters] = useState({ from: '', to: '', accountId: '', voucherType: '' })
    const [range, setRange] = useState(null)
    const [rows, setRows] = useState([])
    const [totals, setTotals] = useState({ count: 0, debit: 0, credit: 0 })
    const [hasMore, setHasMore] = useState(false)
    const [accounts, setAccounts] = useState([])
    const [isLoading, setIsLoading] = useState(true)
    const [isFetching, setIsFetching] = useState(false)
    const [isExporting, setIsExporting] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })
    // Every request carries a ticket; a response whose ticket is stale (the
    // filters moved while it was in flight) is dropped, so a slow "load
    // more" can never append last week's lines under this week's filter.
    const ticket = useRef(0)

    useEffect(() => {
        listAccountOptions().then((res) => {
            if (res.error) setMessage({ type: 'error', text: res.error })
            else setAccounts(res.data)
        })
    }, [])

    // State moves only inside the response callback, never synchronously in
    // the effect: a filter change leaves the old rows up until the new ones
    // arrive, and "Load more" (an event handler) is the one place that
    // switches the fetching flag on up front.
    const load = useCallback((f, offset = 0) => {
        const mine = ++ticket.current
        return listLedgerLines({ ...f, offset }).then((res) => {
            if (mine !== ticket.current) return
            if (res.error) {
                setMessage({ type: 'error', text: res.error })
            } else {
                setMessage({ type: '', text: '' })
                setRange(res.data.range)
                setTotals(res.data.totals)
                setHasMore(res.data.hasMore)
                setRows((prev) => (offset === 0 ? res.data.rows : [...prev, ...res.data.rows]))
            }
            setIsFetching(false)
            setIsLoading(false)
        })
    }, [])

    useEffect(() => { load(filters) }, [filters, load])

    const loadMore = () => {
        setIsFetching(true)
        load(filters, rows.length)
    }

    const shown = {
        from: filters.from || range?.from || '',
        to: filters.to || range?.to || '',
    }

    // A date edit pins the other end to what is on screen, so changing
    // "from" on the default day does not silently widen "to".
    const setDate = (key, value) =>
        setFilters((f) => ({ ...f, from: shown.from, to: shown.to, [key]: value }))

    const accountLabel = useMemo(() => {
        if (!filters.accountId) return 'All accounts'
        const a = accounts.find((x) => String(x.id) === String(filters.accountId))
        return a ? `${a.account_number} ${a.name}` : 'One account'
    }, [filters.accountId, accounts])

    const exportCsv = async () => {
        setIsExporting(true)
        try {
            const all = []
            let offset = 0
            let more = true
            while (more && all.length < EXPORT_CAP) {
                const res = await listLedgerLines({ ...filters, offset, limit: EXPORT_PAGE })
                if (res.error) throw new Error(res.error)
                all.push(...res.data.rows)
                offset += res.data.rows.length
                more = res.data.hasMore && res.data.rows.length > 0
            }
            downloadCsv(
                `general-ledger-${shown.from}-to-${shown.to}.csv`,
                ['Date', 'Voucher', 'Type', 'Description', 'Reference', 'Account #', 'Account', 'Memo', 'Debit', 'Credit'],
                all.map((r) => [
                    r.business_date, r.voucher_no, r.voucher_type, r.description, r.reference || '',
                    r.account_number, r.account_name, r.memo || '',
                    r.debit || '', r.credit || '',
                ]),
            )
            if (more) setMessage({ type: 'warn', text: `The export stops at ${EXPORT_CAP.toLocaleString('en-PK')} lines: narrow the range for the rest.` })
        } catch (e) {
            setMessage({ type: 'error', text: e.message })
        }
        setIsExporting(false)
    }

    const noteClass = message.type === 'error' ? styles.noteError : message.type === 'warn' ? styles.noteWarn : styles.noteSuccess

    return (
        <div className={styles.container} id="ledger-root">
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>General Ledger</h1>
                    <p className={styles.subtitle}>
                        Every posted line, in the order it was booked. Pick a day, an account or a voucher type; the footer totals cover everything that matches.
                    </p>
                </div>
                <div className={`${styles.headerActions} no-print`}>
                    <button type="button" className={styles.secondaryBtn} onClick={exportCsv} disabled={isExporting || isLoading}>
                        {isExporting ? <Loader2 size={15} className={styles.spinner} /> : <FileDown size={15} />} CSV
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={() => window.print()} disabled={isLoading}>
                        <Printer size={15} /> Print / Save as PDF
                    </button>
                </div>
            </div>

            {message.type && (
                <div role="status" aria-live="polite" className={`${styles.note} ${noteClass} no-print`}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {message.text}
                </div>
            )}

            <div className={`${styles.filterRow} no-print`}>
                <div className={styles.dateRange}>
                    <input
                        type="date"
                        value={shown.from}
                        max={shown.to || undefined}
                        onChange={(e) => setDate('from', e.target.value)}
                        aria-label="From date"
                    />
                    <span className={styles.dateSep}>to</span>
                    <input
                        type="date"
                        value={shown.to}
                        min={shown.from || undefined}
                        onChange={(e) => setDate('to', e.target.value)}
                        aria-label="To date"
                    />
                </div>
                <select
                    className={own.select}
                    value={filters.accountId}
                    onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))}
                    aria-label="Account"
                >
                    <option value="">All accounts</option>
                    {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                            {a.account_number} · {a.name}{a.is_active ? '' : ' (inactive)'}
                        </option>
                    ))}
                </select>
                <div className={styles.filterTabs} role="tablist" aria-label="Voucher type">
                    {TYPE_TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={filters.voucherType === t.key}
                            className={`${styles.filterTab} ${filters.voucherType === t.key ? styles.filterActive : ''}`}
                            onClick={() => setFilters((f) => ({ ...f, voucherType: t.key }))}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className={`${styles.reportHead} ${styles.printOnly}`}>
                <div className={styles.reportMeta}>
                    {shown.from === shown.to ? shown.from : `${shown.from} to ${shown.to}`}
                    {' · '}{accountLabel}
                    {filters.voucherType ? ` · ${filters.voucherType} vouchers only` : ''}
                </div>
            </div>

            <div className={styles.listWrap}>
                {isLoading ? (
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={28} />
                        <p>Reading the ledger…</p>
                    </div>
                ) : rows.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <ScrollText size={28} />
                        <p>Nothing posted {shown.from === shown.to ? `on ${shown.from}` : 'in this range'}{filters.accountId || filters.voucherType ? ' for this filter' : ''}.</p>
                    </div>
                ) : (
                    <>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Voucher</th>
                                    <th>Account #</th>
                                    <th>Account</th>
                                    <th>Memo</th>
                                    <th className={styles.alignRight}>Debit</th>
                                    <th className={styles.alignRight}>Credit</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.id}>
                                        <td className={styles.cellMuted}>{r.business_date}</td>
                                        <td className={styles.cellName}>
                                            <Link href={`/accounts/journals/${r.journal_id}`} className={own.voucherLink} title={r.description}>
                                                {r.voucher_no}
                                            </Link>
                                            <span className={styles.cellSub}>{r.description}</span>
                                        </td>
                                        <td className={styles.cellCode}>{r.account_number}</td>
                                        <td className={styles.cellStrong}>{r.account_name}</td>
                                        <td className={`${styles.cellMuted} ${styles.cellWrap}`} style={{ whiteSpace: 'normal' }}>{r.memo || ''}</td>
                                        <td className={styles.cellNum}>{rs(r.debit)}</td>
                                        <td className={styles.cellNum}>{rs(r.credit)}</td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot className={styles.tfoot}>
                                <tr>
                                    <td colSpan={5}>
                                        Total · {totals.count.toLocaleString('en-PK')} line{totals.count === 1 ? '' : 's'}
                                        {rows.length < totals.count ? ` (${rows.length.toLocaleString('en-PK')} shown)` : ''}
                                    </td>
                                    <td className={styles.cellNum}>{rsTotal(totals.debit)}</td>
                                    <td className={styles.cellNum}>{rsTotal(totals.credit)}</td>
                                </tr>
                            </tfoot>
                        </table>
                        {hasMore && (
                            <div className={`${own.moreRow} no-print`}>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={loadMore}
                                    disabled={isFetching}
                                >
                                    {isFetching ? <Loader2 size={15} className={styles.spinner} /> : <ChevronDown size={15} />}
                                    Load more
                                </button>
                                <span>{rows.length.toLocaleString('en-PK')} of {totals.count.toLocaleString('en-PK')}</span>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Print: hide the app chrome and force a light A4 page — the
                section stylesheet already handles the table itself. */}
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

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from '../accounts.module.css'
import { listJournals } from './actions'
import { VOUCHER_TYPES } from '@/lib/accounts/constants.mjs'
import { usePermissions } from '@/components/Layout/AppLayout'
import Link from 'next/link'
import { Files, Loader2, AlertTriangle, ChevronDown, Plus, Printer } from 'lucide-react'

/*
 * The Voucher List: one row per journal, machine-posted and manual alike.
 * Click a row for the voucher itself.
 */

const TYPE_TABS = [{ key: '', label: 'All' }, ...Object.entries(VOUCHER_TYPES).map(([key, label]) => ({ key, label: `${key} · ${label}` }))]

const rs = (n) => (Math.round((Number(n) || 0) * 100) / 100)
    .toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

const STATUS_CLASS = { draft: 'statusDraft', posted: 'statusPosted', void: 'statusVoid' }

export default function VoucherListPage() {
    const router = useRouter()
    const { can } = usePermissions()
    const [filters, setFilters] = useState({ from: '', to: '', voucherType: '' })
    const [range, setRange] = useState(null)
    const [rows, setRows] = useState([])
    const [totals, setTotals] = useState({ count: 0, debit: 0, credit: 0 })
    const [hasMore, setHasMore] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [isFetching, setIsFetching] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })
    const ticket = useRef(0)

    // Every request carries a ticket; a stale response (the filters moved
    // while it was in flight) is dropped. State moves only in the response
    // callback, never synchronously in the effect.
    const load = useCallback((f, offset = 0) => {
        const mine = ++ticket.current
        return listJournals({ ...f, offset }).then((res) => {
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
    const setDate = (key, value) =>
        setFilters((f) => ({ ...f, from: shown.from, to: shown.to, [key]: value }))

    const open = (id) => router.push(`/accounts/journals/${id}`)

    return (
        <div className={styles.container} id="ledger-root">
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Vouchers</h1>
                    <p className={styles.subtitle}>
                        Every journal in the books. Sales and settlements the till posted itself, and the ones a person entered.
                    </p>
                </div>
                <div className={`${styles.headerActions} no-print`}>
                    <button type="button" className={styles.secondaryBtn} onClick={() => window.print()} disabled={isLoading}>
                        <Printer size={15} /> Print / Save as PDF
                    </button>
                    {can('accounts_admin') && (
                        <Link href="/accounts/journals/new" className={styles.primaryBtn} style={{ textDecoration: 'none' }}>
                            <Plus size={16} /> Add transaction
                        </Link>
                    )}
                </div>
            </div>

            {message.type && (
                <div role="status" aria-live="polite" className={`${styles.note} ${styles.noteError} no-print`}>
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
                    {filters.voucherType ? ` · ${filters.voucherType} vouchers only` : ''}
                </div>
            </div>

            <div className={styles.listWrap}>
                {isLoading ? (
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={28} />
                        <p>Loading vouchers…</p>
                    </div>
                ) : rows.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <Files size={28} />
                        <p>No vouchers {shown.from === shown.to ? `on ${shown.from}` : 'in this range'}{filters.voucherType ? ' of this type' : ''}.</p>
                    </div>
                ) : (
                    <>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Voucher No</th>
                                    <th>Type</th>
                                    <th>Description</th>
                                    <th>Reference</th>
                                    <th className={styles.alignRight}>Debit</th>
                                    <th className={styles.alignRight}>Credit</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((j) => (
                                    <tr
                                        key={j.id}
                                        className={styles.rowClickable}
                                        onClick={() => open(j.id)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(j.id) } }}
                                        tabIndex={0}
                                        role="link"
                                        aria-label={`Open voucher ${j.voucher_no}`}
                                    >
                                        <td className={styles.cellMuted}>{j.business_date}</td>
                                        <td className={styles.cellCode}>{j.voucher_no}</td>
                                        <td>
                                            <div className={styles.chipRow}>
                                                <span className={styles.chip} title={j.voucher_type_label}>{j.voucher_type}</span>
                                                <span
                                                    className={`${styles.chip} ${j.is_manual ? styles.chipPrimary : ''}`}
                                                    title={j.is_manual
                                                        ? `Entered by ${j.created_by_name || 'a person'}`
                                                        : j.created_by_name ? `Posted by the system, re-posted by ${j.created_by_name}` : 'Posted by the system'}
                                                >
                                                    {j.is_manual ? 'Manual' : 'Auto'}
                                                </span>
                                            </div>
                                        </td>
                                        <td className={styles.cellWrap} style={{ whiteSpace: 'normal' }}>{j.description}</td>
                                        <td className={styles.cellMuted}>{j.reference || '—'}</td>
                                        <td className={styles.cellNum}>{rs(j.debit_total)}</td>
                                        <td className={styles.cellNum}>{rs(j.credit_total)}</td>
                                        <td>
                                            <span className={`${styles.status} ${styles[STATUS_CLASS[j.status] || 'statusDraft']}`}>{j.status}</span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot className={styles.tfoot}>
                                <tr>
                                    <td colSpan={5}>
                                        Total · {totals.count.toLocaleString('en-PK')} voucher{totals.count === 1 ? '' : 's'}
                                        {rows.length < totals.count ? ` (${rows.length.toLocaleString('en-PK')} shown)` : ''}
                                    </td>
                                    <td className={styles.cellNum}>{rs(totals.debit)}</td>
                                    <td className={styles.cellNum}>{rs(totals.credit)}</td>
                                    <td></td>
                                </tr>
                            </tfoot>
                        </table>
                        {hasMore && (
                            <div className={`${styles.stateBlock} no-print`} style={{ padding: '0.85rem', flexDirection: 'row' }}>
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

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Users, Search, Loader2, Phone, MapPin, Receipt, AlertTriangle } from 'lucide-react'
import { listCustomers, getCustomerOrders } from './actions'
import { formatRupees } from '@/lib/money'
import { formatDateTime } from '@/lib/timeFormat'

/*
 * The customer book: who has ordered, how often, what they spend, and what
 * they order. The till has been filling this table since the first takeaway;
 * this is the first screen that reads it.
 *
 * Two panes rather than a drill-down page, because the question is asked with
 * a phone in one hand: search, tap, read the history without losing the list.
 */
const money = (n) => `Rs. ${formatRupees(n, 0)}`

export default function CustomersPage() {
    const [search, setSearch] = useState('')
    const [rows, setRows] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [selected, setSelected] = useState(null)
    const [detail, setDetail] = useState(null)
    const detailLoading = Boolean(selected) && detail === null

    // Debounced so typing a phone number is one query, not eleven.
    useEffect(() => {
        const timer = setTimeout(() => {
            listCustomers(search).then((res) => {
                if (res.error) setError(res.error)
                else { setError(''); setRows(res.data) }
                setLoading(false)
            })
        }, 250)
        return () => clearTimeout(timer)
    }, [search])

    /*
     * The detail pane. `detail` is cleared by the click that changes the
     * selection rather than by this effect, so "loading" is simply a selection
     * with nothing fetched for it yet — one piece of state instead of two that
     * can disagree.
     */
    useEffect(() => {
        const phone = selected?.phone
        if (!phone) return undefined
        let alive = true
        getCustomerOrders(phone).then((res) => {
            if (alive) setDetail(res.error ? null : res.data)
        })
        return () => { alive = false }
    }, [selected])

    const totals = useMemo(() => ({
        people: rows.length,
        spend: rows.reduce((sum, r) => sum + Number(r.total_spent || 0), 0),
    }), [rows])

    return (
        <div className="max-w-6xl mx-auto p-6">
            <div className="mb-6 flex items-start gap-3">
                <Users className="h-7 w-7 text-muted-foreground mt-1" />
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Customers</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Everyone who has left a phone number at the till. Search by name or number.
                    </p>
                </div>
            </div>

            <div className="relative mb-5">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                    className="w-full min-h-[44px] pl-10 pr-3 rounded-lg border border-border bg-surface text-foreground"
                    placeholder="Name or phone number…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>

            {error && (
                <div className="flex items-start gap-3 p-4 mb-5 rounded-lg border bg-danger-soft border-danger-border text-danger-text text-sm">
                    <AlertTriangle className="h-5 w-5 flex-shrink-0" />{error}
                </div>
            )}

            <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
                <div className="bg-surface rounded-xl border border-border overflow-hidden">
                    <div className="px-4 py-3 border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        {loading ? 'Loading…' : `${totals.people} shown · ${money(totals.spend)} lifetime`}
                    </div>
                    {loading ? (
                        <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                    ) : rows.length === 0 ? (
                        <p className="p-8 text-center text-sm text-muted-foreground">
                            {search
                                ? 'Nobody matches that.'
                                : 'No customers yet — a name and number taken at the till lands here.'}
                        </p>
                    ) : rows.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => { setSelected(c); setDetail(null) }}
                            className={`w-full text-left px-4 py-3 border-b border-border last:border-b-0 hover:bg-background ${selected?.id === c.id ? 'bg-background' : ''}`}
                        >
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="font-semibold text-card-foreground">{c.name}</span>
                                <span className="text-sm text-muted-foreground">{money(c.total_spent)}</span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                                {c.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</span>}
                                <span>{c.total_orders} order{Number(c.total_orders) === 1 ? '' : 's'}</span>
                                <span>last {formatDateTime(new Date(c.updated_at))}</span>
                            </div>
                        </button>
                    ))}
                </div>

                <div className="bg-surface rounded-xl border border-border p-5">
                    {!selected ? (
                        <p className="text-sm text-muted-foreground">Pick someone to see their orders.</p>
                    ) : (
                        <>
                            <h2 className="text-lg font-bold text-card-foreground">{selected.name}</h2>
                            <div className="mt-1 space-y-1 text-sm text-muted-foreground">
                                {selected.phone && <p className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" />{selected.phone}</p>}
                                {selected.address && <p className="flex items-start gap-1.5"><MapPin className="h-3.5 w-3.5 mt-0.5" />{selected.address}</p>}
                            </div>

                            {detailLoading ? (
                                <div className="p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                            ) : (
                                <>
                                    {detail?.favourites?.length > 0 && (
                                        <div className="mt-5">
                                            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Usually orders</h3>
                                            <ul className="text-sm text-card-foreground space-y-1">
                                                {detail.favourites.map((f) => (
                                                    <li key={f.name} className="flex justify-between gap-3">
                                                        <span>{f.name}</span>
                                                        <span className="text-muted-foreground">×{Number(f.qty)}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    <div className="mt-5">
                                        <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Orders</h3>
                                        {!detail?.orders?.length ? (
                                            <p className="text-sm text-muted-foreground">
                                                Nothing under this number yet — the count above came from sales taken before
                                                the number was recorded on the bill.
                                            </p>
                                        ) : (
                                            <ul className="divide-y divide-border">
                                                {detail.orders.map((o) => (
                                                    <li key={o.id} className="py-2 flex items-baseline justify-between gap-3 text-sm">
                                                        <span className="flex items-center gap-1.5 text-card-foreground">
                                                            <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
                                                            #{o.order_number}
                                                            <span className="text-muted-foreground">{o.order_type}</span>
                                                        </span>
                                                        <span className="text-right">
                                                            <span className="block text-card-foreground">{money(o.total)}</span>
                                                            <span className="block text-xs text-muted-foreground">
                                                                {formatDateTime(new Date(o.created_at))}
                                                            </span>
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}

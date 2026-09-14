'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
    ClipboardList, Plus, Trash2, Loader2, AlertTriangle, CheckCircle2,
    PackageCheck, XCircle, ChevronLeft,
} from 'lucide-react'
import {
    getPurchaseOrders, createPurchaseOrder, cancelPurchaseOrder, getPurchaseOrderForReceiving,
} from './actions'
import { createReceiving } from '../receiving/actions'
import { formatRupees } from '@/lib/money'

/*
 * Purchase orders: raise one, watch it, and receive it.
 *
 * Receiving happens through the same kernel verb as every other delivery, with
 * the order's id attached — so the quantities and prices on this screen are
 * DEFAULTS, not the record. What actually turned up is what the stock room
 * types here, and the difference against the order is exactly the thing worth
 * seeing later.
 */
const money = (n) => `Rs. ${formatRupees(n, 2)}`
const qtyFmt = (n) => Number(n).toLocaleString('en-PK', { maximumFractionDigits: 3 })

const STATUS = {
    open: { label: 'Open', cls: 'bg-warning-soft text-warning-text border-warning-border' },
    received: { label: 'Received', cls: 'bg-success-soft text-success-text border-success-border' },
    cancelled: { label: 'Cancelled', cls: 'bg-danger-soft text-danger-text border-danger-border' },
}

const emptyLine = () => ({ key: Math.random().toString(36).slice(2), itemId: '', qty: '', unitCost: '' })

export default function PurchaseOrdersPage() {
    const [data, setData] = useState(null)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState(false)
    const [creating, setCreating] = useState(false)
    const [form, setForm] = useState({ supplierId: '', warehouseId: '', expectedOn: '', notes: '', lines: [emptyLine()] })
    const [receiving, setReceiving] = useState(null)

    const load = useCallback(() => getPurchaseOrders().then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setData(res.data)
    }), [])

    useEffect(() => { load() }, [load])

    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const setLine = (key, patch) => setForm((prev) => ({
        ...prev,
        lines: prev.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    }))

    const submit = async () => {
        setBusy(true)
        const res = await createPurchaseOrder({
            supplierId: form.supplierId,
            warehouseId: form.warehouseId,
            expectedOn: form.expectedOn || null,
            notes: form.notes,
            lines: form.lines.filter((l) => l.itemId && l.qty),
        })
        setBusy(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setMessage({ type: 'success', text: 'Purchase order raised' })
        setCreating(false)
        setForm({ supplierId: '', warehouseId: '', expectedOn: '', notes: '', lines: [emptyLine()] })
        load()
    }

    const startReceive = async (po) => {
        const res = await getPurchaseOrderForReceiving(po.id)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setReceiving({ ...res.data, supplierInvoice: '' })
    }

    const postReceive = async () => {
        setBusy(true)
        const res = await createReceiving({
            supplierId: receiving.supplier_id,
            warehouseId: receiving.warehouse_id,
            purchaseOrderId: receiving.id,
            supplierInvoice: receiving.supplierInvoice,
            lines: receiving.lines
                .filter((l) => Number(l.qty) > 0)
                .map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitCost: Number(l.unitCost) })),
        })
        setBusy(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setMessage({ type: 'success', text: `${receiving.po_number} received into stock` })
        setReceiving(null)
        load()
    }

    const cancel = async (po) => {
        const res = await cancelPurchaseOrder(po.id)
        if (res.error) setMessage({ type: 'error', text: res.error })
        else { setMessage({ type: 'success', text: `${po.po_number} cancelled` }); load() }
    }

    if (!data) {
        return <div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    }

    return (
        <div className="max-w-6xl mx-auto p-6">
            <Link href="/inventory" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
                <ChevronLeft className="h-4 w-4" />Inventory
            </Link>

            <div className="mb-6 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <ClipboardList className="h-7 w-7 text-muted-foreground mt-1" />
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Purchase Orders</h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            What was ordered, at what price, for when, so a short or dearer delivery is a
                            conversation with evidence.
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => setCreating((v) => !v)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg"
                >
                    <Plus className="h-4 w-4" />{creating ? 'Close' : 'New order'}
                </button>
            </div>

            {message.type && (
                <div className={`flex items-start gap-3 p-4 mb-5 rounded-lg border text-sm ${message.type === 'error'
                    ? 'bg-danger-soft border-danger-border text-danger-text'
                    : 'bg-success-soft border-success-border text-success-text'}`}
                >
                    {message.type === 'error' ? <AlertTriangle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
                    {message.text}
                </div>
            )}

            {creating && (
                <div className="bg-surface rounded-xl border border-border p-5 mb-6">
                    <div className="grid gap-3 sm:grid-cols-3 mb-4">
                        <select
                            className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                            value={form.supplierId}
                            onChange={(e) => setForm((p) => ({ ...p, supplierId: e.target.value }))}
                        >
                            <option value="">Supplier…</option>
                            {data.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <select
                            className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                            value={form.warehouseId}
                            onChange={(e) => setForm((p) => ({ ...p, warehouseId: e.target.value }))}
                        >
                            <option value="">Deliver to…</option>
                            {data.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                        <input
                            type="date"
                            className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                            value={form.expectedOn}
                            onChange={(e) => setForm((p) => ({ ...p, expectedOn: e.target.value }))}
                            title="Expected on"
                        />
                    </div>

                    {form.lines.map((l) => (
                        <div key={l.key} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] mb-2">
                            <select
                                className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                                value={l.itemId}
                                onChange={(e) => {
                                    const item = data.items.find((i) => String(i.id) === e.target.value)
                                    // The last price paid is the sensible opening bid for the
                                    // agreed one; it is a default and stays editable.
                                    setLine(l.key, { itemId: e.target.value, unitCost: l.unitCost || (item ? String(item.avg_cost) : '') })
                                }}
                            >
                                <option value="">Ingredient…</option>
                                {data.items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit_abbrev})</option>)}
                            </select>
                            <input
                                className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground text-right"
                                type="number" min="0" step="0.001" placeholder="Qty"
                                value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })}
                            />
                            <input
                                className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground text-right"
                                type="number" min="0" step="0.01" placeholder="Agreed price"
                                value={l.unitCost} onChange={(e) => setLine(l.key, { unitCost: e.target.value })}
                            />
                            <button
                                type="button"
                                className="px-3 text-muted-foreground hover:text-danger-text"
                                onClick={() => setForm((p) => ({
                                    ...p,
                                    lines: p.lines.length > 1 ? p.lines.filter((x) => x.key !== l.key) : [emptyLine()],
                                }))}
                                aria-label="Remove line"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    ))}

                    <div className="flex items-center justify-between gap-3 mt-3">
                        <button
                            type="button"
                            className="text-sm text-primary"
                            onClick={() => setForm((p) => ({ ...p, lines: [...p.lines, emptyLine()] }))}
                        >
                            + Add line
                        </button>
                        <button
                            type="button"
                            onClick={submit}
                            disabled={busy}
                            className="px-5 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg disabled:opacity-40"
                        >
                            {busy ? 'Saving…' : 'Raise order'}
                        </button>
                    </div>
                </div>
            )}

            <div className="space-y-3">
                {data.orders.length === 0 && (
                    <p className="text-sm text-muted-foreground p-8 text-center bg-surface rounded-xl border border-border">
                        No purchase orders yet.
                    </p>
                )}
                {data.orders.map((po) => (
                    <div key={po.id} className="bg-surface rounded-xl border border-border p-4">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold text-card-foreground">{po.po_number}</span>
                                    <span className={`px-2 py-0.5 rounded-full border text-xs ${STATUS[po.status]?.cls}`}>
                                        {STATUS[po.status]?.label ?? po.status}
                                    </span>
                                </div>
                                <p className="mt-0.5 text-sm text-muted-foreground">
                                    {po.supplier_name} → {po.warehouse_name}
                                    {po.expected_on && ` · expected ${String(po.expected_on).slice(0, 10)}`}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="font-semibold text-card-foreground">{money(po.total)}</span>
                                {po.status === 'open' && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => startReceive(po)}
                                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm"
                                        >
                                            <PackageCheck className="h-4 w-4" />Receive
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => cancel(po)}
                                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground"
                                        >
                                            <XCircle className="h-4 w-4" />Cancel
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                        <ul className="mt-3 text-sm divide-y divide-border">
                            {po.lines.map((l, i) => (
                                <li key={i} className="py-1.5 flex justify-between gap-3">
                                    <span className="text-card-foreground">{l.name}</span>
                                    <span className="text-muted-foreground">
                                        {qtyFmt(l.qty)} {l.unit_abbrev} × {money(l.unit_cost)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>

            {receiving && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="bg-surface rounded-xl border border-border w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5">
                        <h2 className="text-lg font-bold text-card-foreground">Receive {receiving.po_number}</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Type what actually arrived and what was actually charged. The order keeps what was
                            promised; the difference is the conversation with the supplier.
                        </p>

                        <input
                            className="w-full min-h-[44px] px-3 mt-4 rounded-lg border border-border bg-background text-foreground"
                            placeholder="Supplier invoice number (optional)"
                            value={receiving.supplierInvoice}
                            onChange={(e) => setReceiving((p) => ({ ...p, supplierInvoice: e.target.value }))}
                        />

                        <div className="mt-4 space-y-2">
                            {receiving.lines.map((l, i) => (
                                <div key={l.itemId} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr] items-center">
                                    <span className="text-sm text-card-foreground">{l.name} ({l.unit_abbrev})</span>
                                    <input
                                        className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground text-right"
                                        type="number" min="0" step="0.001" value={l.qty}
                                        onChange={(e) => setReceiving((p) => ({
                                            ...p,
                                            lines: p.lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                                        }))}
                                    />
                                    <input
                                        className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground text-right"
                                        type="number" min="0" step="0.01" value={l.unitCost}
                                        onChange={(e) => setReceiving((p) => ({
                                            ...p,
                                            lines: p.lines.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)),
                                        }))}
                                    />
                                </div>
                            ))}
                        </div>

                        <div className="mt-5 flex justify-end gap-3">
                            <button type="button" className="px-4 py-2.5 rounded-lg border border-border" onClick={() => setReceiving(null)}>
                                Back
                            </button>
                            <button
                                type="button"
                                onClick={postReceive}
                                disabled={busy}
                                className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40"
                            >
                                {busy ? 'Posting…' : 'Receive into stock'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

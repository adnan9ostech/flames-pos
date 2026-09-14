'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Tags, Plus, Trash2, Loader2, AlertTriangle, CheckCircle2, Save } from 'lucide-react'
import { getDealsAdmin, saveDeal, deleteDeal } from './actions'
import { explodeDeal } from '@/lib/deals.mjs'
import { formatRupees } from '@/lib/money'

/*
 * Deals: what goes in the set, and what the set sells for.
 *
 * The saving is never typed. It is shown live against today's menu prices,
 * because that is exactly how the till will work it out — so a deal that has
 * drifted above its own components is visible here rather than discovered at
 * the counter.
 */
const money = (n) => `Rs. ${formatRupees(n, 0)}`
const ORDER_TYPES = [['dine-in', 'Dine-in'], ['takeaway', 'Takeaway'], ['delivery', 'Delivery']]
const newLine = () => ({ key: Math.random().toString(36).slice(2), menuItemId: '', variantName: '', qty: '1' })

const blank = () => ({
    id: null, name: '', description: '', price: '', orderTypes: [], isActive: true, lines: [newLine()],
})

export default function DealsPage() {
    const [board, setBoard] = useState(null)
    const [form, setForm] = useState(null)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState(false)

    const load = useCallback(() => getDealsAdmin().then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setBoard(res.data)
    }), [])

    useEffect(() => { load() }, [load])
    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const variantsOf = (itemId) => {
        const item = board?.items.find((i) => i.id === itemId)
        if (!item) return []
        return Array.isArray(item.variants) ? item.variants : JSON.parse(item.variants || '[]')
    }

    // The live saving for whatever is in the editor, priced the till's way.
    const preview = useMemo(() => {
        if (!form || !board) return null
        return explodeDeal(
            {
                name: form.name || 'Deal',
                price: Number(form.price) || 0,
                order_types: JSON.stringify(form.orderTypes),
                lines: form.lines
                    .filter((l) => l.menuItemId)
                    .map((l) => ({ menu_item_id: l.menuItemId, variant_name: l.variantName, qty: Number(l.qty) || 1 })),
            },
            board.items,
        )
    }, [form, board])

    const edit = (deal) => setForm(deal ? {
        id: deal.id,
        name: deal.name,
        description: deal.description || '',
        price: String(deal.price),
        orderTypes: deal.order_types,
        isActive: deal.is_active,
        lines: deal.lines.length
            ? deal.lines.map((l) => ({ key: String(l.id), menuItemId: l.menu_item_id, variantName: l.variant_name || '', qty: String(l.qty) }))
            : [newLine()],
    } : blank())

    const submit = async () => {
        setBusy(true)
        const res = await saveDeal(form)
        setBusy(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setMessage({ type: 'success', text: res.success })
        setForm(null)
        load()
    }

    const remove = async (deal) => {
        const res = await deleteDeal(deal.id)
        if (res.error) setMessage({ type: 'error', text: res.error })
        else { setMessage({ type: 'success', text: res.success }); load() }
    }

    if (!board) {
        return <div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    }

    return (
        <div className="max-w-5xl mx-auto p-6">
            <div className="mb-6 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <Tags className="h-7 w-7 text-muted-foreground mt-1" />
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Deals</h1>
                        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                            A set of dishes for one price. Ringing one puts the dishes on the bill at their normal
                            prices and the difference into the order&rsquo;s discount, so the kitchen gets real
                            tickets, the stock room consumes real recipes, and the customer sees what they saved.
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => edit(null)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg"
                >
                    <Plus className="h-4 w-4" />New deal
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

            <div className="space-y-3">
                {board.deals.length === 0 && (
                    <p className="text-sm text-muted-foreground p-8 text-center bg-surface rounded-xl border border-border">
                        No deals yet.
                    </p>
                )}
                {board.deals.map((deal) => {
                    const { listTotal, saving } = explodeDeal(
                        { ...deal, lines: deal.lines.map((l) => ({ menu_item_id: l.menu_item_id, variant_name: l.variant_name, qty: l.qty })) },
                        board.items,
                    )
                    return (
                        <div key={deal.id} className="bg-surface rounded-xl border border-border p-4">
                            <div className="flex items-start justify-between gap-4 flex-wrap">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold text-card-foreground">{deal.name}</span>
                                        {!deal.is_active && (
                                            <span className="px-2 py-0.5 rounded-full border text-xs text-muted-foreground border-border">Off</span>
                                        )}
                                    </div>
                                    <p className="mt-0.5 text-sm text-muted-foreground">
                                        {deal.lines.map((l) => `${l.qty}× ${l.item_name}${l.variant_name ? ` (${l.variant_name})` : ''}`).join(', ')}
                                    </p>
                                    <p className="mt-1 text-sm">
                                        <span className="text-card-foreground font-semibold">{money(deal.price)}</span>
                                        {saving > 0
                                            ? <span className="text-muted-foreground"> · was {money(listTotal)}, saves {money(saving)}</span>
                                            : <span className="text-danger-text"> · the dishes now cost {money(listTotal)}. This deal saves nothing</span>}
                                        <span className="text-muted-foreground">
                                            {' · '}{deal.order_types.length ? deal.order_types.join(', ') : 'all order types'}
                                        </span>
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    <button type="button" onClick={() => edit(deal)} className="px-3 py-2 rounded-lg border border-border text-sm">Edit</button>
                                    <button type="button" onClick={() => remove(deal)} className="px-3 py-2 rounded-lg border border-border text-sm text-danger-text" aria-label="Delete deal">
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>

            {form && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="bg-surface rounded-xl border border-border w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5">
                        <h2 className="text-lg font-bold text-card-foreground mb-4">{form.id ? 'Edit deal' : 'New deal'}</h2>

                        <div className="grid gap-3 sm:grid-cols-[2fr_1fr] mb-3">
                            <input
                                className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                                placeholder="Name: Family Platter"
                                value={form.name}
                                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                            />
                            <input
                                className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground text-right"
                                type="number" min="0" step="1" placeholder="Deal price"
                                value={form.price}
                                onChange={(e) => setForm((p) => ({ ...p, price: e.target.value }))}
                            />
                        </div>

                        <input
                            className="w-full min-h-[44px] px-3 mb-3 rounded-lg border border-border bg-background text-foreground"
                            placeholder="Description (optional): what the till shows under the name"
                            value={form.description}
                            onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                        />

                        <div className="flex flex-wrap gap-2 mb-4">
                            {ORDER_TYPES.map(([key, label]) => (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => setForm((p) => ({
                                        ...p,
                                        orderTypes: p.orderTypes.includes(key)
                                            ? p.orderTypes.filter((t) => t !== key)
                                            : [...p.orderTypes, key],
                                    }))}
                                    className={`px-3 py-2 rounded-lg border text-sm ${form.orderTypes.includes(key)
                                        ? 'bg-selected text-selected-foreground border-selected-border'
                                        : 'border-border text-muted-foreground'}`}
                                >
                                    {label}
                                </button>
                            ))}
                            <span className="self-center text-xs text-muted-foreground">
                                {form.orderTypes.length === 0 && 'none picked = every order type'}
                            </span>
                        </div>

                        {form.lines.map((l) => (
                            <div key={l.key} className="grid gap-2 sm:grid-cols-[2fr_1fr_70px_auto] mb-2">
                                <select
                                    className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                                    value={l.menuItemId}
                                    onChange={(e) => setForm((p) => ({
                                        ...p, lines: p.lines.map((x) => (x.key === l.key ? { ...x, menuItemId: e.target.value, variantName: '' } : x)),
                                    }))}
                                >
                                    <option value="">Dish…</option>
                                    {board.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                                </select>
                                <select
                                    className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                                    value={l.variantName}
                                    onChange={(e) => setForm((p) => ({
                                        ...p, lines: p.lines.map((x) => (x.key === l.key ? { ...x, variantName: e.target.value } : x)),
                                    }))}
                                    disabled={variantsOf(l.menuItemId).length === 0}
                                >
                                    <option value="">Base price</option>
                                    {variantsOf(l.menuItemId).map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                                </select>
                                <input
                                    className="min-h-[44px] px-2 rounded-lg border border-border bg-background text-foreground text-right"
                                    type="number" min="1" step="1"
                                    value={l.qty}
                                    onChange={(e) => setForm((p) => ({
                                        ...p, lines: p.lines.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)),
                                    }))}
                                />
                                <button
                                    type="button"
                                    className="px-3 text-muted-foreground hover:text-danger-text"
                                    onClick={() => setForm((p) => ({
                                        ...p, lines: p.lines.length > 1 ? p.lines.filter((x) => x.key !== l.key) : [newLine()],
                                    }))}
                                    aria-label="Remove dish"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </div>
                        ))}

                        <button
                            type="button"
                            className="text-sm text-primary"
                            onClick={() => setForm((p) => ({ ...p, lines: [...p.lines, newLine()] }))}
                        >
                            + Add dish
                        </button>

                        {preview && preview.lines.length > 0 && (
                            <p className="mt-4 text-sm">
                                These dishes cost <strong>{money(preview.listTotal)}</strong> on the menu today.
                                {preview.saving > 0
                                    ? <span className="text-success-text"> This deal saves {money(preview.saving)}.</span>
                                    : <span className="text-danger-text"> This deal saves nothing at that price.</span>}
                            </p>
                        )}

                        <label className="mt-4 flex items-center gap-2 text-sm text-card-foreground">
                            <input
                                type="checkbox"
                                checked={form.isActive}
                                onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))}
                            />
                            Offered on the till
                        </label>

                        <div className="mt-5 flex justify-end gap-3">
                            <button type="button" className="px-4 py-2.5 rounded-lg border border-border" onClick={() => setForm(null)}>Back</button>
                            <button
                                type="button"
                                onClick={submit}
                                disabled={busy}
                                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40"
                            >
                                <Save className="h-4 w-4" />{busy ? 'Saving…' : 'Save deal'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

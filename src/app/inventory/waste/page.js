'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Trash2, Plus, Loader2, AlertTriangle, CheckCircle2, ChevronLeft } from 'lucide-react'
import { getWasteBoard, recordWaste } from './actions'
import { formatRupees } from '@/lib/money'
import { formatDateTime } from '@/lib/timeFormat'

/*
 * Food that was cooked and then thrown away.
 *
 * Recorded in DISHES, not ingredients, because that is what the person
 * standing over the bin knows. The recipe behind it comes off the shelf
 * exactly as a sale's would — the food really was made.
 */
const money = (n) => `Rs. ${formatRupees(n, 0)}`
const newLine = () => ({ key: Math.random().toString(36).slice(2), menuItemId: '', variantName: '', qty: '1' })

const REASONS = ['Dropped', 'Sent back', 'Cooked wrong', 'Not collected', 'Spoiled', 'Staff meal']

export default function WastePage() {
    const [board, setBoard] = useState(null)
    const [reason, setReason] = useState('')
    const [lines, setLines] = useState([newLine()])
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState(false)

    const load = useCallback(() => getWasteBoard().then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setBoard(res.data)
    }), [])

    useEffect(() => { load() }, [load])
    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const variantsOf = (id) => {
        const item = board?.items.find((i) => i.id === id)
        if (!item) return []
        return Array.isArray(item.variants) ? item.variants : JSON.parse(item.variants || '[]')
    }

    const post = async () => {
        setBusy(true)
        const res = await recordWaste({
            reason,
            lines: lines.filter((l) => l.menuItemId && Number(l.qty) > 0),
        })
        setBusy(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setMessage({ type: 'success', text: `Waste recorded — ${money(res.data.cost)} of food` })
        setReason('')
        setLines([newLine()])
        load()
    }

    if (!board) {
        return <div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    }

    return (
        <div className="max-w-5xl mx-auto p-6">
            <Link href="/inventory" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
                <ChevronLeft className="h-4 w-4" />Inventory
            </Link>

            <div className="mb-6 flex items-start gap-3">
                <Trash2 className="h-7 w-7 text-muted-foreground mt-1" />
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Waste</h1>
                    <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                        Food that was cooked and then thrown away — a dropped plate, a dish sent back, a takeaway
                        nobody collected. Recorded in dishes; the ingredients behind them come off the shelf, because
                        they really were used. This is not a void: a void un-rings something that was never made.
                    </p>
                </div>
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

            <div className="bg-surface rounded-xl border border-border p-5 mb-6">
                <label className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">Why</label>
                <input
                    className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                    placeholder="Required — what happened"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex flex-wrap gap-2 mt-2 mb-4">
                    {REASONS.map((r) => (
                        <button
                            key={r}
                            type="button"
                            onClick={() => setReason(r)}
                            className="px-3 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:border-primary hover:text-primary"
                        >
                            {r}
                        </button>
                    ))}
                </div>

                {lines.map((l) => (
                    <div key={l.key} className="grid gap-2 sm:grid-cols-[2fr_1fr_80px_auto] mb-2">
                        <select
                            className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                            value={l.menuItemId}
                            onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, menuItemId: e.target.value, variantName: '' } : x)))}
                        >
                            <option value="">Dish…</option>
                            {board.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                        </select>
                        <select
                            className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                            value={l.variantName}
                            onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, variantName: e.target.value } : x)))}
                            disabled={variantsOf(l.menuItemId).length === 0}
                        >
                            <option value="">Base</option>
                            {variantsOf(l.menuItemId).map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                        </select>
                        <input
                            className="min-h-[44px] px-2 rounded-lg border border-border bg-background text-foreground text-right"
                            type="number" min="0" step="0.5"
                            value={l.qty}
                            onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))}
                        />
                        <button
                            type="button"
                            className="px-3 text-muted-foreground hover:text-danger-text"
                            onClick={() => setLines((p) => (p.length > 1 ? p.filter((x) => x.key !== l.key) : [newLine()]))}
                            aria-label="Remove line"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    </div>
                ))}

                <div className="flex items-center justify-between gap-3 mt-3">
                    <button type="button" className="text-sm text-primary flex items-center gap-1" onClick={() => setLines((p) => [...p, newLine()])}>
                        <Plus className="h-4 w-4" />Add dish
                    </button>
                    <button
                        type="button"
                        onClick={post}
                        disabled={busy || !reason.trim()}
                        className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40"
                    >
                        {busy ? 'Recording…' : 'Record waste'}
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                {board.docs.length === 0 && (
                    <p className="text-sm text-muted-foreground p-8 text-center bg-surface rounded-xl border border-border">
                        Nothing recorded yet.
                    </p>
                )}
                {board.docs.map((d) => (
                    <div key={d.id} className="bg-surface rounded-xl border border-border p-4">
                        <div className="flex items-baseline justify-between gap-3 flex-wrap">
                            <span className="font-semibold text-card-foreground">{d.reason}</span>
                            <span className="text-sm text-card-foreground">{money(d.cost)}</span>
                        </div>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                            {d.lines.map((l) => `${Number(l.qty)}× ${l.name}${l.variant_name ? ` (${l.variant_name})` : ''}`).join(', ')}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {formatDateTime(new Date(d.created_at))}{d.by ? ` · ${d.by}` : ''}
                        </p>
                    </div>
                ))}
            </div>
        </div>
    )
}

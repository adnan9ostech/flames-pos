'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Layers, Plus, Trash2, Loader2, AlertTriangle, CheckCircle2, Save } from 'lucide-react'
import { getSubRecipeBoard, saveSubRecipe } from './actions'
import { formatRupees } from '@/lib/money'

/*
 * The batches a kitchen makes before it cooks a dish.
 *
 * The screen states the trade plainly at the top, because "sub-recipe" means
 * three different things across three POSs and the one that matters here is
 * that nothing is counted: the masala never sits on a shelf, its spices do.
 */
const money = (n) => `Rs. ${formatRupees(n, 2)}`
const newLine = () => ({ key: Math.random().toString(36).slice(2), itemId: '', qty: '' })

/*
 * ?item=<id> opens straight into that ingredient's recipe. The Ingredients
 * screen links here with it, because "this one is made here rather than
 * bought" is a fact about an ingredient — not a third screen to remember.
 */
export default function SubRecipesPage() {
    return (
        <Suspense fallback={<div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
            <SubRecipesScreen />
        </Suspense>
    )
}

function SubRecipesScreen() {
    const [board, setBoard] = useState(null)
    const [editing, setEditing] = useState(null)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState(false)
    const deepLink = useSearchParams().get('item')

    /*
     * Opened from an ingredient's row: straight into that ingredient's recipe,
     * whether it has one yet or not. Applied on the FIRST load only — every
     * later reload (after a save) must not reopen the editor over whatever the
     * person is doing now.
     */
    const linked = useRef(false)

    const load = useCallback(() => getSubRecipeBoard().then((res) => {
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setBoard(res.data)
        if (!deepLink || linked.current) return
        linked.current = true
        const existing = res.data.subRecipes.find((sub) => String(sub.id) === String(deepLink))
        setEditing(existing ? {
            parentId: String(existing.id),
            lines: existing.lines.map((l) => ({
                key: String(l.component_item_id),
                itemId: String(l.component_item_id),
                qty: String(l.qty),
            })),
        } : { parentId: String(deepLink), lines: [newLine()] })
    }), [deepLink])

    useEffect(() => { load() }, [load])

    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const open = (sub) => setEditing({
        parentId: String(sub?.id ?? ''),
        lines: sub?.lines?.length
            ? sub.lines.map((l) => ({ key: String(l.component_item_id), itemId: String(l.component_item_id), qty: String(l.qty) }))
            : [newLine()],
    })

    const save = async () => {
        setBusy(true)
        const res = await saveSubRecipe({
            parentId: editing.parentId,
            lines: editing.lines.filter((l) => l.itemId && l.qty),
        })
        setBusy(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setMessage({ type: 'success', text: res.success })
        setEditing(null)
        load()
    }

    if (!board) {
        return <div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    }

    const phantoms = new Set(board.subRecipes.map((s) => s.id))

    return (
        <div className="max-w-5xl mx-auto p-6">
            <div className="mb-6 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <Layers className="h-7 w-7 text-muted-foreground mt-1" />
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Sub-recipes</h1>
                        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                            The batches made before a dish is cooked — a masala, a paste, a stock. A dish that calls
                            for 80g of masala takes the <em>spices</em> off the shelf: the batch itself is never
                            bought and never counted, and its cost is the sum of its parts.
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => open(null)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg"
                >
                    <Plus className="h-4 w-4" />New
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
                {board.subRecipes.length === 0 && (
                    <p className="text-sm text-muted-foreground p-8 text-center bg-surface rounded-xl border border-border">
                        No sub-recipes yet. Until one exists, every recipe is written straight from raw ingredients —
                        which works, and means the masala&rsquo;s fifteen spices are copied into every dish that uses it.
                    </p>
                )}
                {board.subRecipes.map((sub) => (
                    <button
                        key={sub.id}
                        type="button"
                        onClick={() => open(sub)}
                        className="w-full text-left bg-surface rounded-xl border border-border p-4 hover:border-primary"
                    >
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="font-semibold text-card-foreground">{sub.name}</span>
                            <span className="text-sm text-muted-foreground">
                                {money(sub.cost)} per {sub.unit_abbrev}
                            </span>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {sub.lines.map((l) => `${Number(l.qty)} ${l.component_unit} ${l.component_name}`).join(' · ')}
                        </p>
                    </button>
                ))}
            </div>

            {editing && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="bg-surface rounded-xl border border-border w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5">
                        <h2 className="text-lg font-bold text-card-foreground mb-3">Sub-recipe</h2>

                        <label className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
                            This makes
                        </label>
                        <select
                            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground mb-4"
                            value={editing.parentId}
                            onChange={(e) => setEditing((p) => ({ ...p, parentId: e.target.value }))}
                        >
                            <option value="">Ingredient…</option>
                            {board.items.map((i) => (
                                <option key={i.id} value={i.id}>
                                    {i.name} ({i.unit_abbrev}){phantoms.has(Number(i.id)) ? ' — has a recipe' : ''}
                                </option>
                            ))}
                        </select>

                        <label className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
                            Made of, per one {board.items.find((i) => String(i.id) === editing.parentId)?.unit_abbrev || 'unit'}
                        </label>
                        {editing.lines.map((l) => (
                            <div key={l.key} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto] mb-2">
                                <select
                                    className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                                    value={l.itemId}
                                    onChange={(e) => setEditing((p) => ({
                                        ...p, lines: p.lines.map((x) => (x.key === l.key ? { ...x, itemId: e.target.value } : x)),
                                    }))}
                                >
                                    <option value="">Ingredient…</option>
                                    {board.items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit_abbrev})</option>)}
                                </select>
                                <input
                                    className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground text-right"
                                    type="number" min="0" step="0.0001" placeholder="Qty"
                                    value={l.qty}
                                    onChange={(e) => setEditing((p) => ({
                                        ...p, lines: p.lines.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)),
                                    }))}
                                />
                                <button
                                    type="button"
                                    className="px-3 text-muted-foreground hover:text-danger-text"
                                    onClick={() => setEditing((p) => ({
                                        ...p,
                                        lines: p.lines.length > 1 ? p.lines.filter((x) => x.key !== l.key) : [newLine()],
                                    }))}
                                    aria-label="Remove line"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </div>
                        ))}

                        <button
                            type="button"
                            className="text-sm text-primary"
                            onClick={() => setEditing((p) => ({ ...p, lines: [...p.lines, newLine()] }))}
                        >
                            + Add ingredient
                        </button>

                        <p className="mt-4 text-xs text-muted-foreground">
                            Saving with no ingredients removes the sub-recipe and turns it back into a plain
                            ingredient — that is how to undo one.
                        </p>

                        <div className="mt-4 flex justify-end gap-3">
                            <button type="button" className="px-4 py-2.5 rounded-lg border border-border" onClick={() => setEditing(null)}>
                                Back
                            </button>
                            <button
                                type="button"
                                onClick={save}
                                disabled={busy || !editing.parentId}
                                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40"
                            >
                                <Save className="h-4 w-4" />{busy ? 'Saving…' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

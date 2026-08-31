'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import styles from './recipes.module.css'
import { getRecipeBoard, getRecipe, saveRecipe } from './actions'
import { useRole } from '@/components/Layout/AppLayout'
import {
    ChefHat, Search, X, Plus, Trash2, Save, Loader2,
    AlertTriangle, CheckCircle2, ChevronLeft,
} from 'lucide-react'

const rupees = (n, digits = 2) =>
    Number(n).toLocaleString('en-PK', { minimumFractionDigits: digits, maximumFractionDigits: digits })

let lineKey = 0
const newLine = (seed = {}) => ({
    key: ++lineKey,
    inventory_item_id: seed.inventory_item_id ? String(seed.inventory_item_id) : '',
    qty: seed.qty !== undefined ? String(seed.qty) : '',
})

export default function RecipesPage() {
    const role = useRole()
    const canEdit = role === 'admin'

    const [board, setBoard] = useState(null)
    const [loadError, setLoadError] = useState('')
    const [search, setSearch] = useState('')

    const [selectedId, setSelectedId] = useState(null)
    const [lines, setLines] = useState([])
    const [notes, setNotes] = useState('')
    const [loadingRecipe, setLoadingRecipe] = useState(false)
    const [dirty, setDirty] = useState(false)

    const [saving, setSaving] = useState(false)
    const [note, setNote] = useState({ type: '', text: '' })

    useEffect(() => {
        getRecipeBoard().then((res) => {
            if (res.error) setLoadError(res.error)
            else setBoard(res.data)
        })
    }, [])

    // Clear a success note on its own; errors stay until the next attempt.
    useEffect(() => {
        if (note.type !== 'success') return
        const timer = setTimeout(() => setNote({ type: '', text: '' }), 4000)
        return () => clearTimeout(timer)
    }, [note])

    const ingredientById = useMemo(() => {
        const map = new Map()
        for (const ing of board?.ingredients ?? []) map.set(String(ing.id), ing)
        return map
    }, [board])

    const dishes = useMemo(() => {
        const term = search.trim().toLowerCase()
        const all = board?.dishes ?? []
        if (!term) return all
        return all.filter((d) =>
            d.name.toLowerCase().includes(term)
            || (d.category_name || '').toLowerCase().includes(term))
    }, [board, search])

    const selected = board?.dishes.find((d) => d.id === selectedId) ?? null

    const selectDish = async (dish) => {
        if (dish.id === selectedId) return
        if (dirty && !window.confirm('Discard the unsaved recipe changes?')) return
        setSelectedId(dish.id)
        setLines([])
        setNotes('')
        setDirty(false)
        setNote({ type: '', text: '' })
        setLoadingRecipe(true)
        const res = await getRecipe(dish.id)
        setLoadingRecipe(false)
        if (res.error) {
            setNote({ type: 'error', text: res.error })
            return
        }
        setLines(res.data.lines.map(newLine))
        setNotes(res.data.notes || '')
    }

    const touch = (fn) => (...args) => {
        setDirty(true)
        fn(...args)
    }

    const setLineField = (key, field, value) => {
        setLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)))
    }

    const removeLine = (key) => setLines((prev) => prev.filter((l) => l.key !== key))

    // Live cost: what the plate consumes at today's moving-average cost. A
    // half-typed quantity prices as zero rather than as NaN.
    const recipeCost = lines.reduce((sum, line) => {
        const ing = ingredientById.get(line.inventory_item_id)
        const qty = Number(line.qty)
        return sum + (ing && Number.isFinite(qty) && qty > 0 ? qty * Number(ing.avg_cost) : 0)
    }, 0)

    const salePrice = Number(selected?.price ?? 0)
    const margin = salePrice - recipeCost
    const marginPct = salePrice > 0 ? (margin / salePrice) * 100 : null

    const submit = async () => {
        if (!selected) return
        setSaving(true)
        setNote({ type: '', text: '' })
        const payload = {
            menuItemId: selected.id,
            notes,
            lines: lines
                .filter((l) => l.inventory_item_id || l.qty)
                .map((l) => ({ inventory_item_id: Number(l.inventory_item_id), qty: Number(l.qty) })),
        }
        const res = await saveRecipe(payload)
        setSaving(false)
        if (res.error) {
            setNote({ type: 'error', text: res.error })
            return
        }
        setDirty(false)
        const kept = res.data.lineCount > 0
        setNote({
            type: 'success',
            text: kept
                ? `Recipe saved — costs Rs. ${rupees(res.data.cost)} per portion`
                : 'Recipe removed',
        })
        // Reflect the has-recipe dot without a full reload.
        setBoard((prev) => prev && {
            ...prev,
            dishes: prev.dishes.map((d) =>
                d.id === selected.id ? { ...d, has_recipe: kept } : d),
        })
    }

    if (loadError) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.errorNote}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {loadError}
                </div>
            </div>
        )
    }

    if (!board) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading recipes…</p>
                </div>
            </div>
        )
    }

    return (
        <div className={styles.container}>
            <PageHeader />

            <div className={styles.split}>
                {/* ===== Dish picker ===== */}
                <div className={styles.dishPanel}>
                    <div className={styles.searchControl}>
                        <Search size={15} className={styles.searchIcon} aria-hidden="true" />
                        <input
                            type="search"
                            className={styles.searchInput}
                            placeholder="Find a dish"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            aria-label="Search dishes"
                        />
                        {search && (
                            <button
                                type="button"
                                className={styles.searchClear}
                                onClick={() => setSearch('')}
                                aria-label="Clear search"
                            >
                                <X size={14} />
                            </button>
                        )}
                    </div>

                    <div className={styles.dishList}>
                        {dishes.map((dish) => (
                            <button
                                key={dish.id}
                                type="button"
                                className={`${styles.dishRow} ${dish.id === selectedId ? styles.dishActive : ''}`}
                                onClick={() => selectDish(dish)}
                            >
                                <span
                                    className={`${styles.recipeDot} ${dish.has_recipe ? styles.dotOn : ''}`}
                                    title={dish.has_recipe ? 'Has a recipe' : 'No recipe yet'}
                                />
                                <span className={styles.dishInfo}>
                                    <span className={styles.dishName}>{dish.name}</span>
                                    {dish.category_name && (
                                        <span className={styles.dishCategory}>{dish.category_name}</span>
                                    )}
                                </span>
                                <span className={styles.dishPrice}>
                                    Rs. {Number(dish.price).toLocaleString('en-PK')}
                                </span>
                            </button>
                        ))}
                        {dishes.length === 0 && (
                            <p className={styles.emptyList}>No dishes match.</p>
                        )}
                    </div>
                </div>

                {/* ===== Recipe editor ===== */}
                <div className={styles.editorPanel}>
                    {!selected ? (
                        <div className={styles.stateBlock}>
                            <ChefHat size={32} />
                            <p>Pick a dish to build its recipe.</p>
                        </div>
                    ) : loadingRecipe ? (
                        <div className={styles.stateBlock}>
                            <Loader2 className={styles.spinner} size={32} />
                            <p>Loading recipe…</p>
                        </div>
                    ) : (
                        <>
                            <div className={styles.editorHeader}>
                                <div>
                                    <h2 className={styles.editorTitle}>{selected.name}</h2>
                                    {selected.category_name && (
                                        <p className={styles.editorSub}>{selected.category_name}</p>
                                    )}
                                </div>
                                {canEdit && (
                                    <button
                                        type="button"
                                        className={styles.saveBtn}
                                        onClick={submit}
                                        disabled={saving || !dirty}
                                    >
                                        {saving
                                            ? <Loader2 size={15} className={styles.spinner} />
                                            : <Save size={15} />}
                                        {saving ? 'Saving…' : 'Save recipe'}
                                    </button>
                                )}
                            </div>

                            {/* Cost vs price, updating as the lines change */}
                            <div className={styles.costRow}>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>Recipe cost</div>
                                    <div className={styles.costValue}>Rs. {rupees(recipeCost)}</div>
                                </div>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>Sale price</div>
                                    <div className={styles.costValue}>Rs. {rupees(salePrice, 0)}</div>
                                </div>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>Margin</div>
                                    <div className={`${styles.costValue} ${margin < 0 ? styles.negMargin : ''}`}>
                                        Rs. {rupees(margin, 0)}
                                        {marginPct !== null && (
                                            <span className={styles.marginPct}>
                                                {marginPct.toFixed(0)}%
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className={styles.linesWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Ingredient</th>
                                            <th className={styles.alignRight}>Qty</th>
                                            <th>Unit</th>
                                            <th className={styles.alignRight}>Avg cost</th>
                                            <th className={styles.alignRight}>Line cost</th>
                                            {canEdit && <th></th>}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {lines.map((line) => {
                                            const ing = ingredientById.get(line.inventory_item_id)
                                            const qty = Number(line.qty)
                                            const lineCost = ing && Number.isFinite(qty) && qty > 0
                                                ? qty * Number(ing.avg_cost) : 0
                                            return (
                                                <tr key={line.key}>
                                                    <td>
                                                        <select
                                                            className={styles.inputSelect}
                                                            value={line.inventory_item_id}
                                                            onChange={touch((e) =>
                                                                setLineField(line.key, 'inventory_item_id', e.target.value))}
                                                            disabled={!canEdit}
                                                        >
                                                            <option value="" disabled>Ingredient…</option>
                                                            {board.ingredients.map((i) => (
                                                                <option key={i.id} value={i.id}>
                                                                    {i.name} ({i.unit_abbrev})
                                                                </option>
                                                            ))}
                                                        </select>
                                                    </td>
                                                    <td className={styles.alignRight}>
                                                        <input
                                                            className={styles.qtyInput}
                                                            type="number"
                                                            min="0"
                                                            step="any"
                                                            inputMode="decimal"
                                                            value={line.qty}
                                                            onChange={touch((e) =>
                                                                setLineField(line.key, 'qty', e.target.value))}
                                                            placeholder="0"
                                                            disabled={!canEdit}
                                                        />
                                                    </td>
                                                    <td className={styles.cellMuted}>
                                                        {ing?.unit_abbrev || '—'}
                                                    </td>
                                                    <td className={`${styles.alignRight} ${styles.num}`}>
                                                        {ing ? `Rs. ${rupees(ing.avg_cost)}` : '—'}
                                                    </td>
                                                    <td className={`${styles.alignRight} ${styles.num} ${styles.cellStrong}`}>
                                                        Rs. {rupees(lineCost)}
                                                    </td>
                                                    {canEdit && (
                                                        <td className={styles.alignRight}>
                                                            <button
                                                                type="button"
                                                                className={styles.removeBtn}
                                                                onClick={touch(() => removeLine(line.key))}
                                                                aria-label="Remove line"
                                                                title="Remove line"
                                                            >
                                                                <Trash2 size={15} />
                                                            </button>
                                                        </td>
                                                    )}
                                                </tr>
                                            )
                                        })}
                                        {lines.length === 0 && (
                                            <tr>
                                                <td colSpan={canEdit ? 6 : 5} className={styles.emptyCell}>
                                                    No ingredients yet — this dish consumes no stock when sold.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            {canEdit && (
                                <button
                                    type="button"
                                    className={styles.addLineBtn}
                                    onClick={touch(() => setLines((prev) => [...prev, newLine()]))}
                                >
                                    <Plus size={15} aria-hidden="true" />
                                    Add ingredient
                                </button>
                            )}

                            <div className={styles.notesRow}>
                                <label htmlFor="recipe_notes" className={styles.notesLabel}>Notes</label>
                                <input
                                    id="recipe_notes"
                                    type="text"
                                    className={styles.notesInput}
                                    value={notes}
                                    onChange={touch((e) => setNotes(e.target.value))}
                                    maxLength={191}
                                    placeholder="Prep notes for the kitchen (optional)"
                                    disabled={!canEdit}
                                />
                            </div>

                            {note.type && (
                                <div
                                    role="status"
                                    aria-live="polite"
                                    className={`${styles.note} ${note.type === 'error' ? styles.noteError : styles.noteSuccess}`}
                                >
                                    {note.type === 'error'
                                        ? <AlertTriangle size={16} aria-hidden="true" />
                                        : <CheckCircle2 size={16} aria-hidden="true" />}
                                    {note.text}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}

function PageHeader() {
    return (
        <div className={styles.header}>
            <Link href="/inventory" className={styles.backLink}>
                <ChevronLeft size={15} aria-hidden="true" />
                Inventory
            </Link>
            <h1 className={styles.title}>Recipes</h1>
            <p className={styles.subtitle}>
                What one sold portion consumes, priced at moving-average cost.
            </p>
        </div>
    )
}

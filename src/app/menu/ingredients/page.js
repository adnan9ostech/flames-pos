'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import styles from '../menu.module.css'
import local from './ingredients.module.css'
import { listIngredients, saveIngredient, toggleIngredient, deleteIngredient } from './actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import { formatNumber, formatRupees } from '@/lib/money'
import {
    Carrot, Plus, Pencil, Trash2, Search, X, Loader2,
    AlertTriangle, CheckCircle2, Info, ShieldAlert,
} from 'lucide-react'

const EMPTY_FORM = {
    id: null,
    name: '',
    category: '',
    unit_id: '',
    avg_cost: '',
    reorder_level: '',
    is_active: true,
}

// Costs are per unit and fractional — Rs. 0.85 a gram rounds to "Rs. 1" at
// whole rupees and the recipe below it prices wrong by a fifth.
const cost = (n) => formatRupees(n, 2)

export default function IngredientsPage() {
    const { can } = usePermissions()
    const canEdit = can('menu')

    const [items, setItems] = useState([])
    const [units, setUnits] = useState([])
    const [isLoading, setIsLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [categoryFilter, setCategoryFilter] = useState('all')
    const [showInactive, setShowInactive] = useState(false)

    const [form, setForm] = useState(EMPTY_FORM)
    const [formOpen, setFormOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [busyId, setBusyId] = useState(null)
    // Set when the server refuses to overwrite a computed cost; holding the
    // payload means "Overwrite anyway" resends exactly what was refused.
    const [override, setOverride] = useState(null)
    const [message, setMessage] = useState({ type: '', text: '' })

    const nameRef = useRef(null)

    useEffect(() => {
        listIngredients().then((res) => {
            if (res.error) setMessage({ type: 'error', text: res.error })
            else {
                setItems(res.data.items)
                setUnits(res.data.units)
            }
            setIsLoading(false)
        })
    }, [])

    useEffect(() => {
        if (message.type !== 'success') return
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const categories = useMemo(() => {
        const set = new Set()
        for (const i of items) if (i.category) set.add(i.category)
        return [...set].sort((a, b) => a.localeCompare(b))
    }, [items])

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase()
        return items.filter((i) =>
            (showInactive || i.is_active)
            && (categoryFilter === 'all'
                || (categoryFilter === 'none' ? !i.category : i.category === categoryFilter))
            && (!q || i.name.toLowerCase().includes(q)
                || (i.category || '').toLowerCase().includes(q)))
    }, [items, search, categoryFilter, showInactive])

    const stats = useMemo(() => {
        const active = items.filter((i) => i.is_active)
        return {
            count: active.length,
            uncosted: active.filter((i) => i.avg_cost <= 0).length,
            value: items.reduce((s, i) => s + i.on_hand * i.avg_cost, 0),
        }
    }, [items])

    const openNew = () => {
        setForm((p) => ({ ...EMPTY_FORM, category: p.category, unit_id: p.unit_id || String(units[0]?.id ?? '') }))
        setFormOpen(true)
        setOverride(null)
        setMessage({ type: '', text: '' })
        setTimeout(() => nameRef.current?.focus(), 0)
    }

    const openEdit = (item) => {
        setForm({
            id: item.id,
            name: item.name,
            category: item.category || '',
            unit_id: String(item.unit_id),
            avg_cost: String(item.avg_cost),
            reorder_level: String(item.reorder_level),
            is_active: item.is_active,
        })
        setFormOpen(true)
        setOverride(null)
        setMessage({ type: '', text: '' })
    }

    const closeForm = () => {
        setFormOpen(false)
        setOverride(null)
    }

    const setField = (field, value) => setForm((p) => ({ ...p, [field]: value }))

    /*
     * One save path for both modes. The list is patched in place rather than
     * refetched — seventy ingredients typed one after another is seventy
     * round trips otherwise, and the row that just landed is already known.
     */
    const submit = async (confirmCostOverride = false) => {
        setSaving(true)
        setMessage({ type: '', text: '' })
        const res = await saveIngredient({ ...form, confirmCostOverride })
        setSaving(false)
        if (res.error) {
            // The cost-overwrite refusal is the one error with a way forward.
            if (!confirmCostOverride && /confirm to overwrite/.test(res.error)) {
                setOverride({ text: res.error })
            }
            setMessage({ type: 'error', text: res.error })
            return
        }
        const saved = res.data
        setItems((prev) => {
            const without = prev.filter((i) => i.id !== saved.id)
            return [...without, saved].sort((a, b) => a.name.localeCompare(b.name))
        })
        setOverride(null)
        setMessage({
            type: 'success',
            text: form.id ? `${saved.name} saved` : `${saved.name} added — next one`,
        })
        // Stays open, keeping the category and the unit: the owner is typing
        // a shopping list, not filling one form.
        setForm((p) => ({
            ...EMPTY_FORM, category: p.category, unit_id: p.unit_id, id: null,
        }))
        nameRef.current?.focus()
    }

    const onToggle = async (item) => {
        setBusyId(item.id)
        const res = await toggleIngredient(item.id)
        setBusyId(null)
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
            return
        }
        setItems((prev) => prev.map((i) =>
            (i.id === item.id ? { ...i, is_active: res.data.is_active } : i)))
    }

    const onDelete = async (item) => {
        if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return
        setBusyId(item.id)
        const res = await deleteIngredient(item.id)
        setBusyId(null)
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
            return
        }
        setItems((prev) => prev.filter((i) => i.id !== item.id))
        if (form.id === item.id) closeForm()
        setMessage({ type: 'success', text: `${item.name} deleted` })
    }

    const unitOf = (id) => units.find((u) => String(u.id) === String(id))?.abbrev || 'unit'

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Ingredients</h1>
                    <p className={styles.subtitle}>
                        What the kitchen buys, and what it costs — the prices every recipe is
                        costed at.
                    </p>
                </div>
                {canEdit && (
                    <div className={styles.headerActions}>
                        <button type="button" className={styles.primaryBtn} onClick={openNew}>
                            <Plus size={16} aria-hidden="true" />
                            Add ingredient
                        </button>
                    </div>
                )}
            </div>

            {/* The rule, stated where the cost is typed. It is a real decision
                — a hand-set price is temporary by design — and finding that
                out from a report six weeks later is how a menu gets mispriced. */}
            <div className={local.explain}>
                <Info size={16} aria-hidden="true" className={local.explainIcon} />
                <p>
                    <strong>Cost per unit is yours to set until the first delivery.</strong>{' '}
                    An ingredient with no purchase history has no computed cost, so type what you
                    pay. From the first stock receiving onward the moving average owns the figure
                    and replaces anything set by hand — each row says which of the two it is on
                    right now.
                </p>
            </div>

            {message.type && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`${styles.note} ${message.type === 'error' ? styles.noteError : styles.noteSuccess}`}
                >
                    {message.type === 'error'
                        ? <AlertTriangle size={16} aria-hidden="true" />
                        : <CheckCircle2 size={16} aria-hidden="true" />}
                    {message.text}
                </div>
            )}

            <div className={styles.statsRow}>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><Carrot size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Ingredients</div>
                        <div className={styles.statValue}>{stats.count}</div>
                        <div className={styles.statHint}>Active in the master</div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={`${styles.statIcon} ${stats.uncosted > 0 ? styles.warnIcon : ''}`}>
                        <ShieldAlert size={20} />
                    </div>
                    <div>
                        <div className={styles.statLabel}>Without a cost</div>
                        <div className={styles.statValue}>{stats.uncosted}</div>
                        <div className={styles.statHint}>
                            {stats.uncosted > 0
                                ? 'Every recipe using these costs zero'
                                : 'Every ingredient is priced'}
                        </div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><Carrot size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Stock value</div>
                        <div className={styles.statValue}>{formatRupees(stats.value)}</div>
                        <div className={styles.statHint}>On hand at cost per unit</div>
                    </div>
                </div>
            </div>

            <div className={styles.filterRow}>
                <div className={styles.searchBox}>
                    <Search size={15} aria-hidden="true" />
                    <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Find an ingredient"
                        aria-label="Search ingredients"
                    />
                    {search && (
                        <button
                            type="button"
                            className={styles.iconBtn}
                            onClick={() => setSearch('')}
                            aria-label="Clear search"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>

                <select
                    className={styles.select}
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    aria-label="Filter by category"
                >
                    <option value="all">All categories</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    <option value="none">Ungrouped</option>
                </select>

                <span className={styles.count}>
                    {visible.length} of {items.length}
                </span>

                <label className={styles.toggleLine}>
                    <input
                        type="checkbox"
                        checked={showInactive}
                        onChange={(e) => setShowInactive(e.target.checked)}
                    />
                    Show switched off
                </label>
            </div>

            {/* One column until the form is open — an empty 22rem gutter beside
                a wide table is a column of nothing. */}
            <div className={canEdit && formOpen ? styles.layout : undefined}>
                <div className={styles.listWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Ingredient</th>
                                <th>Unit</th>
                                <th className={styles.alignRight}>Cost per unit</th>
                                <th className={styles.alignRight}>On hand</th>
                                <th className={styles.alignRight}>Reorder at</th>
                                {canEdit && <th className={styles.cellActions}>Actions</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {isLoading && (
                                <tr>
                                    <td colSpan={canEdit ? 6 : 5} className={styles.emptyCell}>
                                        <Loader2 className={styles.spinner} size={24} />
                                    </td>
                                </tr>
                            )}
                            {!isLoading && visible.length === 0 && (
                                <tr>
                                    <td colSpan={canEdit ? 6 : 5} className={styles.emptyCell}>
                                        {items.length === 0
                                            ? 'No ingredients yet — add the ones the recipes need, with what you pay for them.'
                                            : 'No ingredient matches.'}
                                    </td>
                                </tr>
                            )}
                            {visible.map((item) => (
                                <tr
                                    key={item.id}
                                    className={`${item.is_active ? '' : styles.rowInactive} ${form.id === item.id ? styles.rowActive : ''}`}
                                >
                                    <td className={styles.cellName}>
                                        <span className={styles.cellStrong}>{item.name}</span>
                                        <span className={styles.cellSub}>
                                            {item.category || 'Ungrouped'}
                                            {item.recipe_count > 0
                                                && ` · in ${item.recipe_count} recipe ${item.recipe_count === 1 ? 'line' : 'lines'}`}
                                        </span>
                                    </td>
                                    <td className={styles.cellMuted}>{item.unit_abbrev}</td>
                                    <td className={styles.cellNum}>
                                        <span className={styles.cellStrong}>{cost(item.avg_cost)}</span>
                                        <span className={styles.cellSub}>
                                            {item.avg_cost <= 0 ? (
                                                <span className={`${styles.chip} ${styles.chipWarn}`}>no cost</span>
                                            ) : item.has_receipts ? (
                                                <span className={`${styles.chip} ${styles.chipSuccess}`}>from receipts</span>
                                            ) : (
                                                <span className={styles.chip}>set by hand</span>
                                            )}
                                        </span>
                                    </td>
                                    <td className={styles.cellNum}>
                                        {formatNumber(item.on_hand, 3)}
                                    </td>
                                    <td className={`${styles.cellNum} ${styles.cellMuted}`}>
                                        {item.reorder_level > 0 ? formatNumber(item.reorder_level, 3) : '—'}
                                    </td>
                                    {canEdit && (
                                        <td className={styles.cellActions}>
                                            <span className={styles.rowActions}>
                                                <button
                                                    type="button"
                                                    className={`${styles.switch} ${item.is_active ? styles.switchOn : ''}`}
                                                    onClick={() => onToggle(item)}
                                                    disabled={busyId === item.id}
                                                    aria-label={item.is_active ? `Switch ${item.name} off` : `Switch ${item.name} on`}
                                                    title={item.is_active ? 'Active' : 'Switched off'}
                                                />
                                                <button
                                                    type="button"
                                                    className={styles.iconBtn}
                                                    onClick={() => openEdit(item)}
                                                    aria-label={`Edit ${item.name}`}
                                                >
                                                    <Pencil size={15} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                                    onClick={() => onDelete(item)}
                                                    disabled={busyId === item.id}
                                                    aria-label={`Delete ${item.name}`}
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            </span>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {canEdit && formOpen && (
                    <div className={styles.side}>
                        <form
                            className={styles.card}
                            onSubmit={(e) => { e.preventDefault(); submit(false) }}
                        >
                            <h2 className={styles.cardTitle}>
                                <Carrot size={17} aria-hidden="true" />
                                {form.id ? 'Edit ingredient' : 'New ingredient'}
                            </h2>

                            <div className={styles.field}>
                                <label className={`${styles.fieldLabel} ${styles.required}`} htmlFor="ing_name">
                                    Name
                                </label>
                                <input
                                    id="ing_name"
                                    ref={nameRef}
                                    className={styles.input}
                                    value={form.name}
                                    onChange={(e) => setField('name', e.target.value)}
                                    maxLength={191}
                                    autoComplete="off"
                                    placeholder="Chicken, boneless"
                                />
                            </div>

                            <div className={styles.fieldRow}>
                                <div className={styles.field}>
                                    <label className={styles.fieldLabel} htmlFor="ing_category">Category</label>
                                    <input
                                        id="ing_category"
                                        className={styles.input}
                                        value={form.category}
                                        onChange={(e) => setField('category', e.target.value)}
                                        list="ing_categories"
                                        maxLength={64}
                                        autoComplete="off"
                                        placeholder="Meat"
                                    />
                                    <datalist id="ing_categories">
                                        {categories.map((c) => <option key={c} value={c} />)}
                                    </datalist>
                                </div>
                                <div className={styles.field}>
                                    <label className={`${styles.fieldLabel} ${styles.required}`} htmlFor="ing_unit">
                                        Unit
                                    </label>
                                    <select
                                        id="ing_unit"
                                        className={styles.input}
                                        value={form.unit_id}
                                        onChange={(e) => setField('unit_id', e.target.value)}
                                    >
                                        <option value="">Pick a unit…</option>
                                        {units.map((u) => (
                                            <option key={u.id} value={u.id}>{u.name} ({u.abbrev})</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className={styles.fieldRow}>
                                <div className={styles.field}>
                                    {/* No asterisk: blank is a legal answer and
                                        means "not priced yet", which the list
                                        flags rather than hides. */}
                                    <label className={styles.fieldLabel} htmlFor="ing_cost">
                                        Cost per {unitOf(form.unit_id)}
                                    </label>
                                    <input
                                        id="ing_cost"
                                        className={`${styles.input} ${styles.inputNum}`}
                                        type="number"
                                        min="0"
                                        step="any"
                                        inputMode="decimal"
                                        value={form.avg_cost}
                                        onChange={(e) => setField('avg_cost', e.target.value)}
                                        placeholder="0"
                                    />
                                </div>
                                <div className={styles.field}>
                                    <label className={styles.fieldLabel} htmlFor="ing_reorder">
                                        Reorder at ({unitOf(form.unit_id)})
                                    </label>
                                    <input
                                        id="ing_reorder"
                                        className={`${styles.input} ${styles.inputNum}`}
                                        type="number"
                                        min="0"
                                        step="any"
                                        inputMode="decimal"
                                        value={form.reorder_level}
                                        onChange={(e) => setField('reorder_level', e.target.value)}
                                        placeholder="0"
                                    />
                                </div>
                            </div>

                            <label className={styles.checkLine}>
                                <input
                                    type="checkbox"
                                    checked={form.is_active}
                                    onChange={(e) => setField('is_active', e.target.checked)}
                                />
                                Active — offered when building a recipe
                            </label>

                            {override && (
                                <div className={`${styles.note} ${styles.noteWarn}`}>
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    <span>
                                        {override.text}. The next goods-in will recompute it anyway.
                                        <button
                                            type="button"
                                            className={local.linkBtn}
                                            onClick={() => submit(true)}
                                            disabled={saving}
                                        >
                                            Overwrite anyway
                                        </button>
                                    </span>
                                </div>
                            )}

                            <div className={`${styles.formActions} ${styles.formActionsSplit}`}>
                                <button type="button" className={styles.secondaryBtn} onClick={closeForm}>
                                    Done
                                </button>
                                <button type="submit" className={styles.primaryBtn} disabled={saving}>
                                    {saving
                                        ? <Loader2 size={15} className={styles.spinner} />
                                        : <Plus size={15} aria-hidden="true" />}
                                    {form.id ? 'Save changes' : 'Add and keep going'}
                                </button>
                            </div>

                            <span className={styles.hint}>
                                {form.id
                                    ? 'Saving returns the form to a fresh ingredient, keeping this category and unit.'
                                    : 'The form stays open and keeps the category and unit — type the next name and cost.'}
                            </span>
                        </form>
                    </div>
                )}
            </div>
        </div>
    )
}

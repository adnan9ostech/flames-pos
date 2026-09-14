'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import styles from '../menu.module.css'
import local from './recipes.module.css'
import { getRecipeBoard, getRecipe, saveRecipe, copyRecipe } from './actions'
import { saveIngredient } from '../ingredients/actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import { formatRupees } from '@/lib/money'
import {
    ChefHat, Search, X, Plus, Trash2, Save, Loader2, Copy, Carrot,
    AlertTriangle, CheckCircle2, Info,
} from 'lucide-react'

const BASE = ''
// The picker's last option: not an id, so it can never be saved as one.
const NEW_ING = '__new__'
const BASE_LABEL = 'Base recipe'
const labelOf = (variant) => variant || BASE_LABEL

// Recipe costs carry paisa: a Rs. 12.40 naan rounded to whole rupees prices
// a hundred a day wrong by sixty.
const cost = (n) => formatRupees(n, 2)

let lineKey = 0
const newLine = (seed = {}) => ({
    key: ++lineKey,
    inventory_item_id: seed.inventory_item_id ? String(seed.inventory_item_id) : '',
    qty: seed.qty !== undefined && seed.qty !== null ? String(seed.qty) : '',
})

const FILTERS = [
    ['uncosted', 'No recipe'],
    ['all', 'All dishes'],
    ['costed', 'Costed'],
]

export default function RecipesPage() {
    // useSearchParams needs a boundary; the dish deep-link is the whole point
    // of the parameter, so the fallback is the same shell without a dish.
    return (
        <Suspense fallback={(
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                </div>
            </div>
        )}
        >
            <RecipesScreen />
        </Suspense>
    )
}

function RecipesScreen() {
    const { can } = usePermissions()
    const canEdit = can('menu')
    const searchParams = useSearchParams()
    const deepLink = searchParams.get('dish')

    const [board, setBoard] = useState(null)
    const [loadError, setLoadError] = useState('')
    const [search, setSearch] = useState('')
    const [filter, setFilter] = useState('uncosted')
    const [categoryFilter, setCategoryFilter] = useState('all')

    const [selectedId, setSelectedId] = useState(null)
    const [activeVariant, setActiveVariant] = useState(BASE)
    // One draft per size, so switching tabs never loses what was typed and a
    // save can carry every size that changed.
    const [drafts, setDrafts] = useState({})
    const [dirty, setDirty] = useState(new Set())
    const [notes, setNotes] = useState('')
    const [notesDirty, setNotesDirty] = useState(false)
    const [loadingRecipe, setLoadingRecipe] = useState(false)
    const [saving, setSaving] = useState(false)
    const [copyOpen, setCopyOpen] = useState(false)
    /*
     * Adding an ingredient WITHOUT leaving the recipe.
     *
     * Building this menu's recipes means meeting an ingredient nobody has
     * typed yet roughly once a dish. The old answer was: leave, go to
     * Ingredients, add it, come back, find the dish again, find the line
     * again. A hundred and twenty-five times.
     *
     * `newFor` holds the key of the line that asked, so the created
     * ingredient drops straight into it.
     */
    const [newFor, setNewFor] = useState(null)
    const [newIng, setNewIng] = useState({ name: '', unit_id: '', avg_cost: '' })
    const [adding, setAdding] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })

    const deepLinkDone = useRef(false)

    useEffect(() => {
        getRecipeBoard().then((res) => {
            if (res.error) { setLoadError(res.error); return }
            setBoard(res.data)
            // "No recipe" is the right landing while there is a work list, and
            // an empty screen once there is not — which is exactly where the
            // Blink import leaves this. Show everything when nothing is owed.
            if (!res.data.dishes.some((d) => d.recipes.length === 0)) setFilter('all')
        })
    }, [])

    useEffect(() => {
        if (message.type !== 'success') return
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const ingredientById = useMemo(() => {
        const map = new Map()
        for (const i of board?.ingredients ?? []) map.set(String(i.id), i)
        return map
    }, [board])

    const selected = board?.dishes.find((d) => d.id === selectedId) ?? null

    /* Load one dish into the editor: every size's lines at once. */
    const openDish = useCallback(async (dish) => {
        setSelectedId(dish.id)
        setDrafts({})
        setDirty(new Set())
        setNotes('')
        setNotesDirty(false)
        setActiveVariant(BASE)
        setMessage({ type: '', text: '' })
        setLoadingRecipe(true)
        const res = await getRecipe(dish.id)
        setLoadingRecipe(false)
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
            return
        }
        const next = {}
        for (const line of res.data.lines) {
            (next[line.variant_name] ||= []).push(newLine(line))
        }
        setDrafts(next)
        setNotes(res.data.notes || '')
    }, [])

    // The dish editor links here with ?dish=<uuid>. Applied once, when the
    // board arrives; after that the URL follows the picker rather than
    // driving it, so a click never fights a navigation.
    useEffect(() => {
        if (!board || deepLinkDone.current) return
        deepLinkDone.current = true
        if (!deepLink) return
        const dish = board.dishes.find((d) => d.id === deepLink)
        if (dish) openDish(dish)
        else setMessage({ type: 'error', text: 'That dish is not on the menu any more' })
    }, [board, deepLink, openDish])

    const hasUnsaved = dirty.size > 0 || notesDirty

    const selectDish = (dish) => {
        if (dish.id === selectedId) return
        if (hasUnsaved && !window.confirm('Discard the unsaved recipe changes?')) return
        openDish(dish)
        // Shareable without a re-render: the deep link is an entry point, not
        // a second source of truth for what is on screen.
        window.history.replaceState(null, '', `/menu/recipes?dish=${dish.id}`)
    }

    /* ---- The work list ---- */

    const categories = useMemo(() => {
        const set = new Set()
        for (const d of board?.dishes ?? []) if (d.category_name) set.add(d.category_name)
        return [...set]
    }, [board])

    const stats = useMemo(() => {
        const dishes = board?.dishes ?? []
        const costed = dishes.filter((d) => d.recipes.length > 0)
        const sized = costed.reduce(
            (n, d) => n + d.recipes.filter((r) => r.variant_name !== BASE).length, 0,
        )
        return { total: dishes.length, costed: costed.length, sizeRecipes: sized }
    }, [board])

    const dishes = useMemo(() => {
        const term = search.trim().toLowerCase()
        const list = (board?.dishes ?? []).filter((d) => {
            const isCosted = d.recipes.length > 0
            if (filter === 'uncosted' && isCosted) return false
            if (filter === 'costed' && !isCosted) return false
            if (categoryFilter !== 'all' && d.category_name !== categoryFilter) return false
            if (!term) return true
            return d.name.toLowerCase().includes(term)
                || (d.category_name || '').toLowerCase().includes(term)
        })
        // Uncosted first inside the All tab: the gaps are the job, and a
        // hundred costed dishes above them is where a work list goes to die.
        if (filter !== 'all') return list
        return [...list].sort((a, b) => (a.recipes.length > 0) - (b.recipes.length > 0))
    }, [board, search, filter, categoryFilter])

    /* ---- The editor ---- */

    const sizes = useMemo(() => selected?.variants ?? [], [selected])
    const priceOf = (variant) => {
        if (!variant) {
            // A base recipe has to cover every size that has none of its own,
            // so the honest comparison is the cheapest of them — the thinnest
            // margin it is being asked to survive.
            if (sizes.length > 0) return Math.min(...sizes.map((v) => Number(v.price)))
            return Number(selected?.price ?? 0)
        }
        return Number(sizes.find((v) => v.name === variant)?.price ?? selected?.price ?? 0)
    }

    // Sizes the dish no longer offers but whose lines are still stored. They
    // cost nothing (nothing sells under that name), but leaving them
    // invisible means nobody ever clears them.
    const orphanVariants = useMemo(() => {
        const known = new Set(sizes.map((v) => v.name))
        return Object.keys(drafts).filter((v) => v !== BASE && !known.has(v))
    }, [drafts, sizes])

    const tabs = useMemo(
        () => [BASE, ...sizes.map((v) => v.name), ...orphanVariants],
        [sizes, orphanVariants],
    )

    const linesOf = (variant) => drafts[variant] ?? []

    const costOf = (variant) => linesOf(variant).reduce((sum, line) => {
        const ing = ingredientById.get(line.inventory_item_id)
        const qty = Number(line.qty)
        return sum + (ing && Number.isFinite(qty) && qty > 0 ? qty * ing.avg_cost : 0)
    }, 0)

    // The rule, in code: a size uses its own lines when it has any, else the
    // base. The same CASE the consumption engine and both reports run.
    const effectiveVariant = (variant) => (linesOf(variant).length > 0 ? variant : BASE)

    const activeLines = linesOf(activeVariant)
    const activeCost = costOf(activeVariant)
    const activePrice = priceOf(activeVariant)
    const activeMargin = activePrice - activeCost
    const activeMarginPct = activePrice > 0 ? (activeMargin / activePrice) * 100 : null

    const markDirty = (variant) => setDirty((prev) => {
        if (prev.has(variant)) return prev
        const next = new Set(prev)
        next.add(variant)
        return next
    })

    const setLines = (variant, updater) => {
        setDrafts((prev) => ({ ...prev, [variant]: updater(prev[variant] ?? []) }))
        markDirty(variant)
    }

    const setLineField = (variant, key, field, value) =>
        setLines(variant, (rows) => rows.map((l) => (l.key === key ? { ...l, [field]: value } : l)))

    const addLine = (variant) => setLines(variant, (rows) => [...rows, newLine()])
    const removeLine = (variant, key) => setLines(variant, (rows) => rows.filter((l) => l.key !== key))

    /*
     * Create the ingredient the recipe just asked for, and drop it into the
     * line that asked. The cost is optional here on purpose: receiving sets
     * the real one, and stopping to ask "what does a kilo of this cost" is
     * exactly the interruption this is meant to remove.
     */
    const createIngredient = async (variant, lineKey) => {
        setAdding(true)
        const res = await saveIngredient({
            name: newIng.name,
            unit_id: newIng.unit_id,
            avg_cost: newIng.avg_cost === '' ? 0 : newIng.avg_cost,
            reorder_level: 0,
            is_active: true,
        })
        setAdding(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }

        const row = res.data
        const added = {
            id: row.id,
            name: row.name,
            category: row.category ?? null,
            avg_cost: Number(row.avg_cost) || 0,
            unit_abbrev: row.unit_abbrev,
        }
        // Into the board's own list, sorted the way the board sorts, so the
        // dropdown is not suddenly in a different order from the screen.
        setBoard((prev) => (prev ? {
            ...prev,
            ingredients: [...prev.ingredients, added].sort((a, b) => a.name.localeCompare(b.name)),
        } : prev))
        setLineField(variant, lineKey, 'inventory_item_id', String(row.id))
        setNewFor(null)
        setNewIng({ name: '', unit_id: '', avg_cost: '' })
    }

    const submit = async () => {
        if (!selected) return
        setSaving(true)
        setMessage({ type: '', text: '' })
        // Every size that changed goes in one call; notes alone still needs a
        // size in the payload, so the active tab rides along unchanged.
        const changed = dirty.size > 0 ? [...dirty] : [activeVariant]
        const res = await saveRecipe({
            menuItemId: selected.id,
            notes,
            variants: changed.map((variant) => ({
                variantName: variant,
                lines: linesOf(variant).map((l) => ({
                    inventory_item_id: l.inventory_item_id, qty: l.qty,
                })),
            })),
        })
        setSaving(false)
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
            return
        }
        setDirty(new Set())
        setNotesDirty(false)
        setBoard((prev) => prev && {
            ...prev,
            dishes: prev.dishes.map((d) =>
                (d.id === selected.id ? { ...d, recipes: res.data.recipes } : d)),
        })
        const saved = res.data.saved.find((s) => s.variant_name === activeVariant)
            ?? res.data.saved[0]
        setMessage({
            type: 'success',
            text: saved.line_count > 0
                ? `${labelOf(saved.variant_name)} saved — ${cost(saved.unit_cost)} a portion`
                : `${labelOf(saved.variant_name)} cleared`,
        })
    }

    const afterCopy = (result) => {
        setBoard((prev) => prev && {
            ...prev,
            dishes: prev.dishes.map((d) => {
                if (d.id !== result.menu_item_id) return d
                const rest = d.recipes.filter((r) => r.variant_name !== result.variant_name)
                return {
                    ...d,
                    recipes: [...rest, {
                        variant_name: result.variant_name,
                        line_count: result.line_count,
                        unit_cost: result.unit_cost,
                    }],
                }
            }),
        })
        setCopyOpen(false)
        setMessage({
            type: 'success',
            text: `${result.dish} — ${labelOf(result.variant_name)} now has ${result.line_count} `
                + `${result.line_count === 1 ? 'line' : 'lines'} at ${cost(result.unit_cost)}`,
        })
        if (result.menu_item_id === selectedId && selected) openDish(selected)
    }

    if (loadError) {
        return (
            <div className={styles.container}>
                <Header />
                <div className={`${styles.note} ${styles.noteError}`}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {loadError}
                </div>
            </div>
        )
    }

    if (!board) {
        return (
            <div className={styles.container}>
                <Header />
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading the menu…</p>
                </div>
            </div>
        )
    }

    const noIngredients = board.ingredients.length === 0

    return (
        <div className={styles.container}>
            <Header />

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

            {noIngredients && (
                <div className={`${styles.note} ${styles.noteWarn}`}>
                    <Carrot size={16} aria-hidden="true" />
                    <span>
                        There are no ingredients yet, so every recipe would cost zero.{' '}
                        <Link href="/menu/ingredients" className={local.inlineLink}>
                            Add them with their prices first
                        </Link>.
                    </span>
                </div>
            )}

            <div className={styles.statsRow}>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><ChefHat size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Dishes costed</div>
                        <div className={styles.statValue}>
                            {stats.costed} of {stats.total}
                        </div>
                        <div className={styles.statHint}>Every other dish costs zero on the reports</div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={`${styles.statIcon} ${stats.costed < stats.total ? styles.warnIcon : ''}`}>
                        <AlertTriangle size={20} />
                    </div>
                    <div>
                        <div className={styles.statLabel}>Still to build</div>
                        <div className={styles.statValue}>{stats.total - stats.costed}</div>
                        <div className={styles.statHint}>Copy a near neighbour, then edit it</div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><Copy size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Sizes with their own</div>
                        <div className={styles.statValue}>{stats.sizeRecipes}</div>
                        <div className={styles.statHint}>The rest cost at their dish&apos;s base</div>
                    </div>
                </div>
            </div>

            <div className={styles.layoutWide}>
                {/* ===== Dish picker — the work list ===== */}
                <div className={local.picker}>
                    <div className={styles.searchBox}>
                        <Search size={15} aria-hidden="true" />
                        <input
                            type="search"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Find a dish"
                            aria-label="Search dishes"
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

                    <div className={styles.filterTabs}>
                        {FILTERS.map(([key, label]) => (
                            <button
                                key={key}
                                type="button"
                                className={`${styles.filterTab} ${filter === key ? styles.filterActive : ''}`}
                                onClick={() => setFilter(key)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <select
                        className={styles.select}
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        aria-label="Filter by category"
                    >
                        <option value="all">All categories</option>
                        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>

                    <span className={styles.count}>{dishes.length} shown</span>

                    <div className={local.pickerList}>
                        {dishes.map((dish) => {
                            const costed = dish.recipes.length > 0
                            const own = dish.recipes.filter((r) => r.variant_name !== BASE).length
                            return (
                                <button
                                    key={dish.id}
                                    type="button"
                                    className={`${local.dishRow} ${dish.id === selectedId ? local.dishActive : ''}`}
                                    onClick={() => selectDish(dish)}
                                >
                                    <span
                                        className={`${local.dot} ${costed ? local.dotOn : ''}`}
                                        aria-hidden="true"
                                    />
                                    <span className={local.dishMain}>
                                        <span className={local.dishName}>{dish.name}</span>
                                        <span className={local.dishMeta}>
                                            {dish.category_name || 'Uncategorised'}
                                            {dish.variants.length > 0 && ` · ${dish.variants.length} sizes`}
                                            {own > 0 && ` · ${own} sized ${own === 1 ? 'recipe' : 'recipes'}`}
                                        </span>
                                    </span>
                                    <span className={local.dishState}>
                                        {costed ? cost(dish.recipes.find((r) => r.variant_name === BASE)?.unit_cost
                                            ?? dish.recipes[0].unit_cost) : 'no recipe'}
                                    </span>
                                </button>
                            )
                        })}
                        {dishes.length === 0 && (
                            <p className={local.emptyList}>
                                {filter === 'uncosted'
                                    ? 'Every dish here has a recipe.'
                                    : 'No dish matches.'}
                            </p>
                        )}
                    </div>
                </div>

                {/* ===== Recipe editor ===== */}
                <div className={styles.card}>
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
                            <div className={styles.sectionTitle}>
                                <span>
                                    {selected.name}
                                    <span className={styles.cellSub}>
                                        {selected.category_name || 'Uncategorised'}
                                    </span>
                                </span>
                                {canEdit && (
                                    <span className={styles.headerActions}>
                                        <button
                                            type="button"
                                            className={styles.secondaryBtn}
                                            onClick={() => {
                                                if (hasUnsaved) {
                                                    setMessage({
                                                        type: 'error',
                                                        text: 'Save or discard this recipe before copying over it',
                                                    })
                                                    return
                                                }
                                                setCopyOpen(true)
                                            }}
                                        >
                                            <Copy size={15} aria-hidden="true" />
                                            Copy a recipe
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.primaryBtn}
                                            onClick={submit}
                                            disabled={saving || !hasUnsaved}
                                        >
                                            {saving
                                                ? <Loader2 size={15} className={styles.spinner} />
                                                : <Save size={15} aria-hidden="true" />}
                                            {saving ? 'Saving…' : dirty.size > 1 ? `Save ${dirty.size} sizes` : 'Save recipe'}
                                        </button>
                                    </span>
                                )}
                            </div>

                            {tabs.length > 1 && (
                                <>
                                    <div className={styles.segments} role="tablist" aria-label="Recipe by size">
                                        {tabs.map((variant) => (
                                            <button
                                                key={variant || '__base'}
                                                type="button"
                                                role="tab"
                                                aria-selected={variant === activeVariant}
                                                className={`${styles.segment} ${variant === activeVariant ? styles.segmentActive : ''}`}
                                                onClick={() => setActiveVariant(variant)}
                                            >
                                                {labelOf(variant)}
                                                {linesOf(variant).length > 0 && (
                                                    <span className={styles.segmentDot} aria-hidden="true" />
                                                )}
                                            </button>
                                        ))}
                                    </div>

                                    <div className={local.rule}>
                                        <Info size={15} aria-hidden="true" className={local.ruleIcon} />
                                        <p>
                                            A sold portion uses <strong>its own size&apos;s lines when that
                                            size has any</strong>, otherwise the base. So the base alone
                                            costs every size — give a size its own lines only when it
                                            genuinely differs.
                                            {activeVariant !== BASE && (
                                                linesOf(activeVariant).length > 0
                                                    ? ` ${activeVariant} is costed on these lines.`
                                                    : ` ${activeVariant} has none of its own, so it costs at the base:`
                                                      + ` ${cost(costOf(BASE))}.`
                                            )}
                                        </p>
                                    </div>
                                </>
                            )}

                            {orphanVariants.includes(activeVariant) && (
                                <div className={`${styles.note} ${styles.noteWarn}`}>
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    {selected.name} no longer offers a &quot;{activeVariant}&quot; size, so these
                                    lines cost nothing. Clear them and save to remove them.
                                </div>
                            )}

                            <div className={styles.costRow}>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>Recipe cost</div>
                                    <div className={styles.costValue}>{cost(activeCost)}</div>
                                </div>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>
                                        {activeVariant
                                            ? `${activeVariant} price`
                                            : sizes.length > 0 ? 'Smallest size price' : 'Sale price'}
                                    </div>
                                    <div className={styles.costValue}>{formatRupees(activePrice)}</div>
                                </div>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>Margin</div>
                                    <div className={`${styles.costValue} ${activeMargin < 0 ? styles.negative : ''}`}>
                                        {formatRupees(activeMargin)}
                                        {activeMarginPct !== null && (
                                            <span className={styles.marginPct}>
                                                {activeMarginPct.toFixed(0)}%
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Whole-dish answer: what every size costs once the
                                fallback is applied. The reason a size needs its
                                own recipe shows up here as a margin nobody meant. */}
                            {sizes.length > 0 && (
                                <div className={styles.listWrap}>
                                    <table className={`${styles.table} ${styles.tableNarrow}`}>
                                        <thead>
                                            <tr>
                                                <th>Size</th>
                                                <th>Costs at</th>
                                                <th className={styles.alignRight}>Cost</th>
                                                <th className={styles.alignRight}>Price</th>
                                                <th className={styles.alignRight}>Margin</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {sizes.map((size) => {
                                                const from = effectiveVariant(size.name)
                                                const c = costOf(from)
                                                const p = Number(size.price)
                                                const m = p - c
                                                return (
                                                    <tr
                                                        key={size.name}
                                                        className={size.name === activeVariant ? styles.rowActive : ''}
                                                    >
                                                        <td className={styles.cellStrong}>{size.name}</td>
                                                        <td className={styles.cellMuted}>
                                                            {from === size.name ? 'its own lines' : BASE_LABEL.toLowerCase()}
                                                        </td>
                                                        <td className={styles.cellNum}>{cost(c)}</td>
                                                        <td className={styles.cellNum}>{formatRupees(p)}</td>
                                                        <td className={`${styles.cellNum} ${m < 0 ? styles.negative : ''}`}>
                                                            {formatRupees(m)}
                                                            <span className={styles.marginPct}>
                                                                {p > 0 ? `${((m / p) * 100).toFixed(0)}%` : '—'}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className={styles.listWrap}>
                                <table className={`${styles.table} ${styles.tableNarrow}`}>
                                    <thead>
                                        <tr>
                                            <th>Ingredient</th>
                                            <th className={styles.alignRight}>Qty</th>
                                            <th>Unit</th>
                                            <th className={styles.alignRight}>Cost per unit</th>
                                            <th className={styles.alignRight}>Line cost</th>
                                            {canEdit && <th className={styles.cellActions} />}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {activeLines.map((line) => {
                                            const ing = ingredientById.get(line.inventory_item_id)
                                            const qty = Number(line.qty)
                                            const lineCost = ing && Number.isFinite(qty) && qty > 0
                                                ? qty * ing.avg_cost : 0
                                            return (
                                              <Fragment key={line.key}>
                                                <tr>
                                                    <td>
                                                        <select
                                                            className={`${styles.input} ${styles.inputSm}`}
                                                            value={line.inventory_item_id}
                                                            onChange={(e) => {
                                                                if (e.target.value === NEW_ING) {
                                                                    setNewFor(line.key)
                                                                    return
                                                                }
                                                                setLineField(
                                                                    activeVariant, line.key,
                                                                    'inventory_item_id', e.target.value,
                                                                )
                                                            }}
                                                            disabled={!canEdit}
                                                            aria-label="Ingredient"
                                                        >
                                                            <option value="">Ingredient…</option>
                                                            {board.ingredients.map((i) => (
                                                                <option key={i.id} value={i.id}>
                                                                    {i.name} ({i.unit_abbrev})
                                                                </option>
                                                            ))}
                                                            <option value={NEW_ING}>＋ New ingredient…</option>
                                                        </select>
                                                    </td>
                                                    <td className={local.qtyCell}>
                                                        <input
                                                            className={`${styles.input} ${styles.inputSm} ${styles.inputNum}`}
                                                            type="number"
                                                            min="0"
                                                            step="any"
                                                            inputMode="decimal"
                                                            value={line.qty}
                                                            onChange={(e) => setLineField(
                                                                activeVariant, line.key, 'qty', e.target.value,
                                                            )}
                                                            placeholder="0"
                                                            disabled={!canEdit}
                                                            aria-label="Quantity"
                                                        />
                                                    </td>
                                                    <td className={styles.cellMuted}>{ing?.unit_abbrev || '—'}</td>
                                                    <td className={styles.cellNum}>
                                                        {ing ? cost(ing.avg_cost) : '—'}
                                                    </td>
                                                    <td className={`${styles.cellNum} ${styles.cellStrong}`}>
                                                        {cost(lineCost)}
                                                    </td>
                                                    {canEdit && (
                                                        <td className={styles.cellActions}>
                                                            <button
                                                                type="button"
                                                                className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                                                onClick={() => removeLine(activeVariant, line.key)}
                                                                aria-label="Remove line"
                                                            >
                                                                <Trash2 size={15} />
                                                            </button>
                                                        </td>
                                                    )}
                                                </tr>

                                                {/*
                                                  * The new ingredient, right where it was
                                                  * missed. Name and unit only — the rate is
                                                  * what receiving sets, and stopping to ask
                                                  * for it is the interruption this row exists
                                                  * to remove.
                                                  */}
                                                {newFor === line.key && (
                                                    <tr className={local.newIngRow}>
                                                        <td colSpan={canEdit ? 6 : 5}>
                                                            <div className={local.newIngForm}>
                                                                <input
                                                                    className={`${styles.input} ${styles.inputSm}`}
                                                                    placeholder="Ingredient name"
                                                                    value={newIng.name}
                                                                    onChange={(e) => setNewIng((f) => ({ ...f, name: e.target.value }))}
                                                                    autoFocus
                                                                />
                                                                <select
                                                                    className={`${styles.input} ${styles.inputSm}`}
                                                                    value={newIng.unit_id}
                                                                    onChange={(e) => setNewIng((f) => ({ ...f, unit_id: e.target.value }))}
                                                                    aria-label="Unit"
                                                                >
                                                                    <option value="">Unit…</option>
                                                                    {(board.units ?? []).map((u) => (
                                                                        <option key={u.id} value={u.id}>{u.name} ({u.abbrev})</option>
                                                                    ))}
                                                                </select>
                                                                <input
                                                                    className={`${styles.input} ${styles.inputSm} ${styles.inputNum}`}
                                                                    type="number"
                                                                    min="0"
                                                                    step="any"
                                                                    placeholder="Rate (optional)"
                                                                    value={newIng.avg_cost}
                                                                    onChange={(e) => setNewIng((f) => ({ ...f, avg_cost: e.target.value }))}
                                                                />
                                                                <button
                                                                    type="button"
                                                                    className={styles.primaryBtn}
                                                                    disabled={adding || !newIng.name.trim() || !newIng.unit_id}
                                                                    onClick={() => createIngredient(activeVariant, line.key)}
                                                                >
                                                                    {adding ? 'Adding…' : 'Add & use'}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className={styles.secondaryBtn}
                                                                    onClick={() => setNewFor(null)}
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                              </Fragment>
                                            )
                                        })}
                                        {activeLines.length === 0 && (
                                            <tr>
                                                <td colSpan={canEdit ? 6 : 5} className={styles.emptyCell}>
                                                    {activeVariant === BASE
                                                        ? 'No ingredients yet — this dish consumes no stock when sold.'
                                                        : `No lines of its own — ${activeVariant} costs at the base recipe.`}
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            {canEdit && (
                                <button
                                    type="button"
                                    className={`${styles.secondaryBtn} ${styles.addLineBtn}`}
                                    onClick={() => addLine(activeVariant)}
                                >
                                    <Plus size={15} aria-hidden="true" />
                                    Add ingredient
                                </button>
                            )}

                            <div className={styles.field}>
                                <label className={styles.fieldLabel} htmlFor="recipe_notes">
                                    Prep notes
                                </label>
                                <input
                                    id="recipe_notes"
                                    className={styles.input}
                                    value={notes}
                                    onChange={(e) => { setNotes(e.target.value); setNotesDirty(true) }}
                                    maxLength={191}
                                    placeholder="For the kitchen (optional)"
                                    disabled={!canEdit}
                                />
                                <span className={styles.hint}>
                                    Notes belong to the dish, not to one size, and are kept while the
                                    dish has any recipe lines at all.
                                </span>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {copyOpen && selected && (
                <CopyDialog
                    board={board}
                    dish={selected}
                    variant={activeVariant}
                    onClose={() => setCopyOpen(false)}
                    onDone={afterCopy}
                />
            )}
        </div>
    )
}

function Header() {
    return (
        <div className={styles.header}>
            <div>
                <h1 className={styles.title}>Recipes</h1>
                <p className={styles.subtitle}>
                    What one sold portion consumes, per size, priced at what the ingredients cost.
                </p>
            </div>
        </div>
    )
}

/*
 * Copy lines from one (dish, size) onto another. Both ends are free, so this
 * covers "the Full is the Half doubled" and "the Beef version is the Chicken
 * version" with one dialog. The target's existing lines are named before
 * they are replaced — and the server refuses the replacement unless this
 * dialog has said so, so a stale screen cannot overwrite by accident.
 */
function CopyDialog({ board, dish, variant, onClose, onDone }) {
    const withLines = useMemo(
        () => board.dishes.filter((d) => d.recipes.length > 0),
        [board],
    )
    const [fromDishId, setFromDishId] = useState(
        dish.recipes.length > 0 ? dish.id : (withLines[0]?.id ?? ''),
    )
    const fromDish = board.dishes.find((d) => d.id === fromDishId)
    const fromOptions = fromDish?.recipes ?? []
    const [fromVariant, setFromVariant] = useState(
        fromOptions.some((r) => r.variant_name === variant) ? variant : (fromOptions[0]?.variant_name ?? BASE),
    )
    const [toDishId, setToDishId] = useState(dish.id)
    const [toVariant, setToVariant] = useState(variant === BASE ? (dish.variants[0]?.name ?? BASE) : BASE)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const toDish = board.dishes.find((d) => d.id === toDishId)
    const toOptions = [BASE, ...(toDish?.variants ?? []).map((v) => v.name)]
    const source = fromOptions.find((r) => r.variant_name === fromVariant)
    const targetExisting = toDish?.recipes.find((r) => r.variant_name === toVariant)

    const pickFromDish = (id) => {
        setFromDishId(id)
        const next = board.dishes.find((d) => d.id === id)?.recipes ?? []
        setFromVariant(next[0]?.variant_name ?? BASE)
    }
    const pickToDish = (id) => {
        setToDishId(id)
        setToVariant(BASE)
    }

    const run = async () => {
        setBusy(true)
        setError('')
        const res = await copyRecipe({
            fromMenuItemId: fromDishId,
            fromVariant,
            toMenuItemId: toDishId,
            toVariant,
            overwrite: (targetExisting?.line_count ?? 0) > 0,
        })
        setBusy(false)
        if (res.error) setError(res.error)
        else onDone(res.data)
    }

    return (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-label="Copy a recipe">
            <div className={`${styles.modal} ${styles.modalWide}`}>
                <h2 className={styles.modalTitle}>Copy a recipe</h2>
                <p className={styles.modalBody}>
                    Building a hundred recipes by hand is the real work here. Copy the nearest one
                    and edit the difference.
                </p>

                <div className={styles.fieldRow}>
                    <div className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor="copy_from_dish">Copy from</label>
                        <select
                            id="copy_from_dish"
                            className={styles.input}
                            value={fromDishId}
                            onChange={(e) => pickFromDish(e.target.value)}
                        >
                            {withLines.length === 0 && <option value="">No recipe exists yet</option>}
                            {withLines.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name}{d.category_name ? ` — ${d.category_name}` : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor="copy_from_variant">Its size</label>
                        <select
                            id="copy_from_variant"
                            className={styles.input}
                            value={fromVariant}
                            onChange={(e) => setFromVariant(e.target.value)}
                        >
                            {fromOptions.map((r) => (
                                <option key={r.variant_name || '__base'} value={r.variant_name}>
                                    {labelOf(r.variant_name)} — {r.line_count} {r.line_count === 1 ? 'line' : 'lines'}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                <div className={styles.fieldRow}>
                    <div className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor="copy_to_dish">Onto</label>
                        <select
                            id="copy_to_dish"
                            className={styles.input}
                            value={toDishId}
                            onChange={(e) => pickToDish(e.target.value)}
                        >
                            {board.dishes.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name}{d.category_name ? ` — ${d.category_name}` : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor="copy_to_variant">Its size</label>
                        <select
                            id="copy_to_variant"
                            className={styles.input}
                            value={toVariant}
                            onChange={(e) => setToVariant(e.target.value)}
                        >
                            {toOptions.map((name) => (
                                <option key={name || '__base'} value={name}>{labelOf(name)}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {source && (
                    <p className={styles.modalBody}>
                        {source.line_count} {source.line_count === 1 ? 'line' : 'lines'},{' '}
                        {cost(source.unit_cost)} a portion at today&apos;s ingredient costs. Quantities
                        copy across unchanged — a Full that is a Half and a half still needs editing after.
                    </p>
                )}

                {targetExisting && targetExisting.line_count > 0 && (
                    <div className={`${styles.note} ${styles.noteWarn}`}>
                        <AlertTriangle size={16} aria-hidden="true" />
                        {toDish.name} — {labelOf(toVariant)} already has {targetExisting.line_count}{' '}
                        {targetExisting.line_count === 1 ? 'line' : 'lines'} at {cost(targetExisting.unit_cost)}.
                        Copying replaces them.
                    </div>
                )}

                {error && (
                    <div className={`${styles.note} ${styles.noteError}`}>
                        <AlertTriangle size={16} aria-hidden="true" />
                        {error}
                    </div>
                )}

                <div className={styles.modalActions}>
                    <button type="button" className={styles.secondaryBtn} onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={styles.primaryBtn}
                        onClick={run}
                        disabled={busy || !source}
                    >
                        {busy ? <Loader2 size={15} className={styles.spinner} /> : <Copy size={15} aria-hidden="true" />}
                        {targetExisting && targetExisting.line_count > 0
                            ? `Replace ${targetExisting.line_count} ${targetExisting.line_count === 1 ? 'line' : 'lines'}`
                            : 'Copy lines'}
                    </button>
                </div>
            </div>
        </div>
    )
}

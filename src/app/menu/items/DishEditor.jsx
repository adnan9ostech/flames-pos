'use client';

/*
 * One dish, whole: basics, photo, price or sizes, modifiers, and what its
 * recipe costs. The same component serves /menu/items/new and
 * /menu/items/[id] — a new dish is an empty one, not a different screen, and
 * two forms for one object is two places for the size rules to drift.
 *
 * Validation runs twice on purpose. cleanVariants here gives the person an
 * answer while they type; the same function runs in the server action, which
 * is the one that decides. Numeric fields hold the text that was typed, so
 * "1" on the way to "1250" is never rewritten under the cursor.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from '../menu.module.css';
import own from '../dishes.module.css';
import ImageField from '../ImageField';
import { saveDish } from './actions';
import { cleanVariants, listPrice, MAX_VARIANTS } from '@/lib/menu/rules.mjs';
import { formatRupees } from '@/lib/money';
import {
    AlertTriangle, CheckCircle2, ChefHat, Loader2, Plus, Save, Trash2, Utensils,
} from 'lucide-react';

/* React keys for the size rows, shared by the module so a row keeps its
 * identity while its name is being typed. */
let nextKey = 1;
const newRow = (name = '', price = '') => ({ key: nextKey++, name, price });

const CUSTOM = 'custom';

const initialForm = (dish) => ({
    name: dish?.name || '',
    category_id: dish?.category_id || '',
    description: dish?.description || '',
    unit: dish?.unit || '',
    is_available: dish ? dish.is_available : true,
    image: dish?.image || '',
    priceMode: dish?.variants?.length ? 'sizes' : 'single',
    price: dish && !dish.variants?.length ? String(dish.price) : '',
    setId: dish?.variants?.length ? (dish.variation_set_id || CUSTOM) : '',
    rows: (dish?.variants || []).map((v) => newRow(v.name, String(v.price))),
    modifiers: [...(dish?.modifiers || [])],
});

/* Exactly what the server action is sent — and, stringified, what "unsaved
 * changes" is measured against. */
const payloadOf = (form, dish) => ({
    id: dish?.id,
    name: form.name.trim(),
    category_id: form.category_id,
    description: form.description.trim(),
    unit: form.unit.trim(),
    is_available: form.is_available,
    image: form.image || '',
    priceMode: form.priceMode,
    price: form.priceMode === 'single' ? form.price : '',
    variation_set_id: form.priceMode === 'sizes' && form.setId !== CUSTOM ? form.setId : null,
    variants: form.priceMode === 'sizes'
        ? form.rows.map((r) => ({ name: r.name.trim(), price: String(r.price).trim() }))
        : [],
});

export default function DishEditor({ dish = null, formData, onSaved, onDirtyChange }) {
    const [form, setForm] = useState(() => initialForm(dish));
    const [baseline, setBaseline] = useState(() => JSON.stringify(payloadOf(initialForm(dish), dish)));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const activeSets = useMemo(
        () => formData.variationSets.filter((s) => s.is_active || s.id === dish?.variation_set_id),
        [formData.variationSets, dish],
    );

    const payload = payloadOf(form, dish);
    const dirty = JSON.stringify(payload) !== baseline;

    useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

    /* The browser's own guard. In-app navigation is guarded by the page,
     * which owns the links out of here. */
    useEffect(() => {
        if (!dirty) return undefined;
        const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);

    /*
     * The size list as it will actually be stored: cleanVariants sorts by
     * price, and if that moves a row the names and the prices disagree — a
     * Full cheaper than a Half. Shown before saving, refused on saving.
     */
    const sizes = useMemo(() => {
        const empty = { list: [], error: '', descending: '', unpriced: false, order: '', moved: false };
        if (form.priceMode !== 'sizes') return empty;
        const typed = form.rows.filter((r) => r.name.trim() || String(r.price).trim());

        /*
         * A blank box is a price not typed yet, and cleanVariants says so in
         * its own words ("The price for Half must be a number"). Half-way
         * through filling a fresh set that reads as a fault rather than as
         * work in progress, so the half-filled state gets its own line.
         */
        if (typed.length > 0 && typed.some((r) => String(r.price).trim() === '')) {
            return { ...empty, unpriced: true };
        }

        try {
            const list = cleanVariants(typed.map((r) => ({ name: r.name, price: r.price })));
            const order = list.map((v) => v.name).join(' → ');

            // Prices must not fall as the sizes grow. Equal prices are left
            // alone — pointless, but not wrong, and refusing them would trap
            // anyone whose set fixes the order.
            const priceOf = new Map(list.map((v) => [v.name.toLowerCase(), v.price]));
            let previous = -Infinity;
            let descending = '';
            for (const r of typed) {
                const rowName = r.name.trim().replace(/\s+/g, ' ');
                const rowPrice = priceOf.get(rowName.toLowerCase());
                if (!descending && rowPrice < previous) descending = rowName;
                previous = rowPrice;
            }

            const typedOrder = typed.map((r) => r.name.trim().replace(/\s+/g, ' ')).join(' → ');
            return { list, error: '', descending, unpriced: false, order, moved: typedOrder !== order };
        } catch (e) {
            return { ...empty, error: e.message };
        }
    }, [form.priceMode, form.rows]);

    const tilePrice = form.priceMode === 'sizes'
        ? listPrice(0, sizes.list)
        : Number(form.price) || 0;

    // The thinnest margin the dish earns: the smallest size, because that is
    // the one a base recipe is most likely to be costing.
    const marginPrice = form.priceMode === 'sizes' ? (sizes.list[0]?.price ?? 0) : tilePrice;

    /*
     * "Channay" is deliberately two rows in two categories, so a repeated
     * name is a warning and never a refusal — but a second "Chicken Karahi"
     * in the same category is almost always a slip.
     */
    const nameClash = useMemo(() => {
        const wanted = form.name.trim().toLowerCase();
        if (!wanted) return null;
        const other = formData.dishNames.find(
            (d) => d.id !== dish?.id && d.name.trim().toLowerCase() === wanted,
        );
        if (!other) return null;
        const where = formData.categories.find((c) => c.id === other.category_id)?.name;
        return other.category_id === form.category_id
            ? `There is already a "${other.name}" in this category: check you are not adding it twice.`
            : `There is already a "${other.name}"${where ? ` in ${where}` : ''}. Two categories may each carry one; the till shows the category under the tile.`;
    }, [form.name, form.category_id, formData.dishNames, formData.categories, dish]);

    const setMode = (mode) => setForm((f) => {
        if (mode === f.priceMode) return f;
        if (mode === 'single') return { ...f, priceMode: 'single' };
        if (f.rows.length > 0) return { ...f, priceMode: 'sizes' };
        const first = activeSets[0];
        return first
            ? { ...f, priceMode: 'sizes', setId: first.id, rows: first.options.map((o) => newRow(o)) }
            : { ...f, priceMode: 'sizes', setId: CUSTOM, rows: [newRow(), newRow()] };
    });

    /* Picking a set replaces the NAMES and their order; prices already typed
     * for a size of the same name survive the swap. */
    const chooseSet = (value) => setForm((f) => {
        if (value === CUSTOM) return { ...f, setId: CUSTOM };
        const set = formData.variationSets.find((s) => s.id === value);
        if (!set) return { ...f, setId: value };
        const priced = new Map(f.rows.map((r) => [r.name.trim().toLowerCase(), r.price]));
        return {
            ...f,
            setId: value,
            rows: set.options.map((o) => newRow(o, priced.get(o.toLowerCase()) ?? '')),
        };
    });

    const patchRow = (key, field, value) => setForm((f) => ({
        ...f,
        rows: f.rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)),
    }));

    const toggleModifier = (key) => setForm((f) => ({
        ...f,
        modifiers: f.modifiers.includes(key)
            ? f.modifiers.filter((k) => k !== key)
            : [...f.modifiers, key],
    }));

    const submit = async (e) => {
        e.preventDefault();
        setError('');
        if (form.priceMode === 'sizes') {
            if (sizes.error) { setError(sizes.error); return; }
            if (sizes.unpriced) { setError('Every size needs a price.'); return; }
            if (sizes.descending) {
                setError(`${sizes.descending} is priced below the size listed before it. Sizes run smallest to largest.`);
                return;
            }
        }
        setBusy(true);
        const res = await saveDish(payload);
        setBusy(false);
        if (res.error) { setError(res.error); return; }
        setBaseline(JSON.stringify(payloadOf(form, res.data.dish)));
        onSaved?.(res.data);
    };

    const recipe = formData.recipe;
    const hasBaseRecipe = Boolean(recipe && recipe.base_lines > 0);
    const cost = hasBaseRecipe ? Number(recipe.base_cost) : 0;
    const margin = marginPrice - cost;
    const marginPct = marginPrice > 0 ? Math.round((margin / marginPrice) * 100) : 0;

    return (
        <form className={styles.editorGrid} onSubmit={submit}>
            <div className={own.editorCol}>
                {error && (
                    <div role="alert" className={`${styles.note} ${styles.noteError}`} style={{ marginBottom: 0 }}>
                        <AlertTriangle size={16} aria-hidden="true" /> {error}
                    </div>
                )}

                {/* ---- 1. Basics ---- */}
                <div className={styles.card}>
                    <h2 className={styles.cardTitle}><Utensils size={16} /> Basics</h2>

                    <label className={styles.field}>
                        <span className={`${styles.fieldLabel} ${styles.required}`}>Dish name</span>
                        <input
                            type="text"
                            className={styles.input}
                            value={form.name}
                            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                            placeholder="Chicken Karahi"
                            maxLength={191}
                            required
                            autoFocus={!dish}
                        />
                    </label>

                    {nameClash && (
                        <div role="status" className={`${styles.note} ${styles.noteWarn}`} style={{ marginBottom: 0 }}>
                            <AlertTriangle size={16} aria-hidden="true" /> {nameClash}
                        </div>
                    )}

                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={`${styles.fieldLabel} ${styles.required}`}>Category</span>
                            <select
                                className={styles.input}
                                value={form.category_id}
                                onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))}
                                required
                            >
                                <option value="">Pick a category…</option>
                                {formData.categories.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                            <span className={styles.hint}>
                                The kitchen prints one slip per category, so this also says which station cooks it.
                            </span>
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Unit label</span>
                            <input
                                type="text"
                                className={styles.input}
                                value={form.unit}
                                onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                                placeholder="per plate"
                                maxLength={32}
                            />
                            <span className={styles.hint}>Optional: shown beside the price where the menu has room.</span>
                        </label>
                    </div>

                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Description</span>
                        <textarea
                            className={styles.input}
                            value={form.description}
                            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                            placeholder="Slow-cooked in tomato and green chilli."
                            rows={3}
                        />
                        <span className={styles.hint}>The customer menu shows this under the dish.</span>
                    </label>

                    <label className={styles.checkLine}>
                        <input
                            type="checkbox"
                            checked={form.is_available}
                            onChange={(e) => setForm((f) => ({ ...f, is_available: e.target.checked }))}
                        />
                        <span>On the menu: the till can ring it up{form.is_available ? '' : '. Unticked it shows as sold out'}</span>
                    </label>
                </div>

                {/* ---- 3. Price & sizes ---- */}
                <div className={styles.card}>
                    <h2 className={styles.cardTitle}>Price</h2>

                    <div className={styles.segments} role="group" aria-label="How this dish is priced">
                        <button
                            type="button"
                            className={`${styles.segment} ${form.priceMode === 'single' ? styles.segmentActive : ''}`}
                            onClick={() => setMode('single')}
                        >
                            One price
                        </button>
                        <button
                            type="button"
                            className={`${styles.segment} ${form.priceMode === 'sizes' ? styles.segmentActive : ''}`}
                            onClick={() => setMode('sizes')}
                        >
                            Sizes
                        </button>
                    </div>

                    {form.priceMode === 'single' ? (
                        <label className={styles.field} style={{ maxWidth: '14rem' }}>
                            <span className={`${styles.fieldLabel} ${styles.required}`}>Price</span>
                            <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="0.01"
                                className={`${styles.input} ${styles.inputNum}`}
                                value={form.price}
                                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                                placeholder="1250"
                                required
                            />
                        </label>
                    ) : (
                        <>
                            <label className={styles.field} style={{ maxWidth: '20rem' }}>
                                <span className={styles.fieldLabel}>Size set</span>
                                <select
                                    className={styles.input}
                                    value={form.setId || CUSTOM}
                                    onChange={(e) => chooseSet(e.target.value)}
                                >
                                    {activeSets.map((s) => (
                                        <option key={s.id} value={s.id}>{s.name} ({s.options.join(', ')})</option>
                                    ))}
                                    <option value={CUSTOM}>Custom sizes: just for this dish</option>
                                </select>
                                <span className={styles.hint}>
                                    A set owns the size names and their order; this dish owns the prices.
                                </span>
                            </label>

                            <div className={styles.lines}>
                                <div className={`${styles.lineRow} ${form.setId === CUSTOM ? own.sizeLine : own.sizeLineFixed}`}>
                                    <span className={styles.lineHead}>Size</span>
                                    <span className={`${styles.lineHead} ${styles.alignRight}`}>Price</span>
                                    {form.setId === CUSTOM && <span />}
                                </div>
                                {form.rows.map((r) => (
                                    <div
                                        key={r.key}
                                        className={`${styles.lineRow} ${form.setId === CUSTOM ? own.sizeLine : own.sizeLineFixed}`}
                                    >
                                        {form.setId === CUSTOM ? (
                                            <input
                                                type="text"
                                                className={`${styles.input} ${styles.inputSm}`}
                                                value={r.name}
                                                onChange={(e) => patchRow(r.key, 'name', e.target.value)}
                                                placeholder="Half"
                                                maxLength={64}
                                                aria-label="Size name"
                                            />
                                        ) : (
                                            <span className={own.sizeName}>{r.name}</span>
                                        )}
                                        <input
                                            type="number"
                                            inputMode="decimal"
                                            min="0"
                                            step="0.01"
                                            className={`${styles.input} ${styles.inputSm} ${styles.inputNum}`}
                                            value={r.price}
                                            onChange={(e) => patchRow(r.key, 'price', e.target.value)}
                                            placeholder="0"
                                            aria-label={`Price for ${r.name || 'this size'}`}
                                        />
                                        {form.setId === CUSTOM && (
                                            <button
                                                type="button"
                                                className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                                onClick={() => setForm((f) => ({ ...f, rows: f.rows.filter((x) => x.key !== r.key) }))}
                                                aria-label={`Remove ${r.name || 'this size'}`}
                                            >
                                                <Trash2 size={15} />
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {form.setId === CUSTOM && (
                                <button
                                    type="button"
                                    className={`${styles.secondaryBtn} ${styles.addLineBtn}`}
                                    onClick={() => setForm((f) => ({ ...f, rows: [...f.rows, newRow()] }))}
                                    disabled={form.rows.length >= MAX_VARIANTS}
                                >
                                    <Plus size={15} /> Add size
                                </button>
                            )}

                            {sizes.error && (
                                <div role="alert" className={`${styles.note} ${styles.noteError}`} style={{ marginBottom: 0 }}>
                                    <AlertTriangle size={16} aria-hidden="true" /> {sizes.error}
                                </div>
                            )}
                            {sizes.descending && (
                                <div role="alert" className={`${styles.note} ${styles.noteWarn}`} style={{ marginBottom: 0 }}>
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    {sizes.descending} is priced below the size listed before it. Sizes run smallest to
                                    largest: the till opens on the first and puts the last on the tile. Correct the
                                    prices, or list the sizes in that order.
                                </div>
                            )}
                            {!sizes.error && !sizes.descending && sizes.moved && (
                                <span className={styles.hint}>
                                    Saved smallest first, these read {sizes.order}.
                                </span>
                            )}
                            {sizes.unpriced && (
                                <span className={styles.hint}>Every size needs a price before this can be saved.</span>
                            )}
                        </>
                    )}

                    <div className={own.tilePrice}>
                        <span className={styles.cellMuted}>
                            {form.priceMode === 'sizes'
                                ? 'Tile price: the largest size, which is what the till grid shows'
                                : 'Tile price'}
                        </span>
                        <span className={own.tilePriceValue}>{formatRupees(tilePrice)}</span>
                    </div>
                </div>

                {/* ---- 4. Modifiers ---- */}
                <div className={styles.card}>
                    <h2 className={styles.cardTitle}>Modifiers</h2>
                    {formData.modifiers.length === 0 ? (
                        <p className={styles.hint}>
                            No modifiers exist yet. They are made on the Modifiers screen and then ticked here.
                        </p>
                    ) : (
                        <div className={own.modList}>
                            {formData.modifiers.map((m) => {
                                const on = form.modifiers.includes(m.key);
                                return (
                                    <label key={m.key} className={`${own.modCard} ${on ? own.modCardOn : ''}`}>
                                        <input type="checkbox" checked={on} onChange={() => toggleModifier(m.key)} />
                                        <span>
                                            <span className={own.modName}>{m.name}</span>
                                            <span className={own.modMeta}>
                                                {m.type === 'select' ? 'Pick one' : 'Add-ons'} ·{' '}
                                                {m.options.map((o) => `${o.name}${o.price ? ` +${formatRupees(o.price)}` : ''}`).join(', ')}
                                            </span>
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                    )}
                    <span className={styles.hint}>
                        Ticked modifiers open on the till when the dish is tapped.
                    </span>
                </div>

                <div className={styles.card}>
                    <div className={`${styles.formActions} ${styles.formActionsSplit}`} style={{ borderTop: 'none', paddingTop: 0 }}>
                        {dirty && <span className={own.dirtyNote}>Unsaved changes</span>}
                        <button type="submit" className={styles.primaryBtn} disabled={busy}>
                            {busy ? <Loader2 size={16} className={styles.spinner} /> : <Save size={16} />}
                            {dish ? 'Save changes' : 'Add dish'}
                        </button>
                    </div>
                </div>
            </div>

            <div className={own.editorCol}>
                {/* ---- 2. Photo ---- */}
                <div className={styles.card}>
                    <h2 className={styles.cardTitle}>Photo</h2>
                    <ImageField
                        label=""
                        value={form.image}
                        onChange={(url) => setForm((f) => ({ ...f, image: url || '' }))}
                        disabled={busy}
                    />
                </div>

                {/* ---- 5. Recipe (summary only; the editor lives on /menu/recipes) ---- */}
                <div className={styles.card}>
                    <h2 className={styles.cardTitle}><ChefHat size={16} /> Recipe</h2>
                    {!dish ? (
                        <p className={styles.hint}>
                            Save the dish first. A recipe is attached to a dish that exists.
                        </p>
                    ) : hasBaseRecipe ? (
                        <>
                            <div className={styles.costRow}>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>Ingredient cost</div>
                                    <div className={styles.costValue}>{formatRupees(cost, 2)}</div>
                                </div>
                                <div className={styles.costCard}>
                                    <div className={styles.costLabel}>Margin</div>
                                    <div className={`${styles.costValue} ${margin < 0 ? styles.negative : ''}`}>
                                        {formatRupees(margin, 2)}
                                        <span className={styles.marginPct}>{marginPct}%</span>
                                    </div>
                                </div>
                            </div>
                            <span className={styles.hint}>
                                The base recipe ({recipe.base_lines} ingredient{recipe.base_lines === 1 ? '' : 's'}) at
                                today&apos;s average ingredient cost, against {form.priceMode === 'sizes' ? 'the smallest size' : 'the price'}.
                                {recipe.sized_variants.length > 0
                                    ? ` ${recipe.sized_variants.join(' and ')} carr${recipe.sized_variants.length === 1 ? 'ies' : 'y'} a recipe of their own. Costed on the Recipes screen.`
                                    : ''}
                            </span>
                            <Link href={`/menu/recipes?dish=${dish.id}`} className={`${styles.secondaryBtn} ${own.recipeLink}`}>
                                Edit recipe
                            </Link>
                        </>
                    ) : (
                        <>
                            <p className={styles.hint}>
                                No recipe yet: this dish consumes no stock when sold.
                            </p>
                            <Link href={`/menu/recipes?dish=${dish.id}`} className={`${styles.secondaryBtn} ${own.recipeLink}`}>
                                <Plus size={15} /> Add a recipe
                            </Link>
                        </>
                    )}
                </div>

                {dish?.is_archived && (
                    <div className={`${styles.note} ${styles.noteWarn}`} style={{ marginBottom: 0 }}>
                        <AlertTriangle size={16} aria-hidden="true" />
                        This dish is archived: it is off the till, the customer menu and the kitchen screen.
                        Restore it from the dish list.
                    </div>
                )}

                {dish && !dirty && (
                    <p className={styles.hint} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                        <CheckCircle2 size={13} aria-hidden="true" /> Everything on this dish is saved.
                    </p>
                )}
            </div>
        </form>
    );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from '../menu.module.css';
import local from './categories.module.css';
import {
    listCategories, saveCategory, moveCategory, moveCategoryDishes, deleteCategory,
} from './actions';
import { CATEGORY_ICONS } from '@/lib/menu/rules.mjs';
import { formatNumber } from '@/lib/money';
import { usePermissions } from '@/components/Layout/AppLayout';
import {
    Utensils, Flame, Soup, Cookie, GlassWater, Plus, Loader2, Pencil, Trash2,
    ChevronUp, ChevronDown, AlertTriangle, CheckCircle2, X, Layers, Printer, FolderOpen,
} from 'lucide-react';

/*
 * The till grid's sections — and the kitchen's stations. KotSlips prints one
 * slip per category with the category name alone at the top, so this list is
 * also the running order of the passes. Reordering here reorders the paper.
 */

// The six glyphs the till and the customer menu can draw. Anything else in
// the column silently renders as Utensils there, so nothing else is offered.
const GLYPHS = { Utensils, Flame, Soup, Cookie, GlassWater, Plus };

const CategoryGlyph = ({ name, size = 18 }) => {
    const Icon = GLYPHS[name] || Utensils;
    return <Icon size={size} aria-hidden="true" />;
};

const EMPTY_FORM = { id: null, name: '', icon: 'Utensils' };

export default function CategoriesPage() {
    const { can } = usePermissions();
    const canEdit = can('menu');

    const [categories, setCategories] = useState([]);
    const [unfiled, setUnfiled] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [busyId, setBusyId] = useState(null);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [doomed, setDoomed] = useState(null); // the row the delete dialog is about
    const [moveTo, setMoveTo] = useState('');

    /*
     * Fetched once on mount and never re-fetched: every write action returns
     * the whole renumbered list, so the screen repaints from the transaction
     * that just committed rather than from a second read that could disagree.
     */
    useEffect(() => {
        let live = true;
        listCategories().then((res) => {
            if (!live) return;
            if (res.error) setMessage({ type: 'error', text: res.error });
            else {
                setCategories(res.data.categories);
                setUnfiled(res.data.unfiled);
            }
            setIsLoading(false);
        });
        return () => { live = false; };
    }, []);

    useEffect(() => {
        if (message.type !== 'success') return undefined;
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000);
        return () => clearTimeout(t);
    }, [message]);

    const editing = form.id != null;

    const totals = useMemo(() => categories.reduce((acc, c) => ({
        live: acc.live + c.live_count,
        archived: acc.archived + c.archived_count,
    }), { live: 0, archived: 0 }), [categories]);

    const submit = async (e) => {
        e.preventDefault();
        setSaving(true);
        setMessage({ type: '', text: '' });
        const res = await saveCategory({ id: form.id || undefined, name: form.name, icon: form.icon });
        if (res.error) setMessage({ type: 'error', text: res.error });
        else {
            setCategories(res.data);
            setMessage({ type: 'success', text: editing ? 'Category updated' : `"${form.name.trim()}" added` });
            setForm(EMPTY_FORM);
        }
        setSaving(false);
    };

    const move = async (row, direction) => {
        setBusyId(row.id);
        setMessage({ type: '', text: '' });
        const res = await moveCategory(row.id, direction);
        if (res.error) setMessage({ type: 'error', text: res.error });
        else setCategories(res.data);
        setBusyId(null);
    };

    const askDelete = (row) => {
        setDoomed(row);
        setMoveTo('');
        setMessage({ type: '', text: '' });
    };

    const confirmMoveDishes = async () => {
        if (!doomed || !moveTo) return;
        setSaving(true);
        const res = await moveCategoryDishes(doomed.id, moveTo);
        if (res.error) setMessage({ type: 'error', text: res.error });
        else {
            setCategories(res.data.categories);
            const target = categories.find((c) => c.id === moveTo);
            setMessage({
                type: 'success',
                text: `${formatNumber(res.data.moved)} dish${res.data.moved === 1 ? '' : 'es'} moved to ${target?.name ?? 'the new category'}`,
            });
            setDoomed(res.data.categories.find((c) => c.id === doomed.id) ?? null);
            setMoveTo('');
        }
        setSaving(false);
    };

    const confirmDelete = async () => {
        if (!doomed) return;
        setSaving(true);
        const res = await deleteCategory(doomed.id);
        if (res.error) setMessage({ type: 'error', text: res.error });
        else {
            setCategories(res.data);
            setMessage({ type: 'success', text: `"${doomed.name}" deleted` });
            if (form.id === doomed.id) setForm(EMPTY_FORM);
            setDoomed(null);
        }
        setSaving(false);
    };

    const doomedTotal = doomed ? doomed.live_count + doomed.archived_count : 0;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Categories</h1>
                    <p className={styles.subtitle}>
                        The sections of the till grid, in this order, and the kitchen&apos;s
                        stations: one slip prints per category, with the category name alone at
                        the top for the runner to sort by. Move a category and you move where its
                        pass comes off the printer.
                    </p>
                </div>
                {canEdit && (
                    <div className={styles.headerActions}>
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={() => { setForm(EMPTY_FORM); setMessage({ type: '', text: '' }); }}
                        >
                            <Plus size={16} /> New category
                        </button>
                    </div>
                )}
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
                    <div className={styles.statIcon}><Layers size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Categories</div>
                        <div className={styles.statValue}>{formatNumber(categories.length)}</div>
                        <div className={styles.statHint}>Stations the kitchen prints to</div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><Printer size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Dishes filed</div>
                        <div className={styles.statValue}>{formatNumber(totals.live)}</div>
                        <div className={styles.statHint}>
                            {totals.archived > 0
                                ? `plus ${formatNumber(totals.archived)} archived, still filed here`
                                : 'no archived dishes'}
                        </div>
                    </div>
                </div>
                {unfiled > 0 && (
                    <div className={styles.statCard}>
                        <div className={`${styles.statIcon} ${styles.warnIcon}`}><AlertTriangle size={20} /></div>
                        <div>
                            <div className={styles.statLabel}>Unfiled dishes</div>
                            <div className={styles.statValue}>{formatNumber(unfiled)}</div>
                            <div className={styles.statHint}>
                                On no tab of the till grid; their slips print under “Kitchen”
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className={canEdit ? styles.layout : ''}>
                <div className={styles.listWrap}>
                    {isLoading ? (
                        <div className={styles.stateBlock}>
                            <Loader2 className={styles.spinner} size={28} />
                            <p>Loading the categories…</p>
                        </div>
                    ) : categories.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <FolderOpen size={28} />
                            <p>No categories yet. The till grid needs at least one.</p>
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Order</th>
                                    <th>Category</th>
                                    <th className={styles.cellNum}>Dishes</th>
                                    {canEdit && <th></th>}
                                </tr>
                            </thead>
                            <tbody>
                                {categories.map((c, i) => (
                                    <tr key={c.id} className={form.id === c.id ? styles.rowActive : ''}>
                                        <td>
                                            <div className={local.moveCell}>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${local.tap}`}
                                                    onClick={() => move(c, 'up')}
                                                    disabled={!canEdit || i === 0 || busyId != null}
                                                    aria-label={`Move ${c.name} up`}
                                                    title="Print this station earlier"
                                                >
                                                    <ChevronUp size={16} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${local.tap}`}
                                                    onClick={() => move(c, 'down')}
                                                    disabled={!canEdit || i === categories.length - 1 || busyId != null}
                                                    aria-label={`Move ${c.name} down`}
                                                    title="Print this station later"
                                                >
                                                    <ChevronDown size={16} />
                                                </button>
                                            </div>
                                        </td>
                                        <td className={styles.cellName}>
                                            <div className={local.nameCell}>
                                                <span className={local.glyph}><CategoryGlyph name={c.icon} /></span>
                                                <span>
                                                    <span className={styles.cellStrong}>{c.name}</span>
                                                    <span className={styles.cellSub}>Station {i + 1} on the pass</span>
                                                </span>
                                            </div>
                                        </td>
                                        <td className={styles.cellNum}>
                                            {formatNumber(c.live_count)}
                                            <span className={styles.cellSub}>
                                                {c.archived_count > 0
                                                    ? `+ ${formatNumber(c.archived_count)} archived`
                                                    : 'on the menu'}
                                            </span>
                                        </td>
                                        {canEdit && (
                                            <td className={styles.cellActions}>
                                                <div className={styles.rowActions}>
                                                    <button
                                                        type="button"
                                                        className={`${styles.iconBtn} ${local.tap}`}
                                                        onClick={() => { setForm({ id: c.id, name: c.name, icon: c.icon }); setMessage({ type: '', text: '' }); }}
                                                        aria-label={`Edit ${c.name}`}
                                                        title="Rename or change the icon"
                                                    >
                                                        <Pencil size={15} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={`${styles.iconBtn} ${styles.dangerBtn} ${local.tap}`}
                                                        onClick={() => askDelete(c)}
                                                        aria-label={`Delete ${c.name}`}
                                                        title="Delete this category"
                                                    >
                                                        <Trash2 size={15} />
                                                    </button>
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {canEdit && (
                    <div className={styles.side}>
                        <form className={styles.card} onSubmit={submit}>
                            <h2 className={styles.cardTitle}>
                                {editing ? <><Pencil size={16} /> Edit category</> : <><Plus size={16} /> New category</>}
                            </h2>

                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Name</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.name}
                                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                                    placeholder="Chicken Karahi"
                                    maxLength={191}
                                    required
                                />
                                <span className={styles.hint}>
                                    This is what prints at the top of the kitchen slip. Keep it the name
                                    the kitchen says out loud.
                                </span>
                            </label>

                            <div className={styles.field}>
                                <span className={styles.fieldLabel}>Icon</span>
                                <div className={styles.choiceRow} role="radiogroup" aria-label="Category icon">
                                    {CATEGORY_ICONS.map((ic) => (
                                        <button
                                            key={ic.name}
                                            type="button"
                                            role="radio"
                                            aria-checked={form.icon === ic.name}
                                            className={`${styles.choice} ${local.tapChoice} ${form.icon === ic.name ? styles.choiceActive : ''}`}
                                            onClick={() => setForm((p) => ({ ...p, icon: ic.name }))}
                                        >
                                            <CategoryGlyph name={ic.name} size={16} /> {ic.label}
                                        </button>
                                    ))}
                                </div>
                                <span className={styles.hint}>
                                    Six glyphs, because these are the only six the till and the customer
                                    menu knows how to draw, and anything else shows as a plate.
                                </span>
                            </div>

                            <div className={`${styles.formActions} ${editing ? styles.formActionsSplit : ''}`}>
                                {editing && (
                                    <button
                                        type="button"
                                        className={styles.secondaryBtn}
                                        onClick={() => setForm(EMPTY_FORM)}
                                        disabled={saving}
                                    >
                                        <X size={15} /> Cancel
                                    </button>
                                )}
                                <button type="submit" className={styles.primaryBtn} disabled={saving}>
                                    {saving ? <Loader2 size={16} className={styles.spinner} /> : <CheckCircle2 size={16} />}
                                    {editing ? 'Save changes' : 'Add category'}
                                </button>
                            </div>
                        </form>
                    </div>
                )}
            </div>

            {doomed && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="cat-del-title">
                    <div className={styles.modal}>
                        <h2 className={styles.modalTitle} id="cat-del-title">
                            {doomedTotal > 0 ? `“${doomed.name}” still has dishes in it` : `Delete “${doomed.name}”?`}
                        </h2>

                        {doomedTotal > 0 ? (
                            <>
                                <div className={styles.modalBody}>
                                    It holds {formatNumber(doomed.live_count)} dish
                                    {doomed.live_count === 1 ? '' : 'es'} on the menu
                                    {doomed.archived_count > 0
                                        ? ` and ${formatNumber(doomed.archived_count)} archived`
                                        : ''}. Deleting it would not fail. It would quietly unfile them:
                                </div>
                                <ul className={local.impact}>
                                    <li>they would <strong>drop off every tab</strong> of the till grid (still findable under “All”)</li>
                                    <li>their kitchen slips would print on the catch-all <strong>“Kitchen”</strong> station, not this one</li>
                                    <li>nothing would error and nobody would be told until service</li>
                                </ul>
                                <div className={styles.modalBody}>
                                    Move them to another category first. They keep their prices and
                                    recipes; only their grid tab and their kitchen station change.
                                </div>
                                <label className={styles.field}>
                                    <span className={styles.fieldLabel}>Move all {formatNumber(doomedTotal)} into</span>
                                    <select
                                        className={styles.select}
                                        value={moveTo}
                                        onChange={(e) => setMoveTo(e.target.value)}
                                    >
                                        <option value="">Choose a category…</option>
                                        {categories.filter((c) => c.id !== doomed.id).map((c) => (
                                            <option key={c.id} value={c.id}>{c.name}</option>
                                        ))}
                                    </select>
                                </label>
                                <div className={styles.modalActions}>
                                    <button
                                        type="button"
                                        className={styles.secondaryBtn}
                                        onClick={() => setDoomed(null)}
                                        disabled={saving}
                                    >
                                        Close
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.primaryBtn}
                                        onClick={confirmMoveDishes}
                                        disabled={saving || !moveTo}
                                    >
                                        {saving ? <Loader2 size={16} className={styles.spinner} /> : <CheckCircle2 size={16} />}
                                        Move the dishes
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className={styles.modalBody}>
                                    It holds no dishes, not archived ones either, so nothing on the
                                    till, the kitchen printer or any past bill changes. The row is
                                    written into the audit log before it goes.
                                </div>
                                <div className={styles.modalActions}>
                                    <button
                                        type="button"
                                        className={styles.secondaryBtn}
                                        onClick={() => setDoomed(null)}
                                        disabled={saving}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className={`${styles.secondaryBtn} ${styles.dangerOutline}`}
                                        onClick={confirmDelete}
                                        disabled={saving}
                                    >
                                        {saving ? <Loader2 size={16} className={styles.spinner} /> : <Trash2 size={15} />}
                                        Delete category
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

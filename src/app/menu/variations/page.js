'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from '../menu.module.css';
import local from './variations.module.css';
import {
    listVariationSets, saveVariationSet, toggleVariationSet, deleteVariationSet,
} from './actions';
import { MAX_VARIANTS, VARIANT_NAME_MAX } from '@/lib/menu/rules.mjs';
import { formatNumber } from '@/lib/money';
import { usePermissions } from '@/components/Layout/AppLayout';
import {
    Ruler, Loader2, Pencil, Trash2, Plus, X, ChevronUp, ChevronDown, ArrowRight,
    AlertTriangle, CheckCircle2, Lock, Tag,
} from 'lucide-react';

/*
 * Sizes as shared objects. The set owns the names and their order; the dish
 * owns the prices. Everything on this screen follows from that one split —
 * which is why a rename is a five-table job done in one go, and why removing
 * or reordering an option is simply not offered while a dish is linked.
 */

const EMPTY_FORM = { id: null, name: '', is_active: true, rows: [{ orig: null, name: '' }, { orig: null, name: '' }] };

const formFor = (set) => ({
    id: set.id,
    name: set.name,
    is_active: set.is_active,
    rows: set.options.map((o) => ({ orig: o, name: o })),
});

export default function VariationsPage() {
    const { can } = usePermissions();
    const canEdit = can('menu');

    const [sets, setSets] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [confirmRenames, setConfirmRenames] = useState(null);
    const [gapsFor, setGapsFor] = useState(null);
    const [doomed, setDoomed] = useState(null);

    /*
     * The list is fetched once on mount and then never re-fetched: every write
     * action returns the whole list as it now stands, so the screen repaints
     * from the transaction that just committed rather than from a second read
     * that could disagree with it.
     */
    useEffect(() => {
        let live = true;
        listVariationSets().then((res) => {
            if (!live) return;
            if (res.error) setMessage({ type: 'error', text: res.error });
            else setSets(res.data);
            setIsLoading(false);
        });
        return () => { live = false; };
    }, []);

    useEffect(() => {
        if (message.type !== 'success') return undefined;
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 5000);
        return () => clearTimeout(t);
    }, [message]);

    const editing = form.id != null;
    const current = useMemo(() => sets.find((s) => s.id === form.id) ?? null, [sets, form.id]);
    const linked = current?.dishes ?? [];
    const inUse = linked.length > 0;

    const stats = useMemo(() => {
        let dishes = 0;
        let gaps = 0;
        for (const s of sets) {
            dishes += s.dishes.length;
            gaps += s.dishes.filter((d) => d.missing.length > 0).length;
        }
        return { dishes, gaps };
    }, [sets]);

    const renames = useMemo(() => form.rows
        .filter((r) => r.orig && r.name.trim() && r.orig !== r.name.trim())
        .map((r) => ({ from: r.orig, to: r.name.trim() })), [form.rows]);

    const recipeLinesFor = (from) => (current?.recipe_lines?.[from] ?? 0);

    // Looked up by id rather than held as a snapshot: a save while the
    // modal is open must repaint it, not leave yesterday's gaps on screen.
    const gapsSet = useMemo(() => sets.find((s) => s.id === gapsFor) ?? null, [sets, gapsFor]);

    const startNew = () => {
        setForm(EMPTY_FORM);
        setMessage({ type: '', text: '' });
    };

    const setRow = (i, name) => setForm((p) => ({
        ...p, rows: p.rows.map((r, j) => (j === i ? { ...r, name } : r)),
    }));

    const addRow = () => setForm((p) => (p.rows.length >= MAX_VARIANTS
        ? p
        : { ...p, rows: [...p.rows, { orig: null, name: '' }] }));

    const removeRow = (i) => setForm((p) => ({ ...p, rows: p.rows.filter((_, j) => j !== i) }));

    const moveRow = (i, step) => setForm((p) => {
        const to = i + step;
        if (to < 0 || to >= p.rows.length) return p;
        const rows = [...p.rows];
        [rows[i], rows[to]] = [rows[to], rows[i]];
        return { ...p, rows };
    });

    const persist = async () => {
        setSaving(true);
        setMessage({ type: '', text: '' });
        const res = await saveVariationSet({
            id: form.id || undefined,
            name: form.name,
            is_active: form.is_active,
            rows: form.rows.map((r) => ({ orig: r.orig, name: r.name })),
        });
        if (res.error) setMessage({ type: 'error', text: res.error });
        else {
            setSets(res.data);
            setMessage({
                type: 'success',
                text: editing
                    ? (renames.length > 0
                        ? `Renamed everywhere — ${renames.map((r) => `${r.from} → ${r.to}`).join(', ')}. Past bills untouched.`
                        : 'Size set updated')
                    : `"${form.name.trim()}" added`,
            });
            setForm(EMPTY_FORM);
        }
        setConfirmRenames(null);
        setSaving(false);
    };

    const submit = (e) => {
        e.preventDefault();
        // A rename reaches live dishes and their recipes; it gets a confirmation
        // that says exactly what moves and what deliberately does not.
        if (editing && renames.length > 0 && inUse) setConfirmRenames(renames);
        else persist();
    };

    const flip = async (s) => {
        const res = await toggleVariationSet(s.id);
        if (res.error) setMessage({ type: 'error', text: res.error });
        else setSets(res.data);
    };

    const confirmDelete = async () => {
        if (!doomed) return;
        setSaving(true);
        const res = await deleteVariationSet(doomed.id);
        if (res.error) setMessage({ type: 'error', text: res.error });
        else {
            setSets(res.data);
            setMessage({ type: 'success', text: `"${doomed.name}" deleted` });
            if (form.id === doomed.id) setForm(EMPTY_FORM);
        }
        setDoomed(null);
        setSaving(false);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Sizes &amp; Variations</h1>
                    <p className={styles.subtitle}>
                        A size set is one shared thing — “Half / Full” linked to thirty dishes,
                        not a word retyped on each. The set owns the names and their order,
                        smallest first; every dish owns its own prices.
                    </p>
                </div>
                {canEdit && (
                    <div className={styles.headerActions}>
                        <button type="button" className={styles.primaryBtn} onClick={startNew}>
                            <Plus size={16} /> New size set
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
                    <div className={styles.statIcon}><Ruler size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Size sets</div>
                        <div className={styles.statValue}>{formatNumber(sets.length)}</div>
                        <div className={styles.statHint}>Shared size vocabularies</div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><Tag size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Dishes using a set</div>
                        <div className={styles.statValue}>{formatNumber(stats.dishes)}</div>
                        <div className={styles.statHint}>Each with its own prices</div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={`${styles.statIcon} ${stats.gaps > 0 ? styles.warnIcon : ''}`}>
                        {stats.gaps > 0 ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
                    </div>
                    <div>
                        <div className={styles.statLabel}>Waiting on a price</div>
                        <div className={styles.statValue}>{formatNumber(stats.gaps)}</div>
                        <div className={styles.statHint}>
                            {stats.gaps > 0
                                ? 'A size was added to a set these dishes use'
                                : 'Every linked dish prices every size'}
                        </div>
                    </div>
                </div>
            </div>

            <div className={canEdit ? styles.layout : ''}>
                <div className={styles.listWrap}>
                    {isLoading ? (
                        <div className={styles.stateBlock}>
                            <Loader2 className={styles.spinner} size={28} />
                            <p>Loading the size sets…</p>
                        </div>
                    ) : sets.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <Ruler size={28} />
                            <p>No size sets yet. A dish can still carry its own sizes without one.</p>
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Set</th>
                                    <th>Sizes, smallest first</th>
                                    <th className={styles.cellNum}>Dishes</th>
                                    <th>Pricing</th>
                                    <th>Status</th>
                                    {canEdit && <th></th>}
                                </tr>
                            </thead>
                            <tbody>
                                {sets.map((s) => {
                                    const gaps = s.dishes.filter((d) => d.missing.length > 0);
                                    return (
                                        <tr
                                            key={s.id}
                                            className={`${s.is_active ? '' : styles.rowInactive} ${form.id === s.id ? styles.rowActive : ''}`}
                                        >
                                            <td className={styles.cellName}>
                                                <span className={styles.cellStrong}>{s.name}</span>
                                                <span className={styles.cellSub}>
                                                    {s.options.length} sizes
                                                </span>
                                            </td>
                                            <td>
                                                <div className={styles.chipRow}>
                                                    {s.options.map((o, i) => (
                                                        <span key={o} className={styles.chip}>
                                                            <span className={local.optionRank}>{i + 1}</span> {o}
                                                        </span>
                                                    ))}
                                                </div>
                                            </td>
                                            <td className={styles.cellNum}>{formatNumber(s.dishes.length)}</td>
                                            <td>
                                                {s.dishes.length === 0 ? (
                                                    <span className={styles.cellMuted}>—</span>
                                                ) : (
                                                    <div className={styles.chipRow}>
                                                        <span className={`${styles.chip} ${styles.chipSuccess}`}>
                                                            {formatNumber(s.dishes.length - gaps.length)} priced
                                                        </span>
                                                        {gaps.length > 0 && (
                                                            <button
                                                                type="button"
                                                                className={`${styles.stateBtn} ${styles.stateWarn} ${local.tapPill}`}
                                                                onClick={() => setGapsFor(s.id)}
                                                            >
                                                                {formatNumber(gaps.length)} need a price
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                <button
                                                    type="button"
                                                    className={`${styles.stateBtn} ${local.tapPill} ${s.is_active ? styles.stateOn : styles.stateOff}`}
                                                    onClick={() => flip(s)}
                                                    disabled={!canEdit}
                                                    aria-pressed={s.is_active}
                                                    title={s.is_active ? 'Switch off — it leaves every picker' : 'Switch back on'}
                                                >
                                                    {s.is_active ? 'Active' : 'Off'}
                                                </button>
                                            </td>
                                            {canEdit && (
                                                <td className={styles.cellActions}>
                                                    <div className={styles.rowActions}>
                                                        <button
                                                            type="button"
                                                            className={`${styles.iconBtn} ${local.tap}`}
                                                            onClick={() => { setForm(formFor(s)); setMessage({ type: '', text: '' }); }}
                                                            aria-label={`Edit ${s.name}`}
                                                            title="Edit this set"
                                                        >
                                                            <Pencil size={15} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={`${styles.iconBtn} ${styles.dangerBtn} ${local.tap}`}
                                                            onClick={() => setDoomed(s)}
                                                            disabled={s.dishes.length > 0}
                                                            aria-label={`Delete ${s.name}`}
                                                            title={s.dishes.length > 0
                                                                ? `Used by ${s.dishes.length} dishes — switch it off instead`
                                                                : 'Delete this set'}
                                                        >
                                                            <Trash2 size={15} />
                                                        </button>
                                                    </div>
                                                </td>
                                            )}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                {canEdit && (
                    <div className={styles.side}>
                        <form className={styles.card} onSubmit={submit}>
                            <h2 className={styles.cardTitle}>
                                {editing ? <><Pencil size={16} /> Edit size set</> : <><Plus size={16} /> New size set</>}
                            </h2>

                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Set name</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.name}
                                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                                    placeholder="Half / Full"
                                    maxLength={64}
                                    required
                                />
                                <span className={styles.hint}>
                                    What this vocabulary is called in the dish editor&apos;s picker.
                                </span>
                            </label>

                            <p className={styles.cardSection}>Sizes — smallest first</p>

                            {editing && inUse && (
                                <div className={`${styles.note} ${styles.noteWarn} ${local.inlineNote}`}>
                                    <Lock size={16} aria-hidden="true" />
                                    <span>
                                        {formatNumber(linked.length)} dish{linked.length === 1 ? '' : 'es'} use
                                        this set. Renaming a size is safe and reaches all of them; removing one
                                        or changing the order is not offered, because both reprice dishes
                                        without touching a price. Adding a size is safe — the dishes get it
                                        once someone prices it.
                                    </span>
                                </div>
                            )}

                            <div className={styles.lines}>
                                {form.rows.map((r, i) => {
                                    const pinned = editing && inUse && r.orig != null;
                                    return (
                                        <div key={`${r.orig ?? 'new'}-${i}`} className={`${styles.lineRow} ${local.optionRow}`}>
                                            <label className={styles.field}>
                                                <span className={styles.lineHead}>
                                                    <span className={local.optionRank}>{i + 1}</span>
                                                    {' '}
                                                    {i === 0 ? 'smallest' : i === form.rows.length - 1 ? 'largest' : ''}
                                                </span>
                                                <input
                                                    type="text"
                                                    className={`${styles.input} ${styles.inputSm}`}
                                                    value={r.name}
                                                    onChange={(e) => setRow(i, e.target.value)}
                                                    placeholder={i === 0 ? 'Half' : 'Full'}
                                                    maxLength={VARIANT_NAME_MAX}
                                                    aria-label={`Size ${i + 1}`}
                                                />
                                            </label>
                                            <button
                                                type="button"
                                                className={`${styles.iconBtn} ${local.tap}`}
                                                onClick={() => moveRow(i, -1)}
                                                disabled={i === 0 || pinned}
                                                aria-label={`Move size ${i + 1} up`}
                                                title={pinned ? 'The order is locked while dishes use this set' : 'Smaller'}
                                            >
                                                <ChevronUp size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                className={`${styles.iconBtn} ${local.tap}`}
                                                onClick={() => moveRow(i, 1)}
                                                disabled={i === form.rows.length - 1 || pinned}
                                                aria-label={`Move size ${i + 1} down`}
                                                title={pinned ? 'The order is locked while dishes use this set' : 'Larger'}
                                            >
                                                <ChevronDown size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                className={`${styles.iconBtn} ${styles.dangerBtn} ${local.tap}`}
                                                onClick={() => removeRow(i)}
                                                disabled={pinned || form.rows.length <= 2}
                                                aria-label={`Remove size ${i + 1}`}
                                                title={pinned
                                                    ? 'Detach the dishes first — removing this would leave them priced for a size the set no longer knows'
                                                    : form.rows.length <= 2 ? 'A set needs two sizes' : 'Remove'}
                                            >
                                                <X size={15} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>

                            <button
                                type="button"
                                className={`${styles.secondaryBtn} ${styles.addLineBtn}`}
                                onClick={addRow}
                                disabled={form.rows.length >= MAX_VARIANTS}
                            >
                                <Plus size={15} /> Add a size
                            </button>

                            <label className={styles.checkLine}>
                                <input
                                    type="checkbox"
                                    checked={form.is_active}
                                    onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
                                />
                                <span>Active — offered when a dish picks its sizes</span>
                            </label>

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
                                    {editing ? 'Save changes' : 'Add size set'}
                                </button>
                            </div>
                        </form>
                    </div>
                )}
            </div>

            {confirmRenames && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="rename-title">
                    <div className={styles.modal}>
                        <h2 className={styles.modalTitle} id="rename-title">
                            Rename {confirmRenames.length === 1 ? 'this size' : `these ${confirmRenames.length} sizes`} everywhere?
                        </h2>
                        <div>
                            {confirmRenames.map((r) => (
                                <div key={r.from} className={local.renameLine}>
                                    <span className={local.renameFrom}>{r.from}</span>
                                    <ArrowRight size={14} aria-hidden="true" />
                                    <span className={local.renameTo}>{r.to}</span>
                                    <span className={styles.cellSub}>
                                        {recipeLinesFor(r.from) > 0
                                            ? `${formatNumber(recipeLinesFor(r.from))} recipe lines`
                                            : 'no recipe lines'}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <ul className={local.impact}>
                            <li>the set&apos;s own option list</li>
                            <li>
                                the size list of all <strong>{formatNumber(linked.length)} linked
                                dish{linked.length === 1 ? '' : 'es'}</strong> — prices and their order unchanged
                            </li>
                            <li>those dishes&apos; <strong>per-size recipes</strong>, so costing keeps matching</li>
                        </ul>
                        <div className={`${styles.note} ${styles.noteWarn}`}>
                            <AlertTriangle size={16} aria-hidden="true" />
                            <span>
                                Bills already rung are <strong>not</strong> touched. The size printed on an
                                order line is the text that was sold, and it stays as it was rung — so an old
                                receipt still says “Half” after today.
                            </span>
                        </div>
                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setConfirmRenames(null)}
                                disabled={saving}
                            >
                                Cancel
                            </button>
                            <button type="button" className={styles.primaryBtn} onClick={persist} disabled={saving}>
                                {saving ? <Loader2 size={16} className={styles.spinner} /> : <CheckCircle2 size={16} />}
                                Rename everywhere
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {gapsSet && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="gaps-title">
                    <div className={styles.modal}>
                        <h2 className={styles.modalTitle} id="gaps-title">Dishes waiting on a price</h2>
                        <div className={styles.modalBody}>
                            These dishes use “{gapsSet.name}” but carry no price for the sizes below, so
                            the till does not offer them. A size is written onto a dish only once it has a
                            price — an unpriced size would ring up free.
                        </div>
                        <div className={local.dishList}>
                            {gapsSet.dishes.filter((d) => d.missing.length > 0).map((d) => (
                                <Link key={d.id} href={`/menu/items/${d.id}`} className={local.dishLink}>
                                    <span>
                                        {d.name}
                                        {d.is_archived && <span className={styles.cellSub}>archived</span>}
                                    </span>
                                    <span className={styles.chipRow}>
                                        {d.missing.map((m) => <span key={m} className={`${styles.chip} ${styles.chipWarn}`}>{m}</span>)}
                                    </span>
                                </Link>
                            ))}
                        </div>
                        <div className={styles.modalActions}>
                            <button type="button" className={styles.secondaryBtn} onClick={() => setGapsFor(null)}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {doomed && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="vs-del-title">
                    <div className={styles.modal}>
                        <h2 className={styles.modalTitle} id="vs-del-title">Delete “{doomed.name}”?</h2>
                        <div className={styles.modalBody}>
                            No dish uses this set, so nothing on the till, in a recipe or on a past bill
                            changes. The set and its options are written into the audit log before it goes.
                            If you might want it back, switch it off instead.
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
                                Delete set
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

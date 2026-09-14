'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from '../menu.module.css';
import local from './modifiers.module.css';
import { listModifiers, saveModifier, deleteModifier } from './actions';
import { slugKey, MAX_OPTIONS } from '@/lib/menu/rules.mjs';
import { formatRupees, formatNumber } from '@/lib/money';
import { usePermissions } from '@/components/Layout/AppLayout';
import {
    SlidersHorizontal, Loader2, Pencil, Trash2, Plus, X, ChevronUp, ChevronDown,
    AlertTriangle, CheckCircle2, Lock, Link2,
} from 'lucide-react';

/*
 * Add-ons and choices. Two things about this screen are not cosmetic:
 *
 *  - the KEY is what a dish stores, so it is offered while a modifier is new
 *    and locked the moment a dish links it;
 *  - the ORDER of a pick-one's options decides the default, because the till's
 *    modal pre-selects the SECOND one. The list marks it so nobody has to know.
 */

const TYPES = [
    {
        key: 'select',
        label: 'Pick one',
        blurb: 'One of the options is always chosen. The till pre-selects the SECOND one. '
            + 'put the sensible default there (Medium on a spice level). Needs at least two options.',
    },
    {
        key: 'multiselect',
        label: 'Add-ons',
        blurb: 'Any number, including none. The till starts with nothing picked and the cashier '
            + 'adds what the customer asks for. Needs at least one option.',
    },
];

const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.key, t.label]));

const EMPTY_FORM = {
    id: null,
    name: '',
    key: '',
    keyTouched: false,
    type: 'select',
    options: [{ name: '', price: '' }, { name: '', price: '' }],
};

const formFor = (m) => ({
    id: m.id,
    name: m.name,
    key: m.key,
    keyTouched: true,
    type: m.type,
    options: m.options.map((o) => ({ name: o.name, price: String(o.price ?? '') })),
});

export default function ModifiersPage() {
    const { can } = usePermissions();
    const canEdit = can('menu');

    const [modifiers, setModifiers] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [form, setForm] = useState(null); // null = editor closed
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [doomed, setDoomed] = useState(null);

    /*
     * Fetched once on mount and never re-fetched: every write action returns
     * the whole list as it now stands, so the screen repaints from the
     * transaction that just committed rather than from a second read.
     */
    useEffect(() => {
        let live = true;
        listModifiers().then((res) => {
            if (!live) return;
            if (res.error) setMessage({ type: 'error', text: res.error });
            else setModifiers(res.data);
            setIsLoading(false);
        });
        return () => { live = false; };
    }, []);

    useEffect(() => {
        if (message.type !== 'success') return undefined;
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000);
        return () => clearTimeout(t);
    }, [message]);

    const editing = form?.id != null;
    const current = useMemo(
        () => (form?.id ? modifiers.find((m) => m.id === form.id) ?? null : null),
        [modifiers, form],
    );
    const linked = current?.dishes ?? [];
    const keyLocked = editing && linked.length > 0;

    const linkedTotal = useMemo(
        () => modifiers.reduce((n, m) => n + m.dishes.length, 0),
        [modifiers],
    );

    const setOption = (i, patch) => setForm((p) => ({
        ...p, options: p.options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    }));

    const addOption = () => setForm((p) => (p.options.length >= MAX_OPTIONS
        ? p
        : { ...p, options: [...p.options, { name: '', price: '' }] }));

    const removeOption = (i) => setForm((p) => ({ ...p, options: p.options.filter((_, j) => j !== i) }));

    const moveOption = (i, step) => setForm((p) => {
        const to = i + step;
        if (to < 0 || to >= p.options.length) return p;
        const options = [...p.options];
        [options[i], options[to]] = [options[to], options[i]];
        return { ...p, options };
    });

    // The key follows the name until somebody types a key of their own — the
    // same courtesy the chart of accounts extends to an account number.
    const changeName = (name) => setForm((p) => ({
        ...p, name, key: p.keyTouched ? p.key : slugKey(name),
    }));

    const submit = async (e) => {
        e.preventDefault();
        setSaving(true);
        setMessage({ type: '', text: '' });
        const res = await saveModifier({
            id: form.id || undefined,
            name: form.name,
            key: keyLocked ? current.key : form.key,
            type: form.type,
            options: form.options,
        });
        if (res.error) setMessage({ type: 'error', text: res.error });
        else {
            setModifiers(res.data);
            setMessage({ type: 'success', text: editing ? 'Modifier updated' : `"${form.name.trim()}" added` });
            setForm(null);
        }
        setSaving(false);
    };

    const confirmDelete = async () => {
        if (!doomed) return;
        setSaving(true);
        const res = await deleteModifier(doomed.id);
        if (res.error) setMessage({ type: 'error', text: res.error });
        else {
            setModifiers(res.data);
            setMessage({ type: 'success', text: `"${doomed.name}" deleted` });
            setDoomed(null);
        }
        setSaving(false);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Modifiers</h1>
                    <p className={styles.subtitle}>
                        The choices and add-ons the till puts in front of a cashier when a dish
                        is tapped: a spice level, a side of raita. A dish links a modifier by
                        its key, and what the customer picked is copied onto the bill as text.
                    </p>
                </div>
                {canEdit && (
                    <div className={styles.headerActions}>
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={() => { setForm(EMPTY_FORM); setMessage({ type: '', text: '' }); }}
                        >
                            <Plus size={16} /> New modifier
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
                    <div className={styles.statIcon}><SlidersHorizontal size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Modifiers</div>
                        <div className={styles.statValue}>{formatNumber(modifiers.length)}</div>
                        <div className={styles.statHint}>
                            {modifiers.filter((m) => m.type === 'select').length} pick-one ·{' '}
                            {modifiers.filter((m) => m.type === 'multiselect').length} add-ons
                        </div>
                    </div>
                </div>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><Link2 size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Dish links</div>
                        <div className={styles.statValue}>{formatNumber(linkedTotal)}</div>
                        <div className={styles.statHint}>
                            {linkedTotal === 0
                                ? 'No dish offers a modifier yet. Add them on the dish'
                                : 'Each one freezes that modifier’s key'}
                        </div>
                    </div>
                </div>
            </div>

            <div className={styles.listWrap}>
                {isLoading ? (
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={28} />
                        <p>Loading the modifiers…</p>
                    </div>
                ) : modifiers.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <SlidersHorizontal size={28} />
                        <p>No modifiers yet.</p>
                    </div>
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Modifier</th>
                                <th>Type</th>
                                <th>Options</th>
                                <th className={styles.cellNum}>Dishes</th>
                                {canEdit && <th></th>}
                            </tr>
                        </thead>
                        <tbody>
                            {modifiers.map((m) => (
                                <tr key={m.id}>
                                    <td className={styles.cellName}>
                                        <span className={styles.cellStrong}>{m.name}</span>
                                        <span className={`${styles.cellSub} ${styles.inputMono}`}>{m.key}</span>
                                    </td>
                                    <td>
                                        <span className={`${styles.chip} ${m.type === 'select' ? styles.chipPrimary : ''}`}>
                                            {TYPE_LABEL[m.type]}
                                        </span>
                                    </td>
                                    <td className={styles.cellWrap}>
                                        <div className={styles.chipRow}>
                                            {m.options.map((o, i) => (
                                                <span
                                                    key={o.name}
                                                    className={`${styles.chip} ${m.type === 'select' && i === 1 ? styles.chipSuccess : ''}`}
                                                    title={m.type === 'select' && i === 1
                                                        ? 'The till pre-selects this one'
                                                        : undefined}
                                                >
                                                    {o.name}
                                                    {Number(o.price) > 0 ? ` +${formatRupees(o.price)}` : ''}
                                                    {m.type === 'select' && i === 1 && (
                                                        <span className={local.defaultMark}>default</span>
                                                    )}
                                                </span>
                                            ))}
                                        </div>
                                    </td>
                                    <td className={styles.cellNum}>
                                        {formatNumber(m.dishes.length)}
                                        {m.dishes.length > 0 && (
                                            <span className={styles.cellSub} title={m.dishes.map((d) => d.name).join(', ')}>
                                                key frozen
                                            </span>
                                        )}
                                    </td>
                                    {canEdit && (
                                        <td className={styles.cellActions}>
                                            <div className={styles.rowActions}>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${local.tap}`}
                                                    onClick={() => { setForm(formFor(m)); setMessage({ type: '', text: '' }); }}
                                                    aria-label={`Edit ${m.name}`}
                                                    title="Edit this modifier"
                                                >
                                                    <Pencil size={15} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${styles.dangerBtn} ${local.tap}`}
                                                    onClick={() => setDoomed(m)}
                                                    disabled={m.dishes.length > 0}
                                                    aria-label={`Delete ${m.name}`}
                                                    title={m.dishes.length > 0
                                                        ? `Used by ${m.dishes.length} dishes. Take it off them first`
                                                        : 'Delete this modifier'}
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

            {form && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="mod-title">
                    <form className={`${styles.modal} ${styles.modalWide}`} onSubmit={submit}>
                        <h2 className={styles.modalTitle} id="mod-title">
                            {editing ? `Edit ${current?.name ?? 'modifier'}` : 'New modifier'}
                        </h2>

                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Name</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.name}
                                    onChange={(e) => changeName(e.target.value)}
                                    placeholder="Spice Level"
                                    maxLength={191}
                                    required
                                />
                                <span className={styles.hint}>What the cashier reads above the options.</span>
                            </label>
                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Key</span>
                                <div className={local.keyRow}>
                                    <input
                                        type="text"
                                        className={`${styles.input} ${styles.inputMono}`}
                                        value={keyLocked ? current.key : form.key}
                                        onChange={(e) => setForm((p) => ({
                                            ...p, key: slugKey(e.target.value), keyTouched: true,
                                        }))}
                                        placeholder="spice-level"
                                        maxLength={64}
                                        disabled={keyLocked}
                                        required
                                    />
                                    {keyLocked && <Lock size={16} className={styles.cellMuted} aria-hidden="true" />}
                                </div>
                                <span className={styles.hint}>
                                    {keyLocked
                                        ? `Locked: ${linked.length} dish${linked.length === 1 ? '' : 'es'} store this exact string, and a dish that points at a key which no longer exists loses the modifier with no error. Rename the modifier instead.`
                                        : 'Follows the name until you change it. Nothing links this modifier yet, so it is still free to change.'}
                                </span>
                            </label>
                        </div>

                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>Type</span>
                            <div className={styles.choiceRow} role="radiogroup" aria-label="Modifier type">
                                {TYPES.map((t) => (
                                    <button
                                        key={t.key}
                                        type="button"
                                        role="radio"
                                        aria-checked={form.type === t.key}
                                        className={`${styles.choice} ${local.tapChoice} ${form.type === t.key ? styles.choiceActive : ''}`}
                                        onClick={() => setForm((p) => ({ ...p, type: t.key }))}
                                    >
                                        {t.label}
                                    </button>
                                ))}
                            </div>
                            <span className={styles.hint}>
                                {TYPES.find((t) => t.key === form.type)?.blurb}
                            </span>
                        </div>

                        <p className={styles.cardSection}>
                            Options {form.type === 'select' ? '— second one is the default' : ''}
                        </p>

                        <div className={styles.lines}>
                            {form.options.map((o, i) => (
                                <div key={i} className={`${styles.lineRow} ${local.optionRow}`}>
                                    <label className={styles.field}>
                                        <span className={styles.lineHead}>
                                            <span className={local.optionRank}>{i + 1}</span>
                                            {form.type === 'select' && i === 1 ? ' pre-selected' : ''}
                                        </span>
                                        <input
                                            type="text"
                                            className={`${styles.input} ${styles.inputSm}`}
                                            value={o.name}
                                            onChange={(e) => setOption(i, { name: e.target.value })}
                                            placeholder="Medium"
                                            maxLength={64}
                                            aria-label={`Option ${i + 1} name`}
                                        />
                                    </label>
                                    <label className={styles.field}>
                                        <span className={styles.lineHead}>Extra</span>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            className={`${styles.input} ${styles.inputSm} ${styles.inputNum}`}
                                            value={o.price}
                                            onChange={(e) => setOption(i, { price: e.target.value })}
                                            placeholder="0"
                                            aria-label={`Option ${i + 1} extra charge in rupees`}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className={`${styles.iconBtn} ${local.tap}`}
                                        onClick={() => moveOption(i, -1)}
                                        disabled={i === 0}
                                        aria-label={`Move option ${i + 1} up`}
                                        title="Move up"
                                    >
                                        <ChevronUp size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`${styles.iconBtn} ${local.tap}`}
                                        onClick={() => moveOption(i, 1)}
                                        disabled={i === form.options.length - 1}
                                        aria-label={`Move option ${i + 1} down`}
                                        title="Move down"
                                    >
                                        <ChevronDown size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`${styles.iconBtn} ${styles.dangerBtn} ${local.tap}`}
                                        onClick={() => removeOption(i)}
                                        disabled={form.options.length <= (form.type === 'select' ? 2 : 1)}
                                        aria-label={`Remove option ${i + 1}`}
                                        title={form.options.length <= (form.type === 'select' ? 2 : 1)
                                            ? 'A pick-one needs two options; add-ons needs one'
                                            : 'Remove'}
                                    >
                                        <X size={15} />
                                    </button>
                                </div>
                            ))}
                        </div>

                        <button
                            type="button"
                            className={`${styles.secondaryBtn} ${styles.addLineBtn}`}
                            onClick={addOption}
                            disabled={form.options.length >= MAX_OPTIONS}
                        >
                            <Plus size={15} /> Add an option
                        </button>

                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setForm(null)}
                                disabled={saving}
                            >
                                <X size={15} /> Cancel
                            </button>
                            <button type="submit" className={styles.primaryBtn} disabled={saving}>
                                {saving ? <Loader2 size={16} className={styles.spinner} /> : <CheckCircle2 size={16} />}
                                {editing ? 'Save changes' : 'Add modifier'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {doomed && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="mod-del-title">
                    <div className={styles.modal}>
                        <h2 className={styles.modalTitle} id="mod-del-title">Delete “{doomed.name}”?</h2>
                        <div className={styles.modalBody}>
                            No dish links <code className={styles.inputMono}>{doomed.key}</code>, so this is a
                            real delete rather than an archive:
                        </div>
                        <ul className={local.impact}>
                            <li>no order history points at a modifier row. What a customer picked was copied onto the bill as <strong>text</strong> when it was rung</li>
                            <li>past bills, reports and the KDS are unchanged</li>
                            <li>the whole row goes into the <strong>audit log</strong> before it goes</li>
                        </ul>
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
                                Delete modifier
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

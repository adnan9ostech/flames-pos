'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import styles from './discounts.module.css';
import { listPlans, listScopeOptions, savePlan, togglePlan, deletePlan } from './actions';
import { formatDayMonth } from '@/lib/timeFormat';
import {
    BadgePercent, Loader2, Plus, Pencil, Trash2, AlertTriangle, CheckCircle2,
    Search, X, MoonStar
} from 'lucide-react';

// ISO weekday numbers, Monday first — the numbering `days` stores.
const DAYS = [
    { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' },
    { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' },
    { n: 7, label: 'Sun' },
];

const SCOPES = [
    { key: 'order', label: 'Whole bill' },
    { key: 'category', label: 'Categories' },
    { key: 'item', label: 'Items' },
];

const EMPTY_FORM = {
    id: null,
    name: '',
    value_type: 'percent',
    value: '',
    starts_on: '',
    ends_on: '',
    start_time: '',
    end_time: '',
    days: [],
    scope: 'order',
    category_ids: [],
    item_ids: [],
    min_qty: '',
    max_value: '',
};

const valueLabel = (p) =>
    p.value_type === 'percent' ? `${p.value}%` : `Rs. ${Number(p.value).toLocaleString('en-PK')}`;

const fmtDate = (d) => (d ? formatDayMonth(new Date(`${d}T00:00:00`)) : '');
const fmtTime = (t) => (t ? t.slice(0, 5) : '');

const dateLabel = (p) => {
    if (!p.starts_on && !p.ends_on) return 'Any date';
    if (p.starts_on && p.ends_on) return `${fmtDate(p.starts_on)} – ${fmtDate(p.ends_on)}`;
    return p.starts_on ? `From ${fmtDate(p.starts_on)}` : `Until ${fmtDate(p.ends_on)}`;
};

const timeLabel = (p) => {
    if (!p.start_time || !p.end_time) return 'All day';
    const overnight = p.start_time > p.end_time;
    return `${fmtTime(p.start_time)}–${fmtTime(p.end_time)}${overnight ? ' overnight' : ''}`;
};

const daysLabel = (p) =>
    p.days.length === 0
        ? 'Every day'
        : p.days.map((n) => DAYS.find((d) => d.n === n)?.label).filter(Boolean).join(', ');

const scopeLabel = (p) => {
    if (p.scope === 'category') return `${p.category_ids.length} ${p.category_ids.length === 1 ? 'category' : 'categories'}`;
    if (p.scope === 'item') return `${p.item_ids.length} ${p.item_ids.length === 1 ? 'item' : 'items'}`;
    return 'Whole bill';
};

export default function DiscountsPage() {
    const [plans, setPlans] = useState([]);
    const [options, setOptions] = useState({ categories: [], items: [] });
    const [isLoading, setIsLoading] = useState(true);
    const [form, setForm] = useState(EMPTY_FORM);
    const [itemFilter, setItemFilter] = useState('');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);

    const load = useCallback(async () => {
        const res = await listPlans();
        if (res.error) {
            setMessage({ type: 'error', text: res.error });
        } else {
            setPlans(res.data);
        }
        setIsLoading(false);
    }, []);

    useEffect(() => {
        load();
        listScopeOptions().then((res) => {
            if (res.data) setOptions(res.data);
        });
    }, [load]);

    // Clear a success note on its own; errors stay until the next attempt.
    useEffect(() => {
        if (message.type !== 'success') return;
        const timer = setTimeout(() => setMessage({ type: '', text: '' }), 4000);
        return () => clearTimeout(timer);
    }, [message]);

    const editing = form.id != null;
    const overnight = form.start_time && form.end_time && form.start_time > form.end_time;

    const filteredItems = useMemo(() => {
        const term = itemFilter.trim().toLowerCase();
        if (!term) return options.items;
        return options.items.filter((i) => i.name.toLowerCase().includes(term));
    }, [options.items, itemFilter]);

    const startEdit = (plan) => {
        setForm({
            id: plan.id,
            name: plan.name,
            value_type: plan.value_type,
            value: String(plan.value),
            starts_on: plan.starts_on || '',
            ends_on: plan.ends_on || '',
            start_time: fmtTime(plan.start_time),
            end_time: fmtTime(plan.end_time),
            days: [...plan.days],
            scope: plan.scope,
            category_ids: [...plan.category_ids],
            item_ids: [...plan.item_ids],
            min_qty: plan.min_qty ? String(plan.min_qty) : '',
            max_value: plan.max_value != null ? String(plan.max_value) : '',
        });
        setMessage({ type: '', text: '' });
    };

    const toggleInList = (key, value) => {
        setForm((prev) => ({
            ...prev,
            [key]: prev[key].includes(value)
                ? prev[key].filter((v) => v !== value)
                : [...prev[key], value],
        }));
    };

    const submit = async (e) => {
        e.preventDefault();
        setSaving(true);
        setMessage({ type: '', text: '' });
        const res = await savePlan({
            id: form.id || undefined,
            name: form.name,
            value_type: form.value_type,
            value: Number(form.value),
            starts_on: form.starts_on,
            ends_on: form.ends_on,
            start_time: form.start_time,
            end_time: form.end_time,
            days: form.days,
            scope: form.scope,
            category_ids: form.category_ids,
            item_ids: form.item_ids,
            min_qty: form.min_qty === '' ? 0 : Number(form.min_qty),
            max_value: form.max_value,
        });
        if (res.error) {
            setMessage({ type: 'error', text: res.error });
        } else {
            setMessage({ type: 'success', text: editing ? 'Plan updated' : 'Plan added' });
            setForm(EMPTY_FORM);
            setItemFilter('');
            await load();
        }
        setSaving(false);
    };

    const flip = async (plan) => {
        const res = await togglePlan(plan.id);
        if (res.error) {
            setMessage({ type: 'error', text: res.error });
        } else {
            setPlans((prev) => prev.map((p) => (p.id === plan.id ? res.data : p)));
        }
    };

    const submitDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        const res = await deletePlan(deleteTarget.id);
        if (res.error) {
            setMessage({ type: 'error', text: res.error });
        } else {
            if (form.id === deleteTarget.id) setForm(EMPTY_FORM);
            await load();
        }
        setDeleteTarget(null);
        setDeleting(false);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Discount Plans</h1>
                    <p className={styles.subtitle}>
                        Scheduled deals the till offers as one tap while their window is open.
                    </p>
                </div>
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

            <div className={styles.layout}>
                <div className={styles.listWrap}>
                    {isLoading ? (
                        <div className={styles.stateBlock}>
                            <Loader2 className={styles.spinner} size={28} />
                            <p>Loading plans…</p>
                        </div>
                    ) : plans.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <BadgePercent size={28} />
                            <p>No discount plans yet — add the first one alongside.</p>
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Value</th>
                                    <th>When</th>
                                    <th>Applies to</th>
                                    <th>Status</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {plans.map((plan) => (
                                    <tr key={plan.id} className={plan.is_active ? '' : styles.rowInactive}>
                                        <td className={styles.cellStrong}>{plan.name}</td>
                                        <td className={styles.cellStrong}>
                                            {valueLabel(plan)}
                                            {plan.max_value != null && (
                                                <div className={styles.cellSub}>
                                                    cap Rs. {Number(plan.max_value).toLocaleString('en-PK')}
                                                </div>
                                            )}
                                        </td>
                                        <td className={styles.cellMuted}>
                                            <div>{dateLabel(plan)}</div>
                                            <div className={styles.cellSub}>
                                                {timeLabel(plan)} · {daysLabel(plan)}
                                            </div>
                                        </td>
                                        <td className={styles.cellMuted}>
                                            <div>{scopeLabel(plan)}</div>
                                            {plan.min_qty > 0 && (
                                                <div className={styles.cellSub}>min qty {plan.min_qty}</div>
                                            )}
                                        </td>
                                        <td>
                                            <button
                                                type="button"
                                                className={`${styles.stateBtn} ${plan.is_active ? styles.stateOn : styles.stateOff}`}
                                                onClick={() => flip(plan)}
                                                aria-pressed={plan.is_active}
                                            >
                                                {plan.is_active ? 'Active' : 'Off'}
                                            </button>
                                        </td>
                                        <td className={styles.alignRight}>
                                            <div className={styles.rowActions}>
                                                <button
                                                    type="button"
                                                    className={styles.iconBtn}
                                                    onClick={() => startEdit(plan)}
                                                    title="Edit plan"
                                                    aria-label={`Edit ${plan.name}`}
                                                >
                                                    <Pencil size={15} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                                    onClick={() => setDeleteTarget(plan)}
                                                    title="Delete plan"
                                                    aria-label={`Delete ${plan.name}`}
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                <form className={styles.card} onSubmit={submit}>
                    <h2 className={styles.cardTitle}>
                        {editing ? `Edit “${form.name || '…'}”` : 'New plan'}
                    </h2>

                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Name</span>
                        <input
                            type="text"
                            className={styles.input}
                            value={form.name}
                            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                            placeholder="Lunch Deal"
                            maxLength={64}
                            required
                        />
                        <span className={styles.hint}>
                            The till shows this on the chip, and it becomes the discount reason on the bill.
                        </span>
                    </label>

                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Type</span>
                            <select
                                className={styles.input}
                                value={form.value_type}
                                onChange={(e) => setForm((p) => ({ ...p, value_type: e.target.value }))}
                            >
                                <option value="percent">Percent off</option>
                                <option value="fixed">Fixed rupees off</option>
                            </select>
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>
                                {form.value_type === 'percent' ? 'Percent' : 'Amount (Rs.)'}
                            </span>
                            <input
                                type="number"
                                className={styles.input}
                                value={form.value}
                                onChange={(e) => setForm((p) => ({ ...p, value: e.target.value }))}
                                min="0"
                                max={form.value_type === 'percent' ? 100 : undefined}
                                step="0.01"
                                inputMode="decimal"
                                placeholder={form.value_type === 'percent' ? '20' : '300'}
                                required
                            />
                        </label>
                    </div>

                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Starts on</span>
                            <input
                                type="date"
                                className={styles.input}
                                value={form.starts_on}
                                max={form.ends_on || undefined}
                                onChange={(e) => setForm((p) => ({ ...p, starts_on: e.target.value }))}
                            />
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Ends on</span>
                            <input
                                type="date"
                                className={styles.input}
                                value={form.ends_on}
                                min={form.starts_on || undefined}
                                onChange={(e) => setForm((p) => ({ ...p, ends_on: e.target.value }))}
                            />
                        </label>
                    </div>

                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>From</span>
                            <input
                                type="time"
                                className={styles.input}
                                value={form.start_time}
                                onChange={(e) => setForm((p) => ({ ...p, start_time: e.target.value }))}
                            />
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Until</span>
                            <input
                                type="time"
                                className={styles.input}
                                value={form.end_time}
                                onChange={(e) => setForm((p) => ({ ...p, end_time: e.target.value }))}
                            />
                        </label>
                    </div>
                    <span className={styles.hint}>
                        Blank dates and times mean always.
                        {overnight && (
                            <span className={styles.overnightNote}>
                                <MoonStar size={12} aria-hidden="true" />
                                Ends after midnight — runs into the next morning.
                            </span>
                        )}
                    </span>

                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Days of the week</span>
                        <div className={styles.checkRow}>
                            {DAYS.map(({ n, label }) => (
                                <label key={n} className={styles.checkChip}>
                                    <input
                                        type="checkbox"
                                        checked={form.days.includes(n)}
                                        onChange={() => toggleInList('days', n)}
                                    />
                                    {label}
                                </label>
                            ))}
                        </div>
                        <span className={styles.hint}>Nothing ticked means every day.</span>
                    </div>

                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Applies to</span>
                        <div className={styles.checkRow}>
                            {SCOPES.map(({ key, label }) => (
                                <label key={key} className={styles.checkChip}>
                                    <input
                                        type="radio"
                                        name="scope"
                                        checked={form.scope === key}
                                        onChange={() => setForm((p) => ({ ...p, scope: key }))}
                                    />
                                    {label}
                                </label>
                            ))}
                        </div>
                    </div>

                    {form.scope === 'category' && (
                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>
                                Categories ({form.category_ids.length} picked)
                            </span>
                            <div className={styles.pickList}>
                                {options.categories.map((c) => (
                                    <label key={c.id} className={styles.pickRow}>
                                        <input
                                            type="checkbox"
                                            checked={form.category_ids.includes(c.id)}
                                            onChange={() => toggleInList('category_ids', c.id)}
                                        />
                                        {c.name}
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}

                    {form.scope === 'item' && (
                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>
                                Items ({form.item_ids.length} picked)
                            </span>
                            <div className={styles.pickSearch}>
                                <Search size={14} aria-hidden="true" />
                                <input
                                    type="search"
                                    className={styles.pickSearchInput}
                                    value={itemFilter}
                                    onChange={(e) => setItemFilter(e.target.value)}
                                    placeholder="Filter dishes"
                                    aria-label="Filter dishes"
                                />
                            </div>
                            <div className={styles.pickList}>
                                {filteredItems.map((i) => (
                                    <label key={i.id} className={styles.pickRow}>
                                        <input
                                            type="checkbox"
                                            checked={form.item_ids.includes(i.id)}
                                            onChange={() => toggleInList('item_ids', i.id)}
                                        />
                                        {i.name}
                                    </label>
                                ))}
                                {filteredItems.length === 0 && (
                                    <p className={styles.pickEmpty}>No dishes match.</p>
                                )}
                            </div>
                        </div>
                    )}

                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Minimum quantity</span>
                            <input
                                type="number"
                                className={styles.input}
                                value={form.min_qty}
                                onChange={(e) => setForm((p) => ({ ...p, min_qty: e.target.value }))}
                                min="0"
                                step="1"
                                inputMode="numeric"
                                placeholder="0"
                            />
                            <span className={styles.hint}>Matching items the bill must carry. 0 = no minimum.</span>
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Cap (Rs.)</span>
                            <input
                                type="number"
                                className={styles.input}
                                value={form.max_value}
                                onChange={(e) => setForm((p) => ({ ...p, max_value: e.target.value }))}
                                min="0"
                                step="0.01"
                                inputMode="decimal"
                                placeholder="No cap"
                            />
                            <span className={styles.hint}>The most this plan can take off one bill.</span>
                        </label>
                    </div>

                    <div className={styles.formActions}>
                        {editing && (
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => { setForm(EMPTY_FORM); setItemFilter(''); }}
                                disabled={saving}
                            >
                                <X size={14} aria-hidden="true" />
                                Cancel
                            </button>
                        )}
                        <button type="submit" className={styles.primaryBtn} disabled={saving}>
                            {saving
                                ? <Loader2 size={14} className={styles.inlineSpinner} />
                                : editing ? <Pencil size={14} /> : <Plus size={14} />}
                            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add plan'}
                        </button>
                    </div>
                </form>
            </div>

            {/* Deleting is final; bills already discounted keep their rupee
                amount and reason — nothing points back at the plan. */}
            {deleteTarget && (
                <div className={styles.modalOverlay} onClick={() => !deleting && setDeleteTarget(null)}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <h3 className={styles.modalTitle}>
                            <AlertTriangle size={18} aria-hidden="true" />
                            Delete “{deleteTarget.name}”?
                        </h3>
                        <p className={styles.modalBody}>
                            The till stops offering it immediately. Bills that already used it
                            keep their discount. To pause it instead, switch it off.
                        </p>
                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setDeleteTarget(null)}
                                disabled={deleting}
                            >
                                Keep plan
                            </button>
                            <button
                                type="button"
                                className={styles.dangerConfirm}
                                onClick={submitDelete}
                                disabled={deleting}
                            >
                                {deleting ? <Loader2 size={14} className={styles.inlineSpinner} /> : <Trash2 size={14} />}
                                {deleting ? 'Deleting…' : 'Delete plan'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

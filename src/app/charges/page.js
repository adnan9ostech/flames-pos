'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import styles from './charges.module.css';
import { listCharges, saveCharge, toggleCharge, deleteCharge } from './actions';
import { calcTotals, DEFAULT_TAX_RATE } from '@/lib/orderTotals.mjs';
import {
    Percent, Loader2, Plus, Pencil, Trash2, AlertTriangle, CheckCircle2,
    Receipt, X
} from 'lucide-react';

const ORDER_TYPES = [
    { key: 'dine-in', label: 'Dine-in' },
    { key: 'takeaway', label: 'Takeaway' },
    { key: 'delivery', label: 'Delivery' },
];

const EMPTY_FORM = {
    id: null,
    name: '',
    value_type: 'percent',
    value: '',
    order_types: [],
    before_tax: true,
    auto_apply: true,
};

// The worked example prices a plain one-line bill so the arithmetic is
// checkable in the operator's head: Rs 1,000 of food, dine-in, taxed.
const EXAMPLE_BILL = [{ price: 1000, qty: 1 }];

const valueLabel = (c) =>
    c.value_type === 'percent' ? `${c.value}%` : `Rs. ${Number(c.value).toLocaleString('en-PK')}`;

export default function ChargesPage() {
    const [charges, setCharges] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);

    const load = useCallback(async () => {
        const res = await listCharges();
        if (res.error) {
            setMessage({ type: 'error', text: res.error });
        } else {
            setCharges(res.data);
        }
        setIsLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    // Clear a success note on its own; errors stay until the next attempt.
    useEffect(() => {
        if (message.type !== 'success') return;
        const timer = setTimeout(() => setMessage({ type: '', text: '' }), 4000);
        return () => clearTimeout(timer);
    }, [message]);

    const editing = form.id != null;

    /*
     * The form as a charge object, or null while it wouldn't land on the
     * example bill — off, not yet priced, or scoped away from dine-in.
     */
    const draftCharge = useMemo(() => {
        const value = Number(form.value);
        if (!Number.isFinite(value) || value <= 0) return null;
        if (!form.auto_apply) return null;
        if (form.order_types.length > 0 && !form.order_types.includes('dine-in')) return null;
        return {
            name: form.name.trim() || 'This charge',
            value_type: form.value_type,
            value,
            before_tax: form.before_tax,
        };
    }, [form]);

    /*
     * Priced by the same calcTotals the kernel runs at recompute — the example
     * is the server's arithmetic, not an imitation of it. The row being edited
     * is swapped out for the form's version so the preview tracks the pen.
     */
    const example = useMemo(() => {
        const active = charges.filter((c) =>
            c.id !== form.id && c.is_active && c.auto_apply
            && (c.order_types.length === 0 || c.order_types.includes('dine-in')));
        const applied = draftCharge ? [...active, draftCharge] : active;
        return calcTotals(EXAMPLE_BILL, true, { taxRate: DEFAULT_TAX_RATE, charges: applied });
    }, [charges, draftCharge, form.id]);

    const startEdit = (charge) => {
        setForm({
            id: charge.id,
            name: charge.name,
            value_type: charge.value_type,
            value: String(charge.value),
            order_types: [...charge.order_types],
            before_tax: charge.before_tax,
            auto_apply: charge.auto_apply,
        });
        setMessage({ type: '', text: '' });
    };

    const toggleType = (key) => {
        setForm((prev) => ({
            ...prev,
            order_types: prev.order_types.includes(key)
                ? prev.order_types.filter((t) => t !== key)
                : [...prev.order_types, key],
        }));
    };

    const submit = async (e) => {
        e.preventDefault();
        setSaving(true);
        setMessage({ type: '', text: '' });
        const res = await saveCharge({
            id: form.id || undefined,
            name: form.name,
            value_type: form.value_type,
            value: Number(form.value),
            order_types: form.order_types,
            before_tax: form.before_tax,
            auto_apply: form.auto_apply,
        });
        if (res.error) {
            setMessage({ type: 'error', text: res.error });
        } else {
            setMessage({ type: 'success', text: editing ? 'Charge updated' : 'Charge added' });
            setForm(EMPTY_FORM);
            await load();
        }
        setSaving(false);
    };

    const flip = async (charge) => {
        const res = await toggleCharge(charge.id);
        if (res.error) {
            setMessage({ type: 'error', text: res.error });
        } else {
            setCharges((prev) => prev.map((c) => (c.id === charge.id ? res.data : c)));
        }
    };

    const submitDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        const res = await deleteCharge(deleteTarget.id);
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
                    <h1 className={styles.title}>Charges</h1>
                    <p className={styles.subtitle}>
                        Service charge, delivery fee — applied to every matching bill automatically.
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
                            <p>Loading charges…</p>
                        </div>
                    ) : charges.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <Percent size={28} />
                            <p>No charges yet — add the first one alongside.</p>
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Value</th>
                                    <th>Applies to</th>
                                    <th>Tax</th>
                                    <th>Status</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {charges.map((charge) => (
                                    <tr key={charge.id} className={charge.is_active ? '' : styles.rowInactive}>
                                        <td className={styles.cellStrong}>
                                            {charge.name}
                                            {!charge.auto_apply && (
                                                <span className={styles.manualTag}>manual</span>
                                            )}
                                        </td>
                                        <td className={styles.cellStrong}>{valueLabel(charge)}</td>
                                        <td>
                                            <div className={styles.chipRow}>
                                                {charge.order_types.length === 0
                                                    ? <span className={styles.chip}>All types</span>
                                                    : charge.order_types.map((t) => (
                                                        <span key={t} className={styles.chip}>
                                                            {ORDER_TYPES.find((o) => o.key === t)?.label || t}
                                                        </span>
                                                    ))}
                                            </div>
                                        </td>
                                        <td className={styles.cellMuted}>
                                            {charge.before_tax ? 'Before tax' : 'After tax'}
                                        </td>
                                        <td>
                                            <button
                                                type="button"
                                                className={`${styles.stateBtn} ${charge.is_active ? styles.stateOn : styles.stateOff}`}
                                                onClick={() => flip(charge)}
                                                aria-pressed={charge.is_active}
                                            >
                                                {charge.is_active ? 'Active' : 'Off'}
                                            </button>
                                        </td>
                                        <td className={styles.alignRight}>
                                            <div className={styles.rowActions}>
                                                <button
                                                    type="button"
                                                    className={styles.iconBtn}
                                                    onClick={() => startEdit(charge)}
                                                    title="Edit charge"
                                                    aria-label={`Edit ${charge.name}`}
                                                >
                                                    <Pencil size={15} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                                    onClick={() => setDeleteTarget(charge)}
                                                    title="Delete charge"
                                                    aria-label={`Delete ${charge.name}`}
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

                <div className={styles.side}>
                    <form className={styles.card} onSubmit={submit}>
                        <h2 className={styles.cardTitle}>
                            {editing ? `Edit “${form.name || '…'}”` : 'New charge'}
                        </h2>

                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Name</span>
                            <input
                                type="text"
                                className={styles.input}
                                value={form.name}
                                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                                placeholder="Service Charge"
                                maxLength={64}
                                required
                            />
                        </label>

                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Type</span>
                                <select
                                    className={styles.input}
                                    value={form.value_type}
                                    onChange={(e) => setForm((p) => ({ ...p, value_type: e.target.value }))}
                                >
                                    <option value="percent">Percent of bill</option>
                                    <option value="fixed">Fixed rupees</option>
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
                                    placeholder={form.value_type === 'percent' ? '5' : '150'}
                                    required
                                />
                            </label>
                        </div>

                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>Order types</span>
                            <div className={styles.checkRow}>
                                {ORDER_TYPES.map(({ key, label }) => (
                                    <label key={key} className={styles.checkChip}>
                                        <input
                                            type="checkbox"
                                            checked={form.order_types.includes(key)}
                                            onChange={() => toggleType(key)}
                                        />
                                        {label}
                                    </label>
                                ))}
                            </div>
                            <span className={styles.hint}>Nothing ticked means every order type.</span>
                        </div>

                        <label className={styles.checkLine}>
                            <input
                                type="checkbox"
                                checked={form.before_tax}
                                onChange={(e) => setForm((p) => ({ ...p, before_tax: e.target.checked }))}
                            />
                            <span>
                                Charge before tax
                                <span className={styles.hint}>The charge joins the taxable base — GST is charged on it too.</span>
                            </span>
                        </label>

                        <label className={styles.checkLine}>
                            <input
                                type="checkbox"
                                checked={form.auto_apply}
                                onChange={(e) => setForm((p) => ({ ...p, auto_apply: e.target.checked }))}
                            />
                            <span>
                                Apply automatically
                                <span className={styles.hint}>Lands on every matching bill without a tap at the till.</span>
                            </span>
                        </label>

                        <div className={styles.formActions}>
                            {editing && (
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={() => setForm(EMPTY_FORM)}
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
                                {saving ? 'Saving…' : editing ? 'Save changes' : 'Add charge'}
                            </button>
                        </div>
                    </form>

                    {/* The same calcTotals the server runs at recompute, on a
                        Rs 1,000 dine-in bill — what the form does to money,
                        shown before it's saved. */}
                    <div className={styles.card}>
                        <h2 className={styles.cardTitle}>
                            <Receipt size={16} aria-hidden="true" />
                            On a Rs. 1,000 dine-in bill
                        </h2>
                        <dl className={styles.exampleList}>
                            <div className={styles.exampleRow}>
                                <dt>Subtotal</dt>
                                <dd>Rs. {Number(example.subtotal).toLocaleString('en-PK')}</dd>
                            </div>
                            {example.charges.length === 0 && (
                                <div className={`${styles.exampleRow} ${styles.exampleMuted}`}>
                                    <dt>No charges apply</dt>
                                    <dd>—</dd>
                                </div>
                            )}
                            {example.charges.map((c, idx) => (
                                <div key={idx} className={styles.exampleRow}>
                                    <dt>
                                        {c.name}
                                        <span className={styles.exampleTag}>
                                            {c.before_tax ? 'before tax' : 'after tax'}
                                        </span>
                                    </dt>
                                    <dd>Rs. {Number(c.amount).toLocaleString('en-PK')}</dd>
                                </div>
                            ))}
                            <div className={styles.exampleRow}>
                                <dt>GST @ {Math.round(DEFAULT_TAX_RATE * 100)}%</dt>
                                <dd>Rs. {Number(example.tax).toLocaleString('en-PK')}</dd>
                            </div>
                            <div className={`${styles.exampleRow} ${styles.exampleTotal}`}>
                                <dt>Total</dt>
                                <dd>Rs. {Number(example.total).toLocaleString('en-PK')}</dd>
                            </div>
                        </dl>
                        {draftCharge && (
                            <p className={styles.exampleNote}>Includes the charge in the form as typed.</p>
                        )}
                    </div>
                </div>
            </div>

            {/* Deleting is rare and final — past bills keep their snapshot, but
                the charge stops landing on new ones the moment this confirms. */}
            {deleteTarget && (
                <div className={styles.modalOverlay} onClick={() => !deleting && setDeleteTarget(null)}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <h3 className={styles.modalTitle}>
                            <AlertTriangle size={18} aria-hidden="true" />
                            Delete “{deleteTarget.name}”?
                        </h3>
                        <p className={styles.modalBody}>
                            It stops applying to new bills immediately. Bills already settled keep
                            it — they carry their own copy. To pause it instead, switch it off.
                        </p>
                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setDeleteTarget(null)}
                                disabled={deleting}
                            >
                                Keep charge
                            </button>
                            <button
                                type="button"
                                className={styles.dangerConfirm}
                                onClick={submitDelete}
                                disabled={deleting}
                            >
                                {deleting ? <Loader2 size={14} className={styles.inlineSpinner} /> : <Trash2 size={14} />}
                                {deleting ? 'Deleting…' : 'Delete charge'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

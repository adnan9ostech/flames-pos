'use client';
import { useState, useEffect, useCallback } from 'react';
import styles from './expenses.module.css';
import {
    listExpenses, addExpense, markPaid, deleteExpense,
    listCategories, addCategory, toggleCategory,
} from './actions';
import { useRole } from '@/components/Layout/AppLayout';
import { formatWeekdayDate } from '@/lib/timeFormat';
import {
    Receipt, Loader2, Plus, X, Check, Download, Trash2, Tag,
    Banknote, Landmark, HandCoins, AlertTriangle, CheckCircle2,
    ClipboardList, ShieldAlert,
} from 'lucide-react';

const PAID_FROM = [
    { key: 'drawer', label: 'Drawer', Icon: Banknote },
    { key: 'bank', label: 'Bank', Icon: Landmark },
    { key: 'other', label: 'Other', Icon: HandCoins },
];

const PAID_FROM_LABEL = Object.fromEntries(PAID_FROM.map(p => [p.key, p.label]));

/* The operator's trading day, not the browser's UTC day. */
const karachiToday = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

const rs = (x) => `Rs. ${Number(x).toLocaleString('en-PK')}`;

// business_date arrives as 'YYYY-MM-DD'; parsed at local midnight so the
// label can't slip a day on a machine set away from PKT.
const dayLabel = (d) => formatWeekdayDate(new Date(`${d}T00:00:00`));

export default function ExpensesPage() {
    const role = useRole();

    const [tab, setTab] = useState('vouchers');
    const [from, setFrom] = useState(karachiToday());
    const [to, setTo] = useState(karachiToday());
    const [vouchers, setVouchers] = useState([]);
    const [payables, setPayables] = useState([]);
    const [categories, setCategories] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isFetching, setIsFetching] = useState(false);

    // Entry form. Date left blank books to the current business day server-side.
    const [date, setDate] = useState('');
    const [categoryId, setCategoryId] = useState('');
    const [description, setDescription] = useState('');
    const [payee, setPayee] = useState('');
    const [amount, setAmount] = useState('');
    const [paidFrom, setPaidFrom] = useState('drawer');
    const [payable, setPayable] = useState(false);
    const [saving, setSaving] = useState(false);
    const [note, setNote] = useState({ type: '', text: '' });

    // Two ways in for a category — inline on the form, and the side card —
    // each with its own text so half-typed names don't jump between them.
    const [newCatOpen, setNewCatOpen] = useState(false);
    const [newCatName, setNewCatName] = useState('');
    const [sideCatName, setSideCatName] = useState('');
    const [catBusy, setCatBusy] = useState(false);
    const [catNote, setCatNote] = useState('');

    const [markingId, setMarkingId] = useState(null);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');

    const loadCategories = useCallback(async () => {
        const res = await listCategories();
        if (res.data) setCategories(res.data);
    }, []);

    // Payables load unbounded by the range: an unpaid bill from last month
    // must not vanish because the table is showing this week.
    const load = useCallback(async () => {
        setIsFetching(true);
        const [ranged, owed] = await Promise.all([
            listExpenses({ from, to }),
            listExpenses({ status: 'payable' }),
        ]);
        if (ranged.error) setNote({ type: 'error', text: ranged.error });
        setVouchers(ranged.data || []);
        setPayables(owed.data || []);
        setIsLoading(false);
        setIsFetching(false);
    }, [from, to]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { loadCategories(); }, [loadCategories]);

    // Clear a success note on its own; errors stay until the next attempt.
    useEffect(() => {
        if (note.type !== 'success') return;
        const timer = setTimeout(() => setNote({ type: '', text: '' }), 4000);
        return () => clearTimeout(timer);
    }, [note]);

    const activeCategories = categories.filter(c => c.is_active);

    const submit = async (e) => {
        e.preventDefault();
        setNote({ type: '', text: '' });
        setSaving(true);
        const res = await addExpense({
            business_date: date || undefined,
            category_id: categoryId ? Number(categoryId) : null,
            description,
            payee,
            amount: Number(amount),
            paid_from: paidFrom,
            status: payable ? 'payable' : 'paid',
        });
        if (res.error) {
            setNote({ type: 'error', text: res.error });
        } else {
            setNote({ type: 'success', text: payable ? 'Payable recorded' : 'Expense recorded' });
            // Category, source and date survive the reset: vouchers from one
            // supplier run are usually entered in a burst.
            setDescription('');
            setPayee('');
            setAmount('');
            setPayable(false);
            await load();
        }
        setSaving(false);
    };

    // selectAfter: a category made from the form should land selected in it.
    const saveCategory = async (name, selectAfter) => {
        setCatBusy(true);
        setCatNote('');
        const res = await addCategory(name);
        if (res.error) {
            setCatNote(res.error);
        } else {
            setNewCatName('');
            setSideCatName('');
            setNewCatOpen(false);
            await loadCategories();
            if (selectAfter) setCategoryId(String(res.data.id));
        }
        setCatBusy(false);
    };

    const flipCategory = async (id) => {
        const res = await toggleCategory(id);
        if (res.error) setCatNote(res.error);
        else await loadCategories();
    };

    const settle = async (id) => {
        setMarkingId(id);
        const res = await markPaid(id);
        if (res.error) setNote({ type: 'error', text: res.error });
        else setNote({ type: 'success', text: 'Marked paid' });
        await load();
        setMarkingId(null);
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        setDeleteError('');
        const res = await deleteExpense(deleteTarget.id);
        if (res.error) {
            setDeleteError(res.error);
        } else {
            setDeleteTarget(null);
            await load();
        }
        setDeleting(false);
    };

    const rows = tab === 'payables' ? payables : vouchers;
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const payablePortion = tab === 'vouchers'
        ? vouchers.filter(r => r.status === 'payable').reduce((sum, r) => sum + Number(r.amount), 0)
        : 0;

    const exportCsv = () => {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [
            ['Date', 'Category', 'Description', 'Payee', 'Paid from', 'Status', 'Amount'].join(','),
            ...rows.map(r => [
                r.business_date, r.category_name ?? '', r.description, r.payee ?? '',
                PAID_FROM_LABEL[r.paid_from] ?? r.paid_from, r.status, r.amount,
            ].map(esc).join(',')),
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = tab === 'payables' ? 'payables.csv' : `expenses_${from}_to_${to}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // The actions refuse a non-admin anyway; saying so up front beats letting
    // staff fill a whole voucher and fail on submit.
    if (role && role !== 'admin') {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <ShieldAlert size={32} />
                    <p>Only an admin can record and view expenses.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Expenses</h1>
                </div>
                <div className={styles.headerRight}>
                    <div className={styles.tabs}>
                        <button
                            className={`${styles.filterTab} ${tab === 'vouchers' ? styles.active : ''}`}
                            onClick={() => setTab('vouchers')}
                        >
                            Vouchers
                        </button>
                        <button
                            className={`${styles.filterTab} ${tab === 'payables' ? styles.active : ''}`}
                            onClick={() => setTab('payables')}
                        >
                            Payables
                            {payables.length > 0 && (
                                <span className={styles.filterCount}>{payables.length}</span>
                            )}
                        </button>
                    </div>
                    <button
                        type="button"
                        className={styles.exportBtn}
                        onClick={exportCsv}
                        disabled={rows.length === 0}
                    >
                        <Download size={14} aria-hidden="true" />
                        Export CSV
                    </button>
                </div>
            </div>

            <div className={styles.layout}>
                <div className={styles.main}>
                    {/* ===== Entry form ===== */}
                    <div className={styles.card}>
                        <div className={styles.cardHeader}>
                            <div className={styles.cardIcon}>
                                <Receipt size={22} aria-hidden="true" />
                            </div>
                            <div>
                                <h2 className={styles.cardTitle}>New voucher</h2>
                                <p className={styles.cardHint}>
                                    Money going out that isn&apos;t a refund — mandi runs, repairs, bills.
                                </p>
                            </div>
                        </div>

                        <form onSubmit={submit}>
                            <div className={styles.formGrid}>
                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="exp_category">Category</label>
                                    <div className={styles.categoryRow}>
                                        <select
                                            id="exp_category"
                                            className={styles.select}
                                            value={categoryId}
                                            onChange={(e) => setCategoryId(e.target.value)}
                                        >
                                            <option value="">No category</option>
                                            {activeCategories.map(c => (
                                                <option key={c.id} value={c.id}>{c.name}</option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            className={styles.iconBtn}
                                            title="New category"
                                            aria-label="New category"
                                            onClick={() => { setNewCatOpen(o => !o); setCatNote(''); }}
                                        >
                                            <Plus size={15} />
                                        </button>
                                    </div>
                                    {newCatOpen && (
                                        <div className={styles.inlineCat}>
                                            <input
                                                type="text"
                                                className={styles.input}
                                                placeholder="Category name"
                                                value={newCatName}
                                                maxLength={64}
                                                autoFocus
                                                onChange={(e) => setNewCatName(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') { e.preventDefault(); saveCategory(newCatName, true); }
                                                }}
                                            />
                                            <button
                                                type="button"
                                                className={styles.iconBtn}
                                                title="Save category"
                                                aria-label="Save category"
                                                disabled={catBusy || !newCatName.trim()}
                                                onClick={() => saveCategory(newCatName, true)}
                                            >
                                                {catBusy ? <Loader2 size={15} className={styles.inlineSpinner} /> : <Check size={15} />}
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.iconBtn}
                                                title="Cancel"
                                                aria-label="Cancel new category"
                                                onClick={() => { setNewCatOpen(false); setNewCatName(''); setCatNote(''); }}
                                            >
                                                <X size={15} />
                                            </button>
                                        </div>
                                    )}
                                    {catNote && newCatOpen && <p className={styles.fieldError}>{catNote}</p>}
                                </div>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="exp_date">Date</label>
                                    <input
                                        id="exp_date"
                                        type="date"
                                        className={styles.dateInput}
                                        value={date}
                                        max={karachiToday()}
                                        onChange={(e) => setDate(e.target.value)}
                                    />
                                    <p className={styles.fieldHint}>Leave blank to book to the current business day.</p>
                                </div>

                                <div className={`${styles.field} ${styles.fieldWide}`}>
                                    <label className={styles.label} htmlFor="exp_description">Description</label>
                                    <input
                                        id="exp_description"
                                        type="text"
                                        className={styles.input}
                                        placeholder="Tomatoes and onions — Sunday mandi"
                                        value={description}
                                        maxLength={191}
                                        onChange={(e) => setDescription(e.target.value)}
                                    />
                                </div>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="exp_payee">Payee</label>
                                    <input
                                        id="exp_payee"
                                        type="text"
                                        className={styles.input}
                                        placeholder="Who was paid (optional)"
                                        value={payee}
                                        maxLength={191}
                                        onChange={(e) => setPayee(e.target.value)}
                                    />
                                </div>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="exp_amount">Amount (Rs.)</label>
                                    <input
                                        id="exp_amount"
                                        type="number"
                                        inputMode="decimal"
                                        min="1"
                                        step="0.01"
                                        className={styles.input}
                                        placeholder="0"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                    />
                                </div>

                                <div className={styles.field}>
                                    <span className={styles.label}>Paid from</span>
                                    <div className={styles.segment}>
                                        {PAID_FROM.map(({ key, label, Icon }) => (
                                            <button
                                                key={key}
                                                type="button"
                                                aria-pressed={paidFrom === key}
                                                className={`${styles.segmentBtn} ${paidFrom === key ? styles.segmentActive : ''}`}
                                                onClick={() => setPaidFrom(key)}
                                            >
                                                <Icon size={14} aria-hidden="true" />
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                    {/* A drawer voucher comes out of today's counted cash;
                                        say so where the choice is made. */}
                                    {paidFrom === 'drawer' && !payable && (
                                        <p className={styles.fieldHint}>Counts against the drawer&apos;s expected cash.</p>
                                    )}
                                </div>

                                <div className={styles.field}>
                                    <span className={styles.label}>Payment</span>
                                    <label className={styles.checkboxRow}>
                                        <input
                                            type="checkbox"
                                            className={styles.checkbox}
                                            checked={payable}
                                            onChange={(e) => setPayable(e.target.checked)}
                                        />
                                        Payable — record now, pay later
                                    </label>
                                </div>
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

                            <div className={styles.submitRow}>
                                <button
                                    type="submit"
                                    className={styles.submitBtn}
                                    disabled={saving || !description.trim() || !(Number(amount) > 0)}
                                >
                                    {saving
                                        ? <><Loader2 size={15} className={styles.inlineSpinner} /> Saving…</>
                                        : <><Plus size={15} aria-hidden="true" /> Record expense</>}
                                </button>
                            </div>
                        </form>
                    </div>

                    {/* ===== Voucher table ===== */}
                    <div className={styles.card}>
                        <div className={styles.toolbar}>
                            {tab === 'vouchers' ? (
                                <div className={styles.dateRange}>
                                    <input
                                        type="date"
                                        className={styles.dateInput}
                                        value={from}
                                        max={to || undefined}
                                        onChange={(e) => setFrom(e.target.value)}
                                        aria-label="From date"
                                    />
                                    <span className={styles.dateSep}>to</span>
                                    <input
                                        type="date"
                                        className={styles.dateInput}
                                        value={to}
                                        min={from || undefined}
                                        onChange={(e) => setTo(e.target.value)}
                                        aria-label="To date"
                                    />
                                </div>
                            ) : (
                                <p className={styles.toolbarNote}>
                                    Everything still owed, whatever day it was booked.
                                </p>
                            )}
                            <div className={styles.resultCount}>
                                {isFetching && !isLoading && <Loader2 className={styles.inlineSpinner} size={13} />}
                                {rows.length === 0 ? 'No vouchers' : `${rows.length} voucher${rows.length === 1 ? '' : 's'}`}
                            </div>
                        </div>

                        {isLoading ? (
                            <div className={styles.stateBlock}>
                                <Loader2 className={styles.spinner} size={32} />
                                <p>Loading expenses…</p>
                            </div>
                        ) : rows.length === 0 ? (
                            <div className={styles.stateBlock}>
                                <ClipboardList size={32} />
                                <p>
                                    {tab === 'payables'
                                        ? 'Nothing owed — every voucher is settled.'
                                        : 'No expenses in this range.'}
                                </p>
                            </div>
                        ) : (
                            <div className={`${styles.tableWrap} ${isFetching ? styles.stale : ''}`}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Category</th>
                                            <th>Description</th>
                                            <th>Payee</th>
                                            <th>Paid from</th>
                                            {tab === 'vouchers' && <th>Status</th>}
                                            <th className={styles.alignRight}>Amount</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map(r => (
                                            <tr key={r.id}>
                                                <td className={styles.cellMuted}>{dayLabel(r.business_date)}</td>
                                                <td className={styles.cellMuted}>{r.category_name || '—'}</td>
                                                <td>{r.description}</td>
                                                <td className={styles.cellMuted}>{r.payee || '—'}</td>
                                                <td className={styles.cellMuted}>
                                                    {PAID_FROM_LABEL[r.paid_from] ?? r.paid_from}
                                                </td>
                                                {tab === 'vouchers' && (
                                                    <td>
                                                        <span className={`${styles.statusBadge} ${r.status === 'paid' ? styles.statusPaid : styles.statusPayable}`}>
                                                            {r.status}
                                                        </span>
                                                    </td>
                                                )}
                                                <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                                    {rs(r.amount)}
                                                </td>
                                                <td className={styles.alignRight}>
                                                    <div className={styles.rowActions}>
                                                        {tab === 'payables' && (
                                                            <button
                                                                type="button"
                                                                className={styles.markPaidBtn}
                                                                disabled={markingId === r.id}
                                                                onClick={() => settle(r.id)}
                                                            >
                                                                {markingId === r.id
                                                                    ? <Loader2 size={13} className={styles.inlineSpinner} />
                                                                    : <Check size={13} aria-hidden="true" />}
                                                                Mark paid
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            className={`${styles.iconBtn} ${styles.deleteBtn}`}
                                                            title="Delete voucher"
                                                            aria-label="Delete voucher"
                                                            onClick={() => { setDeleteTarget(r); setDeleteError(''); }}
                                                        >
                                                            <Trash2 size={15} />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot>
                                        <tr>
                                            {/* Both tabs share the first five columns; only Status drops away */}
                                            <td colSpan={5} className={styles.cellStrong}>
                                                {tab === 'payables' ? 'Outstanding' : 'Total'}
                                            </td>
                                            {tab === 'vouchers' && (
                                                <td className={styles.cellMuted}>
                                                    {payablePortion > 0 && `${rs(payablePortion)} payable`}
                                                </td>
                                            )}
                                            <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                                {rs(total)}
                                            </td>
                                            <td></td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        )}
                    </div>
                </div>

                {/* ===== Category manager ===== */}
                <div className={styles.side}>
                    <div className={styles.card}>
                        <div className={styles.cardHeader}>
                            <div className={styles.cardIcon}>
                                <Tag size={20} aria-hidden="true" />
                            </div>
                            <div>
                                <h2 className={styles.cardTitle}>Categories</h2>
                                <p className={styles.cardHint}>
                                    Retired ones keep their old vouchers but leave the form.
                                </p>
                            </div>
                        </div>

                        <div className={styles.addCatRow}>
                            <input
                                type="text"
                                className={styles.input}
                                placeholder="New category"
                                value={sideCatName}
                                maxLength={64}
                                onChange={(e) => setSideCatName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); saveCategory(sideCatName, false); }
                                }}
                            />
                            <button
                                type="button"
                                className={styles.iconBtn}
                                title="Add category"
                                aria-label="Add category"
                                disabled={catBusy || !sideCatName.trim()}
                                onClick={() => saveCategory(sideCatName, false)}
                            >
                                {catBusy ? <Loader2 size={15} className={styles.inlineSpinner} /> : <Plus size={15} />}
                            </button>
                        </div>
                        {catNote && !newCatOpen && <p className={styles.fieldError}>{catNote}</p>}

                        {categories.length === 0 ? (
                            <p className={styles.catEmpty}>No categories yet.</p>
                        ) : (
                            <ul className={styles.catList}>
                                {categories.map(c => (
                                    <li key={c.id} className={styles.catRow}>
                                        <span className={`${styles.catName} ${c.is_active ? '' : styles.catInactive}`}>
                                            {c.name}
                                        </span>
                                        <button
                                            type="button"
                                            className={styles.catToggle}
                                            onClick={() => flipCategory(c.id)}
                                        >
                                            {c.is_active ? 'Retire' : 'Restore'}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </div>

            {/* Delete: allowed, but never quiet — the whole voucher goes into
                the audit log before the row disappears. */}
            {deleteTarget && (
                <div className={styles.modalOverlay} onClick={() => !deleting && setDeleteTarget(null)}>
                    <div className={styles.modal} onClick={e => e.stopPropagation()}>
                        <h3 className={styles.modalTitle}>
                            <AlertTriangle size={18} aria-hidden="true" />
                            Delete this voucher?
                        </h3>
                        <p className={styles.modalBody}>
                            {rs(deleteTarget.amount)} — {deleteTarget.description}
                            {deleteTarget.payee ? ` (${deleteTarget.payee})` : ''}.
                            The full voucher is written to the audit log before it goes.
                        </p>

                        {deleteError && <p className={styles.modalError}>{deleteError}</p>}

                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.modalCancel}
                                onClick={() => setDeleteTarget(null)}
                                disabled={deleting}
                            >
                                Keep voucher
                            </button>
                            <button
                                type="button"
                                className={styles.modalConfirm}
                                onClick={confirmDelete}
                                disabled={deleting}
                            >
                                {deleting
                                    ? <Loader2 size={14} className={styles.inlineSpinner} />
                                    : <Trash2 size={14} aria-hidden="true" />}
                                {deleting ? 'Deleting…' : 'Delete voucher'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

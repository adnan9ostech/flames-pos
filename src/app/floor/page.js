'use client';
import { useState, useEffect, useCallback } from 'react';
import styles from './floor.module.css';
import {
    listWaiters, saveWaiter, toggleWaiter, waiterDeleteImpact, deleteWaiter,
    listTables, saveTable, toggleTable, tableDeleteImpact, deleteTable,
} from './actions';
import { UserRound, Armchair, Plus, Check, X, Loader2, AlertTriangle, Trash2 } from 'lucide-react';

/*
 * Waiters and tables — the two lists the till picks from. Neither is ever
 * deleted: a name that has bills against it is retired instead, so old
 * orders keep reading the way they were rung.
 */
export default function FloorPage() {
    const [tab, setTab] = useState('waiters');
    const [waiters, setWaiters] = useState([]);
    const [tables, setTables] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    // The row being edited; null means the new-entry form is showing instead.
    const [editing, setEditing] = useState(null);
    const [form, setForm] = useState({});

    const load = useCallback(async () => {
        const [w, t] = await Promise.all([listWaiters(), listTables()]);
        if (w.error || t.error) setError(w.error || t.error);
        setWaiters(w.data || []);
        setTables(t.data || []);
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const startNew = () => { setEditing('new'); setForm({}); setError(''); };
    const startEdit = (row) => { setEditing(row.id); setForm({ ...row }); setError(''); };
    const cancel = () => { setEditing(null); setForm({}); };

    const submit = async () => {
        setBusy(true);
        setError('');
        const payload = editing === 'new' ? { ...form } : { ...form, id: editing };
        const res = tab === 'waiters' ? await saveWaiter(payload) : await saveTable(payload);
        if (res.error) setError(res.error);
        else { await load(); cancel(); }
        setBusy(false);
    };

    // { row, impact } while the delete dialog is up; null when it is not.
    const [deleting, setDeleting] = useState(null);
    const [typed, setTyped] = useState('');

    const askDelete = async (row) => {
        setError('');
        setTyped('');
        const res = tab === 'waiters' ? await waiterDeleteImpact(row.id) : await tableDeleteImpact(row.id);
        if (res.error) { setError(res.error); return; }
        setDeleting({ row, impact: res.data });
    };

    const confirmDelete = async () => {
        setBusy(true);
        const res = tab === 'waiters' ? await deleteWaiter(deleting.row.id) : await deleteTable(deleting.row.id);
        if (res.error) setError(res.error);
        else { await load(); setDeleting(null); setTyped(''); }
        setBusy(false);
    };

    const flip = async (row) => {
        setBusy(true);
        const res = tab === 'waiters' ? await toggleWaiter(row.id) : await toggleTable(row.id);
        if (res.error) setError(res.error);
        else await load();
        setBusy(false);
    };

    if (loading) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading floor…</p>
                </div>
            </div>
        );
    }

    const rows = tab === 'waiters' ? waiters : tables;
    /* The waiters tab shows four columns and the tables tab six; a row that
       spans the table has to say which. A fixed colSpan={6} declared a
       six-column table on the waiters tab — two columns no header ever
       covered, which is what assistive tech reads and what a browser lays the
       empty and inline-edit rows out against. */
    const columnCount = tab === 'waiters' ? 4 : 6;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Waiters &amp; Tables</h1>
                <p className={styles.subtitle}>
                    What the till offers when an order is rung. Retiring a name hides it from
                    the till without touching the bills it already carries.
                </p>
            </div>

            <div className={styles.tabs}>
                <button
                    type="button"
                    className={`${styles.tab} ${tab === 'waiters' ? styles.tabActive : ''}`}
                    onClick={() => { setTab('waiters'); cancel(); }}
                >
                    <UserRound size={16} aria-hidden="true" />
                    Waiters ({waiters.filter(w => w.is_active).length})
                </button>
                <button
                    type="button"
                    className={`${styles.tab} ${tab === 'tables' ? styles.tabActive : ''}`}
                    onClick={() => { setTab('tables'); cancel(); }}
                >
                    <Armchair size={16} aria-hidden="true" />
                    Tables ({tables.filter(t => t.is_active).length})
                </button>
            </div>

            {error && (
                <div className={styles.error} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    {error}
                </div>
            )}

            <div className={styles.card}>
                <div className={styles.cardHead}>
                    <h2 className={styles.cardTitle}>{tab === 'waiters' ? 'Waiters' : 'Tables'}</h2>
                    {editing !== 'new' && (
                        <button type="button" className={styles.addBtn} onClick={startNew}>
                            <Plus size={16} aria-hidden="true" />
                            Add {tab === 'waiters' ? 'waiter' : 'table'}
                        </button>
                    )}
                </div>

                {editing === 'new' && (
                    <Form
                        tab={tab} form={form} setForm={setForm}
                        onSave={submit} onCancel={cancel} busy={busy}
                    />
                )}

                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Name</th>
                            {tab === 'waiters' ? <th>Code</th> : <><th>Seats</th><th>Area</th><th>Order</th></>}
                            <th>Status</th>
                            <th aria-label="Actions" />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && (
                            <tr><td colSpan={columnCount} className={styles.empty}>
                                Nothing here yet — add the first one.
                            </td></tr>
                        )}
                        {rows.map((row) => (
                            editing === row.id ? (
                                <tr key={row.id}>
                                    <td colSpan={columnCount}>
                                        <Form
                                            tab={tab} form={form} setForm={setForm}
                                            onSave={submit} onCancel={cancel} busy={busy}
                                        />
                                    </td>
                                </tr>
                            ) : (
                                <tr key={row.id} className={row.is_active ? '' : styles.retired}>
                                    <td className={styles.name}>{row.name}</td>
                                    {tab === 'waiters' ? (
                                        <td>{row.code || '—'}</td>
                                    ) : (
                                        <>
                                            <td>{row.seats ?? '—'}</td>
                                            <td>{row.area || '—'}</td>
                                            <td>{row.sort_order}</td>
                                        </>
                                    )}
                                    <td>
                                        <span className={row.is_active ? styles.activeChip : styles.retiredChip}>
                                            {row.is_active ? 'On the floor' : 'Retired'}
                                        </span>
                                    </td>
                                    <td className={styles.actions}>
                                        <button type="button" className={styles.linkBtn} onClick={() => startEdit(row)}>
                                            Edit
                                        </button>
                                        <button type="button" className={styles.linkBtn} onClick={() => flip(row)} disabled={busy}>
                                            {row.is_active ? 'Retire' : 'Restore'}
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.dangerLink}
                                            onClick={() => askDelete(row)}
                                            disabled={busy}
                                            aria-label={`Delete ${row.name}`}
                                        >
                                            <Trash2 size={14} aria-hidden="true" />
                                        </button>
                                    </td>
                                </tr>
                            )
                        ))}
                    </tbody>
                </table>
            </div>

            {deleting && (
                <DeleteDialog
                    kind={tab === 'waiters' ? 'waiter' : 'table'}
                    row={deleting.row}
                    impact={deleting.impact}
                    typed={typed}
                    setTyped={setTyped}
                    busy={busy}
                    onCancel={() => { setDeleting(null); setTyped(''); }}
                    onRetire={async () => { await flip(deleting.row); setDeleting(null); }}
                    onConfirm={confirmDelete}
                />
            )}
        </div>
    );
}

/*
 * Deleting is offered, but never casually: the dialog states the real
 * consequence for THIS row (which differs between waiters and tables), puts
 * retiring in front as the reversible option, and asks for the name to be
 * typed once history is actually at stake.
 */
function DeleteDialog({ kind, row, impact, typed, setTyped, busy, onCancel, onRetire, onConfirm }) {
    const hasHistory = impact.orders > 0;
    const needsTyping = hasHistory;
    const canDelete = !busy && (!needsTyping || typed.trim() === row.name);

    return (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="del-title">
            <div className={styles.dialog}>
                <h2 id="del-title" className={styles.dialogTitle}>
                    <AlertTriangle size={18} aria-hidden="true" />
                    Delete {kind} “{row.name}”?
                </h2>

                {kind === 'waiter' ? (
                    hasHistory ? (
                        <p className={styles.dialogBody}>
                            This waiter is linked to <strong>{impact.orders} order{impact.orders === 1 ? '' : 's'}</strong>.
                            Those bills keep printing the name, but they stop counting toward
                            any waiter in reports — sales by waiter for past days will change.
                            The deletion is written to the audit log.
                        </p>
                    ) : (
                        <p className={styles.dialogBody}>
                            No orders are linked to this waiter, so nothing in the books changes.
                        </p>
                    )
                ) : (
                    hasHistory ? (
                        <p className={styles.dialogBody}>
                            <strong>{impact.orders} past order{impact.orders === 1 ? '' : 's'}</strong> used this table.
                            Orders store the table as text, so those bills and reports are
                            unaffected — the table just stops being offered at the till.
                        </p>
                    ) : (
                        <p className={styles.dialogBody}>
                            No orders have used this table. Nothing else is affected.
                        </p>
                    )
                )}

                <p className={styles.dialogHint}>
                    Retiring does the same job and can be undone.
                </p>

                {needsTyping && (
                    <label className={styles.confirmField}>
                        <span>Type <strong>{row.name}</strong> to confirm</span>
                        <input
                            className={styles.input}
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            autoFocus
                        />
                    </label>
                )}

                <div className={styles.dialogActions}>
                    <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
                        Cancel
                    </button>
                    {row.is_active && (
                        <button type="button" className={styles.retireBtn} onClick={onRetire} disabled={busy}>
                            Retire instead
                        </button>
                    )}
                    <button type="button" className={styles.deleteBtn} onClick={onConfirm} disabled={!canDelete}>
                        {busy ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
                        Delete permanently
                    </button>
                </div>
            </div>
        </div>
    );
}

function Form({ tab, form, setForm, onSave, onCancel, busy }) {
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
    return (
        <div className={styles.form}>
            <input
                className={styles.input}
                placeholder={tab === 'waiters' ? 'Name' : 'Table name (T1)'}
                value={form.name || ''}
                onChange={set('name')}
                maxLength={tab === 'waiters' ? 191 : 16}
                autoFocus
            />
            {tab === 'waiters' ? (
                <input
                    className={styles.input}
                    placeholder="Code (W-01)"
                    value={form.code || ''}
                    onChange={set('code')}
                    maxLength={16}
                />
            ) : (
                <>
                    <input
                        className={styles.input} type="number" min="1"
                        placeholder="Seats" value={form.seats ?? ''} onChange={set('seats')}
                    />
                    <input
                        className={styles.input}
                        placeholder="Area (Indoor)" value={form.area || ''} onChange={set('area')} maxLength={32}
                    />
                    <input
                        className={styles.input} type="number"
                        placeholder="Sort" value={form.sort_order ?? ''} onChange={set('sort_order')}
                    />
                </>
            )}
            <button type="button" className={styles.saveBtn} onClick={onSave} disabled={busy}>
                {busy ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                Save
            </button>
            <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
                <X size={16} aria-hidden="true" />
            </button>
        </div>
    );
}

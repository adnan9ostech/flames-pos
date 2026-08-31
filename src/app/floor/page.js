'use client';
import { useState, useEffect, useCallback } from 'react';
import styles from './floor.module.css';
import {
    listWaiters, saveWaiter, toggleWaiter,
    listTables, saveTable, toggleTable,
} from './actions';
import { UserRound, Armchair, Plus, Check, X, Loader2, AlertTriangle } from 'lucide-react';

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
                            <tr><td colSpan={6} className={styles.empty}>
                                Nothing here yet — add the first one.
                            </td></tr>
                        )}
                        {rows.map((row) => (
                            editing === row.id ? (
                                <tr key={row.id}>
                                    <td colSpan={6}>
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
                                    </td>
                                </tr>
                            )
                        ))}
                    </tbody>
                </table>
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

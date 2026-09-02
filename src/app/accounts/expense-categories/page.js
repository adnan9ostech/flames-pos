'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import styles from '../accounts.module.css'
import { listExpenseCategories, saveExpenseCategory, toggleExpenseCategory } from './actions'
import { listExpenseAccountOptions } from '../expense-codes/actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import {
    FolderOpen, Loader2, Pencil, AlertTriangle, CheckCircle2, Search, Plus, X, Hash,
} from 'lucide-react'

const EMPTY_FORM = {
    id: null,
    code: '',
    name: '',
    gl_account_id: '',
    is_active: true,
}

const NEW_FOCUS_ID = 'expense-category-code'

const fetchAll = () => Promise.all([listExpenseCategories(), listExpenseAccountOptions()])

/*
 * The headings expense codes are filed under. A small screen on purpose: a
 * category is a name, an optional short code and an optional default account
 * that pre-fills the picker when a code is added under it. The codes
 * themselves, and the accounts they post to, live one screen over.
 */
export default function ExpenseCategoriesPage() {
    const { can } = usePermissions()
    const canEdit = can('accounts_admin')

    const [categories, setCategories] = useState([])
    const [accounts, setAccounts] = useState([])
    const [isLoading, setIsLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [showInactive, setShowInactive] = useState(false)
    const [form, setForm] = useState(EMPTY_FORM)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })

    // The list and the account picker arrive together so they never disagree
    // mid-load.
    const apply = useCallback(([cats, accs]) => {
        if (cats.error) setMessage({ type: 'error', text: cats.error })
        else setCategories(cats.data)
        if (accs.error) setMessage({ type: 'error', text: accs.error })
        else setAccounts(accs.data.expense)
        setIsLoading(false)
    }, [])
    const load = useCallback(async () => apply(await fetchAll()), [apply])

    useEffect(() => {
        let alive = true
        fetchAll().then((results) => { if (alive) apply(results) })
        return () => { alive = false }
    }, [apply])

    // ?new=1 (the hub's "Add Expense Category" tile) lands ready to type. The side form
    // already mounts empty, so "open" means putting the cursor in its first
    // field; the param is then dropped so a reload does not do it again. Read
    // from the URL directly rather than through useSearchParams, which would
    // need a Suspense boundary for one boolean.
    useEffect(() => {
        if (typeof window === 'undefined') return
        const params = new URLSearchParams(window.location.search)
        if (params.get('new') !== '1') return
        params.delete('new')
        const rest = params.toString()
        window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
        document.getElementById(NEW_FOCUS_ID)?.focus()
    }, [])

    useEffect(() => {
        if (message.type !== 'success') return
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const editing = form.id != null

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase()
        return categories.filter((c) =>
            (showInactive || c.is_active)
            && (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
                || (c.account_name || '').toLowerCase().includes(q)))
    }, [categories, search, showInactive])

    // The picker offers active expense accounts, plus whatever this category
    // already points at even if it has since been switched off.
    const accountOptions = useMemo(() => {
        const list = [...accounts]
        const current = categories.find((c) => c.id === form.id)
        if (current?.gl_account_id && !list.some((a) => a.id === current.gl_account_id)) {
            list.push({ id: current.gl_account_id, account_number: current.account_number, name: `${current.account_name} (inactive)` })
        }
        return list
    }, [accounts, categories, form.id])

    const startNew = () => {
        setForm({ ...EMPTY_FORM })
        setMessage({ type: '', text: '' })
    }

    const startEdit = (c) => {
        setForm({
            id: c.id,
            code: c.code,
            name: c.name,
            gl_account_id: c.gl_account_id ? String(c.gl_account_id) : '',
            is_active: c.is_active,
        })
        setMessage({ type: '', text: '' })
    }

    const submit = async (e) => {
        e.preventDefault()
        setSaving(true)
        setMessage({ type: '', text: '' })
        const res = await saveExpenseCategory({
            id: form.id || undefined,
            code: form.code,
            name: form.name,
            gl_account_id: form.gl_account_id ? Number(form.gl_account_id) : null,
            is_active: form.is_active,
        })
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
        } else {
            setMessage({ type: 'success', text: editing ? 'Category updated' : `Category "${res.data.name}" added` })
            setForm(EMPTY_FORM)
            await load()
        }
        setSaving(false)
    }

    const flip = async (c) => {
        const res = await toggleExpenseCategory(c.id)
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setCategories((prev) => prev.map((x) => (x.id === c.id ? res.data : x)))
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Expense Categories</h1>
                    <p className={styles.subtitle}>
                        The headings expense codes are filed under, and how the expense reports group spending.
                    </p>
                </div>
                <div className={styles.headerActions}>
                    <Link href="/accounts/expense-codes" className={styles.secondaryBtn}>
                        <Hash size={15} /> Expense codes
                    </Link>
                    {canEdit && (
                        <button type="button" className={styles.primaryBtn} onClick={startNew}>
                            <Plus size={16} /> New category
                        </button>
                    )}
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

            <div className={styles.filterRow}>
                <label className={styles.searchBox}>
                    <Search size={15} aria-hidden="true" />
                    <input
                        type="search"
                        placeholder="Code, name or account"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search categories"
                    />
                </label>
                <label className={styles.toggleLine}>
                    <input
                        type="checkbox"
                        checked={showInactive}
                        onChange={(e) => setShowInactive(e.target.checked)}
                    />
                    Show inactive
                </label>
            </div>

            <div className={canEdit ? styles.layout : ''}>
                <div className={styles.listWrap}>
                    {isLoading ? (
                        <div className={styles.stateBlock}>
                            <Loader2 className={styles.spinner} size={28} />
                            <p>Loading categories…</p>
                        </div>
                    ) : visible.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <FolderOpen size={28} />
                            <p>{categories.length === 0 ? 'No categories yet.' : 'No categories match.'}</p>
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Code</th>
                                    <th>Category</th>
                                    <th>Default account</th>
                                    <th className={styles.alignRight}>Codes</th>
                                    <th>Status</th>
                                    {canEdit && <th></th>}
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((c) => (
                                    <tr key={c.id} className={c.is_active ? '' : styles.rowInactive}>
                                        <td className={styles.cellCode}>
                                            {c.code || <span className={styles.cellMuted}>—</span>}
                                        </td>
                                        <td className={styles.cellName}>
                                            <span className={styles.cellStrong}>{c.name}</span>
                                        </td>
                                        <td>
                                            {c.gl_account_id ? (
                                                <span className={styles.cellName}>
                                                    <span className={styles.cellStrong}>{c.account_name}</span>
                                                    <span className={`${styles.cellSub} ${styles.cellCode}`}>{c.account_number}</span>
                                                </span>
                                            ) : <span className={styles.cellMuted}>—</span>}
                                        </td>
                                        <td className={styles.cellNum}>
                                            {c.code_count === 0
                                                ? <span className={styles.cellMuted}>0</span>
                                                : c.active_code_count === c.code_count
                                                    ? c.code_count
                                                    : <span title={`${c.active_code_count} active of ${c.code_count}`}>{c.active_code_count} / {c.code_count}</span>}
                                        </td>
                                        <td>
                                            <button
                                                type="button"
                                                className={`${styles.stateBtn} ${c.is_active ? styles.stateOn : styles.stateOff}`}
                                                onClick={() => flip(c)}
                                                disabled={!canEdit}
                                                aria-pressed={c.is_active}
                                                title={canEdit ? (c.is_active ? 'Deactivate' : 'Reactivate') : undefined}
                                            >
                                                {c.is_active ? 'Active' : 'Off'}
                                            </button>
                                        </td>
                                        {canEdit && (
                                            <td className={styles.alignRight}>
                                                <div className={styles.rowActions}>
                                                    <button
                                                        type="button"
                                                        className={styles.iconBtn}
                                                        onClick={() => startEdit(c)}
                                                        title="Edit category"
                                                        aria-label={`Edit ${c.name}`}
                                                    >
                                                        <Pencil size={15} />
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
                                {editing ? <><Pencil size={16} /> Edit {form.name || 'category'}</> : <><Plus size={16} /> New category</>}
                            </h2>

                            <div className={styles.fieldRow}>
                                <label className={styles.field} style={{ flex: '0 0 7.5rem' }}>
                                    <span className={styles.fieldLabel}>Code</span>
                                    <input
                                        id={NEW_FOCUS_ID}
                                        type="text"
                                        className={`${styles.input} ${styles.inputMono}`}
                                        value={form.code}
                                        onChange={(e) => setForm((p) => ({ ...p, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') }))}
                                        placeholder="UTIL"
                                        maxLength={16}
                                    />
                                </label>
                                <label className={styles.field}>
                                    <span className={`${styles.fieldLabel} ${styles.required}`}>Name</span>
                                    <input
                                        type="text"
                                        className={styles.input}
                                        value={form.name}
                                        onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                                        placeholder="Utilities"
                                        maxLength={64}
                                        required
                                    />
                                </label>
                            </div>

                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Default expense account</span>
                                <select
                                    className={styles.input}
                                    value={form.gl_account_id}
                                    onChange={(e) => setForm((p) => ({ ...p, gl_account_id: e.target.value }))}
                                >
                                    <option value="">None</option>
                                    {accountOptions.map((a) => (
                                        <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                                    ))}
                                </select>
                                <span className={styles.hint}>
                                    Pre-fills the account when a code is added under this category. Only accounts marked
                                    for expense use on the chart are offered.
                                </span>
                            </label>

                            <label className={styles.checkLine}>
                                <input
                                    type="checkbox"
                                    checked={form.is_active}
                                    onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
                                />
                                <span>Active — offered when filing a code or an expense</span>
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
                                    {editing ? 'Save changes' : 'Add category'}
                                </button>
                            </div>
                        </form>
                    </div>
                )}
            </div>
        </div>
    )
}

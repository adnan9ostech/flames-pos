'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import styles from '../accounts.module.css'
import {
    listExpenseCodes, listExpenseAccountOptions, saveExpenseCode, toggleExpenseCode,
} from './actions'
import { listExpenseCategories } from '../expense-categories/actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import {
    Hash, Loader2, Pencil, AlertTriangle, CheckCircle2, Search, Plus, X, Lock, FolderOpen,
} from 'lucide-react'

const EMPTY_FORM = {
    id: null,
    code: '',
    name: '',
    category_id: '',
    account_id: '',
    payable_account_id: '',
    is_active: true,
    has_lines: false,
    line_count: 0,
    account_label: '',
    payable_locked: false,
}

const NEW_FOCUS_ID = 'expense-code-code'

const fetchAll = () => Promise.all([listExpenseCodes(), listExpenseCategories(), listExpenseAccountOptions()])

/*
 * Expense codes: what a voucher line picks. ChowPOS's list columns, kept —
 * Code | Name | Category | Account | Active | Edit — with the payable account
 * shown under the debit account, because the two together are the whole
 * posting rule and a person checking one wants to see the other.
 */
export default function ExpenseCodesPage() {
    const { can } = usePermissions()
    const canEdit = can('accounts_admin')

    const [codes, setCodes] = useState([])
    const [categories, setCategories] = useState([])
    const [accounts, setAccounts] = useState({ expense: [], payable: [] })
    const [isLoading, setIsLoading] = useState(true)
    const [categoryFilter, setCategoryFilter] = useState('all')
    const [search, setSearch] = useState('')
    const [showInactive, setShowInactive] = useState(false)
    const [form, setForm] = useState(EMPTY_FORM)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })

    // One round trip for the three lists the screen needs, applied together
    // so the table and the pickers never disagree mid-load.
    const apply = useCallback(([list, cats, accs]) => {
        const failed = [list, cats, accs].find((r) => r.error)
        if (failed) setMessage({ type: 'error', text: failed.error })
        if (!list.error) setCodes(list.data)
        if (!cats.error) setCategories(cats.data)
        if (!accs.error) setAccounts(accs.data)
        setIsLoading(false)
    }, [])
    const load = useCallback(async () => apply(await fetchAll()), [apply])

    useEffect(() => {
        let alive = true
        fetchAll().then((results) => { if (alive) apply(results) })
        return () => { alive = false }
    }, [apply])

    // ?new=1 (the hub's "Add Expense Code" tile) lands ready to type. The side form
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
        return codes.filter((c) =>
            (showInactive || c.is_active)
            && (categoryFilter === 'all'
                || (categoryFilter === 'none' ? c.category_id == null : String(c.category_id) === categoryFilter))
            && (!q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
                || (c.category_name || '').toLowerCase().includes(q)
                || c.account_name.toLowerCase().includes(q) || c.account_number.includes(q)))
    }, [codes, categoryFilter, search, showInactive])

    // Filter tabs: every category that has at least one (visible) code, plus
    // an "Unfiled" tab only when something is actually unfiled.
    const tabs = useMemo(() => {
        const counts = {}
        let unfiled = 0
        let all = 0
        for (const c of codes) {
            if (!c.is_active && !showInactive) continue
            all += 1
            if (c.category_id == null) unfiled += 1
            else counts[c.category_id] = (counts[c.category_id] || 0) + 1
        }
        const list = [{ key: 'all', label: 'All', count: all }]
        for (const cat of categories) {
            if (counts[cat.id]) list.push({ key: String(cat.id), label: cat.name, count: counts[cat.id] })
        }
        if (unfiled) list.push({ key: 'none', label: 'Unfiled', count: unfiled })
        return list
    }, [codes, categories, showInactive])

    // Category picker: active categories, plus the one already on this code
    // even if it has since been switched off.
    const categoryOptions = useMemo(() => {
        const active = categories.filter((c) => c.is_active)
        const current = categories.find((c) => String(c.id) === form.category_id)
        if (current && !current.is_active) active.push(current)
        return active
    }, [categories, form.category_id])

    // Account pickers: active eligible accounts, plus whatever the code being
    // edited already points at even if that account has since been switched off.
    const current = useMemo(() => codes.find((c) => c.id === form.id) || null, [codes, form.id])
    const expenseOptions = useMemo(() => {
        const list = accounts.expense
        if (!current || list.some((a) => a.id === current.account_id)) return list
        return [...list, { id: current.account_id, account_number: current.account_number, name: `${current.account_name} (inactive)` }]
    }, [accounts.expense, current])
    const payableOptions = useMemo(() => {
        const list = accounts.payable
        if (!current?.payable_account_id || list.some((a) => a.id === current.payable_account_id)) return list
        return [...list, { id: current.payable_account_id, account_number: current.payable_number, name: `${current.payable_name} (inactive)` }]
    }, [accounts.payable, current])

    const startNew = () => {
        setForm({ ...EMPTY_FORM })
        setMessage({ type: '', text: '' })
    }

    const startEdit = (c) => {
        setForm({
            id: c.id,
            code: c.code,
            name: c.name,
            category_id: c.category_id ? String(c.category_id) : '',
            account_id: String(c.account_id),
            payable_account_id: c.payable_account_id ? String(c.payable_account_id) : '',
            is_active: c.is_active,
            has_lines: c.has_lines,
            line_count: c.line_count,
            account_label: `${c.account_number} ${c.account_name}`,
            // A payable account a posted line may still owe against is fixed
            // too; one that was never set can be set now.
            payable_locked: Boolean(c.has_lines && c.payable_account_id),
        })
        setMessage({ type: '', text: '' })
    }

    // Picking a category pre-fills the debit account from the category's
    // default — only while the account is still empty, never over a choice.
    const changeCategory = (value) => {
        setForm((p) => {
            const cat = categories.find((c) => String(c.id) === value)
            const account_id = !p.account_id && cat?.gl_account_id ? String(cat.gl_account_id) : p.account_id
            return { ...p, category_id: value, account_id }
        })
    }

    const submit = async (e) => {
        e.preventDefault()
        setSaving(true)
        setMessage({ type: '', text: '' })
        const res = await saveExpenseCode({
            id: form.id || undefined,
            code: form.code,
            name: form.name,
            category_id: form.category_id ? Number(form.category_id) : null,
            account_id: form.account_id ? Number(form.account_id) : null,
            payable_account_id: form.payable_account_id ? Number(form.payable_account_id) : null,
            is_active: form.is_active,
        })
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
        } else {
            setMessage({ type: 'success', text: editing ? `${res.data.code} updated` : `Code ${res.data.code} added` })
            setForm(EMPTY_FORM)
            await load()
        }
        setSaving(false)
    }

    const flip = async (c) => {
        const res = await toggleExpenseCode(c.id)
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setCodes((prev) => prev.map((x) => (x.id === c.id ? res.data : x)))
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Expense Codes</h1>
                    <p className={styles.subtitle}>
                        What a voucher line picks. Each code carries the account it debits and the
                        payable account it credits while the voucher is unpaid.
                    </p>
                </div>
                <div className={styles.headerActions}>
                    <Link href="/accounts/expense-categories" className={styles.secondaryBtn}>
                        <FolderOpen size={15} /> Categories
                    </Link>
                    {canEdit && (
                        <button type="button" className={styles.primaryBtn} onClick={startNew}>
                            <Plus size={16} /> New code
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
                <div className={styles.filterTabs} role="tablist" aria-label="Category">
                    {tabs.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={categoryFilter === t.key}
                            className={`${styles.filterTab} ${categoryFilter === t.key ? styles.filterActive : ''}`}
                            onClick={() => setCategoryFilter(t.key)}
                        >
                            {t.label} {t.count ? `· ${t.count}` : ''}
                        </button>
                    ))}
                </div>
                <label className={styles.searchBox}>
                    <Search size={15} aria-hidden="true" />
                    <input
                        type="search"
                        placeholder="Code, name, category or account"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search expense codes"
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
                            <p>Loading expense codes…</p>
                        </div>
                    ) : visible.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <Hash size={28} />
                            <p>{codes.length === 0 ? 'No expense codes yet.' : 'No expense codes match.'}</p>
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Code</th>
                                    <th>Name</th>
                                    <th>Category</th>
                                    <th>Account</th>
                                    <th>Status</th>
                                    {canEdit && <th></th>}
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((c) => (
                                    <tr key={c.id} className={c.is_active ? '' : styles.rowInactive}>
                                        <td className={styles.cellCode}>{c.code}</td>
                                        <td className={styles.cellName}>
                                            <span className={styles.cellStrong}>
                                                {c.name}
                                                {c.has_lines && (
                                                    <span className={styles.sysTag} title={`${c.line_count || 'Some'} voucher line(s) use this code; its account is fixed`}>
                                                        in use
                                                    </span>
                                                )}
                                            </span>
                                        </td>
                                        <td>
                                            {c.category_name
                                                ? <span className={styles.chip}>{c.category_name}</span>
                                                : <span className={styles.cellMuted}>—</span>}
                                        </td>
                                        <td className={styles.cellName}>
                                            <span className={styles.cellStrong}>
                                                <span className={styles.cellCode}>{c.account_number}</span> {c.account_name}
                                                {!c.account_active && (
                                                    <span className={styles.sysTag} title="This account is switched off on the chart">off</span>
                                                )}
                                            </span>
                                            <span className={styles.cellSub}>
                                                {c.payable_account_id
                                                    ? <>Payable: <span className={styles.cellCode}>{c.payable_number}</span> {c.payable_name}</>
                                                    : 'No payable account: must be paid on the voucher'}
                                            </span>
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
                                                        title="Edit code"
                                                        aria-label={`Edit ${c.code}`}
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
                                {editing ? <><Pencil size={16} /> Edit {form.code}</> : <><Plus size={16} /> New expense code</>}
                            </h2>

                            <div className={styles.fieldRow}>
                                <label className={styles.field} style={{ flex: '0 0 7.5rem' }}>
                                    <span className={`${styles.fieldLabel} ${styles.required}`}>Code</span>
                                    <input
                                        id={NEW_FOCUS_ID}
                                        type="text"
                                        className={`${styles.input} ${styles.inputMono}`}
                                        value={form.code}
                                        onChange={(e) => setForm((p) => ({ ...p, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') }))}
                                        placeholder="ELEC"
                                        minLength={2}
                                        maxLength={16}
                                        required
                                    />
                                </label>
                                <label className={styles.field}>
                                    <span className={`${styles.fieldLabel} ${styles.required}`}>Name</span>
                                    <input
                                        type="text"
                                        className={styles.input}
                                        value={form.name}
                                        onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                                        placeholder="Electricity"
                                        maxLength={96}
                                        required
                                    />
                                </label>
                            </div>

                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Category</span>
                                <select
                                    className={styles.input}
                                    value={form.category_id}
                                    onChange={(e) => changeCategory(e.target.value)}
                                >
                                    <option value="">Unfiled</option>
                                    {categoryOptions.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.code ? `${c.code} · ` : ''}{c.name}{c.is_active ? '' : ' (inactive)'}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Account (debited)</span>
                                <select
                                    className={styles.input}
                                    value={form.account_id}
                                    onChange={(e) => setForm((p) => ({ ...p, account_id: e.target.value }))}
                                    disabled={form.has_lines}
                                    required
                                >
                                    <option value="">Choose an expense account</option>
                                    {expenseOptions.map((a) => (
                                        <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                                    ))}
                                </select>
                                {form.has_lines ? (
                                    <span className={styles.hint}>
                                        <Lock size={11} /> {form.line_count || 'Voucher'} line(s) are posted against {form.account_label},
                                        so this code&apos;s account is fixed. To post elsewhere, switch this code off and add a new one.
                                    </span>
                                ) : (
                                    <span className={styles.hint}>
                                        Where the money spent under this code lands on the P&amp;L. Only accounts marked for
                                        expense use on the chart are offered.
                                    </span>
                                )}
                            </label>

                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Payable account (credited while unpaid)</span>
                                <select
                                    className={styles.input}
                                    value={form.payable_account_id}
                                    onChange={(e) => setForm((p) => ({ ...p, payable_account_id: e.target.value }))}
                                    disabled={form.payable_locked}
                                >
                                    <option value="">None: must be paid on the voucher</option>
                                    {payableOptions.map((a) => (
                                        <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                                    ))}
                                </select>
                                {form.payable_locked ? (
                                    <span className={styles.hint}>
                                        <Lock size={11} /> Voucher lines are booked against this payable account, and a later
                                        payment must clear the same one, so it is fixed. To use another, switch this code off and add a new one.
                                    </span>
                                ) : (
                                    <span className={styles.hint}>
                                        A voucher line under this code that is not paid on the spot sits here until it is.
                                    </span>
                                )}
                            </label>

                            <label className={styles.checkLine}>
                                <input
                                    type="checkbox"
                                    checked={form.is_active}
                                    onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
                                />
                                <span>Active: offered on voucher lines</span>
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
                                    {editing ? 'Save changes' : 'Add code'}
                                </button>
                            </div>
                        </form>
                    </div>
                )}
            </div>
        </div>
    )
}

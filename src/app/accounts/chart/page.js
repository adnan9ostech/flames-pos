'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import styles from '../accounts.module.css'
import { listAccounts, saveAccount, toggleAccount } from './actions'
import { GROUPS, groupOf, LINK_GROUPS, digitsLabel } from '@/lib/accounts/constants.mjs'
import { usePermissions } from '@/components/Layout/AppLayout'
import {
    BookOpen, Loader2, Pencil, AlertTriangle, CheckCircle2, Search, Plus, X, Lock,
} from 'lucide-react'

const EMPTY_FORM = {
    id: null,
    account_number: '',
    name: '',
    account_group: 'asset',
    category: '',
    link_codes: [],
    is_active: true,
    is_system: false,
}

const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]))

/*
 * The next free number in a group, ten above the highest one in it, or the
 * group's first slot if it is empty. A suggestion, never a rule — the field
 * stays editable — but it means adding "Bank — Savings" does not begin with
 * scrolling the list to see what number 1020 was.
 */
const suggestNumber = (accounts, groupKey) => {
    const g = groupOf(groupKey)
    if (!g) return ''
    const first = g.digits[0]
    const last = g.digits[g.digits.length - 1]
    const nums = accounts
        .filter((a) => a.account_group === groupKey)
        .map((a) => Number(a.account_number))
        .filter(Number.isFinite)
    if (nums.length === 0) return `${first}000`
    // +5, not +10: the chart is four digits now, so a block like 7010-7095 has
    // room for a neighbour but not for a decade between every pair.
    const next = Math.max(...nums) + 5
    return next < (Number(last) + 1) * 1000 ? String(next) : ''
}

export default function ChartOfAccountsPage() {
    const { can } = usePermissions()
    const canEdit = can('accounts_admin')

    const [accounts, setAccounts] = useState([])
    const [isLoading, setIsLoading] = useState(true)
    const [groupFilter, setGroupFilter] = useState('all')
    const [search, setSearch] = useState('')
    const [showInactive, setShowInactive] = useState(false)
    const [form, setForm] = useState(EMPTY_FORM)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })

    const load = useCallback(async () => {
        const res = await listAccounts()
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setAccounts(res.data)
        setIsLoading(false)
    }, [])

    useEffect(() => { load() }, [load])

    useEffect(() => {
        if (message.type !== 'success') return
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const editing = form.id != null

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase()
        return accounts.filter((a) =>
            (groupFilter === 'all' || a.account_group === groupFilter)
            && (showInactive || a.is_active)
            && (!q || a.name.toLowerCase().includes(q) || a.account_number.includes(q)
                || a.category.toLowerCase().includes(q)))
    }, [accounts, groupFilter, search, showInactive])

    // Existing categories per group feed a datalist, so spelling stays
    // consistent without the category being a rigid lookup table.
    const categoriesFor = useMemo(() => {
        const map = {}
        for (const a of accounts) {
            (map[a.account_group] ||= new Set()).add(a.category)
        }
        return map
    }, [accounts])

    const counts = useMemo(() => {
        const c = { all: 0 }
        for (const a of accounts) {
            if (!a.is_active && !showInactive) continue
            c.all += 1
            c[a.account_group] = (c[a.account_group] || 0) + 1
        }
        return c
    }, [accounts, showInactive])

    const startNew = () => {
        setForm({ ...EMPTY_FORM, account_number: suggestNumber(accounts, 'asset') })
        setMessage({ type: '', text: '' })
    }

    const startEdit = (a) => {
        setForm({
            id: a.id,
            account_number: a.account_number,
            name: a.name,
            account_group: a.account_group,
            category: a.category,
            link_codes: [...a.link_codes],
            is_active: a.is_active,
            is_system: a.is_system,
        })
        setMessage({ type: '', text: '' })
    }

    const changeGroup = (key) => {
        setForm((p) => ({
            ...p,
            account_group: key,
            // Only re-suggest for a NEW account whose number still matches the
            // old group's digit — never overwrite a number someone typed.
            account_number: !p.id && (!p.account_number || !groupOf(key)?.digits.includes(p.account_number[0]))
                ? suggestNumber(accounts, key)
                : p.account_number,
        }))
    }

    const toggleCode = (code) => {
        setForm((p) => ({
            ...p,
            link_codes: p.link_codes.includes(code)
                ? p.link_codes.filter((c) => c !== code)
                : [...p.link_codes, code],
        }))
    }

    const submit = async (e) => {
        e.preventDefault()
        setSaving(true)
        setMessage({ type: '', text: '' })
        const res = await saveAccount({
            id: form.id || undefined,
            account_number: form.account_number,
            name: form.name,
            account_group: form.account_group,
            category: form.category,
            link_codes: form.link_codes,
            is_active: form.is_active,
        })
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
        } else {
            setMessage({ type: 'success', text: editing ? 'Account updated' : `Account ${res.data.account_number} added` })
            setForm(EMPTY_FORM)
            await load()
        }
        setSaving(false)
    }

    const flip = async (a) => {
        const res = await toggleAccount(a.id)
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setAccounts((prev) => prev.map((x) => (x.id === a.id ? res.data : x)))
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Chart of Accounts</h1>
                    <p className={styles.subtitle}>
                        Every account the books are kept in. Numbers say what they are:{' '}
                        {GROUPS.map((g) => `${digitsLabel(g)} ${g.label.toLowerCase()}`).join(' · ')}.
                    </p>
                </div>
                {canEdit && (
                    <div className={styles.headerActions}>
                        <button type="button" className={styles.primaryBtn} onClick={startNew}>
                            <Plus size={16} /> New account
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

            <div className={styles.filterRow}>
                <div className={styles.filterTabs} role="tablist" aria-label="Account group">
                    {[{ key: 'all', label: 'All' }, ...GROUPS].map((g) => (
                        <button
                            key={g.key}
                            type="button"
                            role="tab"
                            aria-selected={groupFilter === g.key}
                            className={`${styles.filterTab} ${groupFilter === g.key ? styles.filterActive : ''}`}
                            onClick={() => setGroupFilter(g.key)}
                        >
                            {g.label} {counts[g.key] ? `· ${counts[g.key]}` : ''}
                        </button>
                    ))}
                </div>
                <label className={styles.searchBox}>
                    <Search size={15} aria-hidden="true" />
                    <input
                        type="search"
                        placeholder="Number, name or category"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search accounts"
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
                            <p>Loading the chart…</p>
                        </div>
                    ) : visible.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <BookOpen size={28} />
                            <p>No accounts match.</p>
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Number</th>
                                    <th>Account</th>
                                    <th>Used for</th>
                                    <th>Status</th>
                                    {canEdit && <th></th>}
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((a) => (
                                    <tr key={a.id} className={a.is_active ? '' : styles.rowInactive}>
                                        <td className={styles.cellCode}>
                                            {a.account_number}
                                            <span className={styles.cellSub}>{GROUP_LABEL[a.account_group]}</span>
                                        </td>
                                        <td className={styles.cellName}>
                                            <span className={styles.cellStrong}>
                                                {a.name}
                                                {a.is_system && (
                                                    <span className={styles.sysTag} title="The ledger posts to this account automatically">
                                                        system
                                                    </span>
                                                )}
                                            </span>
                                            <span className={styles.cellSub}>{a.category}</span>
                                        </td>
                                        <td>
                                            <div className={styles.chipRow}>
                                                {a.link_codes.length === 0
                                                    ? <span className={styles.cellMuted}>—</span>
                                                    : a.link_codes.slice(0, 3).map((c) => (
                                                        <span key={c} className={styles.chip}>{c}</span>
                                                    ))}
                                                {a.link_codes.length > 3 && (
                                                    <span className={styles.chip} title={a.link_codes.slice(3).join(', ')}>
                                                        +{a.link_codes.length - 3}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td>
                                            <button
                                                type="button"
                                                className={`${styles.stateBtn} ${a.is_active ? styles.stateOn : styles.stateOff}`}
                                                onClick={() => flip(a)}
                                                disabled={!canEdit || a.is_system}
                                                aria-pressed={a.is_active}
                                                title={a.is_system
                                                    ? 'System accounts cannot be switched off'
                                                    : canEdit ? (a.is_active ? 'Deactivate' : 'Reactivate') : undefined}
                                            >
                                                {a.is_active ? 'Active' : 'Off'}
                                            </button>
                                        </td>
                                        {canEdit && (
                                            <td className={styles.alignRight}>
                                                <div className={styles.rowActions}>
                                                    <button
                                                        type="button"
                                                        className={styles.iconBtn}
                                                        onClick={() => startEdit(a)}
                                                        title="Edit account"
                                                        aria-label={`Edit ${a.name}`}
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
                                {editing ? <><Pencil size={16} /> Edit {form.account_number}</> : <><Plus size={16} /> New account</>}
                                {form.is_system && <Lock size={14} className={styles.cellMuted} title="System account" />}
                            </h2>

                            <div className={styles.fieldRow}>
                                <label className={styles.field}>
                                    <span className={`${styles.fieldLabel} ${styles.required}`}>Group</span>
                                    <select
                                        className={styles.input}
                                        value={form.account_group}
                                        onChange={(e) => changeGroup(e.target.value)}
                                    >
                                        {GROUPS.map((g) => (
                                            <option key={g.key} value={g.key}>{g.label} ({digitsLabel(g)})</option>
                                        ))}
                                    </select>
                                </label>
                                <label className={styles.field}>
                                    <span className={`${styles.fieldLabel} ${styles.required}`}>Number</span>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        pattern="\d{4}"
                                        maxLength={4}
                                        className={`${styles.input} ${styles.inputMono}`}
                                        value={form.account_number}
                                        onChange={(e) => setForm((p) => ({ ...p, account_number: e.target.value.replace(/\D/g, '') }))}
                                        placeholder={digitsLabel(groupOf(form.account_group))}
                                        required
                                    />
                                </label>
                            </div>

                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Name</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.name}
                                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                                    placeholder="Bank: Savings Account"
                                    maxLength={96}
                                    required
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={`${styles.fieldLabel} ${styles.required}`}>Category</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.category}
                                    onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                                    list="account-categories"
                                    placeholder="CURRENT ASSET"
                                    maxLength={48}
                                    required
                                    style={{ textTransform: 'uppercase' }}
                                />
                                <datalist id="account-categories">
                                    {[...(categoriesFor[form.account_group] || [])].map((c) => (
                                        <option key={c} value={c} />
                                    ))}
                                </datalist>
                                <span className={styles.hint}>
                                    How the reports group this account. Pick an existing one unless it is genuinely new.
                                </span>
                            </label>

                            <p className={styles.cardSection}>What this account may be used for</p>
                            {LINK_GROUPS.map((lg) => (
                                <div key={lg.title} className={styles.checkGroup}>
                                    <span className={styles.checkGroupTitle}>{lg.title}</span>
                                    {lg.codes.map(({ code, label }) => (
                                        <label key={code} className={styles.checkLine}>
                                            <input
                                                type="checkbox"
                                                checked={form.link_codes.includes(code)}
                                                onChange={() => toggleCode(code)}
                                            />
                                            <span>{label}<code>{code}</code></span>
                                        </label>
                                    ))}
                                </div>
                            ))}

                            {!form.is_system && (
                                <label className={styles.checkLine}>
                                    <input
                                        type="checkbox"
                                        checked={form.is_active}
                                        onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
                                    />
                                    <span>Active: offered in pickers and posted to</span>
                                </label>
                            )}
                            {form.is_system && (
                                <span className={styles.hint}>
                                    <Lock size={11} /> A system account: the ledger posts to it automatically. It can be renamed or renumbered, never switched off.
                                </span>
                            )}

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
                                    {editing ? 'Save changes' : 'Add account'}
                                </button>
                            </div>
                        </form>
                    </div>
                )}
            </div>
        </div>
    )
}

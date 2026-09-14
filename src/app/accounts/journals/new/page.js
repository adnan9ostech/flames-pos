'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import styles from '../../accounts.module.css'
import { getJournalForm, postJournalVoucher } from './actions'
// jvRules, not manualJournal: the rules are shared with the server, the
// database half must never reach the browser bundle.
import {
    cleanLines, money, OPENING_DESCRIPTION, OPENING_REFERENCE,
} from './jvRules.mjs'
import { usePermissions } from '@/components/Layout/AppLayout'
import {
    AlertTriangle, CheckCircle2, FilePlus2, Loader2, Lock, Plus, Trash2, X,
} from 'lucide-react'

/*
 * Add Transaction — ChowPOS's manual journal voucher. A header, a repeating
 * item list, and running Debit / Credit totals under the columns that say
 * out loud whether the voucher balances. Save posts immediately: there is no
 * draft JV, so the button is refused until the totals agree.
 */

const rupees = (n) =>
    `Rs. ${Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

let lineKey = 0
const newLine = (account_id = '') => ({ key: ++lineKey, account_id, debit: '', credit: '', memo: '' })

const GROUP_LABEL = { asset: 'Asset', liability: 'Liability', income: 'Income', expense: 'Expense', equity: 'Equity' }

export default function AddTransactionPage() {
    const router = useRouter()
    const { can } = usePermissions()
    const canPost = can('accounts_admin')

    const [form, setForm] = useState(null)
    const [loadError, setLoadError] = useState('')
    const [date, setDate] = useState('')
    const [description, setDescription] = useState('')
    const [reference, setReference] = useState('')
    const [notes, setNotes] = useState('')
    const [opening, setOpening] = useState(false)
    const [lines, setLines] = useState(() => [newLine(), newLine()])
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })

    const load = useCallback(async () => {
        const res = await getJournalForm()
        if (res.error) { setLoadError(res.error); return }
        setForm(res.data)
        setDate((d) => d || res.data.businessDate)
    }, [])

    useEffect(() => { load() }, [load])

    const accountById = useMemo(
        () => new Map((form?.accounts ?? []).map((a) => [String(a.id), a])),
        [form],
    )

    /* Live totals, rounded the way the server rounds. */
    const totals = useMemo(() => {
        const dr = money(lines.reduce((s, l) => s + money(l.debit), 0))
        const cr = money(lines.reduce((s, l) => s + money(l.credit), 0))
        return { dr, cr, diff: money(Math.abs(dr - cr)), balanced: dr === cr && dr > 0 }
    }, [lines])

    const patch = (key, field, value) =>
        setLines((prev) => prev.map((l) => {
            if (l.key !== key) return l
            // Debit or credit, never both: typing on one side clears the other.
            if (field === 'debit' && value !== '') return { ...l, debit: value, credit: '' }
            if (field === 'credit' && value !== '') return { ...l, credit: value, debit: '' }
            return { ...l, [field]: value }
        }))

    const remove = (key) => setLines((prev) => (prev.length > 2 ? prev.filter((l) => l.key !== key) : prev))
    const addLine = () => setLines((prev) => [...prev, newLine()])

    /*
     * Opening-balance mode: the spec's step-12 opening JV without a table of
     * its own. Fixes the header and pre-adds the equity line the balances
     * are posted against; switching it off leaves what was typed alone.
     */
    const toggleOpening = (on) => {
        setOpening(on)
        if (!on) return
        setReference(OPENING_REFERENCE)
        setDescription(OPENING_DESCRIPTION)
        const eq = form?.openingEquityAccountId
        if (eq && !lines.some((l) => String(l.account_id) === String(eq))) {
            setLines((prev) => {
                const blank = prev.findIndex((l) => !l.account_id && l.debit === '' && l.credit === '')
                const line = { ...newLine(String(eq)), memo: 'Opening balance equity' }
                if (blank === -1) return [...prev, line]
                return prev.map((l, i) => (i === blank ? line : l))
            })
        }
    }

    const submit = async (e) => {
        e.preventDefault()
        setMessage({ type: '', text: '' })
        // The same rules the server applies, so the round trip is never the
        // first place a mistake is heard about.
        try {
            cleanLines(lines)
        } catch (err) {
            setMessage({ type: 'error', text: err.message })
            return
        }
        if (!description.trim()) {
            setMessage({ type: 'error', text: 'A description is needed' })
            return
        }
        setSaving(true)
        const res = await postJournalVoucher({
            business_date: date,
            description,
            reference,
            notes,
            lines: lines.map((l) => ({
                account_id: l.account_id, debit: l.debit, credit: l.credit, memo: l.memo,
            })),
        })
        if (res.error) {
            setMessage({ type: 'error', text: res.error })
            setSaving(false)
            return
        }
        router.push(`/accounts/journals/${res.data.id}`)
    }

    if (loadError) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <AlertTriangle size={28} />
                    <p>{loadError}</p>
                </div>
            </div>
        )
    }

    if (!form) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={28} />
                    <p>Loading the chart…</p>
                </div>
            </div>
        )
    }

    const maxDate = [form.businessDate, form.today].sort().at(-1)

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Add Transaction</h1>
                    <p className={styles.subtitle}>
                        A manual journal voucher. It posts the moment you save, so debits must equal
                        credits: a mistake is put right with a second voucher, never by editing this one.
                    </p>
                </div>
                <div className={styles.headerActions}>
                    <Link href="/accounts/journals" className={styles.secondaryBtn}>
                        <X size={15} /> Back to vouchers
                    </Link>
                </div>
            </div>

            {!canPost && (
                <div className={`${styles.note} ${styles.noteWarn}`} role="status">
                    <Lock size={16} aria-hidden="true" />
                    Posting a manual journal needs the accounts-admin right. You can look, not save.
                </div>
            )}

            {message.type && (
                <div
                    role="alert"
                    className={`${styles.note} ${message.type === 'error' ? styles.noteError : styles.noteSuccess}`}
                >
                    {message.type === 'error'
                        ? <AlertTriangle size={16} aria-hidden="true" />
                        : <CheckCircle2 size={16} aria-hidden="true" />}
                    {message.text}
                </div>
            )}

            <form onSubmit={submit} className={styles.card}>
                <h2 className={styles.cardTitle}><FilePlus2 size={16} /> Voucher</h2>

                <div className={styles.fieldRow}>
                    <label className={styles.field} style={{ flex: '0 0 7rem' }}>
                        <span className={styles.fieldLabel}>Voucher type</span>
                        <input type="text" className={`${styles.input} ${styles.inputMono}`} value="JV" readOnly aria-readonly="true" />
                    </label>
                    <label className={styles.field} style={{ flex: '0 0 11rem' }}>
                        <span className={`${styles.fieldLabel} ${styles.required}`}>Date</span>
                        <input
                            type="date"
                            className={styles.input}
                            value={date}
                            max={maxDate}
                            onChange={(e) => setDate(e.target.value)}
                            required
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={`${styles.fieldLabel} ${styles.required}`}>Description</span>
                        <input
                            type="text"
                            className={styles.input}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Card settlement received from bank, net of fees"
                            maxLength={191}
                            required
                        />
                    </label>
                    <label className={styles.field} style={{ flex: '0 0 13rem' }}>
                        <span className={styles.fieldLabel}>Reference</span>
                        <input
                            type="text"
                            className={styles.input}
                            value={reference}
                            onChange={(e) => setReference(e.target.value)}
                            placeholder="Cheque no, bank ref…"
                            maxLength={64}
                        />
                    </label>
                </div>

                <div className={styles.fieldRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Notes</span>
                        <textarea
                            className={styles.input}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Anything the next reader should know. Kept in the audit trail."
                            maxLength={1000}
                            rows={2}
                        />
                    </label>
                </div>

                <label className={styles.checkLine}>
                    <input type="checkbox" checked={opening} onChange={(e) => toggleOpening(e.target.checked)} />
                    <span>
                        Opening balances: the pre-cutover position, posted against Opening Balance Equity.
                        Sets the reference to <code>{OPENING_REFERENCE}</code> and adds the equity line.
                    </span>
                </label>

                <p className={styles.cardSection}>Item list</p>

                <div className={styles.listWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th style={{ width: '38%' }}>Account</th>
                                <th className={styles.alignRight} style={{ width: '14%' }}>Debit</th>
                                <th className={styles.alignRight} style={{ width: '14%' }}>Credit</th>
                                <th>Memo</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {lines.map((l, i) => {
                                const a = accountById.get(String(l.account_id))
                                return (
                                    <tr key={l.key}>
                                        <td>
                                            <select
                                                className={styles.input}
                                                value={l.account_id}
                                                onChange={(e) => patch(l.key, 'account_id', e.target.value)}
                                                aria-label={`Line ${i + 1} account`}
                                            >
                                                <option value="">Account…</option>
                                                {form.accounts.map((acc) => (
                                                    <option key={acc.id} value={acc.id}>
                                                        {acc.account_number}: {acc.name}
                                                    </option>
                                                ))}
                                            </select>
                                            {a && <span className={styles.cellSub}>{GROUP_LABEL[a.account_group]}</span>}
                                        </td>
                                        <td>
                                            <input
                                                type="number"
                                                min="0"
                                                step="0.01"
                                                inputMode="decimal"
                                                className={`${styles.input} ${styles.inputNum}`}
                                                value={l.debit}
                                                onChange={(e) => patch(l.key, 'debit', e.target.value)}
                                                placeholder="0"
                                                aria-label={`Line ${i + 1} debit`}
                                            />
                                        </td>
                                        <td>
                                            <input
                                                type="number"
                                                min="0"
                                                step="0.01"
                                                inputMode="decimal"
                                                className={`${styles.input} ${styles.inputNum}`}
                                                value={l.credit}
                                                onChange={(e) => patch(l.key, 'credit', e.target.value)}
                                                placeholder="0"
                                                aria-label={`Line ${i + 1} credit`}
                                            />
                                        </td>
                                        <td>
                                            <input
                                                type="text"
                                                className={styles.input}
                                                value={l.memo}
                                                onChange={(e) => patch(l.key, 'memo', e.target.value)}
                                                placeholder="Memo"
                                                maxLength={191}
                                                aria-label={`Line ${i + 1} memo`}
                                            />
                                        </td>
                                        <td className={styles.alignRight}>
                                            <button
                                                type="button"
                                                className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                                onClick={() => remove(l.key)}
                                                disabled={lines.length <= 2}
                                                title={lines.length <= 2 ? 'A journal needs two lines' : 'Remove line'}
                                                aria-label={`Remove line ${i + 1}`}
                                            >
                                                <Trash2 size={15} />
                                            </button>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                        <tfoot className={styles.tfoot}>
                            <tr>
                                <td>Totals</td>
                                <td className={styles.cellNum}>{rupees(totals.dr)}</td>
                                <td className={styles.cellNum}>{rupees(totals.cr)}</td>
                                <td colSpan={2}>
                                    <span className={totals.balanced ? styles.balanced : styles.unbalanced} role="status" aria-live="polite">
                                        {totals.balanced
                                            ? <><CheckCircle2 size={14} style={{ verticalAlign: '-2px' }} /> Balanced</>
                                            : totals.dr === 0 && totals.cr === 0
                                                ? 'Nothing entered yet'
                                                : `Out of balance by ${rupees(totals.diff)}`}
                                    </span>
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                </div>

                <button type="button" className={`${styles.secondaryBtn} ${styles.addLineBtn}`} onClick={addLine}>
                    <Plus size={15} /> Add line
                </button>

                <div className={styles.formActions}>
                    <button
                        type="submit"
                        className={styles.primaryBtn}
                        disabled={!canPost || saving || !totals.balanced}
                        title={!totals.balanced ? 'Debits must equal credits before this can post' : undefined}
                    >
                        {saving ? <Loader2 size={16} className={styles.spinner} /> : <CheckCircle2 size={16} />}
                        {saving ? 'Posting…' : 'Save and post'}
                    </button>
                </div>
            </form>
        </div>
    )
}

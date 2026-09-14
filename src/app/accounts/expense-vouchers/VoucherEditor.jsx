'use client'

import { useEffect, useMemo, useState } from 'react'
import styles from '../accounts.module.css'
import own from './voucher.module.css'
import { saveDraft, postVoucher, deleteDraft } from './actions'
import {
    Plus, Trash2, Loader2, Save, CheckCircle2, X, AlertTriangle,
} from 'lucide-react'

/*
 * The expense voucher as a form — ChowPOS's document, field for field:
 * Date; an Expenses section of repeating Code | Description | Amount lines
 * with a running total; a Payments section of repeating Account | Amount |
 * Paid on | Reference lines; Remarks; then Delete / Save / Save & Post.
 *
 * Shared by /new (no voucher yet) and /[id] (a draft being edited). Numeric
 * fields hold the raw text the person typed, so "1" on the way to "1250"
 * is never normalised under the cursor; money is rounded once, on the
 * server. Save keeps the draft out of the books; Save & Post is the one
 * button that reaches the ledger and the drawer.
 */

const rupees = (n) => (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (n) => Math.round((Number(n) || 0) * 100) / 100

/* React keys for the repeating rows: a counter the whole module shares, so
 * a row keeps its identity through edits and never collides with a saved
 * line's id. Not a ref, because the initial rows are keyed during render. */
let nextKey = 1
const newLine = () => ({ key: nextKey++, expense_code_id: '', description: '', amount: '' })
const newPayment = (paid_on) => ({ key: nextKey++, account_id: '', amount: '', paid_on, reference: '' })

export default function VoucherEditor({ voucher = null, formData, onDone }) {

    const [form, setForm] = useState(() => ({
        business_date: voucher?.business_date || formData.today,
        remarks: voucher?.remarks || '',
        lines: voucher?.lines?.length
            ? voucher.lines.map((l) => ({
                key: nextKey++, expense_code_id: String(l.expense_code_id),
                description: l.description || '', amount: String(l.amount),
            }))
            : [newLine()],
        payments: (voucher?.payments || []).map((p) => ({
            key: nextKey++, account_id: String(p.account_id), amount: String(p.amount),
            paid_on: p.paid_on, reference: p.reference || '',
        })),
    }))
    const [busy, setBusy] = useState('')       // '' | 'save' | 'post' | 'delete'
    const [error, setError] = useState('')
    const [confirmDelete, setConfirmDelete] = useState(false)

    useEffect(() => { setError('') }, [form])

    const codeById = useMemo(() => new Map(formData.codes.map((c) => [String(c.id), c])), [formData.codes])

    const total = useMemo(() => money(form.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)), [form.lines])
    const paid = useMemo(() => money(form.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0)), [form.payments])
    const owed = money(total - paid)
    const overpaid = paid > total

    const patch = (list, key, field, value) =>
        setForm((f) => ({ ...f, [list]: f[list].map((l) => (l.key === key ? { ...l, [field]: value } : l)) }))
    const remove = (list, key) =>
        setForm((f) => ({ ...f, [list]: f[list].filter((l) => l.key !== key) }))

    const payload = () => ({
        id: voucher?.id,
        business_date: form.business_date,
        remarks: form.remarks,
        lines: form.lines.map(({ key, ...l }) => l),
        payments: form.payments.map(({ key, ...p }) => p),
    })

    const run = async (kind) => {
        setBusy(kind)
        setError('')
        const res = kind === 'post' ? await postVoucher(payload())
            : kind === 'save' ? await saveDraft(payload())
                : await deleteDraft(voucher.id)
        setBusy('')
        setConfirmDelete(false)
        if (res.error) { setError(res.error); return }
        onDone?.(kind, res.data)
    }

    const submit = (e) => { e.preventDefault(); run('save') }

    return (
        <form className={`${styles.card} ${own.doc}`} onSubmit={submit}>
            {error && (
                <div role="alert" className={`${styles.note} ${styles.noteError}`} style={{ marginBottom: 0 }}>
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            <div className={own.head}>
                <label className={styles.field}>
                    <span className={`${styles.fieldLabel} ${styles.required}`}>Date</span>
                    <input
                        type="date"
                        className={styles.input}
                        value={form.business_date}
                        onChange={(e) => setForm((f) => ({ ...f, business_date: e.target.value }))}
                        required
                    />
                    <span className={styles.hint}>The trading day the expense belongs to. The journal posts on this day.</span>
                </label>
                {voucher && (
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Voucher</span>
                        <div className={`${styles.input} ${styles.inputMono}`} style={{ display: 'flex', alignItems: 'center' }}>
                            {voucher.voucher_no}
                        </div>
                    </div>
                )}
            </div>

            {/* ---- Expenses ---- */}
            <div className={own.sectionHead}>
                <p className={styles.cardSection}>Expenses</p>
                <button
                    type="button"
                    className={`${styles.secondaryBtn} ${styles.addLineBtn}`}
                    onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, newLine()] }))}
                >
                    <Plus size={15} /> Add line
                </button>
            </div>
            <div className={styles.lines}>
                <div className={`${styles.lineRow} ${own.lineExpense} ${own.lineHeadRow}`}>
                    <span className={styles.lineHead}>Expense code *</span>
                    <span className={styles.lineHead}>Description</span>
                    <span className={`${styles.lineHead} ${styles.alignRight}`}>Amount *</span>
                    <span />
                </div>
                {form.lines.map((l) => {
                    const code = codeById.get(l.expense_code_id)
                    return (
                        <div key={l.key} className={`${styles.lineRow} ${own.lineExpense}`}>
                            <div className={styles.field}>
                                <select
                                    className={styles.input}
                                    value={l.expense_code_id}
                                    onChange={(e) => patch('lines', l.key, 'expense_code_id', e.target.value)}
                                    aria-label="Expense code"
                                    required
                                >
                                    <option value="">Pick a code…</option>
                                    {formData.codes.map((c) => (
                                        <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                                    ))}
                                </select>
                                {code && (
                                    <span className={styles.hint}>
                                        {code.category ? `${code.category} · ` : ''}Dr {code.account_name}
                                    </span>
                                )}
                            </div>
                            <input
                                type="text"
                                className={styles.input}
                                value={l.description}
                                onChange={(e) => patch('lines', l.key, 'description', e.target.value)}
                                placeholder={code ? code.name : 'What it was for'}
                                maxLength={191}
                                aria-label="Description"
                            />
                            <input
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                step="0.01"
                                className={`${styles.input} ${styles.inputNum}`}
                                value={l.amount}
                                onChange={(e) => patch('lines', l.key, 'amount', e.target.value)}
                                placeholder="0.00"
                                aria-label="Amount"
                                required
                            />
                            <div className={own.removeCell}>
                                <button
                                    type="button"
                                    className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                    onClick={() => remove('lines', l.key)}
                                    disabled={form.lines.length === 1}
                                    title="Remove line"
                                    aria-label="Remove line"
                                >
                                    <Trash2 size={15} />
                                </button>
                            </div>
                        </div>
                    )
                })}
                <div className={styles.lineTotals}>
                    <span>Total <strong>Rs. {rupees(total)}</strong></span>
                </div>
            </div>

            {/* ---- Payments ---- */}
            <div className={own.sectionHead}>
                <div>
                    <p className={styles.cardSection}>Payments</p>
                    <span className={styles.hint}>
                        Leave empty to book the whole voucher as a payable. Whatever the payments do not cover is owed.
                    </span>
                </div>
                <button
                    type="button"
                    className={`${styles.secondaryBtn} ${styles.addLineBtn}`}
                    onClick={() => setForm((f) => ({ ...f, payments: [...f.payments, newPayment(f.business_date || formData.today)] }))}
                    disabled={formData.payAccounts.length === 0}
                    title={formData.payAccounts.length === 0 ? 'No account carries AP_PAID. Set one on the chart first' : undefined}
                >
                    <Plus size={15} /> Add payment
                </button>
            </div>
            {form.payments.length > 0 && (
                <div className={styles.lines}>
                    <div className={`${styles.lineRow} ${own.linePayment} ${own.lineHeadRow}`}>
                        <span className={styles.lineHead}>Paid from *</span>
                        <span className={`${styles.lineHead} ${styles.alignRight}`}>Amount *</span>
                        <span className={styles.lineHead}>Paid on *</span>
                        <span className={styles.lineHead}>Reference</span>
                        <span />
                    </div>
                    {form.payments.map((p) => (
                        <div key={p.key} className={`${styles.lineRow} ${own.linePayment}`}>
                            <select
                                className={styles.input}
                                value={p.account_id}
                                onChange={(e) => patch('payments', p.key, 'account_id', e.target.value)}
                                aria-label="Paid from account"
                                required
                            >
                                <option value="">Pick an account…</option>
                                {formData.payAccounts.map((a) => (
                                    <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                                ))}
                            </select>
                            <input
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                step="0.01"
                                className={`${styles.input} ${styles.inputNum}`}
                                value={p.amount}
                                onChange={(e) => patch('payments', p.key, 'amount', e.target.value)}
                                placeholder="0.00"
                                aria-label="Payment amount"
                                required
                            />
                            <input
                                type="date"
                                className={styles.input}
                                value={p.paid_on}
                                onChange={(e) => patch('payments', p.key, 'paid_on', e.target.value)}
                                aria-label="Paid on"
                                required
                            />
                            <input
                                type="text"
                                className={styles.input}
                                value={p.reference}
                                onChange={(e) => patch('payments', p.key, 'reference', e.target.value)}
                                placeholder="Cheque no., transfer ref"
                                maxLength={64}
                                aria-label="Reference"
                            />
                            <div className={own.removeCell}>
                                <button
                                    type="button"
                                    className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                    onClick={() => remove('payments', p.key)}
                                    title="Remove payment"
                                    aria-label="Remove payment"
                                >
                                    <Trash2 size={15} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <div className={styles.lineTotals}>
                <span>Paid <strong>Rs. {rupees(paid)}</strong></span>
                <span className={overpaid ? styles.unbalanced : ''}>
                    {overpaid ? 'Over by' : 'Owed'} <strong>Rs. {rupees(Math.abs(owed))}</strong>
                </span>
            </div>
            {overpaid && (
                <span className={`${styles.hint} ${styles.unbalanced}`}>
                    Payments exceed the total. Reduce a payment or add the missing expense line.
                </span>
            )}

            <label className={styles.field}>
                <span className={styles.fieldLabel}>Remarks</span>
                <textarea
                    className={styles.input}
                    value={form.remarks}
                    onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                    placeholder="Payee, invoice number, why. This becomes the payee on the Expenses screen"
                    maxLength={191}
                    rows={2}
                />
            </label>

            <div className={`${styles.formActions} ${voucher ? styles.formActionsSplit : ''}`}>
                {voucher && (
                    <button
                        type="button"
                        className={`${styles.secondaryBtn} ${styles.dangerOutline}`}
                        onClick={() => setConfirmDelete(true)}
                        disabled={Boolean(busy)}
                    >
                        <Trash2 size={15} /> Delete
                    </button>
                )}
                <div className={styles.headerActions}>
                    <button type="submit" className={styles.secondaryBtn} disabled={Boolean(busy) || overpaid}>
                        {busy === 'save' ? <Loader2 size={15} className={styles.spinner} /> : <Save size={15} />}
                        Save
                    </button>
                    <button
                        type="button"
                        className={styles.primaryBtn}
                        onClick={() => run('post')}
                        disabled={Boolean(busy) || overpaid}
                        title="Writes the journal and puts the lines on the Expenses screen"
                    >
                        {busy === 'post' ? <Loader2 size={16} className={styles.spinner} /> : <CheckCircle2 size={16} />}
                        Save &amp; Post
                    </button>
                </div>
            </div>

            {confirmDelete && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="ev-delete-title">
                    <div className={styles.modal}>
                        <h2 id="ev-delete-title" className={styles.modalTitle}>Delete {voucher.voucher_no}?</h2>
                        <p className={styles.modalBody}>
                            It is a draft, so nothing has reached the ledger or the drawer. The number will not be reused.
                        </p>
                        <div className={styles.modalActions}>
                            <button type="button" className={styles.secondaryBtn} onClick={() => setConfirmDelete(false)} disabled={busy === 'delete'}>
                                <X size={15} /> Keep it
                            </button>
                            <button type="button" className={`${styles.secondaryBtn} ${styles.dangerOutline}`} onClick={() => run('delete')} disabled={busy === 'delete'}>
                                {busy === 'delete' ? <Loader2 size={15} className={styles.spinner} /> : <Trash2 size={15} />}
                                Delete draft
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </form>
    )
}

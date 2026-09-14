'use client'

import { useCallback, useEffect, useState } from 'react'
import {
    Building2, Plus, Loader2, AlertTriangle, CheckCircle2, X, MapPin, Phone, Check,
} from 'lucide-react'
import { listBranches, getBranch, saveBranch } from './actions'
import SettingsTabs from '@/components/settings/SettingsTabs'

/*
 * The outlets, and what each one does differently.
 *
 * The grammar of the editor is one idea: EVERY OVERRIDE BOX IS ALLOWED TO BE
 * EMPTY, and empty means "whatever the company says" — which is shown right
 * there as the placeholder. So an operator never has to know what the company
 * charges in order to leave it alone, and clearing a box is how an override is
 * removed. There is no separate "use default" switch to get out of step with
 * the value beside it.
 */

const pct = (fraction) => (fraction == null ? '' : String(Number((fraction * 100).toFixed(2))))

const EMPTY = {
    id: null, name: '', code: '', address: '', phone: '', is_active: true, sort_order: 0,
}

const field =
    'w-full min-h-[44px] rounded-lg bg-background border border-input px-3 text-foreground ' +
    'placeholder-muted focus:outline-none focus:ring-2 focus:ring-focus focus:border-primary'

const Label = ({ children, hint }) => (
    <div className="mb-1.5">
        <span className="text-sm font-medium text-card-foreground">{children}</span>
        {hint && <span className="ml-2 text-xs text-muted-foreground">{hint}</span>}
    </div>
)

export default function BranchesPage() {
    const [rows, setRows] = useState(null)
    const [current, setCurrent] = useState(null)
    const [editing, setEditing] = useState(null)   // {branch, override, company, authorities}
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState(false)

    const load = useCallback(() => listBranches().then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else { setRows(res.data.branches); setCurrent(res.data.currentBranchId) }
    }), [])

    useEffect(() => { load() }, [load])
    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    // A new branch borrows only the COMPANY column from an existing read — the
    // placeholders that tell the operator what it is about to inherit.
    const openNew = () => getBranch(rows?.[0]?.id ?? 1).then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setEditing({ ...res.data, branch: EMPTY, override: {} })
    })

    const openEdit = (id) => getBranch(id).then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setEditing(res.data)
    })

    const submit = async (formData) => {
        setBusy(true)
        const res = await saveBranch(formData)
        setBusy(false)
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setMessage({ type: 'success', text: res.success })
        setEditing(null)
        load()
    }

    return (
        <div className="max-w-5xl mx-auto p-6">
            <div className="mb-6 flex items-start gap-3">
                <Building2 className="h-7 w-7 text-muted-foreground mt-1" />
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Branches</h1>
                    <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                        One company, one menu, one customer book. Each outlet keeps its own orders, cash,
                        tables, stock and day. A branch only stores what it does <em>differently</em>, so
                        leaving a box empty here means it follows the company, and raising the company&rsquo;s
                        tax rate later still reaches it.
                    </p>
                </div>
            </div>

            <SettingsTabs active="branches" />

            {message.type && (
                <div className={`flex items-start gap-3 p-4 mb-5 rounded-lg border text-sm ${message.type === 'error'
                    ? 'bg-danger-soft border-danger-border text-danger-text'
                    : 'bg-success-soft border-success-border text-success-text'}`}
                >
                    {message.type === 'error' ? <AlertTriangle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
                    {message.text}
                </div>
            )}

            {!rows ? (
                <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
                <>
                    <div className="bg-surface rounded-xl border border-border overflow-hidden mb-5">
                        {rows.map((b) => (
                            <button
                                key={b.id}
                                type="button"
                                onClick={() => openEdit(b.id)}
                                className="w-full text-left flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5 border-b border-border last:border-b-0 hover:bg-surface-raise"
                            >
                                <span className="font-semibold text-card-foreground">{b.name}</span>
                                {b.code && (
                                    <span className="text-xs px-2 py-0.5 rounded bg-surface-raise border border-border text-muted-foreground">
                                        {b.code}
                                    </span>
                                )}
                                {b.id === current && (
                                    <span className="text-xs px-2 py-0.5 rounded bg-selected text-selected-foreground border border-selected-border font-medium">
                                        you are here
                                    </span>
                                )}
                                {!b.is_active && (
                                    <span className="text-xs px-2 py-0.5 rounded bg-danger-soft border border-danger-border text-danger-text">
                                        closed
                                    </span>
                                )}
                                <span className="flex-1" />
                                {b.tax_rate_cash != null && (
                                    <span className="text-xs text-muted-foreground">
                                        own tax {pct(b.tax_rate_cash)}%{b.tax_authority ? ` · ${b.tax_authority}` : ''}
                                    </span>
                                )}
                                <span className="text-xs text-muted-foreground">
                                    {b.order_count.toLocaleString()} orders · {b.staff_count} staff
                                </span>
                            </button>
                        ))}
                    </div>

                    <button
                        type="button"
                        onClick={openNew}
                        className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg"
                    >
                        <Plus className="h-4 w-4" />Add a branch
                    </button>
                </>
            )}

            {editing && (
                <Editor
                    state={editing}
                    busy={busy}
                    onClose={() => setEditing(null)}
                    onSubmit={submit}
                />
            )}
        </div>
    )
}

function Editor({ state, busy, onClose, onSubmit }) {
    const { branch, override, company, authorities } = state
    const isNew = !branch.id

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
            <form
                action={onSubmit}
                className="bg-surface rounded-xl border border-border w-full max-w-2xl my-4"
            >
                <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
                    <Building2 className="h-5 w-5 text-muted-foreground" />
                    <h2 className="text-lg font-semibold text-card-foreground flex-1">
                        {isNew ? 'New branch' : branch.name}
                    </h2>
                    <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-surface-raise">
                        <X className="h-5 w-5 text-muted-foreground" />
                    </button>
                </div>

                <input type="hidden" name="id" value={branch.id ?? ''} />

                <div className="p-5 space-y-6">
                    <section className="space-y-4">
                        <div className="grid sm:grid-cols-3 gap-4">
                            <div className="sm:col-span-2">
                                <Label>Branch name</Label>
                                <input name="name" defaultValue={branch.name} required className={field}
                                    placeholder="Flames Gulberg" />
                            </div>
                            <div>
                                <Label hint="short">Code</Label>
                                <input name="code" defaultValue={branch.code} className={field} placeholder="GLB" />
                            </div>
                        </div>
                        <div>
                            <Label hint="printed on this branch's bills">Address</Label>
                            <div className="relative">
                                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <input name="address" defaultValue={branch.address}
                                    className={`${field} pl-9`} placeholder={company.address || 'Street, city'} />
                            </div>
                        </div>
                        <div className="grid sm:grid-cols-2 gap-4">
                            <div>
                                <Label>Phone</Label>
                                <div className="relative">
                                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <input name="phone" defaultValue={branch.phone}
                                        className={`${field} pl-9`} placeholder={company.phone || '0300 0000000'} />
                                </div>
                            </div>
                            <div>
                                <Label hint="lower shows first">Order in lists</Label>
                                <input name="sort_order" type="number" defaultValue={branch.sort_order ?? 0}
                                    className={field} />
                            </div>
                        </div>
                        <label className="flex items-center gap-3 cursor-pointer">
                            <input type="checkbox" name="is_active" value="true" defaultChecked={branch.is_active !== false}
                                className="h-5 w-5 rounded accent-[var(--color-primary)]" />
                            <span className="text-sm text-card-foreground">
                                Open for business
                                <span className="block text-xs text-muted-foreground">
                                    A closed branch keeps all its history and disappears from the switcher.
                                </span>
                            </span>
                        </label>
                        {/* A bare checkbox submits nothing when unchecked, which
                            reads identically to the field not being on the form.
                            This pairs it so "off" is a value that arrives. */}
                        <input type="hidden" name="is_active" value="false" />
                    </section>

                    <section className="border-t border-border pt-5 space-y-4">
                        <div>
                            <h3 className="text-sm font-semibold text-card-foreground">What this branch does differently</h3>
                            <p className="text-xs text-muted-foreground mt-1">
                                Empty means it follows the company. The grey text in each box is what it follows.
                            </p>
                        </div>

                        <div className="grid sm:grid-cols-3 gap-4">
                            <div>
                                <Label hint="%">Tax on cash</Label>
                                <input name="tax_rate_cash" inputMode="decimal"
                                    defaultValue={pct(override.tax_rate_cash)}
                                    placeholder={pct(company.tax_rate_cash)} className={field} />
                            </div>
                            <div>
                                <Label hint="%">Tax on card</Label>
                                <input name="tax_rate_card" inputMode="decimal"
                                    defaultValue={pct(override.tax_rate_card)}
                                    placeholder={pct(company.tax_rate_card)} className={field} />
                            </div>
                            <div>
                                <Label>Tax called</Label>
                                <input name="tax_label" defaultValue={override.tax_label ?? ''}
                                    placeholder={company.tax_label} className={field} />
                            </div>
                        </div>

                        <div className="grid sm:grid-cols-3 gap-4">
                            <div>
                                <Label>Files to</Label>
                                <select name="tax_authority" defaultValue={override.tax_authority ?? ''} className={field}>
                                    <option value="">Same as company</option>
                                    {authorities.map((a) => <option key={a} value={a}>{a}</option>)}
                                </select>
                            </div>
                            <div>
                                <Label hint="this outlet's own">POS ID</Label>
                                <input name="fbr_pos_id" defaultValue={override.fbr_pos_id ?? ''}
                                    placeholder="registered separately" className={field} />
                            </div>
                            <div>
                                <Label>NTN</Label>
                                <input name="fbr_ntn" defaultValue={override.fbr_ntn ?? ''}
                                    placeholder="company NTN" className={field} />
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Each outlet registers its own POS with the authority and gets its own ID. The token
                            that goes with it is a credential and lives in the server environment, never here.
                        </p>

                        <div>
                            <Label hint="under the total">Bill footer</Label>
                            <input name="receipt_footer" defaultValue={override.receipt_footer ?? ''}
                                placeholder="Thank you. No refunds after 24 hours." className={field} />
                        </div>

                        <div className="grid sm:grid-cols-4 gap-4">
                            <div>
                                <Label>Opens</Label>
                                <input name="day_start_time" type="time" defaultValue={override.day_start_time ?? ''}
                                    className={field} />
                            </div>
                            <div>
                                <Label>Closes</Label>
                                <input name="day_end_time" type="time" defaultValue={override.day_end_time ?? ''}
                                    className={field} />
                            </div>
                            <div>
                                <Label hint="Rs">Till float</Label>
                                <input name="opening_float" inputMode="decimal"
                                    defaultValue={override.opening_float ?? ''}
                                    placeholder={String(company.opening_float)} className={field} />
                            </div>
                            <div>
                                <Label hint="Rs">Short allowed</Label>
                                <input name="variance_tolerance" inputMode="decimal"
                                    defaultValue={override.variance_tolerance ?? ''}
                                    placeholder={String(company.variance_tolerance)} className={field} />
                            </div>
                        </div>
                    </section>
                </div>

                <div className="flex justify-end gap-3 px-5 py-4 border-t border-border">
                    <button type="button" onClick={onClose}
                        className="px-4 py-2.5 rounded-lg border border-border text-foreground hover:bg-surface-raise">
                        Cancel
                    </button>
                    <button type="submit" disabled={busy}
                        className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg disabled:opacity-40">
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        {isNew ? 'Add branch' : 'Save'}
                    </button>
                </div>
            </form>
        </div>
    )
}

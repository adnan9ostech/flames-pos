'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import styles from './receiving.module.css'
import { getReceivingData, createReceiving, createDraft } from './actions'
import { useRole } from '@/components/Layout/AppLayout'
import { formatDateTime } from '@/lib/timeFormat'
import {
    Truck, ClipboardList, Plus, Trash2, Loader2, AlertTriangle,
    CheckCircle2, ChevronLeft, ChevronDown, ChevronRight, X,
} from 'lucide-react'

const rupees = (n, digits = 2) =>
    Number(n).toLocaleString('en-PK', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const qtyFmt = (n) => Number(n).toLocaleString('en-PK', { maximumFractionDigits: 3 })

const STATUS_LABEL = { open: 'Open', fulfilled: 'Fulfilled', cancelled: 'Cancelled' }

export default function ReceivingPage() {
    const role = useRole()
    const canEdit = role === 'admin'

    const [data, setData] = useState(null)
    const [loadError, setLoadError] = useState('')

    // GRN form. Numeric fields hold the raw strings the operator typed, so a
    // half-entered "1" on the way to "12.5" isn't normalised under the cursor.
    const keyRef = useRef(1)
    const newLine = () => ({ key: keyRef.current++, itemId: '', qty: '', cost: '' })
    const [form, setForm] = useState({ supplierId: '', warehouseId: '', draftId: '', invoice: '', notes: '' })
    const [lines, setLines] = useState([newLine()])
    const [busy, setBusy] = useState(false)
    const [formError, setFormError] = useState('')
    const [posted, setPosted] = useState('')

    // Demand-draft mini flow.
    const [draftOpen, setDraftOpen] = useState(false)
    const [draftLines, setDraftLines] = useState([newLine()])
    const [draftNotes, setDraftNotes] = useState('')
    const [draftBusy, setDraftBusy] = useState(false)
    const [draftError, setDraftError] = useState('')

    const [expandedId, setExpandedId] = useState(null)

    const load = useCallback(async () => {
        const res = await getReceivingData()
        if (res.error) setLoadError(res.error)
        else {
            setLoadError('')
            setData(res.data)
        }
    }, [])

    useEffect(() => { load() }, [load])

    // One warehouse is the overwhelming case; picking it saves a tap per GRN.
    useEffect(() => {
        if (data && !form.warehouseId && data.warehouses.length > 0) {
            setForm((f) => ({ ...f, warehouseId: String(data.warehouses[0].id) }))
        }
    }, [data, form.warehouseId])

    // The success note clears on its own; errors stay until the next attempt.
    useEffect(() => {
        if (!posted) return
        const timer = setTimeout(() => setPosted(''), 6000)
        return () => clearTimeout(timer)
    }, [posted])

    const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

    const setLineField = (setter) => (key, field, value) =>
        setter((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)))
    const patchLine = setLineField(setLines)
    const patchDraftLine = setLineField(setDraftLines)

    /*
     * Referencing a draft pre-fills the lines with what was asked for — the
     * receiver corrects quantities to what actually arrived and types the
     * costs off the supplier's invoice.
     */
    const pickDraft = (e) => {
        const draftId = e.target.value
        setForm((f) => ({ ...f, draftId }))
        const draft = data?.drafts.find((d) => String(d.id) === draftId)
        if (draft && draft.lines.length > 0) {
            setLines(draft.lines.map((l) => ({
                key: keyRef.current++,
                itemId: String(l.inventory_item_id),
                qty: String(l.qty),
                cost: '',
            })))
        }
    }

    const completeLines = lines.filter((l) => l.itemId && Number(l.qty) > 0 && l.cost !== '')
    const runningTotal = completeLines.reduce((sum, l) => sum + Number(l.qty) * Number(l.cost), 0)

    const postReceiving = async () => {
        setFormError('')
        setPosted('')
        if (!form.supplierId) { setFormError('Pick a supplier'); return }
        if (completeLines.length === 0) {
            setFormError('At least one line needs an item, a quantity and a unit cost')
            return
        }
        setBusy(true)
        const res = await createReceiving({
            supplierId: Number(form.supplierId),
            warehouseId: Number(form.warehouseId),
            draftId: form.draftId ? Number(form.draftId) : null,
            supplierInvoice: form.invoice,
            notes: form.notes,
            lines: completeLines.map((l) => ({
                itemId: Number(l.itemId), qty: Number(l.qty), unitCost: Number(l.cost),
            })),
        })
        if (res.error) {
            setFormError(res.error)
        } else {
            setPosted(`GRN #${res.data.id} posted: Rs. ${rupees(res.data.total)}`)
            setForm((f) => ({ ...f, draftId: '', invoice: '', notes: '' }))
            setLines([newLine()])
            await load()
        }
        setBusy(false)
    }

    const postDraft = async () => {
        setDraftError('')
        const complete = draftLines.filter((l) => l.itemId && Number(l.qty) > 0)
        if (complete.length === 0) {
            setDraftError('At least one line needs an item and a quantity')
            return
        }
        setDraftBusy(true)
        const res = await createDraft({
            notes: draftNotes,
            lines: complete.map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty) })),
        })
        if (res.error) {
            setDraftError(res.error)
        } else {
            setDraftOpen(false)
            setDraftLines([newLine()])
            setDraftNotes('')
            await load()
        }
        setDraftBusy(false)
    }

    if (loadError) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.errorNote}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {loadError}
                </div>
            </div>
        )
    }

    if (!data) {
        return (
            <div className={styles.container}>
                <PageHeader />
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading receiving…</p>
                </div>
            </div>
        )
    }

    const itemById = new Map(data.items.map((i) => [String(i.id), i]))
    const openDrafts = data.drafts.filter((d) => d.status === 'open')

    const lineRow = (line, patch, remove, withCost) => {
        const item = itemById.get(line.itemId)
        return (
            <tr key={line.key}>
                <td>
                    <select
                        className={styles.inputSelect}
                        value={line.itemId}
                        onChange={(e) => patch(line.key, 'itemId', e.target.value)}
                    >
                        <option value="" disabled>Item…</option>
                        {data.items.map((i) => (
                            <option key={i.id} value={i.id}>{i.name} ({i.unit_abbrev})</option>
                        ))}
                    </select>
                </td>
                <td className={styles.alignRight}>
                    <input
                        className={`${styles.input} ${styles.inputNarrow}`}
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={line.qty}
                        onChange={(e) => patch(line.key, 'qty', e.target.value)}
                        placeholder="0"
                        aria-label="Quantity"
                    />
                </td>
                {withCost && (
                    <>
                        <td className={styles.alignRight}>
                            <input
                                className={`${styles.input} ${styles.inputNarrow}`}
                                type="number"
                                min="0"
                                step="any"
                                inputMode="decimal"
                                value={line.cost}
                                onChange={(e) => patch(line.key, 'cost', e.target.value)}
                                placeholder={item ? rupees(item.avg_cost) : '0'}
                                aria-label="Unit cost"
                            />
                        </td>
                        <td className={`${styles.alignRight} ${styles.num}`}>
                            {line.qty && line.cost !== ''
                                ? `Rs. ${rupees(Number(line.qty) * Number(line.cost))}`
                                : <span className={styles.cellMuted}>—</span>}
                        </td>
                    </>
                )}
                <td className={styles.alignRight}>
                    <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={remove}
                        aria-label="Remove line"
                        title="Remove line"
                    >
                        <Trash2 size={15} />
                    </button>
                </td>
            </tr>
        )
    }

    return (
        <div className={styles.container}>
            <PageHeader />

            {canEdit && (
                <div className={styles.card}>
                    <div className={styles.cardHead}>
                        <div className={styles.cardIcon}><Truck size={20} /></div>
                        <div>
                            <h2 className={styles.cardTitle}>New receiving</h2>
                            <p className={styles.cardBlurb}>
                                Goods in against a supplier invoice. Posting updates stock and each
                                item&apos;s average cost.
                            </p>
                        </div>
                    </div>

                    <div className={styles.formGrid}>
                        <label className={styles.fieldLabel}>
                            Supplier
                            <select className={styles.inputSelect} value={form.supplierId} onChange={setField('supplierId')}>
                                <option value="" disabled>Pick a supplier…</option>
                                {data.suppliers.map((s) => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className={styles.fieldLabel}>
                            Warehouse
                            <select className={styles.inputSelect} value={form.warehouseId} onChange={setField('warehouseId')}>
                                {data.warehouses.map((w) => (
                                    <option key={w.id} value={w.id}>{w.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className={styles.fieldLabel}>
                            Demand draft
                            <select className={styles.inputSelect} value={form.draftId} onChange={pickDraft}>
                                <option value="">None: direct receiving</option>
                                {openDrafts.map((d) => (
                                    <option key={d.id} value={d.id}>
                                        Draft #{d.id} · {d.lines.length} item{d.lines.length === 1 ? '' : 's'}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className={styles.fieldLabel}>
                            Supplier invoice #
                            <input
                                className={styles.input}
                                value={form.invoice}
                                onChange={setField('invoice')}
                                maxLength={64}
                                placeholder="Optional"
                            />
                        </label>
                        <label className={`${styles.fieldLabel} ${styles.fieldWide}`}>
                            Notes
                            <input
                                className={styles.input}
                                value={form.notes}
                                onChange={setField('notes')}
                                maxLength={191}
                                placeholder="Optional"
                            />
                        </label>
                    </div>

                    <div className={styles.linesWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Item</th>
                                    <th className={styles.alignRight}>Qty</th>
                                    <th className={styles.alignRight}>Unit cost</th>
                                    <th className={styles.alignRight}>Line total</th>
                                    <th className={styles.alignRight}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {lines.map((l) => lineRow(
                                    l, patchLine,
                                    () => setLines((prev) => prev.length > 1 ? prev.filter((x) => x.key !== l.key) : [newLine()]),
                                    true,
                                ))}
                            </tbody>
                            <tfoot>
                                <tr>
                                    <td>
                                        <button
                                            type="button"
                                            className={styles.ghostBtn}
                                            onClick={() => setLines((prev) => [...prev, newLine()])}
                                        >
                                            <Plus size={15} aria-hidden="true" />
                                            Add line
                                        </button>
                                    </td>
                                    <td colSpan={2} className={`${styles.alignRight} ${styles.totalLabel}`}>Total</td>
                                    <td className={`${styles.alignRight} ${styles.totalValue}`}>
                                        Rs. {rupees(runningTotal)}
                                    </td>
                                    <td></td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>

                    {formError && (
                        <div className={styles.errorNote}>
                            <AlertTriangle size={16} aria-hidden="true" />
                            {formError}
                        </div>
                    )}
                    {posted && (
                        <div className={styles.successNote} role="status" aria-live="polite">
                            <CheckCircle2 size={16} aria-hidden="true" />
                            {posted}
                        </div>
                    )}

                    <div className={styles.cardFoot}>
                        <button type="button" className={styles.primaryBtn} onClick={postReceiving} disabled={busy}>
                            {busy ? <Loader2 size={15} className={styles.spinner} /> : <Truck size={15} aria-hidden="true" />}
                            Post receiving
                        </button>
                    </div>
                </div>
            )}

            <div className={styles.card}>
                <div className={styles.cardHead}>
                    <div className={styles.cardIcon}><ClipboardList size={20} /></div>
                    <div>
                        <h2 className={styles.cardTitle}>Demand drafts</h2>
                        <p className={styles.cardBlurb}>
                            What the kitchen asks for before money moves. A draft closes when a
                            receiving references it.
                        </p>
                    </div>
                    {canEdit && !draftOpen && (
                        <button type="button" className={styles.addBtn} onClick={() => setDraftOpen(true)}>
                            <Plus size={15} aria-hidden="true" />
                            New draft
                        </button>
                    )}
                </div>

                {draftOpen && (
                    <div className={styles.draftForm}>
                        <div className={styles.linesWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Item</th>
                                        <th className={styles.alignRight}>Qty</th>
                                        <th className={styles.alignRight}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {draftLines.map((l) => lineRow(
                                        l, patchDraftLine,
                                        () => setDraftLines((prev) => prev.length > 1 ? prev.filter((x) => x.key !== l.key) : [newLine()]),
                                        false,
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr>
                                        <td colSpan={3}>
                                            <button
                                                type="button"
                                                className={styles.ghostBtn}
                                                onClick={() => setDraftLines((prev) => [...prev, newLine()])}
                                            >
                                                <Plus size={15} aria-hidden="true" />
                                                Add line
                                            </button>
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                        <input
                            className={styles.input}
                            value={draftNotes}
                            onChange={(e) => setDraftNotes(e.target.value)}
                            maxLength={191}
                            placeholder="Notes (optional)"
                        />
                        {draftError && (
                            <div className={styles.errorNote}>
                                <AlertTriangle size={16} aria-hidden="true" />
                                {draftError}
                            </div>
                        )}
                        <div className={styles.cardFoot}>
                            <button
                                type="button"
                                className={styles.ghostBtn}
                                onClick={() => { setDraftOpen(false); setDraftError('') }}
                                disabled={draftBusy}
                            >
                                <X size={15} aria-hidden="true" />
                                Cancel
                            </button>
                            <button type="button" className={styles.primaryBtn} onClick={postDraft} disabled={draftBusy}>
                                {draftBusy ? <Loader2 size={15} className={styles.spinner} /> : <Plus size={15} aria-hidden="true" />}
                                Save draft
                            </button>
                        </div>
                    </div>
                )}

                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Draft</th>
                                <th>Created</th>
                                <th>Items</th>
                                <th>Notes</th>
                                <th className={styles.alignRight}>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.drafts.map((d) => (
                                <tr key={d.id}>
                                    <td className={styles.cellStrong}>#{d.id}</td>
                                    <td className={styles.cellMuted}>{formatDateTime(new Date(d.created_at))}</td>
                                    <td className={styles.cellMuted}>
                                        {d.lines.map((l) => `${l.item_name} ${qtyFmt(l.qty)} ${l.unit_abbrev}`).join(', ') || '—'}
                                    </td>
                                    <td className={styles.cellMuted}>{d.notes || '—'}</td>
                                    <td className={styles.alignRight}>
                                        <span className={`${styles.chip} ${styles[`chip_${d.status}`] ?? ''}`}>
                                            {STATUS_LABEL[d.status] ?? d.status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                            {data.drafts.length === 0 && (
                                <tr><td colSpan={5} className={styles.emptyCell}>No demand drafts yet.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className={styles.card}>
                <div className={styles.cardHead}>
                    <div className={styles.cardIcon}><Truck size={20} /></div>
                    <div>
                        <h2 className={styles.cardTitle}>Recent receivings</h2>
                        <p className={styles.cardBlurb}>The last 20 GRNs, newest first. Click a row for its lines.</p>
                    </div>
                </div>

                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th></th>
                                <th>GRN</th>
                                <th>Date</th>
                                <th>Supplier</th>
                                <th>Warehouse</th>
                                <th>Invoice</th>
                                <th>Draft</th>
                                <th className={styles.alignRight}>Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.receivings.map((r) => (
                                <ReceivingRow
                                    key={r.id}
                                    receiving={r}
                                    expanded={expandedId === r.id}
                                    onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
                                />
                            ))}
                            {data.receivings.length === 0 && (
                                <tr><td colSpan={8} className={styles.emptyCell}>Nothing received yet.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

function ReceivingRow({ receiving, expanded, onToggle }) {
    return (
        <>
            <tr className={styles.clickableRow} onClick={onToggle}>
                <td className={styles.chevCell}>
                    {expanded
                        ? <ChevronDown size={15} aria-hidden="true" />
                        : <ChevronRight size={15} aria-hidden="true" />}
                </td>
                <td className={styles.cellStrong}>#{receiving.id}</td>
                <td className={styles.cellMuted}>{receiving.business_date}</td>
                <td>{receiving.supplier_name}</td>
                <td className={styles.cellMuted}>{receiving.warehouse_name}</td>
                <td className={styles.cellMuted}>{receiving.supplier_invoice || '—'}</td>
                <td className={styles.cellMuted}>{receiving.draft_id ? `#${receiving.draft_id}` : '—'}</td>
                <td className={`${styles.alignRight} ${styles.num} ${styles.cellStrong}`}>
                    Rs. {rupees(receiving.total)}
                </td>
            </tr>
            {expanded && (
                <tr>
                    <td colSpan={8} className={styles.detailCell}>
                        <table className={styles.subTable}>
                            <thead>
                                <tr>
                                    <th>Item</th>
                                    <th className={styles.alignRight}>Qty</th>
                                    <th className={styles.alignRight}>Unit cost</th>
                                    <th className={styles.alignRight}>Line total</th>
                                </tr>
                            </thead>
                            <tbody>
                                {receiving.lines.map((l, i) => (
                                    <tr key={i}>
                                        <td>{l.item_name}</td>
                                        <td className={`${styles.alignRight} ${styles.num}`}>
                                            {qtyFmt(l.qty)} {l.unit_abbrev}
                                        </td>
                                        <td className={`${styles.alignRight} ${styles.num}`}>Rs. {rupees(l.unit_cost)}</td>
                                        <td className={`${styles.alignRight} ${styles.num}`}>
                                            Rs. {rupees(Number(l.qty) * Number(l.unit_cost))}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {receiving.notes && <p className={styles.detailNotes}>{receiving.notes}</p>}
                    </td>
                </tr>
            )}
        </>
    )
}

function PageHeader() {
    return (
        <div className={styles.header}>
            <div>
                <Link href="/inventory" className={styles.backLink}>
                    <ChevronLeft size={15} aria-hidden="true" />
                    Inventory
                </Link>
                <h1 className={styles.title}>Receiving</h1>
                <p className={styles.subtitle}>
                    Goods in: every GRN moves stock, sets average cost and grows the
                    supplier payable.
                </p>
            </div>
        </div>
    )
}

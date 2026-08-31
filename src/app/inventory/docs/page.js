'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Link from 'next/link'
import styles from './docs.module.css'
import { getDocsData, createTransfer, createAdjustment, createMisc, createCount } from './actions'
import { useRole } from '@/components/Layout/AppLayout'
import {
    ArrowRightLeft, SlidersHorizontal, Utensils, ClipboardCheck,
    Plus, Trash2, Loader2, AlertTriangle, CheckCircle2, ChevronLeft,
} from 'lucide-react'

const TABS = [
    { key: 'transfer', label: 'Transfer', Icon: ArrowRightLeft },
    { key: 'adjustment', label: 'Adjustment', Icon: SlidersHorizontal },
    { key: 'misc', label: 'Misc consumption', Icon: Utensils },
    { key: 'count', label: 'Count', Icon: ClipboardCheck },
]

const qtyFmt = (n) => Number(n).toLocaleString('en-PK', { maximumFractionDigits: 3 })

/* Signed quantities keep their sign on screen: +2 found, −2 written off. */
const signedFmt = (n) => (Number(n) > 0 ? `+${qtyFmt(n)}` : qtyFmt(n))

export default function StockDocsPage() {
    const role = useRole()
    const canEdit = role === 'admin'

    const [data, setData] = useState(null)
    const [loadError, setLoadError] = useState('')
    const [tab, setTab] = useState('transfer')

    // Line drafts hold raw input strings so half-typed numbers aren't
    // normalised under the cursor.
    const keyRef = useRef(1)
    const newLine = () => ({ key: keyRef.current++, itemId: '', qty: '' })
    const [transfer, setTransfer] = useState({ fromId: '', toId: '', reason: '', lines: [newLine()] })
    const [adjust, setAdjust] = useState({ warehouseId: '', reason: '', lines: [newLine()] })
    const [misc, setMisc] = useState({ warehouseId: '', reason: '', lines: [newLine()] })
    const [count, setCount] = useState({ warehouseId: '', counts: {} })

    const [busy, setBusy] = useState(false)
    const [formError, setFormError] = useState('')
    const [posted, setPosted] = useState('')

    const load = useCallback(async () => {
        const res = await getDocsData()
        if (res.error) setLoadError(res.error)
        else {
            setLoadError('')
            setData(res.data)
        }
    }, [])

    useEffect(() => { load() }, [load])

    // One warehouse is the overwhelming case; picking it saves a tap per doc.
    useEffect(() => {
        if (!data || data.warehouses.length === 0) return
        const first = String(data.warehouses[0].id)
        const second = String(data.warehouses[1]?.id ?? data.warehouses[0].id)
        setTransfer((f) => (f.fromId ? f : { ...f, fromId: first, toId: second }))
        setAdjust((f) => (f.warehouseId ? f : { ...f, warehouseId: first }))
        setMisc((f) => (f.warehouseId ? f : { ...f, warehouseId: first }))
        setCount((f) => (f.warehouseId ? f : { ...f, warehouseId: first }))
    }, [data])

    // The success note clears on its own; errors stay until the next attempt.
    useEffect(() => {
        if (!posted) return
        const timer = setTimeout(() => setPosted(''), 6000)
        return () => clearTimeout(timer)
    }, [posted])

    /* On-hand per item per warehouse, straight off the ledger sums. */
    const stockMap = useMemo(() => {
        const map = new Map()
        for (const s of data?.stock ?? []) {
            map.set(`${s.inventory_item_id}:${s.warehouse_id}`, s.qty)
        }
        return map
    }, [data])
    const onHand = (itemId, warehouseId) => stockMap.get(`${itemId}:${warehouseId}`) ?? 0

    const switchTab = (next) => {
        setTab(next)
        setFormError('')
        setPosted('')
    }

    const submit = async (action, payload, describe) => {
        setBusy(true)
        setFormError('')
        setPosted('')
        const res = await action(payload)
        if (res.error) {
            setFormError(res.error)
        } else {
            setPosted(describe(res.data))
            await load()
        }
        setBusy(false)
        return !res.error
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
                    <p>Loading stock documents…</p>
                </div>
            </div>
        )
    }

    const warehouseSelect = (value, onChange, label) => (
        <label className={styles.fieldLabel}>
            {label}
            <select className={styles.inputSelect} value={value} onChange={onChange}>
                {data.warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                ))}
            </select>
        </label>
    )

    /*
     * The shared line editor: item + quantity, an optional on-hand column for
     * context, and signed input where the document calls for it.
     */
    const lineEditor = (form, setFormState, { signed = false, hintWarehouse = null } = {}) => (
        <div className={styles.linesWrap}>
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>Item</th>
                        <th className={styles.alignRight}>{signed ? '+ / − Qty' : 'Qty'}</th>
                        {hintWarehouse != null && <th className={styles.alignRight}>On hand</th>}
                        <th className={styles.alignRight}></th>
                    </tr>
                </thead>
                <tbody>
                    {form.lines.map((line) => (
                        <tr key={line.key}>
                            <td>
                                <select
                                    className={styles.inputSelect}
                                    value={line.itemId}
                                    onChange={(e) => setFormState((f) => ({
                                        ...f,
                                        lines: f.lines.map((l) => (l.key === line.key ? { ...l, itemId: e.target.value } : l)),
                                    }))}
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
                                    step="any"
                                    min={signed ? undefined : '0'}
                                    inputMode="decimal"
                                    value={line.qty}
                                    onChange={(e) => setFormState((f) => ({
                                        ...f,
                                        lines: f.lines.map((l) => (l.key === line.key ? { ...l, qty: e.target.value } : l)),
                                    }))}
                                    placeholder="0"
                                    aria-label="Quantity"
                                />
                            </td>
                            {hintWarehouse != null && (
                                <td className={`${styles.alignRight} ${styles.num} ${styles.cellMuted}`}>
                                    {line.itemId ? qtyFmt(onHand(Number(line.itemId), Number(hintWarehouse))) : '—'}
                                </td>
                            )}
                            <td className={styles.alignRight}>
                                <button
                                    type="button"
                                    className={styles.iconBtn}
                                    onClick={() => setFormState((f) => ({
                                        ...f,
                                        lines: f.lines.length > 1 ? f.lines.filter((l) => l.key !== line.key) : [newLine()],
                                    }))}
                                    aria-label="Remove line"
                                    title="Remove line"
                                >
                                    <Trash2 size={15} />
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr>
                        <td colSpan={hintWarehouse != null ? 4 : 3}>
                            <button
                                type="button"
                                className={styles.ghostBtn}
                                onClick={() => setFormState((f) => ({ ...f, lines: [...f.lines, newLine()] }))}
                            >
                                <Plus size={15} aria-hidden="true" />
                                Add line
                            </button>
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    )

    const completeLines = (form, { signed = false } = {}) =>
        form.lines.filter((l) => l.itemId && (signed ? Number(l.qty) !== 0 && l.qty !== '' : Number(l.qty) > 0))

    /* ===== Per-tab submit handlers ===== */

    const postTransfer = async () => {
        const ok = await submit(createTransfer, {
            fromWarehouseId: Number(transfer.fromId),
            toWarehouseId: Number(transfer.toId),
            reason: transfer.reason,
            lines: completeLines(transfer).map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty) })),
        }, (d) => `Transfer #${d.id} posted`)
        if (ok) setTransfer((f) => ({ ...f, reason: '', lines: [newLine()] }))
    }

    const postAdjustment = async () => {
        const ok = await submit(createAdjustment, {
            warehouseId: Number(adjust.warehouseId),
            reason: adjust.reason,
            lines: completeLines(adjust, { signed: true }).map((l) => ({ itemId: Number(l.itemId), delta: Number(l.qty) })),
        }, (d) => `Adjustment #${d.id} posted`)
        if (ok) setAdjust((f) => ({ ...f, reason: '', lines: [newLine()] }))
    }

    const postMisc = async () => {
        const ok = await submit(createMisc, {
            warehouseId: Number(misc.warehouseId),
            reason: misc.reason,
            lines: completeLines(misc).map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty) })),
        }, (d) => `Consumption #${d.id} posted`)
        if (ok) setMisc((f) => ({ ...f, reason: '', lines: [newLine()] }))
    }

    const countedEntries = Object.entries(count.counts).filter(([, v]) => v !== '')

    const postCountDoc = async () => {
        const ok = await submit(createCount, {
            warehouseId: Number(count.warehouseId),
            lines: countedEntries.map(([itemId, v]) => ({ itemId: Number(itemId), countedQty: Number(v) })),
        }, (d) => {
            const n = d.variances.filter((v) => v.delta !== 0).length
            return `Count #${d.id} posted — ${n === 0 ? 'no corrections needed' : `${n} correction${n === 1 ? '' : 's'}`}`
        })
        if (ok) setCount((f) => ({ ...f, counts: {} }))
    }

    /* ===== Recent documents, shared across tabs ===== */

    const describeLine = (l, docType) =>
        docType === 'adjustment'
            ? `${l.item_name} ${signedFmt(l.qty)} ${l.unit_abbrev}`
            : `${l.item_name} ${qtyFmt(l.qty)} ${l.unit_abbrev}`

    const recentDocs = (docType) => {
        const docs = data.docs[docType] ?? []
        const isTransfer = docType === 'transfer'
        const isCount = docType === 'count'
        return (
            <div className={styles.tableWrap}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Doc</th>
                            <th>Date</th>
                            <th>{isTransfer ? 'From → To' : 'Warehouse'}</th>
                            <th>{isCount ? 'Counted' : 'Lines'}</th>
                            {!isCount && <th>Reason</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {docs.map((d) => (
                            <tr key={d.id}>
                                <td className={styles.cellStrong}>#{d.id}</td>
                                <td className={styles.cellMuted}>{d.business_date}</td>
                                <td className={styles.cellMuted}>
                                    {isTransfer ? `${d.warehouse_name} → ${d.to_warehouse_name}` : d.warehouse_name}
                                </td>
                                <td>{d.lines.map((l) => describeLine(l, docType)).join(', ') || '—'}</td>
                                {!isCount && <td className={styles.cellMuted}>{d.reason || '—'}</td>}
                            </tr>
                        ))}
                        {docs.length === 0 && (
                            <tr>
                                <td colSpan={isCount ? 4 : 5} className={styles.emptyCell}>
                                    No {TABS.find((t) => t.key === docType)?.label.toLowerCase()} documents yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        )
    }

    const notes = (
        <>
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
        </>
    )

    const postButton = (label, onClick, disabled = false) => (
        <div className={styles.cardFoot}>
            <button type="button" className={styles.primaryBtn} onClick={onClick} disabled={busy || disabled}>
                {busy ? <Loader2 size={15} className={styles.spinner} /> : <CheckCircle2 size={15} aria-hidden="true" />}
                {label}
            </button>
        </div>
    )

    return (
        <div className={styles.container}>
            <PageHeader />

            <div className={styles.tabs}>
                {TABS.map(({ key, label, Icon }) => (
                    <button
                        key={key}
                        type="button"
                        className={`${styles.tab} ${tab === key ? styles.activeTab : ''}`}
                        onClick={() => switchTab(key)}
                    >
                        <Icon size={15} aria-hidden="true" />
                        {label}
                    </button>
                ))}
            </div>

            {tab === 'transfer' && (
                <>
                    {canEdit && (
                        <div className={styles.card}>
                            <div className={styles.formGrid}>
                                {warehouseSelect(transfer.fromId, (e) => setTransfer((f) => ({ ...f, fromId: e.target.value })), 'From warehouse')}
                                {warehouseSelect(transfer.toId, (e) => setTransfer((f) => ({ ...f, toId: e.target.value })), 'To warehouse')}
                                <label className={`${styles.fieldLabel} ${styles.fieldWide}`}>
                                    Reason
                                    <input
                                        className={styles.input}
                                        value={transfer.reason}
                                        onChange={(e) => setTransfer((f) => ({ ...f, reason: e.target.value }))}
                                        maxLength={191}
                                        placeholder="Optional"
                                    />
                                </label>
                            </div>
                            {lineEditor(transfer, setTransfer, { hintWarehouse: transfer.fromId })}
                            {notes}
                            {postButton('Post transfer', postTransfer)}
                        </div>
                    )}
                    {recentDocs('transfer')}
                </>
            )}

            {tab === 'adjustment' && (
                <>
                    {canEdit && (
                        <div className={styles.card}>
                            <div className={styles.formGrid}>
                                {warehouseSelect(adjust.warehouseId, (e) => setAdjust((f) => ({ ...f, warehouseId: e.target.value })), 'Warehouse')}
                                <label className={`${styles.fieldLabel} ${styles.fieldWide}`}>
                                    Reason (required)
                                    <input
                                        className={styles.input}
                                        value={adjust.reason}
                                        onChange={(e) => setAdjust((f) => ({ ...f, reason: e.target.value }))}
                                        maxLength={191}
                                        placeholder="Spoilage, found stock, data entry fix…"
                                    />
                                </label>
                            </div>
                            {lineEditor(adjust, setAdjust, { signed: true, hintWarehouse: adjust.warehouseId })}
                            <p className={styles.hint}>
                                Positive adds stock, negative removes it — a −2 writes two off.
                            </p>
                            {notes}
                            {postButton('Post adjustment', postAdjustment)}
                        </div>
                    )}
                    {recentDocs('adjustment')}
                </>
            )}

            {tab === 'misc' && (
                <>
                    {canEdit && (
                        <div className={styles.card}>
                            <div className={styles.formGrid}>
                                {warehouseSelect(misc.warehouseId, (e) => setMisc((f) => ({ ...f, warehouseId: e.target.value })), 'Warehouse')}
                                <label className={`${styles.fieldLabel} ${styles.fieldWide}`}>
                                    Reason
                                    <input
                                        className={styles.input}
                                        value={misc.reason}
                                        onChange={(e) => setMisc((f) => ({ ...f, reason: e.target.value }))}
                                        maxLength={191}
                                        placeholder="Staff meal, tasting, breakage…"
                                    />
                                </label>
                            </div>
                            {lineEditor(misc, setMisc, { hintWarehouse: misc.warehouseId })}
                            {notes}
                            {postButton('Post consumption', postMisc)}
                        </div>
                    )}
                    {recentDocs('misc')}
                </>
            )}

            {tab === 'count' && (
                <>
                    {canEdit && (
                        <div className={styles.card}>
                            <div className={styles.formGrid}>
                                {warehouseSelect(count.warehouseId, (e) => setCount({ warehouseId: e.target.value, counts: {} }), 'Warehouse')}
                            </div>
                            <p className={styles.hint}>
                                Type what the shelf actually holds. Only filled rows post; each one
                                books the variance shown, not the counted number itself.
                            </p>
                            <div className={styles.linesWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Item</th>
                                            <th className={styles.alignRight}>System</th>
                                            <th className={styles.alignRight}>Counted</th>
                                            <th className={styles.alignRight}>Variance</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.items.map((item) => {
                                            const system = onHand(item.id, Number(count.warehouseId))
                                            const raw = count.counts[item.id] ?? ''
                                            const variance = raw === '' ? null : Number(raw) - system
                                            return (
                                                <tr key={item.id}>
                                                    <td className={styles.cellStrong}>{item.name}</td>
                                                    <td className={`${styles.alignRight} ${styles.num} ${styles.cellMuted}`}>
                                                        {qtyFmt(system)} {item.unit_abbrev}
                                                    </td>
                                                    <td className={styles.alignRight}>
                                                        <input
                                                            className={`${styles.input} ${styles.inputNarrow}`}
                                                            type="number"
                                                            min="0"
                                                            step="any"
                                                            inputMode="decimal"
                                                            value={raw}
                                                            onChange={(e) => setCount((f) => ({
                                                                ...f,
                                                                counts: { ...f.counts, [item.id]: e.target.value },
                                                            }))}
                                                            placeholder="—"
                                                            aria-label={`Counted ${item.name}`}
                                                        />
                                                    </td>
                                                    <td className={`${styles.alignRight} ${styles.num} ${variance == null ? styles.cellMuted
                                                        : variance < 0 ? styles.varianceShort
                                                            : variance > 0 ? styles.varianceOver : styles.cellMuted}`}
                                                    >
                                                        {variance == null ? '—' : variance === 0 ? 'matches' : signedFmt(variance)}
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                        {data.items.length === 0 && (
                                            <tr><td colSpan={4} className={styles.emptyCell}>No stock items yet.</td></tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            {notes}
                            {postButton(
                                countedEntries.length === 0
                                    ? 'Post count'
                                    : `Post count (${countedEntries.length} item${countedEntries.length === 1 ? '' : 's'})`,
                                postCountDoc,
                                countedEntries.length === 0,
                            )}
                        </div>
                    )}
                    {recentDocs('count')}
                </>
            )}
        </div>
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
                <h1 className={styles.title}>Stock Documents</h1>
                <p className={styles.subtitle}>
                    Transfers, adjustments, misc consumption and counts — every one posts
                    through the same ledger the sales engine writes.
                </p>
            </div>
        </div>
    )
}

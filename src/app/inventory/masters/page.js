'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import styles from './masters.module.css'
import { getMasters, saveItem, saveUnit, saveSupplier, saveWarehouse } from './actions'
import { useRole } from '@/components/Layout/AppLayout'
import {
    Boxes, Ruler, Truck, Warehouse, Plus, Pencil, Check, X,
    Loader2, AlertTriangle, ChevronLeft,
} from 'lucide-react'

const TABS = [
    { key: 'items', label: 'Items', Icon: Boxes },
    { key: 'units', label: 'Units', Icon: Ruler },
    { key: 'suppliers', label: 'Suppliers', Icon: Truck },
    { key: 'warehouses', label: 'Warehouses', Icon: Warehouse },
]

const rupees = (n, digits = 2) =>
    Number(n).toLocaleString('en-PK', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const qtyFmt = (n) => Number(n).toLocaleString('en-PK', { maximumFractionDigits: 3 })

export default function MastersPage() {
    const role = useRole()
    const canEdit = role === 'admin'

    const [tab, setTab] = useState('items')
    const [data, setData] = useState(null)
    const [loadError, setLoadError] = useState('')

    // One form open at a time across every tab: {id} for a row being edited,
    // {id: null} for the add form, null for none. The draft holds raw input
    // strings so half-typed numbers aren't normalised under the cursor.
    const [editing, setEditing] = useState(null)
    const [draft, setDraft] = useState({})
    const [busy, setBusy] = useState(false)
    const [formError, setFormError] = useState('')

    const load = useCallback(async () => {
        const res = await getMasters()
        if (res.error) setLoadError(res.error)
        else {
            setLoadError('')
            setData(res.data)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const closeForm = () => {
        setEditing(null)
        setDraft({})
        setFormError('')
    }

    const openForm = (id, seed) => {
        setEditing({ id })
        setDraft(seed)
        setFormError('')
    }

    const switchTab = (next) => {
        setTab(next)
        closeForm()
    }

    const setField = (key) => (e) => {
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
        setDraft((prev) => ({ ...prev, [key]: value }))
    }

    const submit = async (action, payload) => {
        setBusy(true)
        setFormError('')
        const res = await action(payload)
        if (res.error) {
            setFormError(res.error)
        } else {
            closeForm()
            await load()
        }
        setBusy(false)
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
                    <p>Loading masters…</p>
                </div>
            </div>
        )
    }

    const isAdding = editing && editing.id === null
    const editingId = editing?.id ?? null

    /* Shared row-form controls: save on the left so Enter lands there. */
    const FormActions = ({ onSave }) => (
        <span className={styles.rowActions}>
            <button
                type="button"
                className={styles.saveBtn}
                onClick={onSave}
                disabled={busy}
                aria-label="Save"
                title="Save"
            >
                {busy ? <Loader2 size={15} className={styles.spinner} /> : <Check size={15} />}
            </button>
            <button
                type="button"
                className={styles.iconBtn}
                onClick={closeForm}
                disabled={busy}
                aria-label="Cancel"
                title="Cancel"
            >
                <X size={15} />
            </button>
        </span>
    )

    const EditBtn = ({ onClick }) => (
        <button
            type="button"
            className={styles.iconBtn}
            onClick={onClick}
            aria-label="Edit"
            title="Edit"
        >
            <Pencil size={15} />
        </button>
    )

    /* ===== Items tab ===== */

    const saveItemDraft = () => submit(saveItem, {
        id: editingId,
        name: draft.name,
        unit_id: Number(draft.unit_id),
        reorder_level: Number(draft.reorder_level) || 0,
        is_active: draft.is_active !== false,
    })

    /* The readonly columns keep showing the row's facts while it's edited —
       blanking them would make an edit look like it wiped the stock. */
    const itemFormCells = (item = null) => (
        <>
            <td>
                <input
                    className={styles.input}
                    value={draft.name ?? ''}
                    onChange={setField('name')}
                    placeholder="Chicken (boneless)"
                    maxLength={191}
                    autoFocus
                />
            </td>
            <td>
                <select
                    className={styles.inputSelect}
                    value={draft.unit_id ?? ''}
                    onChange={setField('unit_id')}
                >
                    <option value="" disabled>Unit…</option>
                    {data.units.map((u) => (
                        <option key={u.id} value={u.id}>{u.name} ({u.abbrev})</option>
                    ))}
                </select>
            </td>
            <td className={`${styles.alignRight} ${styles.num}`}>
                {item
                    ? <>{qtyFmt(item.current_qty)} {item.unit_abbrev}</>
                    : <span className={styles.cellMuted}>—</span>}
            </td>
            <td className={`${styles.alignRight} ${styles.num}`}>
                {item
                    ? <>Rs. {rupees(item.avg_cost)}</>
                    : <span className={styles.cellMuted}>—</span>}
            </td>
            <td className={styles.alignRight}>
                <input
                    className={`${styles.input} ${styles.inputNarrow}`}
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={draft.reorder_level ?? ''}
                    onChange={setField('reorder_level')}
                    placeholder="0"
                />
            </td>
            <td className={styles.alignCenter}>
                <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={draft.is_active !== false}
                    onChange={setField('is_active')}
                    aria-label="Active"
                />
            </td>
            <td className={styles.alignRight}>
                <FormActions onSave={saveItemDraft} />
            </td>
        </>
    )

    const renderItems = () => (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th>Item</th>
                    <th>Unit</th>
                    <th className={styles.alignRight}>On hand</th>
                    <th className={styles.alignRight}>Avg cost</th>
                    <th className={styles.alignRight}>Reorder at</th>
                    <th className={styles.alignCenter}>Active</th>
                    <th className={styles.alignRight}></th>
                </tr>
            </thead>
            <tbody>
                {isAdding && <tr className={styles.formRow}>{itemFormCells()}</tr>}
                {data.items.map((item) => {
                    if (editingId === item.id) {
                        return <tr key={item.id} className={styles.formRow}>{itemFormCells(item)}</tr>
                    }
                    const low = item.reorder_level > 0 && Number(item.current_qty) < Number(item.reorder_level)
                    return (
                        <tr key={item.id} className={item.is_active ? '' : styles.inactiveRow}>
                            <td className={styles.cellStrong}>{item.name}</td>
                            <td className={styles.cellMuted}>{item.unit_abbrev}</td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {qtyFmt(item.current_qty)} {item.unit_abbrev}
                                {low && (
                                    <span className={styles.lowChip}>
                                        <AlertTriangle size={11} aria-hidden="true" />
                                        low
                                    </span>
                                )}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                Rs. {rupees(item.avg_cost)}
                            </td>
                            <td className={`${styles.alignRight} ${styles.num}`}>
                                {item.reorder_level > 0 ? qtyFmt(item.reorder_level) : '—'}
                            </td>
                            <td className={styles.alignCenter}>
                                {item.is_active ? <Check size={15} className={styles.activeMark} /> : '—'}
                            </td>
                            <td className={styles.alignRight}>
                                {/* Edited where it can be edited whole — name,
                                    unit, rate, reorder level and category on
                                    one form, rather than half of them here. */}
                                {canEdit && (
                                    <Link
                                        href="/menu/ingredients"
                                        className={styles.inlineLink}
                                        title="Edit this ingredient in Menu → Ingredients"
                                    >
                                        Edit
                                    </Link>
                                )}
                            </td>
                        </tr>
                    )
                })}
                {data.items.length === 0 && !isAdding && (
                    <tr><td colSpan={7} className={styles.emptyCell}>No stock items yet.</td></tr>
                )}
            </tbody>
        </table>
    )

    /* ===== Units tab ===== */

    const saveUnitDraft = () => submit(saveUnit, {
        id: editingId, name: draft.name, abbrev: draft.abbrev,
    })

    const unitFormCells = () => (
        <>
            <td>
                <input
                    className={styles.input}
                    value={draft.name ?? ''}
                    onChange={setField('name')}
                    placeholder="Kilogram"
                    maxLength={32}
                    autoFocus
                />
            </td>
            <td>
                <input
                    className={`${styles.input} ${styles.inputNarrow}`}
                    value={draft.abbrev ?? ''}
                    onChange={setField('abbrev')}
                    placeholder="kg"
                    maxLength={8}
                />
            </td>
            <td className={styles.alignRight}>
                <FormActions onSave={saveUnitDraft} />
            </td>
        </>
    )

    const renderUnits = () => (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th>Unit</th>
                    <th>Abbreviation</th>
                    <th className={styles.alignRight}></th>
                </tr>
            </thead>
            <tbody>
                {isAdding && <tr className={styles.formRow}>{unitFormCells()}</tr>}
                {data.units.map((unit) => (
                    editingId === unit.id
                        ? <tr key={unit.id} className={styles.formRow}>{unitFormCells()}</tr>
                        : (
                            <tr key={unit.id}>
                                <td className={styles.cellStrong}>{unit.name}</td>
                                <td className={styles.cellMuted}>{unit.abbrev}</td>
                                <td className={styles.alignRight}>
                                    {canEdit && (
                                        <EditBtn onClick={() => openForm(unit.id, {
                                            name: unit.name, abbrev: unit.abbrev,
                                        })} />
                                    )}
                                </td>
                            </tr>
                        )
                ))}
            </tbody>
        </table>
    )

    /* ===== Suppliers tab ===== */

    const saveSupplierDraft = () => submit(saveSupplier, {
        id: editingId,
        name: draft.name,
        phone: draft.phone,
        ntn: draft.ntn,
        address: draft.address,
        is_active: draft.is_active !== false,
    })

    const supplierFormCells = () => (
        <>
            <td>
                <input
                    className={styles.input}
                    value={draft.name ?? ''}
                    onChange={setField('name')}
                    placeholder="Metro Cash & Carry"
                    maxLength={191}
                    autoFocus
                />
            </td>
            <td>
                <input
                    className={styles.input}
                    value={draft.phone ?? ''}
                    onChange={setField('phone')}
                    placeholder="0300…"
                    maxLength={32}
                />
            </td>
            <td>
                <input
                    className={styles.input}
                    value={draft.ntn ?? ''}
                    onChange={setField('ntn')}
                    placeholder="NTN"
                    maxLength={16}
                />
            </td>
            <td>
                <input
                    className={styles.input}
                    value={draft.address ?? ''}
                    onChange={setField('address')}
                    placeholder="Address"
                    maxLength={500}
                />
            </td>
            <td className={styles.alignCenter}>
                <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={draft.is_active !== false}
                    onChange={setField('is_active')}
                    aria-label="Active"
                />
            </td>
            <td className={styles.alignRight}>
                <FormActions onSave={saveSupplierDraft} />
            </td>
        </>
    )

    const renderSuppliers = () => (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th>Supplier</th>
                    <th>Phone</th>
                    <th>NTN</th>
                    <th>Address</th>
                    <th className={styles.alignCenter}>Active</th>
                    <th className={styles.alignRight}></th>
                </tr>
            </thead>
            <tbody>
                {isAdding && <tr className={styles.formRow}>{supplierFormCells()}</tr>}
                {data.suppliers.map((s) => (
                    editingId === s.id
                        ? <tr key={s.id} className={styles.formRow}>{supplierFormCells()}</tr>
                        : (
                            <tr key={s.id} className={s.is_active ? '' : styles.inactiveRow}>
                                <td className={styles.cellStrong}>{s.name}</td>
                                <td className={styles.cellMuted}>{s.phone || '—'}</td>
                                <td className={styles.cellMuted}>{s.ntn || '—'}</td>
                                <td className={styles.cellMuted}>{s.address || '—'}</td>
                                <td className={styles.alignCenter}>
                                    {s.is_active ? <Check size={15} className={styles.activeMark} /> : '—'}
                                </td>
                                <td className={styles.alignRight}>
                                    {canEdit && (
                                        <EditBtn onClick={() => openForm(s.id, {
                                            name: s.name,
                                            phone: s.phone ?? '',
                                            ntn: s.ntn ?? '',
                                            address: s.address ?? '',
                                            is_active: s.is_active,
                                        })} />
                                    )}
                                </td>
                            </tr>
                        )
                ))}
                {data.suppliers.length === 0 && !isAdding && (
                    <tr><td colSpan={6} className={styles.emptyCell}>No suppliers yet.</td></tr>
                )}
            </tbody>
        </table>
    )

    /* ===== Warehouses tab ===== */

    const saveWarehouseDraft = () => submit(saveWarehouse, {
        id: editingId, name: draft.name,
    })

    const warehouseFormCells = () => (
        <>
            <td>
                <input
                    className={styles.input}
                    value={draft.name ?? ''}
                    onChange={setField('name')}
                    placeholder="Main Store"
                    maxLength={64}
                    autoFocus
                />
            </td>
            <td className={styles.alignRight}>
                <FormActions onSave={saveWarehouseDraft} />
            </td>
        </>
    )

    const renderWarehouses = () => (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th>Warehouse</th>
                    <th className={styles.alignRight}></th>
                </tr>
            </thead>
            <tbody>
                {isAdding && <tr className={styles.formRow}>{warehouseFormCells()}</tr>}
                {data.warehouses.map((w) => (
                    editingId === w.id
                        ? <tr key={w.id} className={styles.formRow}>{warehouseFormCells()}</tr>
                        : (
                            <tr key={w.id}>
                                <td className={styles.cellStrong}>{w.name}</td>
                                <td className={styles.alignRight}>
                                    {canEdit && (
                                        <EditBtn onClick={() => openForm(w.id, { name: w.name })} />
                                    )}
                                </td>
                            </tr>
                        )
                ))}
            </tbody>
        </table>
    )

    const ADD_SEED = {
        items: { name: '', unit_id: '', reorder_level: '', is_active: true },
        units: { name: '', abbrev: '' },
        suppliers: { name: '', phone: '', ntn: '', address: '', is_active: true },
        warehouses: { name: '' },
    }

    const ADD_LABEL = {
        items: 'Add item',
        units: 'Add unit',
        suppliers: 'Add supplier',
        warehouses: 'Add warehouse',
    }

    return (
        <div className={styles.container}>
            <PageHeader />

            <div className={styles.toolbar}>
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

                {/*
                  * ONE DOOR for an ingredient, and this is not it.
                  *
                  * This tab and Menu → Ingredients both wrote inventory_items,
                  * but only Ingredients can set a rate — so an ingredient born
                  * here was silently uncosted, and every recipe using it
                  * priced at zero. That is not a duplicate screen, it is a
                  * trap. Items stays as the stock view it is good at (on hand,
                  * reorder, what it costs) and sends the creating and the
                  * editing to the one screen that does the whole job.
                  */}
                {tab === 'items' ? (
                    <Link href="/menu/ingredients" className={styles.addBtn}>
                        <Plus size={15} aria-hidden="true" />
                        Add or edit in Ingredients
                    </Link>
                ) : canEdit && !editing && (
                    <button
                        type="button"
                        className={styles.addBtn}
                        onClick={() => openForm(null, ADD_SEED[tab])}
                    >
                        <Plus size={15} aria-hidden="true" />
                        {ADD_LABEL[tab]}
                    </button>
                )}
            </div>

            {formError && (
                <div className={styles.errorNote}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {formError}
                </div>
            )}

            <div className={styles.tableWrap}>
                {tab === 'items' && renderItems()}
                {tab === 'units' && renderUnits()}
                {tab === 'suppliers' && renderSuppliers()}
                {tab === 'warehouses' && renderWarehouses()}
            </div>
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
                <h1 className={styles.title}>Masters</h1>
                <p className={styles.subtitle}>
                    Units, suppliers and warehouses, and a read-only look at what is on the
                    shelf. Ingredients themselves are added and priced in{' '}
                    <Link href="/menu/ingredients" className={styles.inlineLink}>Menu → Ingredients</Link>,
                    which is the only screen that can set a rate. Average cost then follows
                    receivings, never a hand edit.
                </p>
            </div>
        </div>
    )
}

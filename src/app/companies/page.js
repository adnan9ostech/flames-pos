'use client';
import { useState, useEffect, useCallback } from 'react';
import styles from './companies.module.css';
import { listCompanies, saveCompany, toggleCompany, getCompanyStatement } from './actions';
import { formatDateTime } from '@/lib/timeFormat';
import {
    Building2, Plus, Pencil, Power, FileText, Loader2, X, AlertTriangle,
} from 'lucide-react';

const EMPTY_FORM = {
    id: null, name: '', contact: '', phone: '', ntn: '', address: '', credit_limit: '',
};

const rupees = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK')}`;

const RECEIPT_METHOD_LABEL = {
    cash: 'Cash', card: 'Card', bank: 'Bank transfer', cheque: 'Cheque',
};

export default function CompaniesPage() {
    const [companies, setCompanies] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [pageError, setPageError] = useState('');

    // The create/edit form; null means closed, a filled shape means open.
    const [form, setForm] = useState(null);
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    const [busyId, setBusyId] = useState(null);

    // The statement is seeded with the company row so the panel opens
    // immediately with a name while its entries load behind it.
    const [statement, setStatement] = useState(null);
    const [statementLoading, setStatementLoading] = useState(false);

    const load = useCallback(async () => {
        const res = await listCompanies();
        if (res.error) {
            setPageError(res.error);
        } else {
            setPageError('');
            setCompanies(res.data);
        }
        setIsLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const openForm = (company = null) => {
        setFormError('');
        setForm(company
            ? {
                id: company.id,
                name: company.name || '',
                contact: company.contact || '',
                phone: company.phone || '',
                ntn: company.ntn || '',
                address: company.address || '',
                credit_limit: company.credit_limit == null ? '' : String(company.credit_limit),
            }
            : { ...EMPTY_FORM });
    };

    const setField = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

    const submitForm = async (e) => {
        e.preventDefault();
        setSaving(true);
        setFormError('');
        const res = await saveCompany(form);
        if (res.error) {
            setFormError(res.error);
        } else {
            setForm(null);
            await load();
        }
        setSaving(false);
    };

    const toggle = async (company) => {
        setBusyId(company.id);
        const res = await toggleCompany(company.id);
        if (res.error) setPageError(res.error);
        else await load();
        setBusyId(null);
    };

    const openStatement = async (company) => {
        setStatement({ company, entries: [], balance: company.balance });
        setStatementLoading(true);
        const res = await getCompanyStatement(company.id);
        if (res.error) {
            setPageError(res.error);
            setStatement(null);
        } else {
            setStatement(res.data);
        }
        setStatementLoading(false);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Companies</h1>
                    <p className={styles.subtitle}>
                        The accounts that charge meals to a city ledger and settle by invoice.
                    </p>
                </div>
                <button type="button" className={styles.primaryBtn} onClick={() => openForm()}>
                    <Plus size={16} aria-hidden="true" />
                    New company
                </button>
            </div>

            {pageError && (
                <div className={styles.errorBanner} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    {pageError}
                </div>
            )}

            {isLoading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading companies…</p>
                </div>
            ) : companies.length === 0 ? (
                <div className={styles.stateBlock}>
                    <Building2 size={32} />
                    <p>No companies yet: add the first account to start charging to the ledger.</p>
                </div>
            ) : (
                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Company</th>
                                <th>Contact</th>
                                <th className={styles.alignRight}>Credit limit</th>
                                <th className={styles.alignRight}>Balance</th>
                                <th>Status</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {companies.map((company) => (
                                <tr key={company.id} className={company.is_active ? '' : styles.inactiveRow}>
                                    <td className={styles.cellStrong}>
                                        {company.name}
                                        {company.ntn && (
                                            <div className={styles.cellSub}>NTN {company.ntn}</div>
                                        )}
                                    </td>
                                    <td className={styles.cellMuted}>
                                        {company.contact || '—'}
                                        {company.phone && (
                                            <div className={styles.cellSub}>{company.phone}</div>
                                        )}
                                    </td>
                                    <td className={`${styles.cellMuted} ${styles.alignRight}`}>
                                        {company.credit_limit == null ? 'No cap' : rupees(company.credit_limit)}
                                    </td>
                                    <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                        <span className={company.balance > 0 ? styles.balanceDue : ''}>
                                            {rupees(company.balance)}
                                        </span>
                                    </td>
                                    <td>
                                        <span className={`${styles.statusChip} ${company.is_active ? styles.activeChip : styles.inactiveChip}`}>
                                            {company.is_active ? 'Active' : 'Inactive'}
                                        </span>
                                    </td>
                                    <td className={styles.alignRight}>
                                        <div className={styles.rowActions}>
                                            <button
                                                type="button"
                                                className={styles.iconBtn}
                                                onClick={() => openStatement(company)}
                                                title="Statement"
                                                aria-label={`Statement for ${company.name}`}
                                            >
                                                <FileText size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.iconBtn}
                                                onClick={() => openForm(company)}
                                                title="Edit"
                                                aria-label={`Edit ${company.name}`}
                                            >
                                                <Pencil size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                className={`${styles.iconBtn} ${company.is_active ? styles.dangerBtn : ''}`}
                                                onClick={() => toggle(company)}
                                                disabled={busyId === company.id}
                                                title={company.is_active ? 'Deactivate' : 'Reactivate'}
                                                aria-label={`${company.is_active ? 'Deactivate' : 'Reactivate'} ${company.name}`}
                                            >
                                                {busyId === company.id
                                                    ? <Loader2 size={15} className={styles.spinner} />
                                                    : <Power size={15} />}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ===== Create / edit ===== */}
            {form && (
                <div className={styles.modalOverlay} onClick={() => !saving && setForm(null)}>
                    <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={submitForm}>
                        <h3 className={styles.modalTitle}>
                            <Building2 size={18} aria-hidden="true" />
                            {form.id ? 'Edit company' : 'New company'}
                        </h3>

                        <div className={styles.formGrid}>
                            <label className={`${styles.field} ${styles.fullWidth}`}>
                                <span className={styles.label}>Company name</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.name}
                                    onChange={setField('name')}
                                    maxLength={191}
                                    autoFocus
                                    required
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Contact person</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.contact}
                                    onChange={setField('contact')}
                                    maxLength={191}
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Phone</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.phone}
                                    onChange={setField('phone')}
                                    maxLength={32}
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>NTN</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={form.ntn}
                                    onChange={setField('ntn')}
                                    maxLength={16}
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Credit limit (Rs.)</span>
                                <input
                                    type="number"
                                    className={styles.input}
                                    value={form.credit_limit}
                                    onChange={setField('credit_limit')}
                                    min="0"
                                    step="1"
                                    inputMode="numeric"
                                    placeholder="No cap"
                                />
                            </label>

                            <label className={`${styles.field} ${styles.fullWidth}`}>
                                <span className={styles.label}>Address</span>
                                <textarea
                                    className={styles.textarea}
                                    value={form.address}
                                    onChange={setField('address')}
                                    rows={2}
                                />
                            </label>
                        </div>

                        {formError && <p className={styles.modalError}>{formError}</p>}

                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.modalCancel}
                                onClick={() => setForm(null)}
                                disabled={saving}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className={styles.modalConfirm}
                                disabled={saving || !form.name.trim()}
                            >
                                {saving
                                    ? <Loader2 size={14} className={styles.spinner} />
                                    : <Building2 size={14} />}
                                {saving ? 'Saving…' : form.id ? 'Save changes' : 'Add company'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* ===== Statement ===== */}
            {statement && (
                <div className={styles.modalOverlay} onClick={() => setStatement(null)}>
                    <div className={`${styles.modal} ${styles.wideModal}`} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.statementHeader}>
                            <h3 className={styles.modalTitle}>
                                <FileText size={18} aria-hidden="true" />
                                {statement.company.name}: statement
                            </h3>
                            <button
                                type="button"
                                className={styles.iconBtn}
                                onClick={() => setStatement(null)}
                                aria-label="Close statement"
                            >
                                <X size={15} />
                            </button>
                        </div>

                        {statementLoading ? (
                            <div className={styles.stateBlock}>
                                <Loader2 className={styles.spinner} size={28} />
                                <p>Loading statement…</p>
                            </div>
                        ) : statement.entries.length === 0 ? (
                            <div className={styles.stateBlock}>
                                <p>No ledger activity yet. Charges appear here as the till settles bills to this account.</p>
                            </div>
                        ) : (
                            <div className={styles.statementWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Detail</th>
                                            <th>Invoice</th>
                                            <th className={styles.alignRight}>Charge</th>
                                            <th className={styles.alignRight}>Receipt</th>
                                            <th className={styles.alignRight}>Balance</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {statement.entries.map((entry, idx) => (
                                            <tr key={idx}>
                                                <td className={styles.cellMuted}>
                                                    {formatDateTime(new Date(entry.at))}
                                                </td>
                                                <td>
                                                    {entry.kind === 'charge' ? (
                                                        <>
                                                            <span className={styles.cellStrong}>
                                                                {entry.amount < 0 ? 'Void: order' : 'Order'} #{entry.order_number}
                                                            </span>
                                                            {entry.invoice_number && (
                                                                <div className={styles.cellSub}>{entry.invoice_number}</div>
                                                            )}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span className={styles.cellStrong}>
                                                                {RECEIPT_METHOD_LABEL[entry.method] || entry.method} received
                                                            </span>
                                                            {(entry.reference || entry.memo) && (
                                                                <div className={styles.cellSub}>
                                                                    {[entry.reference, entry.memo].filter(Boolean).join(' · ')}
                                                                </div>
                                                            )}
                                                        </>
                                                    )}
                                                </td>
                                                <td>
                                                    {entry.cl_invoice_no ? (
                                                        <span className={`${styles.statusChip} ${styles.invoicedChip}`}>
                                                            {entry.cl_invoice_no}
                                                        </span>
                                                    ) : entry.kind === 'charge' ? (
                                                        <span className={`${styles.statusChip} ${styles.uninvoicedChip}`}>
                                                            Uninvoiced
                                                        </span>
                                                    ) : (
                                                        <span className={styles.cellMuted}>On account</span>
                                                    )}
                                                </td>
                                                <td className={styles.alignRight}>
                                                    {entry.kind === 'charge' ? rupees(entry.amount) : ''}
                                                </td>
                                                <td className={`${styles.alignRight} ${styles.receiptCell}`}>
                                                    {entry.kind === 'receipt' ? rupees(entry.amount) : ''}
                                                </td>
                                                <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                                    {rupees(entry.running)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {!statementLoading && (
                            <div className={styles.statementFooter}>
                                <span>Closing balance</span>
                                <strong className={statement.balance > 0 ? styles.balanceDue : ''}>
                                    {rupees(statement.balance)}
                                </strong>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import styles from './cityledger.module.css';
import { generateInvoice, recordReceipt, listInvoices, listReceipts, agingReport } from './actions';
import { listCompanies } from '@/app/companies/actions';
import { formatDateTime, formatDayMonth } from '@/lib/timeFormat';
import {
    FileText, Banknote, Hourglass, Loader2, AlertTriangle, CheckCircle2, ReceiptText,
} from 'lucide-react';

const TABS = [
    { key: 'invoices', label: 'Invoices', Icon: FileText },
    { key: 'receipts', label: 'Receipts', Icon: Banknote },
    { key: 'aging', label: 'Aging', Icon: Hourglass },
];

const METHODS = [
    { key: 'bank', label: 'Bank transfer' },
    { key: 'cheque', label: 'Cheque' },
    { key: 'cash', label: 'Cash' },
    { key: 'card', label: 'Card' },
];

const METHOD_LABEL = Object.fromEntries(METHODS.map((m) => [m.key, m.label]));

const EMPTY_INVOICE_FORM = { companyId: '', from: '', to: '' };
const EMPTY_RECEIPT_FORM = {
    companyId: '', invoiceId: '', amount: '', method: 'bank', reference: '', memo: '',
};

const rupees = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK')}`;

// DATE strings ('YYYY-MM-DD') render as a short day; timestamps get the full form.
const dayLabel = (d) => (d ? formatDayMonth(new Date(`${d}T00:00:00`)) : '—');
const stampLabel = (iso) => (iso ? formatDateTime(new Date(iso)) : '—');

export default function CityLedgerPage() {
    const [tab, setTab] = useState('invoices');
    const [isLoading, setIsLoading] = useState(true);
    const [pageError, setPageError] = useState('');

    const [companies, setCompanies] = useState([]);
    const [invoices, setInvoices] = useState([]);
    const [receipts, setReceipts] = useState([]);
    const [aging, setAging] = useState([]);

    const [invForm, setInvForm] = useState(EMPTY_INVOICE_FORM);
    const [invBusy, setInvBusy] = useState(false);
    const [invNote, setInvNote] = useState({ type: '', text: '' });

    const [recForm, setRecForm] = useState(EMPTY_RECEIPT_FORM);
    const [recBusy, setRecBusy] = useState(false);
    const [recNote, setRecNote] = useState({ type: '', text: '' });

    const load = useCallback(async () => {
        const [companiesRes, invoicesRes, receiptsRes, agingRes] = await Promise.all([
            listCompanies(), listInvoices(), listReceipts(), agingReport(),
        ]);
        const failed = [companiesRes, invoicesRes, receiptsRes, agingRes].find((r) => r.error);
        if (failed) {
            setPageError(failed.error);
        } else {
            setPageError('');
            setCompanies(companiesRes.data);
            setInvoices(invoicesRes.data);
            setReceipts(receiptsRes.data);
            setAging(agingRes.data);
        }
        setIsLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    // The generate form only offers accounts the till can still charge;
    // receipts take money for any account, active or not.
    const activeCompanies = useMemo(() => companies.filter((c) => c.is_active), [companies]);

    // Only invoices still carrying a balance are offered as a receipt target.
    const openInvoicesFor = useMemo(
        () => invoices.filter((i) => i.company_id === recForm.companyId && i.due > 0),
        [invoices, recForm.companyId],
    );

    const submitInvoice = async (e) => {
        e.preventDefault();
        setInvBusy(true);
        setInvNote({ type: '', text: '' });
        const res = await generateInvoice(invForm);
        if (res.error) {
            setInvNote({ type: 'error', text: res.error });
        } else {
            setInvNote({
                type: 'success',
                text: `${res.data.invoice_no} raised for ${rupees(res.data.total)} (${res.data.charges} charge${res.data.charges === 1 ? '' : 's'}).`,
            });
            setInvForm(EMPTY_INVOICE_FORM);
            await load();
        }
        setInvBusy(false);
    };

    const submitReceipt = async (e) => {
        e.preventDefault();
        setRecBusy(true);
        setRecNote({ type: '', text: '' });
        const res = await recordReceipt({
            ...recForm,
            invoiceId: recForm.invoiceId ? Number(recForm.invoiceId) : null,
        });
        if (res.error) {
            setRecNote({ type: 'error', text: res.error });
        } else {
            setRecNote({ type: 'success', text: `Receipt of ${rupees(res.data.amount)} recorded.` });
            setRecForm(EMPTY_RECEIPT_FORM);
            await load();
        }
        setRecBusy(false);
    };

    const Note = ({ note }) => note.text && (
        <div
            role="status"
            aria-live="polite"
            className={`${styles.note} ${note.type === 'error' ? styles.noteError : styles.noteSuccess}`}
        >
            {note.type === 'error'
                ? <AlertTriangle size={15} aria-hidden="true" />
                : <CheckCircle2 size={15} aria-hidden="true" />}
            {note.text}
        </div>
    );

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>City Ledger</h1>
                    <p className={styles.subtitle}>
                        Bill company accounts for their charges, take their payments, and watch what ages.
                    </p>
                </div>

                <div className={styles.tabs}>
                    {TABS.map(({ key, label, Icon }) => (
                        <button
                            key={key}
                            type="button"
                            className={`${styles.tab} ${tab === key ? styles.active : ''}`}
                            onClick={() => setTab(key)}
                        >
                            <Icon size={15} aria-hidden="true" />
                            {label}
                        </button>
                    ))}
                </div>
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
                    <p>Loading the ledger…</p>
                </div>
            ) : tab === 'invoices' ? (
                <>
                    {/* ===== Generate ===== */}
                    <form className={styles.formCard} onSubmit={submitInvoice}>
                        <div className={styles.formRow}>
                            <label className={styles.field}>
                                <span className={styles.label}>Company</span>
                                <select
                                    className={styles.select}
                                    value={invForm.companyId}
                                    onChange={(e) => setInvForm((f) => ({ ...f, companyId: e.target.value }))}
                                >
                                    <option value="">Choose…</option>
                                    {activeCompanies.map((c) => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                </select>
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>From</span>
                                <input
                                    type="date"
                                    className={styles.input}
                                    value={invForm.from}
                                    max={invForm.to || undefined}
                                    onChange={(e) => setInvForm((f) => ({ ...f, from: e.target.value }))}
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>To</span>
                                <input
                                    type="date"
                                    className={styles.input}
                                    value={invForm.to}
                                    min={invForm.from || undefined}
                                    onChange={(e) => setInvForm((f) => ({ ...f, to: e.target.value }))}
                                />
                            </label>

                            <button
                                type="submit"
                                className={styles.primaryBtn}
                                disabled={invBusy || !invForm.companyId || !invForm.from || !invForm.to}
                            >
                                {invBusy
                                    ? <Loader2 size={15} className={styles.spinner} />
                                    : <FileText size={15} aria-hidden="true" />}
                                {invBusy ? 'Generating…' : 'Generate invoice'}
                            </button>
                        </div>
                        <Note note={invNote} />
                    </form>

                    {invoices.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <ReceiptText size={32} />
                            <p>No invoices yet — pick a company and a period above to raise the first one.</p>
                        </div>
                    ) : (
                        <div className={styles.tableWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Invoice</th>
                                        <th>Company</th>
                                        <th>Period</th>
                                        <th>Raised</th>
                                        <th className={styles.alignRight}>Total</th>
                                        <th className={styles.alignRight}>Paid</th>
                                        <th className={styles.alignRight}>Due</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {invoices.map((invoice) => (
                                        <tr key={invoice.id}>
                                            <td className={styles.cellStrong}>{invoice.invoice_no}</td>
                                            <td>{invoice.company_name}</td>
                                            <td className={styles.cellMuted}>
                                                {dayLabel(invoice.period_from)} – {dayLabel(invoice.period_to)}
                                            </td>
                                            <td className={styles.cellMuted}>{stampLabel(invoice.created_at)}</td>
                                            <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                                {rupees(invoice.total)}
                                            </td>
                                            <td className={`${styles.alignRight} ${styles.paidText}`}>
                                                {invoice.paid > 0 ? rupees(invoice.paid) : '—'}
                                            </td>
                                            <td className={styles.alignRight}>
                                                {invoice.due > 0 ? (
                                                    <span className={styles.dueText}>{rupees(invoice.due)}</span>
                                                ) : (
                                                    <span className={styles.settledChip}>Settled</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            ) : tab === 'receipts' ? (
                <>
                    {/* ===== Record ===== */}
                    <form className={styles.formCard} onSubmit={submitReceipt}>
                        <div className={styles.formRow}>
                            <label className={styles.field}>
                                <span className={styles.label}>Company</span>
                                <select
                                    className={styles.select}
                                    value={recForm.companyId}
                                    onChange={(e) => setRecForm((f) => ({ ...f, companyId: e.target.value, invoiceId: '' }))}
                                >
                                    <option value="">Choose…</option>
                                    {companies.map((c) => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                </select>
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Against invoice</span>
                                <select
                                    className={styles.select}
                                    value={recForm.invoiceId}
                                    onChange={(e) => setRecForm((f) => ({ ...f, invoiceId: e.target.value }))}
                                    disabled={!recForm.companyId}
                                >
                                    <option value="">On account</option>
                                    {openInvoicesFor.map((i) => (
                                        <option key={i.id} value={i.id}>
                                            {i.invoice_no} — due {rupees(i.due)}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Amount (Rs.)</span>
                                <input
                                    type="number"
                                    className={styles.input}
                                    value={recForm.amount}
                                    onChange={(e) => setRecForm((f) => ({ ...f, amount: e.target.value }))}
                                    min="1"
                                    step="0.01"
                                    inputMode="decimal"
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Method</span>
                                <select
                                    className={styles.select}
                                    value={recForm.method}
                                    onChange={(e) => setRecForm((f) => ({ ...f, method: e.target.value }))}
                                >
                                    {METHODS.map((m) => (
                                        <option key={m.key} value={m.key}>{m.label}</option>
                                    ))}
                                </select>
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Reference</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={recForm.reference}
                                    onChange={(e) => setRecForm((f) => ({ ...f, reference: e.target.value }))}
                                    maxLength={64}
                                    placeholder="Cheque / txn no."
                                />
                            </label>

                            <label className={styles.field}>
                                <span className={styles.label}>Memo</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    value={recForm.memo}
                                    onChange={(e) => setRecForm((f) => ({ ...f, memo: e.target.value }))}
                                    maxLength={191}
                                />
                            </label>

                            <button
                                type="submit"
                                className={styles.primaryBtn}
                                disabled={recBusy || !recForm.companyId || !(Number(recForm.amount) > 0)}
                            >
                                {recBusy
                                    ? <Loader2 size={15} className={styles.spinner} />
                                    : <Banknote size={15} aria-hidden="true" />}
                                {recBusy ? 'Recording…' : 'Record receipt'}
                            </button>
                        </div>
                        <Note note={recNote} />
                    </form>

                    {receipts.length === 0 ? (
                        <div className={styles.stateBlock}>
                            <Banknote size={32} />
                            <p>No receipts yet — record the first payment above when it arrives.</p>
                        </div>
                    ) : (
                        <div className={styles.tableWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Received</th>
                                        <th>Company</th>
                                        <th>Invoice</th>
                                        <th>Method</th>
                                        <th>Reference</th>
                                        <th className={styles.alignRight}>Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {receipts.map((receipt) => (
                                        <tr key={receipt.id}>
                                            <td className={styles.cellMuted}>{stampLabel(receipt.received_at)}</td>
                                            <td className={styles.cellStrong}>{receipt.company_name}</td>
                                            <td className={styles.cellMuted}>{receipt.invoice_no || 'On account'}</td>
                                            <td>{METHOD_LABEL[receipt.method] || receipt.method}</td>
                                            <td className={styles.cellMuted}>
                                                {[receipt.reference, receipt.memo].filter(Boolean).join(' · ') || '—'}
                                            </td>
                                            <td className={`${styles.cellStrong} ${styles.alignRight} ${styles.paidText}`}>
                                                {rupees(receipt.amount)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            ) : (
                /* ===== Aging ===== */
                aging.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <Hourglass size={32} />
                        <p>Nothing to age — no company accounts have activity yet.</p>
                    </div>
                ) : (
                    <div className={styles.tableWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>Company</th>
                                    <th className={styles.alignRight}>Uninvoiced</th>
                                    <th className={styles.alignRight}>0–30 days</th>
                                    <th className={styles.alignRight}>31–60</th>
                                    <th className={styles.alignRight}>61–90</th>
                                    <th className={styles.alignRight}>90+</th>
                                    <th>Last invoice</th>
                                    <th>Last payment</th>
                                    <th className={styles.alignRight}>Balance</th>
                                </tr>
                            </thead>
                            <tbody>
                                {aging.map((row) => (
                                    <tr key={row.company_id}>
                                        <td className={styles.cellStrong}>
                                            {row.name}
                                            {!row.is_active && <span className={styles.inactiveTag}> · inactive</span>}
                                        </td>
                                        <td className={styles.alignRight}>
                                            {row.uninvoiced !== 0 ? rupees(row.uninvoiced) : '—'}
                                        </td>
                                        <td className={styles.alignRight}>
                                            {row.b0_30 !== 0 ? rupees(row.b0_30) : '—'}
                                        </td>
                                        <td className={styles.alignRight}>
                                            {row.b31_60 !== 0 ? rupees(row.b31_60) : '—'}
                                        </td>
                                        <td className={`${styles.alignRight} ${row.b61_90 !== 0 ? styles.agingWarn : ''}`}>
                                            {row.b61_90 !== 0 ? rupees(row.b61_90) : '—'}
                                        </td>
                                        <td className={`${styles.alignRight} ${row.b90_plus !== 0 ? styles.agingLate : ''}`}>
                                            {row.b90_plus !== 0 ? rupees(row.b90_plus) : '—'}
                                        </td>
                                        <td className={styles.cellMuted}>{stampLabel(row.last_invoice)}</td>
                                        <td className={styles.cellMuted}>{stampLabel(row.last_receipt)}</td>
                                        <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                            <span className={row.balance > 0 ? styles.dueText : ''}>
                                                {rupees(row.balance)}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            )}
        </div>
    );
}

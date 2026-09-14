'use client';

import styles from '../accounts.module.css';
import { Printer, FileDown, FileSpreadsheet } from 'lucide-react';

/*
 * What the four statements share: the money formatting, the date helpers,
 * the Print / CSV / Excel buttons and the heading that appears only on
 * paper. Kept beside the pages rather than in the section stylesheet's
 * orbit because it is behaviour, not style — and four copies of a CSV
 * builder would drift the way the charges/expenses date helpers once did.
 */

/* Today on the Karachi calendar — the same day the business day resolves to
 * when no day has been opened. en-CA emits ISO order. */
export const karachiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

export const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;

/* '2 Sep 2026' for a 'YYYY-MM-DD'. Parsed at UTC midnight so the day never shifts. */
export const fmtDay = (ymd) => (ymd
    ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
    : '');

export const periodLabel = (from, to) => (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`);

/* Rupees, en-PK grouping, paise only when there are any: the till is
 * integer-exact, so a figure with decimals is itself a signal. */
export const rupees = (n) => (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/* A true minus sign, never a hyphen: '−1,234'. */
const signed = (n) => {
    const v = Number(n) || 0;
    return v < 0 ? `−${rupees(-v)}` : rupees(v);
};

/* A money cell. Negative figures take the red the stylesheet prints as
 * parentheses; a zero can be blanked so a debit/credit pair reads cleanly. */
export function Money({ value, blankZero = false, strong = false }) {
    const v = Number(value) || 0;
    if (blankZero && v === 0) return <span className={styles.cellMuted}>—</span>;
    return (
        <span className={`${v < 0 ? styles.negative : ''} ${strong ? styles.cellStrong : ''}`.trim()}>
            {signed(v)}
        </span>
    );
}

/* Client-built CSV, downloaded via a Blob link — the idiom six report pages
 * already use. Numbers are written bare so a spreadsheet reads them as
 * numbers; text is quoted only when it has to be. */
export const downloadCsv = (filename, rows) => {
    const esc = (v) => {
        if (typeof v === 'number') return String(v);
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
};

/*
 * Print / CSV / Excel. "Print / Save as PDF" is the honest label: the till
 * runs Chrome in kiosk-printing mode, where this goes straight to the roll.
 * The Excel button is a plain link to the export route, which answers with
 * an attachment — the browser downloads it without a script in the way.
 */
export function ReportToolbar({ onCsv, excelHref, disabled = false }) {
    return (
        <div className={styles.headerActions}>
            <button type="button" className={styles.secondaryBtn} onClick={() => window.print()} disabled={disabled}>
                <Printer size={15} /> Print / Save as PDF
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={onCsv} disabled={disabled}>
                <FileDown size={15} /> CSV
            </button>
            {excelHref && !disabled ? (
                <a className={styles.secondaryBtn} href={excelHref}>
                    <FileSpreadsheet size={15} /> Excel
                </a>
            ) : (
                <button type="button" className={styles.secondaryBtn} disabled>
                    <FileSpreadsheet size={15} /> Excel
                </button>
            )}
        </div>
    );
}

/* The heading only paper sees: whose books, which statement, what period. */
export function PrintHeading({ merchantName, title, period }) {
    return (
        <div className={styles.printOnly}>
            <p className={styles.reportMeta}>
                <strong>{merchantName}</strong> · {title} · {period}
            </p>
        </div>
    );
}

export function DateRange({ from, to, onFrom, onTo, max }) {
    return (
        <div className={styles.dateRange}>
            <input type="date" value={from} max={to || max} onChange={(e) => onFrom(e.target.value)} aria-label="From date" />
            <span className={styles.dateSep}>to</span>
            <input type="date" value={to} min={from} max={max} onChange={(e) => onTo(e.target.value)} aria-label="To date" />
        </div>
    );
}

'use client';
import { FileDown } from 'lucide-react';
import styles from './printButton.module.css';

/*
 * "Save as PDF" on a report.
 *
 * It is window.print(), and that is the honest answer rather than a shortcut.
 * Every browser prints to PDF, the output is real text a person can search and
 * copy rather than a picture of a table, it needs no library on a till that
 * ships to a shared cPanel box, and it costs nothing to keep working when a
 * report grows a column. What it needs instead is print CSS worth printing,
 * which is in globals.css under .print-root.
 *
 * The caller marks the part of the page worth printing:
 *
 *   <div className="print-root"> … the report … </div>
 *   <PrintButton label="Save as PDF" />
 *
 * Without that class the page prints as it looks on screen, sidebar and all,
 * which is what four of the six reports did until now: nothing.
 */
export default function PrintButton({ label = 'Save as PDF', title = null }) {
    return (
        <button
            type="button"
            className={`${styles.btn} no-print`}
            onClick={() => window.print()}
            title={title ?? 'Opens the browser print dialog — choose "Save as PDF"'}
        >
            <FileDown size={15} aria-hidden="true" />
            {label}
        </button>
    );
}

'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './reportsNav.module.css';

/*
 * The report library, as one strip that stays put. It used to live only on
 * the index page, so opening any report was a one-way trip — you landed on
 * Hourly Sales with no way back to the others but the browser button.
 *
 * A nested layout renders it above every /reports screen, which is also why
 * it is a Link and not an <a>: the strip must not re-render on navigation.
 */
const REPORTS = [
    ['/reports', 'Overview'],
    ['/reports/handover', 'Handover'],
    ['/reports/daily-sales', 'Daily Food Sales'],
    ['/reports/hourly', 'Hourly Sales'],
    ['/reports/item-wise', 'Item-wise Sale'],
    ['/reports/menu-analytics', 'Menu Analytics'],
    ['/reports/gross-profit', 'Gross Profit'],
];

export default function ReportsNav() {
    const pathname = usePathname();

    return (
        <nav className={`${styles.strip} no-print`} aria-label="Reports">
            {REPORTS.map(([href, label]) => {
                // Exact match only: every report is a child of /reports, so a
                // prefix test would light Overview on all of them.
                const active = pathname === href;
                return (
                    <Link
                        key={href}
                        href={href}
                        className={`${styles.tab} ${active ? styles.active : ''}`}
                        aria-current={active ? 'page' : undefined}
                    >
                        {label}
                    </Link>
                );
            })}
        </nav>
    );
}

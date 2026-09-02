'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './accountsNav.module.css';

/*
 * The section strip. Seven stops, not sixteen: the hub below lays out every
 * tile ChowPOS shows, but a strip that wide would wrap onto three lines on a
 * laptop and be unreadable on the till. Each stop is a section, and the "Add"
 * screens are reached from their own list (the New button) rather than from
 * here — which is also where a person expects to find them once the list is
 * in front of them.
 *
 * Prefix matching, unlike the Reports strip's exact match: /accounts/journals/new
 * must light "Vouchers", and /accounts/reports/trial-balance must light
 * "Reports". Only the hub itself matches exactly, or it would light everywhere.
 */
const SECTIONS = [
    ['/accounts', 'Overview', true],
    ['/accounts/chart', 'Chart of Accounts'],
    ['/accounts/ledger', 'General Ledger'],
    ['/accounts/journals', 'Vouchers'],
    ['/accounts/expense-vouchers', 'Expense Vouchers'],
    ['/accounts/expense-codes', 'Expense Setup'],
    ['/accounts/reports', 'Reports'],
];

// The expense-setup stop owns two list screens.
const ALIASES = { '/accounts/expense-categories': '/accounts/expense-codes' };

export default function AccountsNav() {
    const pathname = usePathname();
    const current = Object.entries(ALIASES).find(([p]) => pathname.startsWith(p))?.[1] || pathname;

    return (
        <nav className={`${styles.strip} no-print`} aria-label="Accounts">
            {SECTIONS.map(([href, label, exact]) => {
                const active = exact
                    ? current === href
                    : current === href || current.startsWith(`${href}/`);
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

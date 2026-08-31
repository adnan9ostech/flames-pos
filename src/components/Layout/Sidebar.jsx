'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
    Utensils, ClipboardList, BarChart3, ExternalLink, User, LogOut,
    MonitorPlay, PanelLeftClose, PanelLeftOpen, Settings,
    Wallet, CalendarCheck, ReceiptText, Building2, Percent, BadgePercent, Package, BookText, Armchair
} from 'lucide-react';
import styles from './Sidebar.module.css';
import { logout } from '@/app/logout/actions';

const NAV_LINKS = [
    { href: '/pos', label: 'POS', Icon: Utensils },
    { href: '/orders', label: 'Orders', Icon: ClipboardList },
    { href: '/kds', label: 'Kitchen Display', Icon: MonitorPlay, newTab: true },
    { href: '/customer', label: 'Customer View', Icon: ExternalLink, newTab: true },
    { href: '/reports', label: 'Reports', Icon: BarChart3, adminOnly: true },
    { href: '/settings', label: 'Settings', Icon: Settings, adminOnly: true }
];

// The day-to-day paperwork of running the place. The drawer belongs to
// whoever holds the cash, so it is the one staff-visible entry; the rest is
// the admin's morning-after territory.
const BACK_OFFICE_LINKS = [
    { href: '/drawer', label: 'Cash Drawer', Icon: Wallet },
    { href: '/dayclose', label: 'Day Close', Icon: CalendarCheck, adminOnly: true },
    { href: '/floor', label: 'Waiters & Tables', Icon: Armchair, adminOnly: true },
    { href: '/expenses', label: 'Expenses', Icon: ReceiptText, adminOnly: true },
    { href: '/companies', label: 'Companies', Icon: Building2, adminOnly: true },
    { href: '/cityledger', label: 'City Ledger', Icon: BookText, adminOnly: true },
    { href: '/charges', label: 'Charges', Icon: Percent, adminOnly: true },
    { href: '/discounts', label: 'Discounts', Icon: BadgePercent, adminOnly: true },
    { href: '/inventory', label: 'Inventory', Icon: Package, adminOnly: true },
];

const Sidebar = ({ collapsed = false, onToggle, role }) => {
    const pathname = usePathname();
    // Icons carry the whole nav once the labels are gone, so scale them up
    const iconSize = collapsed ? 26 : 20;
    const links = NAV_LINKS.filter(link => !link.adminOnly || role === 'admin');
    const backOffice = BACK_OFFICE_LINKS.filter(link => !link.adminOnly || role === 'admin');

    const navLink = ({ href, label, Icon, newTab }) => (
        <Link
            key={href}
            href={href}
            /* startsWith keeps a nested page (/inventory/recipes) lighting its
               section, while '/' alone can't match everything. */
            className={`${styles.link} ${pathname === href || pathname.startsWith(`${href}/`) ? styles.active : ''}`}
            title={collapsed ? label : undefined}
            {...(newTab ? { target: '_blank' } : {})}
        >
            <Icon className={styles.icon} size={iconSize} />
            {!collapsed && <span className={styles.label}>{label}</span>}
        </Link>
    );

    return (
        <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
            <div className={styles.header}>
                <Link href="/pos" className={styles.logo} aria-label="Go to POS home">
                    {collapsed ? (
                        // Crop the wordmark down to the flame mark on the left
                        <span className={styles.logoMark}>
                            <Image
                                src="/flames-by-the-indus-logo.svg"
                                alt="Flames by the Indus"
                                width={146}
                                height={52}
                                priority
                            />
                        </span>
                    ) : (
                        <Image
                            src="/flames-by-the-indus-logo.svg"
                            alt="Flames by the Indus"
                            width={160}
                            height={48}
                            priority
                        />
                    )}
                </Link>

                {!collapsed && (
                    <button
                        type="button"
                        className={styles.toggle}
                        onClick={onToggle}
                        title="Hide menu"
                        aria-label="Hide menu"
                    >
                        <PanelLeftClose size={20} />
                    </button>
                )}
            </div>

            <nav className={styles.nav}>
                {collapsed && (
                    <button
                        type="button"
                        className={`${styles.link} ${styles.toggleRow}`}
                        onClick={onToggle}
                        title="Show menu"
                        aria-label="Show menu"
                    >
                        <PanelLeftOpen className={styles.icon} size={iconSize} />
                    </button>
                )}

                {links.map(navLink)}

                {backOffice.length > 0 && (
                    <>
                        {!collapsed && <p className={styles.sectionLabel}>Back office</p>}
                        {collapsed && <div className={styles.sectionRule} />}
                        {backOffice.map(navLink)}
                    </>
                )}

                <div className={styles.spacer}></div>

                {navLink({ href: '/profile', label: 'Profile', Icon: User })}

                <form action={logout} className={styles.logoutForm}>
                    <button
                        type="submit"
                        className={styles.link}
                        title={collapsed ? 'Logout' : undefined}
                    >
                        <LogOut className={styles.icon} size={iconSize} />
                        {!collapsed && <span className={styles.label}>Logout</span>}
                    </button>
                </form>
            </nav>

            <div className={styles.footer}>
                {!collapsed && <p>User: {role === 'admin' ? 'Admin' : 'Staff'}</p>}
                <div className={styles.status} title={collapsed ? 'Online' : undefined}>
                    {!collapsed && 'Online'}
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;

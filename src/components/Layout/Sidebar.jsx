'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
    Utensils, ClipboardList, BarChart3, ExternalLink, User, LogOut,
    MonitorPlay, PanelLeftClose, PanelLeftOpen, Settings,
    Wallet, CalendarCheck, ReceiptText, Building2, Percent, BadgePercent, Package, BookText, Armchair,
    Users
} from 'lucide-react';
import styles from './Sidebar.module.css';
import { ROLES } from '@/lib/auth/permissions.mjs';
import { logout } from '@/app/logout/actions';

/*
 * Each link names the right that opens it — the same key the proxy checks —
 * so the rail draws exactly the app this person can actually reach, and a
 * new role needs no change here. A link with no `perm` needs only a session.
 */
const NAV_LINKS = [
    { href: '/pos', label: 'POS', Icon: Utensils, perm: 'pos' },
    { href: '/orders', label: 'Orders', Icon: ClipboardList, perm: 'orders' },
    { href: '/kds', label: 'Kitchen Display', Icon: MonitorPlay, newTab: true, perm: 'kds' },
    { href: '/customer', label: 'Customer View', Icon: ExternalLink, newTab: true },
    { href: '/reports', label: 'Reports', Icon: BarChart3, perm: 'reports' },
];

// The day-to-day paperwork of running the place: the morning-after reads and
// the master lists, kept out of the way of the till.
const BACK_OFFICE_LINKS = [
    { href: '/drawer', label: 'Cash Drawer', Icon: Wallet, perm: 'drawer' },
    { href: '/dayclose', label: 'Day Close', Icon: CalendarCheck, perm: 'dayclose' },
    { href: '/floor', label: 'Waiters & Tables', Icon: Armchair, perm: 'menu' },
    { href: '/expenses', label: 'Expenses', Icon: ReceiptText, perm: 'expenses' },
    { href: '/companies', label: 'Companies', Icon: Building2, perm: 'cityledger' },
    { href: '/cityledger', label: 'City Ledger', Icon: BookText, perm: 'cityledger' },
    { href: '/charges', label: 'Charges', Icon: Percent, perm: 'menu' },
    { href: '/discounts', label: 'Discounts', Icon: BadgePercent, perm: 'menu' },
    { href: '/inventory', label: 'Inventory', Icon: Package, perm: 'inventory' },
    { href: '/users', label: 'Users', Icon: Users, perm: 'users' },
    // Last, because it is the least-visited screen in the building.
    { href: '/settings', label: 'Settings', Icon: Settings, perm: 'settings' },
];

const Sidebar = ({ collapsed = false, onToggle, role, name, perms = [] }) => {
    const pathname = usePathname();
    // Icons carry the whole nav once the labels are gone, so scale them up
    // there; expanded, they sit beside text and can afford to be smaller —
    // eighteen rows have to fit a laptop viewport.
    const iconSize = collapsed ? 24 : 17;
    const can = (key) => !key || perms.includes(key);
    const links = NAV_LINKS.filter(link => can(link.perm));
    const backOffice = BACK_OFFICE_LINKS.filter(link => can(link.perm));

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
            </nav>

            {/* Outside the scroller: however long the rail grows, the way out
                of the app stays on screen. */}
            <div className={styles.navPinned}>
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
            </div>

            <div className={styles.footer}>
                {!collapsed && (
                    <>
                        <p className={styles.userName}>{name || 'Signed in'}</p>
                        {role && <p className={styles.userRole}>{ROLES[role] || role}</p>}
                    </>
                )}
                <div className={styles.status} title={collapsed ? 'Online' : undefined}>
                    {!collapsed && 'Online'}
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;

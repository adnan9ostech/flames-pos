'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
    LogOut, PanelLeftClose, PanelLeftOpen, Search,
} from 'lucide-react';
import styles from './Sidebar.module.css';
import { ROLES } from '@/lib/auth/permissions.mjs';
import { primaryNav, backOfficeNav } from '@/lib/navIndex.mjs';
import { navIcon } from './navIcons';
import CommandPalette from './CommandPalette';
import { logout } from '@/app/logout/actions';

/*
 * The rail draws exactly the app this person can reach: both lists come from
 * `src/lib/navIndex.js`, filtered by the same permission keys the proxy checks,
 * so a new role needs no change here and a new screen appears in the rail and
 * in search together.
 */
const Sidebar = ({ collapsed = false, onToggle, role, name, perms = [] }) => {
    const pathname = usePathname();
    const [searchOpen, setSearchOpen] = useState(false);

    // Icons carry the whole nav once the labels are gone, so scale them up
    // there; expanded, they sit beside text and can afford to be smaller —
    // eighteen rows have to fit a laptop viewport.
    const iconSize = collapsed ? 24 : 17;
    const links = primaryNav(perms);
    const backOffice = backOfficeNav(perms);

    /*
     * Cmd/Ctrl-K from anywhere in the app. A modifier combo rather than a bare
     * "/" on purpose: the till has a search field of its own and someone
     * hunting for a dish must be able to type a slash into it.
     */
    useEffect(() => {
        const onKey = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setSearchOpen((v) => !v);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const closeSearch = useCallback(() => setSearchOpen(false), []);

    const navLink = ({ href, label, icon, newTab }) => {
        const Icon = navIcon(icon);
        return (
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
    };

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

            {/*
              * Search sits above the rail, not inside it: it is the way to
              * reach the screens the rail deliberately does not list — the six
              * reports, the inventory sub-pages, tax settings — and burying it
              * among eighteen links would hide the one control that finds the
              * other seventeen. It is a button rather than a real input so
              * there is one place text is typed (the palette) rather than two
              * that have to stay in sync.
              */}
            <div className={styles.searchWrap}>
                <button
                    type="button"
                    className={`${styles.search} ${collapsed ? styles.searchCollapsed : ''}`}
                    onClick={() => setSearchOpen(true)}
                    title={collapsed ? 'Search screens (Ctrl K)' : undefined}
                    aria-label="Search screens"
                    aria-haspopup="dialog"
                >
                    <Search className={styles.icon} size={collapsed ? iconSize : 16} />
                    {!collapsed && (
                        <>
                            <span className={styles.searchLabel}>Search…</span>
                            <kbd className={styles.searchKbd}>⌘K</kbd>
                        </>
                    )}
                </button>
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
                {navLink({ href: '/profile', label: 'Profile', icon: 'User' })}

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

            <CommandPalette open={searchOpen} onClose={closeSearch} perms={perms} />
        </aside>
    );
};

export default Sidebar;

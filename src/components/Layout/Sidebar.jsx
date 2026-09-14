'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
    LogOut, PanelLeftClose, PanelLeftOpen, Search,
} from 'lucide-react';
import styles from './Sidebar.module.css';
import { ROLES } from '@/lib/auth/permissions.mjs';
import { primaryNav, sidebarSections, childrenOf } from '@/lib/navIndex.mjs';
import { navIcon } from './navIcons';
import CommandPalette from './CommandPalette';
import { useBrand } from './BrandProvider';
import NotificationBell from './NotificationBell';
import BranchSwitcher from './BranchSwitcher';
import ThemeSwitcher from './ThemeSwitcher';
import { logout } from '@/app/logout/actions';

/*
 * The rail draws exactly the app this person can reach: both lists come from
 * `src/lib/navIndex.js`, filtered by the same permission keys the proxy checks,
 * so a new role needs no change here and a new screen appears in the rail and
 * in search together.
 */
const Sidebar = ({ collapsed = false, onToggle, role, name, perms = [] }) => {
    const pathname = usePathname();
    // The restaurant's own name and logos, not this one's.
    const brand = useBrand();
    const [searchOpen, setSearchOpen] = useState(false);

    // Icons carry the whole nav once the labels are gone, so scale them up
    // there; expanded, they sit beside text and can afford to be smaller —
    // eighteen rows have to fit a laptop viewport.
    const iconSize = collapsed ? 24 : 17;
    const links = primaryNav(perms);
    const groups = sidebarSections(perms);

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

    const navLink = ({ href, label, icon, newTab, child = false }) => {
        const Icon = navIcon(icon);
        /*
         * Exactly one row is filled: the page you are actually on. A parent
         * whose child is open is merely OPEN — bolder, not filled — because
         * two filled rows stacked read as two answers to "where am I".
         */
        const here = pathname === href;
        const inside = !child && !here && pathname.startsWith(`${href}/`);
        return (
        <Link
            key={href}
            href={href}
            className={`${styles.link} ${child ? styles.childLink : ''} ${here ? styles.active : ''} ${inside ? styles.sectionOpen : ''}`}
            title={collapsed ? label : undefined}
            {...(newTab ? { target: '_blank' } : {})}
        >
            <Icon className={styles.icon} size={child ? iconSize - 2 : iconSize} />
            {!collapsed && <span className={styles.label}>{label}</span>}
        </Link>
        );
    };

    /*
     * A rail row, plus what lives under it while you are in there.
     *
     * Two thirds of this app is off the rail — Purchase Orders, Waste, Deals,
     * Sub-recipes, Trial Balance — reachable only from a hub page's tiles or
     * by knowing about Ctrl-K. Listing all sixty screens would trade that for
     * an unreadable rail, so the rail GROWS WHERE YOU ARE instead: open
     * Inventory and its own screens appear underneath it until you leave.
     *
     * Collapsed, it does not expand: 84px has no room for a second level, and
     * the icons would be a column of identical circles.
     */
    const navRow = (entry) => {
        const inside = pathname === entry.href || pathname.startsWith(`${entry.href}/`);
        const kids = inside && !collapsed ? childrenOf(entry.href, perms) : [];
        if (kids.length === 0) return navLink(entry);
        return (
            <Fragment key={entry.href}>
                {navLink(entry)}
                {kids.map((k) => navLink({ ...k, child: true }))}
            </Fragment>
        );
    };

    return (
        <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
            <div className={styles.header}>
                {/*
                  * TWO assets, swapped in CSS rather than one `src` picked in JS.
                  *
                  * The wordmark is painted white in the source SVG, so on the
                  * light theme's near-white card it disappears entirely. No CSS
                  * filter can rescue it — anything that darkens the white type
                  * also wrecks the orange flame beside it (invert() turns
                  * #F26513 cyan), which is why there is a second file rather
                  * than a filter.
                  *
                  * Swapping `src` on the resolved theme would mean a state read,
                  * a re-render and a fresh image request mid-switch — a visible
                  * blink on the one element that should feel most stable. Both
                  * render, CSS shows one. They are ~14KB each and the hidden one
                  * is already in cache when someone flips the theme.
                  *
                  * Collapsed, the span crops the wordmark down to the flame,
                  * which is brand orange in both files — but the pair still has
                  * to swap, because the crop window is a few pixels wider than
                  * the flame itself.
                  */}
                <Link href="/pos" className={styles.logo} aria-label="Go to POS home">
                    {collapsed ? (
                        // Crop the wordmark down to the flame mark on the left
                        <span className={styles.logoMark}>
                            <Image
                                className={styles.logoOnDark}
                                src={brand.logoLight}
                                alt={brand.name}
                                width={146}
                                height={52}
                                priority
                            />
                            <Image
                                className={styles.logoOnLight}
                                src={brand.logoDark}
                                alt=""
                                aria-hidden="true"
                                width={146}
                                height={52}
                            />
                        </span>
                    ) : (
                        <>
                            <Image
                                className={styles.logoOnDark}
                                src={brand.logoLight}
                                alt={brand.name}
                                width={160}
                                height={48}
                                priority
                            />
                            <Image
                                className={styles.logoOnLight}
                                src={brand.logoDark}
                                alt=""
                                aria-hidden="true"
                                width={160}
                                height={48}
                            />
                        </>
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
              * Directly under the logo, above search: the branch is the frame
              * every other control on this rail is read inside — the orders,
              * the day, the stock — so it has to be read before them. It draws
              * nothing at all on a single-outlet restaurant.
              */}
            <BranchSwitcher collapsed={collapsed} />

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

            {/*
              * Under search, above the rail: the bell has to be on every
              * screen (the point is that nobody is watching the screen the
              * problem belongs to), and the rail is the only furniture this
              * app has on every screen.
              */}
            <NotificationBell collapsed={collapsed} />

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

                {links.map(navRow)}

                {/* One heading per category rather than one "Back office" for
                    all thirteen. Collapsed, the headings become the rules that
                    were already drawn there — the grouping survives, the words
                    do not have room to. */}
                {groups.map((group) => (
                    <Fragment key={group.title}>
                        {!collapsed && <p className={styles.sectionLabel}>{group.title}</p>}
                        {collapsed && <div className={styles.sectionRule} />}
                        {group.items.map(navRow)}
                    </Fragment>
                ))}
            </nav>

            {/* Outside the scroller: however long the rail grows, the way out
                of the app stays on screen. */}
            <div className={styles.navPinned}>
                {/*
                  * Above Profile/Logout so it is reachable from every screen in
                  * one click. The full three-way control lives on /profile —
                  * this is the shortcut, not the only way in.
                  */}
                <ThemeSwitcher variant="compact" collapsed={collapsed} />

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

'use client';
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';

/*
 * Who is signed in — role, granted permission keys and name — read once
 * server-side in layout.js and handed down rather than re-fetched per page
 * (the receipt needs the role to print who was on the till; the screens need
 * the rights to decide what to offer).
 *
 * One context, two views of it: useRole() for the pages written against the
 * role string, usePermissions() for anything asking what this person may do.
 * Rights, not roles, is the question worth asking now — a manager and an
 * admin differ by one key, not by everything.
 */
const RoleContext = createContext(null);

export const useRole = () => useContext(RoleContext)?.role ?? null;

const NO_RIGHTS = { perms: [], can: () => false };

export const usePermissions = () => useContext(RoleContext)?.rights ?? NO_RIGHTS;

// Who is signed in, for the places that record WHO did something — a void
// reason reads better as a name than as a role now that accounts are people.
export const useUserName = () => useContext(RoleContext)?.name ?? null;

const COLLAPSE_KEY = 'fbi.sidebarCollapsed';

/*
 * The collapse preference lives in localStorage so it survives reloads and stays
 * in step across tabs. Reading it through a store (rather than an effect) keeps
 * the server-rendered markup matching the first client render.
 */
const listeners = new Set();

const collapseStore = {
    subscribe(onChange) {
        listeners.add(onChange);
        window.addEventListener('storage', onChange);
        return () => {
            listeners.delete(onChange);
            window.removeEventListener('storage', onChange);
        };
    },
    getSnapshot: () => window.localStorage.getItem(COLLAPSE_KEY) === '1',
    getServerSnapshot: () => false,
    set(collapsed) {
        window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
        listeners.forEach(onChange => onChange());
    }
};

export default function AppLayout({ children, session }) {
    const pathname = usePathname();
    const role = session?.role ?? null;
    const name = session?.name ?? null;

    // The array identity changes on every server render, so key the memo on
    // its contents — a re-render must not hand every consumer a new `can`.
    const permKey = (session?.perms ?? []).join(',');
    const value = useMemo(() => {
        const perms = permKey ? permKey.split(',') : [];
        return { role, name, rights: { perms, can: (key) => perms.includes(key) } };
    }, [role, name, permKey]);

    const isCustomerView = pathname?.startsWith('/customer');
    const isLoginView = pathname?.startsWith('/login');
    // The KDS runs fullscreen on a kitchen screen, so it drops the sidebar
    const isKdsView = pathname?.startsWith('/kds');

    const collapsed = useSyncExternalStore(
        collapseStore.subscribe,
        collapseStore.getSnapshot,
        collapseStore.getServerSnapshot
    );

    const toggleSidebar = () => collapseStore.set(!collapsed);

    if (isCustomerView || isLoginView || isKdsView) {
        return (
            <RoleContext.Provider value={value}>
                <main style={{ minHeight: '100vh', backgroundColor: 'var(--background)' }}>
                    {children}
                </main>
            </RoleContext.Provider>
        );
    }

    return (
        <RoleContext.Provider value={value}>
            <div style={{ display: 'flex', '--sidebar-width': collapsed ? '84px' : '280px' }}>
                <Sidebar
                    collapsed={collapsed}
                    onToggle={toggleSidebar}
                    role={role}
                    name={name}
                    perms={value.rights.perms}
                />
                <main style={{
                    marginLeft: 'var(--sidebar-width)',
                    width: 'calc(100% - var(--sidebar-width))',
                    minHeight: '100vh',
                    backgroundColor: 'var(--background)',
                    transition: 'margin-left 0.2s ease, width 0.2s ease'
                }}>
                    {children}
                </main>
            </div>
        </RoleContext.Provider>
    );
}

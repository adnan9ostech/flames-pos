/*
 * Who can reach what.
 *
 * A role grants a default set; a user may carry overrides on top, so a
 * cashier can be handed `reports` without being promoted to manager. The
 * effective set is computed once at sign-in and travels inside the signed
 * session cookie, which is what lets the route gate decide with no database
 * round trip. Changing someone's role or permissions bumps their
 * token_version, so their other devices re-authenticate and pick the new
 * set up rather than running on yesterday's rights.
 *
 * Shared by the server and the browser: the same map decides what the proxy
 * allows and what the sidebar bothers to draw.
 */

// Route-level rights, named after what a person would say they do.
export const PERMISSIONS = {
    pos: 'Take orders (POS)',
    orders: 'Order history',
    kds: 'Kitchen display',
    void: 'Void an order',
    drawer: 'Cash drawer',
    dayclose: 'Close the business day',
    reports: 'Reports and analytics',
    expenses: 'Expenses',
    cityledger: 'City ledger and companies',
    inventory: 'Inventory and suppliers',
    menu: 'Charges, discounts, waiters and tables',
    settings: 'Store settings',
    users: 'Manage users',
};

export const PERMISSION_KEYS = Object.keys(PERMISSIONS);

export const ROLES = {
    admin: 'Admin',
    manager: 'Manager',
    cashier: 'Cashier',
    frontdesk: 'Front desk',
    kitchen: 'Kitchen',
    accountant: 'Accountant',
    // The shared login the restaurant used before people had accounts. Kept
    // so an un-migrated row still resolves; not offered for new users.
    staff: 'Staff (legacy)',
};

const grant = (...keys) => Object.fromEntries(keys.map((k) => [k, true]));

export const ROLE_DEFAULTS = {
    admin: grant(...PERMISSION_KEYS),
    // Runs the restaurant but cannot mint or delete accounts — the one
    // right that lets someone quietly grant themselves everything else.
    manager: grant(...PERMISSION_KEYS.filter((k) => k !== 'users')),
    cashier: grant('pos', 'orders', 'kds', 'drawer'),
    frontdesk: grant('pos', 'orders', 'kds', 'menu'),
    kitchen: grant('kds'),
    // Reads the money, never rings it: no POS, no voids.
    accountant: grant('orders', 'reports', 'expenses', 'cityledger', 'inventory', 'dayclose', 'drawer'),
    staff: grant('pos', 'orders', 'kds', 'drawer'),
};

/*
 * Role defaults with the user's own overrides applied. An override is
 * explicit either way — `false` takes a right away that the role grants.
 *
 * Except for admin: an admin holds everything, always. The role IS the
 * grant, so there is nothing to tune and no way to whittle one down —
 * which also means an admin can never be edited out of the `users` right
 * and locked away from their own restaurant.
 */
export const effectivePermissions = (role, overrides) => {
    if (role === 'admin') return { ...ROLE_DEFAULTS.admin };

    const base = { ...(ROLE_DEFAULTS[role] || {}) };
    if (overrides && typeof overrides === 'object') {
        for (const [key, value] of Object.entries(overrides)) {
            if (!PERMISSION_KEYS.includes(key)) continue;
            if (value) base[key] = true;
            else delete base[key];
        }
    }
    return base;
};

/* The compact form the cookie carries: just the granted keys. */
export const grantedKeys = (perms) => PERMISSION_KEYS.filter((k) => perms[k]);

export const can = (session, key) => Boolean(session?.perms?.includes(key));

/*
 * Which right a path needs. Longest match wins, so /reports/handover is
 * covered by /reports without listing every report. Paths absent from this
 * map need only a session (the profile page), and /customer is public.
 */
export const ROUTE_PERMISSIONS = {
    '/pos': 'pos',
    '/orders': 'orders',
    '/kds': 'kds',
    '/drawer': 'drawer',
    '/dayclose': 'dayclose',
    '/reports': 'reports',
    '/expenses': 'expenses',
    '/cityledger': 'cityledger',
    '/companies': 'cityledger',
    '/inventory': 'inventory',
    '/charges': 'menu',
    '/discounts': 'menu',
    '/floor': 'menu',
    '/settings': 'settings',
    '/users': 'users',
};

export const permissionForPath = (pathname) => {
    let match = null;
    for (const [prefix, key] of Object.entries(ROUTE_PERMISSIONS)) {
        if ((pathname === prefix || pathname.startsWith(`${prefix}/`))
            && (!match || prefix.length > match.length)) {
            match = prefix;
        }
    }
    return match ? ROUTE_PERMISSIONS[match] : null;
};

/*
 * Where to send someone who has just signed in, or who reached a screen
 * their role cannot open: the first thing they CAN open. A kitchen account
 * lands on the board, an accountant on reports.
 */
export const landingPath = (perms) => {
    const order = ['pos', 'kds', 'orders', 'reports', 'drawer', 'expenses', 'inventory', 'cityledger', 'users', 'settings'];
    const first = order.find((k) => perms?.includes?.(k) ?? perms?.[k]);
    const paths = {
        pos: '/pos', kds: '/kds', orders: '/orders', reports: '/reports',
        drawer: '/drawer', expenses: '/expenses', inventory: '/inventory',
        cityledger: '/cityledger', users: '/users', settings: '/settings',
    };
    return paths[first] || '/profile';
};

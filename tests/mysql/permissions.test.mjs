/*
 * The permission map decides what the proxy lets through and what the sidebar
 * draws, and it is computed once at sign-in and then carried inside a signed
 * cookie — so a mistake here is not a wrong page, it is a cashier holding a
 * valid ticket to the reports for as long as their session lasts.
 *
 * Pure module, no database: these run without the pool and therefore without
 * the suite lock. They live beside the MySQL suites only because that is where
 * `node --test tests/mysql/*.test.mjs` looks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PERMISSIONS, PERMISSION_KEYS, ROLES, ROLE_DEFAULTS,
    effectivePermissions, grantedKeys,
    ROUTE_PERMISSIONS, permissionForPath, landingPath,
} from '../../src/lib/auth/permissions.mjs';

const ROLE_KEYS = Object.keys(ROLES);

test('the three maps agree with each other', () => {
    assert.deepEqual(PERMISSION_KEYS, Object.keys(PERMISSIONS));
    for (const key of PERMISSION_KEYS) {
        assert.equal(typeof PERMISSIONS[key], 'string', `${key} needs a label`);
        assert.ok(PERMISSIONS[key].length > 0, `${key}'s label is empty`);
    }
    // A role with no defaults would sign in to a blank app; a defaults entry
    // with no role is a rename nobody finished.
    assert.deepEqual(Object.keys(ROLE_DEFAULTS).sort(), [...ROLE_KEYS].sort());
});

test('every role default is a subset of the known permissions, all granted', () => {
    for (const role of ROLE_KEYS) {
        for (const [key, value] of Object.entries(ROLE_DEFAULTS[role])) {
            assert.ok(PERMISSION_KEYS.includes(key), `${role} grants unknown '${key}'`);
            assert.equal(value, true, `${role}.${key} should be true, got ${value}`);
        }
    }
});

test('the roles that matter grant exactly what their names promise', () => {
    assert.deepEqual(grantedKeys(ROLE_DEFAULTS.admin), PERMISSION_KEYS);

    // 'users' is the one right that lets somebody quietly grant themselves the
    // rest, which is the whole difference between a manager and an admin.
    // 'accounts_admin' is its twin on the money side: whoever can re-map
    // revenue decides what the P&L says, so it stays with admin and the
    // accountant.
    assert.deepEqual(
        grantedKeys(ROLE_DEFAULTS.manager),
        PERMISSION_KEYS.filter((k) => k !== 'users' && k !== 'accounts_admin'),
    );
    assert.equal(ROLE_DEFAULTS.manager.users, undefined);
    assert.equal(ROLE_DEFAULTS.manager.accounts_admin, undefined);
    assert.equal(ROLE_DEFAULTS.manager.accounts, true, 'a manager still posts vouchers and reads reports');
    assert.equal(ROLE_DEFAULTS.accountant.accounts_admin, true);

    assert.deepEqual(grantedKeys(ROLE_DEFAULTS.kitchen), ['kds']);

    // The front desk keeps the till-setup lists and never gets the menu.
    assert.equal(ROLE_DEFAULTS.frontdesk.setup, true);
    assert.equal(ROLE_DEFAULTS.frontdesk.menu, undefined);
    assert.equal(ROLE_DEFAULTS.manager.menu, true);

    // Reads the money, never rings it.
    assert.equal(ROLE_DEFAULTS.accountant.pos, undefined);
    assert.equal(ROLE_DEFAULTS.accountant.void, undefined);
    assert.equal(ROLE_DEFAULTS.accountant.reports, true);
});

test('effectivePermissions adds a right an override grants', () => {
    const perms = effectivePermissions('cashier', { reports: true });
    assert.equal(perms.reports, true);
    // The role's own grants survive alongside the addition.
    assert.equal(perms.pos, true);
    assert.deepEqual(grantedKeys(perms), ['pos', 'orders', 'kds', 'drawer', 'reports']);
});

test('a false override REMOVES a right the role grants', () => {
    const perms = effectivePermissions('manager', { void: false, drawer: false });
    assert.equal(perms.void, undefined);
    assert.ok(!('void' in perms), 'a revoked key must be absent, not present-and-falsy');
    assert.ok(!grantedKeys(perms).includes('void'));
    assert.ok(!grantedKeys(perms).includes('drawer'));
    assert.equal(perms.reports, true, 'revoking one right must not touch the others');
});

test('unknown override keys are ignored', () => {
    const perms = effectivePermissions('cashier', { teleport: true, USERS: true, '': true });
    assert.deepEqual(grantedKeys(perms), ['pos', 'orders', 'kds', 'drawer']);
    assert.equal(perms.teleport, undefined);
    // A false override on a key nobody knows must not be mistaken for one that
    // strips something real.
    assert.deepEqual(
        grantedKeys(effectivePermissions('cashier', { teleport: false })),
        ['pos', 'orders', 'kds', 'drawer'],
    );
});

test('effectivePermissions copes with an empty, missing or unusable override', () => {
    for (const overrides of [null, undefined, {}, [], 42, '{"reports":true}']) {
        assert.deepEqual(
            effectivePermissions('cashier', overrides),
            ROLE_DEFAULTS.cashier,
            // permissions comes out of a JSON column already parsed; a raw
            // string is a caller bug, and it falls back to the role's defaults
            // rather than silently granting whatever it might have contained.
            `overrides ${JSON.stringify(overrides)} should leave the defaults alone`,
        );
    }
    // An unknown role grants nothing at all — better a locked-out session than
    // an accidental one.
    assert.deepEqual(effectivePermissions('wizard'), {});
    assert.deepEqual(effectivePermissions(undefined, { pos: true }), { pos: true });
});

test('effectivePermissions never mutates the shared defaults', () => {
    const before = JSON.stringify(ROLE_DEFAULTS);
    effectivePermissions('cashier', { reports: true, pos: false });
    assert.equal(JSON.stringify(ROLE_DEFAULTS), before);
});

test('grantedKeys round-trips every role in a stable order', () => {
    for (const role of ROLE_KEYS) {
        const perms = effectivePermissions(role);
        const keys = grantedKeys(perms);
        assert.deepEqual(Object.fromEntries(keys.map((k) => [k, true])), perms, role);
        // The cookie's key order must not wander between sign-ins.
        assert.deepEqual(keys, PERMISSION_KEYS.filter((k) => keys.includes(k)), role);
    }
    assert.deepEqual(grantedKeys({}), []);
    assert.deepEqual(grantedKeys({ pos: false, orders: true }), ['orders']);
});

test('permissionForPath covers a section without listing its every page', () => {
    assert.equal(permissionForPath('/reports/handover'), 'reports');
    assert.equal(permissionForPath('/inventory/recipes'), 'inventory');
    assert.equal(permissionForPath('/inventory/receiving/new'), 'inventory');
    assert.equal(permissionForPath('/reports'), 'reports');

    // Two screens, one right.
    assert.equal(permissionForPath('/companies'), 'cityledger');
    assert.equal(permissionForPath('/floor'), 'setup');
    assert.equal(permissionForPath('/discounts'), 'setup');
    // The menu is its own right: pricing a karahi is not retiring a waiter.
    assert.equal(permissionForPath('/menu/items/new'), 'menu');
    assert.equal(permissionForPath('/menu'), 'menu');

    // Unlisted is unguarded: the customer screen is public and the root is the
    // shell's own redirect.
    assert.equal(permissionForPath('/customer'), null);
    assert.equal(permissionForPath('/customer/12'), null);
    assert.equal(permissionForPath('/'), null);
    assert.equal(permissionForPath('/profile'), null);
    assert.equal(permissionForPath('/login'), null);

    // A prefix has to end on a path segment, or /posters would need 'pos'.
    assert.equal(permissionForPath('/posters'), null);
    assert.equal(permissionForPath('/ordersomething'), null);
});

test('permissionForPath resolves the longest match when sections nest', () => {
    for (const [prefix, key] of Object.entries(ROUTE_PERMISSIONS)) {
        assert.ok(PERMISSION_KEYS.includes(key), `${prefix} maps to unknown right '${key}'`);
        assert.equal(permissionForPath(prefix), key);

        // Whichever prefix is longest must win, so adding /reports/tax later
        // cannot be shadowed by /reports being listed first.
        const deeper = Object.keys(ROUTE_PERMISSIONS)
            .filter((p) => p !== prefix && p.startsWith(`${prefix}/`));
        for (const child of deeper) {
            assert.equal(permissionForPath(`${child}/anything`), ROUTE_PERMISSIONS[child]);
        }
    }
});

test('landingPath sends each role to the first screen it can actually open', () => {
    assert.equal(landingPath(grantedKeys(ROLE_DEFAULTS.admin)), '/pos');
    assert.equal(landingPath(grantedKeys(ROLE_DEFAULTS.manager)), '/pos');
    assert.equal(landingPath(grantedKeys(ROLE_DEFAULTS.cashier)), '/pos');
    assert.equal(landingPath(grantedKeys(ROLE_DEFAULTS.frontdesk)), '/pos');
    assert.equal(landingPath(grantedKeys(ROLE_DEFAULTS.staff)), '/pos');
    assert.equal(landingPath(grantedKeys(ROLE_DEFAULTS.kitchen)), '/kds');
    // No POS and no KDS, so history is the first thing on the list it holds.
    assert.equal(landingPath(grantedKeys(ROLE_DEFAULTS.accountant)), '/orders');
});

test('landingPath takes either the cookie array or the permission object', () => {
    assert.equal(landingPath(ROLE_DEFAULTS.kitchen), '/kds');
    assert.equal(landingPath(['kds']), '/kds');
    assert.equal(landingPath(effectivePermissions('accountant')), '/orders');
    // Stripping the POS right must move the landing, not leave them bouncing
    // off a screen the proxy will not open.
    assert.equal(landingPath(grantedKeys(effectivePermissions('cashier', { pos: false }))), '/kds');
});

test('landingPath falls back to the profile when nothing is reachable', () => {
    assert.equal(landingPath([]), '/profile');
    assert.equal(landingPath({}), '/profile');
    assert.equal(landingPath(undefined), '/profile');
    assert.equal(landingPath(null), '/profile');
    // Rights that gate an action rather than a screen of their own have no
    // landing: 'setup' opens /floor, but nothing routes you there on sign-in.
    assert.equal(landingPath(['void']), '/profile');
    assert.equal(landingPath(['setup']), '/profile');
    assert.equal(landingPath(['dayclose']), '/profile');
});

test('the landing every role gets is a page that role may open', () => {
    for (const role of ROLE_KEYS) {
        const perms = effectivePermissions(role);
        const path = landingPath(grantedKeys(perms));
        if (path === '/profile') continue; // needs only a session
        const needed = permissionForPath(path);
        assert.ok(needed, `${role} lands on ${path}, which no rule guards`);
        assert.equal(perms[needed], true, `${role} lands on ${path} but lacks '${needed}'`);
    }
});

test('an admin holds everything, whatever overrides say', () => {
    // The role IS the grant. A stored override — left behind by a promotion,
    // or hand-written into the row — must not be able to whittle an admin
    // down, least of all out of the 'users' right that would lock them away
    // from their own restaurant.
    assert.deepEqual(
        grantedKeys(effectivePermissions('admin', { users: false, settings: false })),
        PERMISSION_KEYS,
    );
    assert.deepEqual(
        grantedKeys(effectivePermissions('admin', null)),
        PERMISSION_KEYS,
    );
});

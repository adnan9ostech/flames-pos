/*
 * Test-database plumbing for the MySQL suite. These tests COMMIT real rows
 * through the production verbs, so the guard below is the only thing standing
 * between a typo'd env and a wiped dev database: nothing here runs unless
 * DB_NAME names a *_test database. (The static imports are safe either way —
 * creating a pool touches no data.)
 *
 * Port of supabase/tests/p1_rpc_tests.sql setup, minus the wrap-it-all-in-one
 * -rollback trick Postgres allowed: MySQL DDL and the verbs' own transactions
 * make that impossible, so each suite wipes and reseeds instead.
 */
if (!String(process.env.DB_NAME ?? '').endsWith('_test')) {
    throw new Error(
        `Refusing to run: DB_NAME is '${process.env.DB_NAME ?? ''}', and these tests ` +
        `commit real rows. Point DB_NAME at a database ending in '_test'.`,
    );
}

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../../src/lib/db/pool.mjs';
import {
    createOrder as kernelCreateOrder,
    appendRound as kernelAppendRound,
} from '../../src/lib/db/orders.mjs';

/* The rates every suite is seeded with — cash and card deliberately differ so
 * a test that settles at the wrong rate cannot pass by coincidence. */
export const TAX = { cash: 0.16, card: 0.05 };

export const q = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
};

export const one = async (sql, params = []) => (await q(sql, params))[0] ?? null;

export const count = async (sql, params = []) => Number((await one(sql, params)).n);

/*
 * node --test runs each file in its own process, and by default several files
 * at once — against ONE shared database. A named MySQL lock serializes the
 * files without caring which processes they live in. Held on a dedicated
 * connection so the pool's churn can't release it early.
 */
let lockConn = null;

export const acquireSuiteLock = async () => {
    lockConn = await pool.getConnection();
    const [rows] = await lockConn.query(
        "SELECT GET_LOCK('flames_pos_mysql_tests', 300) AS ok",
    );
    if (rows[0].ok !== 1) throw new Error('Could not acquire the test-suite lock');
};

export const closeDb = async () => {
    if (lockConn) {
        await lockConn.query("SELECT RELEASE_LOCK('flames_pos_mysql_tests')");
        lockConn.release();
        lockConn = null;
    }
    await pool.end();
};

const MENU_ITEM_ID = '00000000-0000-4000-8000-00000000fe37';

/*
 * The two people every suite gets: one who can do everything and one who can
 * only ring orders up. Fixed usernames, because the seed is keyed on username
 * (the row's UNIQUE identity now that a role no longer has one) and every
 * suite reseeds into the same database.
 */
const TEST_USERS = [
    { username: 'test_admin', role: 'admin', full_name: 'Test Admin' },
    { username: 'test_cashier', role: 'cashier', full_name: 'Test Cashier' },
];

/*
 * Empty the transactional tables (FK-safe order: children before orders,
 * ledgers last) and reseed the fixtures the verbs read: one store_settings
 * row carrying the two tax rates, one menu item for FK-linked lines, and the
 * two test accounts.
 */
export const resetDb = async () => {
    for (const table of [
        'payments', 'order_items', 'order_rounds', 'fbr_invoices',
        'orders', 'audit_log', 'invoice_counters', 'business_days',
        // Charge config changes totals (the seeded 5% service charge broke
        // every dine-in expectation the day it landed) — tests that want a
        // charge insert their own.
        'charges',
        // The ledger, children first. Journals cascade their lines, but the
        // DELETE is explicit so a future test reading a stray line cannot be
        // fooled by cascade ordering. The chart of accounts itself is NOT
        // wiped: it is migration-seeded reference data, like the tax rates,
        // and the poster resolves against it on every settle.
        'gl_journal_lines', 'gl_journals', 'gl_voucher_counters',
        'expense_voucher_payments', 'expense_voucher_lines',
        'expense_vouchers', 'expense_voucher_counters', 'expenses',
    ]) {
        await pool.query(`DELETE FROM ${table}`);
    }

    /*
     * Branch fixtures, children first.
     *
     * Every one of these tables gained a foreign key to `branches` when the
     * books learned to file by outlet, so a test that created branch 2 and
     * left a document behind makes the DELETE below fail — and a throw in a
     * `before()` hook does not fail the file cleanly, it HANGS it with the
     * suite lock still held, which stalls every other file behind it for the
     * lock's full 300 seconds. That is a very expensive way to find out about
     * a stray row, so the children go first.
     *
     * Overrides are per-test facts rather than fixtures: a branch price or a
     * tax rate left behind by one test would silently re-price the next one.
     */
    for (const table of [
        'branch_menu_items', 'branch_settings',
        'waste_lines', 'waste_docs',
        'stock_ledger', 'stock_doc_lines', 'stock_docs',
        'stock_receiving_lines', 'stock_receivings',
        'supplier_payments', 'company_receipts',
        'notifications',
    ]) {
        await pool.query(`DELETE FROM ${table}`);
    }
    await pool.query('DELETE FROM branches WHERE id <> 1');

    await pool.query('DELETE FROM store_settings');
    await pool.query(
        `INSERT INTO store_settings (id, merchant_name, tax_rate_cash, tax_rate_card)
         VALUES (?, 'Flames Test', ?, ?)`,
        [randomUUID(), TAX.cash, TAX.card],
    );

    await pool.query(
        `INSERT INTO menu_items (id, name, price, variants, modifiers)
         VALUES (?, 'Test Chicken Karahi', 1200, '[]', '[]') AS new_row
         ON DUPLICATE KEY UPDATE name = new_row.name, price = new_row.price,
                                 is_available = 1`,
        [MENU_ITEM_ID],
    );

    // The dishes seedLines minted for earlier runs. Safe here and only here:
    // the order lines that referenced them were deleted above, and outside a
    // test database deleting a menu_items row is never cleanup.
    await pool.query('DELETE FROM menu_items WHERE name LIKE ?', [`${SUITE_DISH_PREFIX}%`]);
    suiteDishes.clear();

    /*
     * The one modifier the suite rings: verbs.test.mjs sends
     * `selectedModifiers: { m1: [{ name: 'Extra' }] }`. Option prices now come
     * from this table rather than from the object the caller echoes back, so
     * the option has to exist — and at 0, which is what that test's arithmetic
     * has always assumed.
     */
    await pool.query(
        `INSERT INTO modifiers (id, \`key\`, name, type, options)
         VALUES ('m1', 'suite_m1', 'Suite Modifier', 'multiselect',
                 '[{"name": "Extra", "price": 0}]') AS new_row
         ON DUPLICATE KEY UPDATE options = new_row.options`,
    );

    // Password 'testpass1' at a cheap cost factor: these hashes gate nothing in
    // this suite, they just satisfy the schema honestly. Keyed on username —
    // role lost its unique index when one row per role stopped being the model.
    const passwordHash = bcrypt.hashSync('testpass1', 4);
    for (const u of TEST_USERS) {
        await pool.query(
            `INSERT INTO users (id, username, full_name, role, password_hash, token_version)
             VALUES (?, ?, ?, ?, ?, 1) AS new_row
             ON DUPLICATE KEY UPDATE
               full_name = new_row.full_name, role = new_row.role,
               password_hash = new_row.password_hash, token_version = 1,
               permissions = NULL, must_change_password = 0, is_active = 1`,
            [randomUUID(), u.username, u.full_name, u.role, passwordHash],
        );
    }

    const seeded = await q(
        'SELECT id, username FROM users WHERE username IN (?, ?)',
        TEST_USERS.map((u) => u.username),
    );
    const idFor = (username) => seeded.find((r) => r.username === username).id;

    return {
        menuItem: await one('SELECT * FROM menu_items WHERE id = ?', [MENU_ITEM_ID]),
        users: {
            admin: idFor('test_admin'),
            cashier: idFor('test_cashier'),
        },
    };
};

/*
 * Ring a line the way the till does — through the menu.
 *
 * The kernel now prices every line from menu_items rather than from whatever
 * `price` the caller claimed, because the old behaviour let a crafted call
 * sell a Rs 8,995 dish for Rs 1 (see pricedLines in src/lib/db/orders.mjs).
 * These tests were written against that behaviour and name their lines freely
 * — `{ name: 'Test Gulab Jamun', price: 835, qty: 2 }` — which is exactly the
 * shape a cart has.
 *
 * So this seeds a dish AT THAT PRICE and hands the line its id. Every existing
 * assertion is unchanged and now runs through the real pricing path: the test
 * still says "a line worth Rs 835", and the menu now agrees that it is.
 *
 * Deduped per price-and-size within a run, and the rows are named so resetDb
 * can clear them; a test that already picked a dish (fx.menuItem) passes
 * straight through.
 */
const suiteDishes = new Map();
export const SUITE_DISH_PREFIX = 'Suite priced dish';

export const seedLines = async (items) => {
    const out = [];
    for (const i of items) {
        if (i?.id) { out.push(i); continue; }
        const size = i?.selectedVariant?.name ?? null;
        const price = Number(i?.price) || 0;
        const key = `${size ?? '-'}|${price}`;
        let id = suiteDishes.get(key);
        if (!id) {
            id = randomUUID();
            await pool.query(
                `INSERT INTO menu_items (id, name, price, variants, modifiers, is_available)
                 VALUES (?, ?, ?, ?, '[]', 1)`,
                [id, `${SUITE_DISH_PREFIX} ${key} ${id.slice(0, 8)}`, price,
                    size ? JSON.stringify([{ name: size, price }]) : '[]'],
            );
            suiteDishes.set(key, id);
        }
        out.push({ ...i, id });
    }
    return out;
};

/*
 * The kernel verbs, as the suite calls them: identical signatures, with the
 * menu seeded first. Tests import these from here instead of reaching into
 * src/lib/db/orders.mjs, so no call site had to change.
 */
export const createOrder = async (items, opts = {}, clientRequestId = null, expectedTotal = null) =>
    kernelCreateOrder(await seedLines(items), opts, clientRequestId, expectedTotal);

export const appendRound = async (orderId, items, clientRequestId = null, expectedTotal = null, opts = {}) =>
    kernelAppendRound(orderId, await seedLines(items), clientRequestId, expectedTotal, opts);

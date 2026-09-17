/*
 * The export's table classification, checked against the real schema.
 *
 * The failure this prevents: somebody adds a table, forgets to classify it,
 * and a restaurant's data is silently left behind on its next deploy — or
 * worse, a transaction table joins SETUP and a new install opens with somebody
 * else's takings already in the ledger.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../src/lib/db/pool.mjs';
import { closeDb } from './helpers.mjs';
import { SETUP, TRANSACTIONS, COUNTERS, SYSTEM, classificationProblems, parentsFirst } from '../../scripts/db/master-tables.mjs';

const tablesInDb = async () => {
    const rows = await query(
        `SELECT table_name AS t FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    return rows.map((r) => r.t);
};

test('every table in the schema is classified exactly once', async () => {
    const problems = classificationProblems(await tablesInDb());
    assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}\n`);
});

test('nothing that records money is carried to a new install', async () => {
    // Named explicitly rather than pattern-matched: this list is the point.
    for (const t of ['orders', 'payments', 'gl_journals', 'gl_journal_lines',
        'stock_ledger', 'expenses', 'audit_log', 'business_days', 'drawer_sessions']) {
        assert.ok(!SETUP.includes(t), `${t} must never be in SETUP — a new install's books start empty`);
        assert.ok(TRANSACTIONS.includes(t), `${t} should be classified as a transaction table`);
    }
});

test('counters are reset, so the first live bill is number one', () => {
    for (const t of ['invoice_counters', 'token_counters']) {
        assert.ok(COUNTERS.includes(t) && !SETUP.includes(t), `${t} must not travel`);
    }
});

test('users and schema_migrations never travel', () => {
    // Dev passwords are known; the migrator owns its own bookkeeping.
    assert.deepEqual([...SYSTEM].sort(), ['schema_migrations', 'users']);
    assert.ok(!SETUP.includes('users'));
});

test('the menu and what it is made of do travel', () => {
    for (const t of ['categories', 'menu_items', 'recipes', 'recipe_lines',
        'inventory_items', 'units', 'accounts', 'store_settings']) {
        assert.ok(SETUP.includes(t), `${t} is what somebody typed — it must travel`);
    }
});

test('parentsFirst puts a parent before its child', async () => {
    const edges = await query(
        `SELECT table_name AS child, referenced_table_name AS parent
           FROM information_schema.key_column_usage
          WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`,
    );
    const ordered = parentsFirst(SETUP, edges);
    assert.equal(ordered.length, SETUP.length, 'every table is emitted exactly once');
    assert.deepEqual([...new Set(ordered)].length, SETUP.length, 'no duplicates');

    const at = new Map(ordered.map((t, i) => [t, i]));
    const set = new Set(SETUP);
    for (const { child, parent } of edges) {
        if (child === parent || !set.has(child) || !set.has(parent)) continue;
        assert.ok(at.get(parent) < at.get(child),
            `${parent} must be loaded before ${child}, or REPLACE can cascade the child away`);
    }
});

after(async () => { await closeDb(); });

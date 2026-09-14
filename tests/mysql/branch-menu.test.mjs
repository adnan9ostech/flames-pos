/*
 * One menu, one price everywhere — and then the exceptions.
 *
 * `branch_menu_items` holds only departures, and the two rules that make that
 * work are easy to break and invisible when broken:
 *
 *   1. A price EQUAL to the menu's is not an override, it is agreement.
 *      Storing it would freeze the branch at today's number: raise the menu
 *      next month and that outlet silently keeps the old price, having
 *      recorded a difference nobody meant. So the row goes.
 *
 *   2. A branch may only take a dish OFF. `CASE WHEN b.is_available = 0 THEN 0
 *      ELSE m.is_available END` — a dish withdrawn across the menu stays
 *      withdrawn, and no branch can put it back on sale by itself.
 *
 * These drive the reader the till actually calls, not a copy of its SQL.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q } from './helpers.mjs';
import { getMenuItems } from '../../src/lib/db/reads.mjs';
import { branchMenuOverride } from '../../src/lib/menu/rules.mjs';

const LAHORE = 2;
let dishId;
const MENU_PRICE = 1000;

before(async () => {
    await acquireSuiteLock();
    await resetDb();
    await q(`INSERT INTO branches (id, name, code, is_active) VALUES (?, 'Test Lahore', 'LHR', 1)`, [LAHORE]);
    dishId = randomUUID();
    await q(
        `INSERT INTO menu_items (id, name, price, variants, modifiers, is_available)
         VALUES (?, 'Test Branch Karahi', ?, '[]', '[]', 1)`,
        [dishId, MENU_PRICE],
    );
});
after(closeDb);

const seen = async (branchId) => {
    const items = await getMenuItems(branchId);
    return items.find((i) => i.id === dishId);
};

test('with no override, every branch sees the menu', async () => {
    for (const b of [1, LAHORE]) {
        const item = await seen(b);
        assert.equal(Number(item.price), MENU_PRICE);
        assert.equal(Boolean(item.is_available), true);
    }
});

test('a branch price re-prices that branch and no other', async () => {
    await q(
        'INSERT INTO branch_menu_items (branch_id, menu_item_id, price) VALUES (?, ?, ?)',
        [LAHORE, dishId, 1450],
    );
    assert.equal(Number((await seen(LAHORE)).price), 1450);
    assert.equal(Number((await seen(1)).price), MENU_PRICE, 'head office is untouched');
});

test('raising the MENU price still reaches a branch that only turned a dish off', async () => {
    // The whole point of storing differences rather than copies. This branch
    // has an availability exception but no price one, so a menu rise must
    // carry to it.
    await q('UPDATE branch_menu_items SET price = NULL, is_available = 0 WHERE branch_id = ?', [LAHORE]);
    await q('UPDATE menu_items SET price = 1200 WHERE id = ?', [dishId]);
    assert.equal(Number((await seen(LAHORE)).price), 1200);
    await q('UPDATE menu_items SET price = ? WHERE id = ?', [MENU_PRICE, dishId]);
});

test('a branch can take a dish off, and cannot put a withdrawn one back on', async () => {
    await q('UPDATE branch_menu_items SET is_available = 0 WHERE branch_id = ?', [LAHORE]);
    assert.equal(Boolean((await seen(LAHORE)).is_available), false, 'off at Lahore');
    assert.equal(Boolean((await seen(1)).is_available), true, 'still on at head office');

    // Withdrawn menu-wide, with this branch's row saying "available".
    await q('UPDATE menu_items SET is_available = 0 WHERE id = ?', [dishId]);
    await q('UPDATE branch_menu_items SET is_available = 1 WHERE branch_id = ?', [LAHORE]);
    assert.equal(
        Boolean((await seen(LAHORE)).is_available), false,
        'a branch cannot put a withdrawn dish back on sale',
    );
    await q('UPDATE menu_items SET is_available = 1 WHERE id = ?', [dishId]);
});

test('agreement with the menu is not an override, and leaves no row', () => {
    // The decision the screen and the verb both make, asserted where it lives.
    // A 'use server' file cannot be loaded by node --test, which is exactly why
    // this judgement was lifted into menu/rules.mjs rather than kept inline.
    const menu = MENU_PRICE;

    const differs = branchMenuOverride('1450', true, menu);
    assert.deepEqual(differs, { price: 1450, isAvailable: true, isOverride: true });

    // The menu's OWN price is agreement. Storing it would pin this branch to
    // today's number and quietly ignore the next menu rise.
    const agrees = branchMenuOverride(String(menu), true, menu);
    assert.deepEqual(agrees, { price: null, isAvailable: true, isOverride: false });

    // Paise are compared, not string-matched: "1000.00" is the same price.
    assert.equal(branchMenuOverride('1000.00', true, menu).isOverride, false);

    // Off with no price is still a difference and must keep its row.
    assert.deepEqual(
        branchMenuOverride('', false, menu),
        { price: null, isAvailable: false, isOverride: true },
    );

    // Back on with no price is no exception at all.
    assert.equal(branchMenuOverride('', true, menu).isOverride, false);
    assert.equal(branchMenuOverride(null, true, menu).isOverride, false);
});

test('a nonsense price is refused rather than stored', () => {
    for (const bad of ['abc', -5, 99_999_999]) {
        assert.throws(() => branchMenuOverride(bad, true, MENU_PRICE), /price/i, `${bad} is refused`);
    }
});

test('archiving a dish takes it off every branch, override or not', async () => {
    // Upsert: the earlier tests in this file leave this branch with a row,
    // and the point here is the archive, not how the row got there.
    await q(
        `INSERT INTO branch_menu_items (branch_id, menu_item_id, price) VALUES (?, ?, 1450)
         AS new_row ON DUPLICATE KEY UPDATE price = new_row.price`,
        [LAHORE, dishId],
    );
    await q('UPDATE menu_items SET is_archived = 1 WHERE id = ?', [dishId]);
    assert.equal(await seen(LAHORE), undefined, 'an archived dish reaches no till');
    assert.equal(await seen(1), undefined);
    await q('UPDATE menu_items SET is_archived = 0 WHERE id = ?', [dishId]);
});

test('deleting a branch takes its menu exceptions with it', async () => {
    await q(`INSERT INTO branches (id, name, code) VALUES (98, 'Test Temp Menu', 'TMP')`);
    await q('INSERT INTO branch_menu_items (branch_id, menu_item_id, price) VALUES (98, ?, 500)', [dishId]);
    await q('DELETE FROM branches WHERE id = 98');
    assert.equal((await q('SELECT * FROM branch_menu_items WHERE branch_id = 98')).length, 0);
});

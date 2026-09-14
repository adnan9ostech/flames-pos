/*
 * The menu's rules. Most of this is a pure module — the same file the browser
 * pre-validates a form with and the server enforces on save — so it runs with
 * no database and no suite lock, like the permissions suite. The handful of
 * tests at the bottom that DO touch MySQL take the lock, because they write.
 *
 * What is being protected here is money. A size list in the wrong order rings
 * a Full karahi up at the Half price; a dish whose `price` disagrees with its
 * largest size shows one number on the tile and charges another; a stored
 * image path that is not ours is a remote fetch on a till that may be offline.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
    cleanName, cleanPrice, cleanVariants, listPrice, slugKey,
    cleanModifierKeys, cleanOptions, cleanImagePath, requireUuid,
    CATEGORY_ICON_NAMES, MODIFIER_TYPES, MENU_IMAGE_URL_PREFIX,
    RECIPE_VARIANT_FOR_LINE, RECIPE_COST_TABLE,
} from '../../src/lib/menu/rules.mjs';
import { formatRupees, formatNumber, formatPriceRange } from '../../src/lib/money.js';
import { acquireSuiteLock, closeDb, q, one } from './helpers.mjs';

/* ---------- names, prices ---------- */

test('a name is trimmed, collapsed and bounded', () => {
    assert.equal(cleanName('  Chicken   Karahi '), 'Chicken Karahi');
    assert.throws(() => cleanName('   ', 'A dish'), /A dish needs a name/);
    assert.throws(() => cleanName('x'.repeat(200), 'A dish'), /too long/);
    assert.throws(() => cleanName(null, 'A dish'), /needs a name/);
});

test('a price is a non-negative number, rounded to paise', () => {
    assert.equal(cleanPrice('1200'), 1200);
    assert.equal(cleanPrice(' 1200.456 '), 1200.46);
    assert.equal(cleanPrice(0), 0);
    assert.throws(() => cleanPrice('-1'), /cannot be negative/);
    assert.throws(() => cleanPrice('abc'), /must be a number/);
    // An empty box is not a zero-rupee dish: it is a missing answer.
    assert.throws(() => cleanPrice(''), /must be a number/);
    assert.throws(() => cleanPrice('99999999'), /implausibly large/);
});

/* ---------- sizes ---------- */

test('sizes come back ascending by price, whatever order they were typed in', () => {
    const v = cleanVariants([{ name: 'Full', price: '8995' }, { name: 'Half', price: '4945' }]);
    assert.deepEqual(v, [{ name: 'Half', price: 4945 }, { name: 'Full', price: 8995 }]);
    // The till's modal defaults to the FIRST entry, so this order is what keeps
    // a Half from ringing up as a Full.
    assert.equal(v[0].name, 'Half');
});

test('the tile price is the LARGEST size, never the smallest', () => {
    const v = cleanVariants([{ name: 'Half', price: '2945' }, { name: 'Full', price: '5445' }]);
    assert.equal(listPrice(2945, v), 5445);
    assert.equal(listPrice(1200, []), 1200);
    assert.equal(listPrice(1200, null), 1200);
});

test('a size list refuses the shapes that would misprice a dish', () => {
    assert.throws(() => cleanVariants([{ name: 'Full', price: '5445' }]), /one size is a dish with a price/);
    assert.throws(() => cleanVariants([{ name: 'Half', price: '1' }, { name: 'half', price: '2' }]), /listed twice/);
    assert.throws(() => cleanVariants([{ name: '', price: '500' }, { name: 'Full', price: '900' }]), /needs a name/);
    assert.throws(() => cleanVariants(
        Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, price: String(i + 1) }))), /At most 8/);
});

test('empty editor rows fall out instead of failing the save', () => {
    assert.deepEqual(cleanVariants([{ name: '', price: '' }, { name: '  ', price: '  ' }]), []);
    assert.deepEqual(
        cleanVariants([{ name: 'Half', price: '100' }, { name: '', price: '' }, { name: 'Full', price: '200' }]),
        [{ name: 'Half', price: 100 }, { name: 'Full', price: 200 }],
    );
});

/* ---------- modifiers ---------- */

test('a modifier key is a slug, and a dish may only link keys that exist', () => {
    assert.equal(slugKey('Spice Level'), 'spice-level');
    assert.equal(slugKey('  Add-ons!!  '), 'add-ons');
    assert.deepEqual(cleanModifierKeys(['raita', 'raita', ''], ['raita', 'spiciness']), ['raita']);
    assert.throws(() => cleanModifierKeys(['ketchup'], ['raita']), /no longer exists/);
});

test('a pick-one modifier needs a real choice; add-ons need at least one', () => {
    assert.deepEqual(MODIFIER_TYPES, ['select', 'multiselect']);
    assert.throws(() => cleanOptions([{ name: 'Mild', price: '0' }], 'select'), /at least two options/);
    assert.throws(() => cleanOptions([], 'multiselect'), /at least one option/);
    const opts = cleanOptions([{ name: 'Raita', price: '50' }, { name: 'Salad', price: '' }], 'multiselect');
    // A blank price is free, not invalid — most add-ons are.
    assert.deepEqual(opts, [{ name: 'Raita', price: 50 }, { name: 'Salad', price: 0 }]);
    assert.throws(() => cleanOptions([{ name: 'Mild', price: '0' }, { name: 'mild', price: '0' }], 'select'), /listed twice/);
});

/* ---------- photos ---------- */

test('only the app\'s own photo paths can be stored', () => {
    const uploaded = `${MENU_IMAGE_URL_PREFIX}${randomUUID()}.webp`;
    assert.equal(cleanImagePath(uploaded), uploaded);
    assert.equal(cleanImagePath('/menu-images/menu-v4/karahi/chicken-karahi.webp'),
        '/menu-images/menu-v4/karahi/chicken-karahi.webp');
    assert.equal(cleanImagePath(''), null);
    assert.equal(cleanImagePath(null), null);
    // A remote URL on a till that may be offline is a photo that does not print
    // and does not draw; traversal is the other half of the same guard.
    assert.throws(() => cleanImagePath('https://example.com/x.webp'), /not one the menu can use/);
    assert.throws(() => cleanImagePath('/menu-images/../../etc/passwd'), /not one the menu can use/);
    assert.throws(() => cleanImagePath(`${MENU_IMAGE_URL_PREFIX}evil.svg`), /not one the menu can use/);
});

test('a dish id must be a uuid before it reaches a query', () => {
    const id = randomUUID();
    assert.equal(requireUuid(id.toUpperCase()), id);
    assert.throws(() => requireUuid('1 OR 1=1'), /Pick a dish first/);
});

/* ---------- money ---------- */

test('money is formatted in one locale, everywhere', () => {
    assert.equal(formatNumber(1250), '1,250');
    assert.equal(formatRupees(1250), 'Rs. 1,250');
    assert.equal(formatRupees(1250.5, 2), 'Rs. 1,250.50');
    // A missing figure prints as zero, never as "NaN" on a customer's bill.
    assert.equal(formatRupees(null), 'Rs. 0');
    assert.equal(formatRupees(undefined), 'Rs. 0');
    assert.equal(formatPriceRange(5445, [{ name: 'Half', price: 2945 }, { name: 'Full', price: 5445 }]),
        'Rs. 2,945 – 5,445');
    assert.equal(formatPriceRange(1200, []), 'Rs. 1,200');
});

/* ---------- the till's glyph vocabulary ---------- */

test('the category icons offered are the ones the till can actually draw', () => {
    // POS and the customer menu each map exactly these names and fall back to
    // Utensils for anything else — offering a seventh would draw a plate.
    assert.deepEqual(CATEGORY_ICON_NAMES, ['Utensils', 'Flame', 'Soup', 'Cookie', 'GlassWater', 'Plus']);
});

/* ---------- the database rules ---------- */

before(acquireSuiteLock);
after(closeDb);

test('an archived dish leaves the menu the till reads, and keeps its history', async () => {
    const { getMenuItems } = await import('../../src/lib/db/reads.mjs');
    const id = randomUUID();
    await q(`INSERT INTO menu_items (id, name, price, variants, modifiers) VALUES (?, ?, 1, '[]', '[]')`,
        [id, `ZZ Archive Probe ${id.slice(0, 8)}`]);
    try {
        assert.ok((await getMenuItems()).some((m) => m.id === id), 'a live dish is on the menu');
        await q('UPDATE menu_items SET is_archived = 1 WHERE id = ?', [id]);
        assert.ok(!(await getMenuItems()).some((m) => m.id === id), 'an archived dish is not');
        // The row itself survives, because order_items points at it.
        assert.ok(await one('SELECT id FROM menu_items WHERE id = ?', [id]));
    } finally {
        await q('DELETE FROM menu_items WHERE id = ?', [id]);
    }
});

test('a size carries its own recipe, and falls back to the base when it has none', async () => {
    const dish = randomUUID();
    const unit = (await one('SELECT id FROM units LIMIT 1')).id;
    await q(`INSERT INTO menu_items (id, name, price, variants, modifiers)
             VALUES (?, ?, 900, '[{"name":"Half","price":500},{"name":"Full","price":900}]', '[]')`,
        [dish, `ZZ Recipe Probe ${dish.slice(0, 8)}`]);
    const ing = (await q('INSERT INTO inventory_items (name, unit_id, avg_cost) VALUES (?, ?, 10)',
        [`ZZ Probe Ingredient ${dish.slice(0, 8)}`, unit])).insertId;
    try {
        await q('INSERT INTO recipes (menu_item_id) VALUES (?)', [dish]);
        // Base: 1 unit. Full: 3 units. Half has none of its own.
        await q(`INSERT INTO recipe_lines (menu_item_id, variant_name, inventory_item_id, qty)
                 VALUES (?, '', ?, 1), (?, 'Full', ?, 3)`, [dish, ing, dish, ing]);

        // The resolver, exactly as the consumption engine and the costing
        // reports use it: a sold line's own size if that size has lines, else ''.
        const resolve = async (variant) => (await q(
            `SELECT ${RECIPE_VARIANT_FOR_LINE} AS v
               FROM (SELECT ? AS menu_item_id, ? AS variant) oi`,
            [dish, variant],
        ))[0].v;
        assert.equal(await resolve('Full'), 'Full', 'a size with its own lines uses them');
        assert.equal(await resolve('Half'), '', 'a size with none falls back to the base');
        assert.equal(await resolve(null), '', 'an unsized line is the base');

        const costs = await q(
            `SELECT variant_name, unit_cost FROM (${RECIPE_COST_TABLE}) rc
              WHERE rc.menu_item_id = ? ORDER BY variant_name`, [dish]);
        assert.deepEqual(costs.map((r) => [r.variant_name, Number(r.unit_cost)]), [['', 10], ['Full', 30]]);
    } finally {
        await q('DELETE FROM recipe_lines WHERE menu_item_id = ?', [dish]);
        await q('DELETE FROM recipes WHERE menu_item_id = ?', [dish]);
        await q('DELETE FROM menu_items WHERE id = ?', [dish]);
        await q('DELETE FROM inventory_items WHERE id = ?', [ing]);
    }
});

test('every sized dish that names a variation set matches it, position for position', async () => {
    // The set owns the option names and their order; the dish owns the prices.
    // A dish whose sizes have drifted from its set would show one vocabulary on
    // the Variations screen and another on the till.
    const drifted = await q(
        `SELECT m.name, m.variants, v.name AS set_name, v.options
           FROM menu_items m JOIN variation_sets v ON v.id = m.variation_set_id
          WHERE JSON_LENGTH(m.variants) <> JSON_LENGTH(v.options)
             OR JSON_EXTRACT(m.variants, '$[0].name') <> JSON_EXTRACT(v.options, '$[0]')`);
    assert.deepEqual(drifted, [], 'dishes whose sizes disagree with their set');
});

test('a branch sells the same menu, with only its own differences', async () => {
    const { getMenuItems } = await import('../../src/lib/db/reads.mjs');
    const tag = randomUUID().slice(0, 8);
    const dishId = randomUUID();
    await q(
        "INSERT INTO menu_items (id, name, price, variants, modifiers) VALUES (?, ?, 500, '[]', '[]')",
        [dishId, `Branch Dish ${tag}`],
    );
    const other = (await q(
        "INSERT INTO branches (name, code, is_active) VALUES (?, ?, 1)", [`Second ${tag}`, `B${tag.slice(0, 4)}`],
    )).insertId;

    try {
        // No override anywhere: both branches sell it at the menu's price.
        const base = (await getMenuItems(1)).find((m) => m.id === dishId);
        const away = (await getMenuItems(other)).find((m) => m.id === dishId);
        assert.equal(Number(base.price), 500);
        assert.equal(Number(away.price), 500);
        assert.equal(base.is_available, true);

        // Dearer at the second branch, and off there later.
        await q(
            'INSERT INTO branch_menu_items (branch_id, menu_item_id, price) VALUES (?, ?, 650)',
            [other, dishId],
        );
        assert.equal(Number((await getMenuItems(other)).find((m) => m.id === dishId).price), 650);
        assert.equal(Number((await getMenuItems(1)).find((m) => m.id === dishId).price), 500,
            'the other branch is untouched');

        await q('UPDATE branch_menu_items SET is_available = 0 WHERE branch_id = ? AND menu_item_id = ?',
            [other, dishId]);
        assert.equal((await getMenuItems(other)).find((m) => m.id === dishId).is_available, false);
        assert.equal((await getMenuItems(1)).find((m) => m.id === dishId).is_available, true,
            'off here is not off everywhere');

        // And a dish taken off the menu for the whole company is off at every
        // branch, whatever the override says.
        await q('UPDATE menu_items SET is_available = 0 WHERE id = ?', [dishId]);
        await q('UPDATE branch_menu_items SET is_available = 1 WHERE branch_id = ?', [other]);
        assert.equal((await getMenuItems(other)).find((m) => m.id === dishId).is_available, false,
            'a branch cannot switch on what the company switched off');
    } finally {
        await q('DELETE FROM branch_menu_items WHERE branch_id = ?', [other]);
        await q('DELETE FROM branches WHERE id = ?', [other]);
        await q('DELETE FROM menu_items WHERE id = ?', [dishId]);
    }
});

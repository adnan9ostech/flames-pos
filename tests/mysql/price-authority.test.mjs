/*
 * The menu decides the price. The browser does not.
 *
 * This is the invariant that was missing. `unit_price` used to be whatever
 * `price` the caller sent, and the server never looked at the dish the line
 * claimed to be — so a crafted call sold Mutton White Qorma, menu price
 * Rs 8,995, for Rs 1: the line kept the real menu_item_id, the bill settled at
 * Rs 2, a fiscal invoice was minted, and the sale journal posted Rs 2 to the
 * books. Nothing downstream disagreed because nothing upstream ever had.
 *
 * These tests ring the kernel DIRECTLY rather than through the suite's
 * menu-seeding shim, because the shim exists to make a dish match the price a
 * test claims — which is precisely what must not be assumed here.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one } from './helpers.mjs';
import { createOrder, settleOrder } from '../../src/lib/db/orders.mjs';

const LAHORE = 2;
let dish;      // a sized dish, priced per size
let plain;     // an unsized dish
let modId;

before(async () => {
    await acquireSuiteLock();
    await resetDb();

    /*
     * This file's own fixtures, cleared first so a re-run is clean: the
     * modifier's `key` is UNIQUE and resetDb does not know about these rows.
     * Order lines referencing the dishes were deleted by resetDb above.
     */
    await q("DELETE FROM branch_menu_items WHERE menu_item_id IN (SELECT id FROM menu_items WHERE name LIKE 'Authority %')");
    await q("DELETE FROM menu_items WHERE name LIKE 'Authority %'");
    await q("DELETE FROM modifiers WHERE `key` = 'authority_addons'");

    dish = randomUUID();
    await q(
        `INSERT INTO menu_items (id, name, price, variants, modifiers, is_available)
         VALUES (?, 'Authority Karahi', 8995, ?, '[]', 1)`,
        [dish, JSON.stringify([{ name: 'Half', price: 4945 }, { name: 'Full', price: 8995 }])],
    );
    plain = randomUUID();
    await q(
        `INSERT INTO menu_items (id, name, price, variants, modifiers, is_available)
         VALUES (?, 'Authority Naan', 120, '[]', '[]', 1)`,
        [plain],
    );
    modId = randomUUID();
    await q(
        `INSERT INTO modifiers (id, \`key\`, name, type, options)
         VALUES (?, 'authority_addons', 'Add-ons', 'multiselect',
                 '[{"name": "Raita", "price": 50}, {"name": "Free Salad", "price": 0}]')`,
        [modId],
    );
    await q(`INSERT INTO branches (id, name, code, is_active) VALUES (?, 'Authority Lahore', 'ALH', 1)`, [LAHORE]);
});
after(closeDb);

const ring = (items, opts = {}) => createOrder(
    items, { order_type: 'takeaway', payment_status: 'unpaid', ...opts }, randomUUID(),
);

test('a claimed price is ignored — the menu is the authority', async () => {
    const order = await ring([{ id: plain, name: 'Authority Naan', price: 1, qty: 3 }]);
    assert.equal(Number(order.subtotal), 360, '3 x the menu 120, not 3 x the claimed 1');

    const line = await one('SELECT unit_price, menu_item_id FROM order_items WHERE order_id = ?', [order.id]);
    assert.equal(Number(line.unit_price), 120);
    assert.equal(line.menu_item_id, plain, 'and the line still names the dish it is');
});

test('a claimed price is ignored upwards too — nobody overcharges by crafting a request', async () => {
    const order = await ring([{ id: plain, name: 'Authority Naan', price: 99999, qty: 1 }]);
    assert.equal(Number(order.subtotal), 120);
});

test('a size prices from that size, not from the dish or from the claim', async () => {
    const half = await ring([{
        id: dish, name: 'Authority Karahi (Half)', price: 1, qty: 1,
        selectedVariant: { name: 'Half', price: 1 },
    }]);
    assert.equal(Number(half.subtotal), 4945);

    const full = await ring([{
        id: dish, name: 'Authority Karahi (Full)', price: 7, qty: 1,
        selectedVariant: { name: 'Full', price: 7 },
    }]);
    assert.equal(Number(full.subtotal), 8995);
});

test('a modifier option prices from the modifier table, not from the option the caller echoes back', async () => {
    const order = await ring([{
        id: plain, name: 'Authority Naan', price: 1, qty: 1,
        // The caller claims Raita is free and Free Salad costs 900. Neither
        // number is consulted: Raita is 50 and Free Salad is 0.
        selectedModifiers: { [modId]: [{ name: 'Raita', price: 0 }, { name: 'Free Salad', price: 900 }] },
    }]);
    assert.equal(Number(order.subtotal), 170, '120 + 50 + 0');
});

test('a line that names no dish on the menu is refused', async () => {
    await assert.rejects(
        ring([{ name: 'Invented Dish', price: 500, qty: 1 }]),
        /is not on the menu/,
    );
    await assert.rejects(
        ring([{ id: randomUUID(), name: 'Deleted Dish', price: 500, qty: 1 }]),
        /is not on the menu/,
    );
});

test('an archived dish cannot be rung', async () => {
    const gone = randomUUID();
    await q(
        `INSERT INTO menu_items (id, name, price, variants, modifiers, is_archived)
         VALUES (?, 'Authority Retired', 400, '[]', '[]', 1)`,
        [gone],
    );
    await assert.rejects(ring([{ id: gone, name: 'Authority Retired', price: 400, qty: 1 }]), /is not on the menu/);
});

test('a size or an option that no longer exists is refused, by name', async () => {
    await assert.rejects(
        ring([{ id: dish, name: 'x', price: 1, qty: 1, selectedVariant: { name: 'Bucket' } }]),
        /"Bucket" is no longer a size of Authority Karahi/,
    );
    await assert.rejects(
        ring([{ id: plain, name: 'x', price: 1, qty: 1, selectedModifiers: { [modId]: [{ name: 'Caviar' }] } }]),
        /"Caviar" is no longer an option on Authority Naan/,
    );
});

test('a branch price override reaches the bill', async () => {
    await q(
        'INSERT INTO branch_menu_items (branch_id, menu_item_id, price) VALUES (?, ?, 175)',
        [LAHORE, plain],
    );
    const here = await ring([{ id: plain, name: 'Authority Naan', price: 1, qty: 2 }], { branch_id: 1 });
    const there = await ring([{ id: plain, name: 'Authority Naan', price: 1, qty: 2 }], { branch_id: LAHORE });
    assert.equal(Number(here.subtotal), 240, 'head office pays the menu');
    assert.equal(Number(there.subtotal), 350, 'Lahore pays its own 175');
});

test('a comped bill settles, and writes no payment row — no money moved', async () => {
    // 100% off: the discount clamp takes it to exactly the subtotal.
    const order = await ring(
        [{ id: plain, name: 'Authority Naan', price: 1, qty: 1 }],
        { include_tax: false, discount: 99999 },
    );
    assert.equal(Number(order.discount), 120, 'clamped to the bill, never beyond it');
    assert.equal(Number(order.total), 0);

    const settled = await settleOrder(order.id, { method: 'cash', clientRequestId: randomUUID() });
    assert.equal(settled.payment_status, 'paid', 'a comped bill can be closed');
    assert.equal(
        (await q('SELECT id FROM payments WHERE order_id = ?', [order.id])).length, 0,
        'and leaves no payment row, because the column means money that moved',
    );
});

/*
 * And who did it.
 *
 * Every ring, settle and void used to file an audit row with staff_id NULL —
 * 199 creates and 159 settles in the development database with no person on
 * any of them, while remove_item, which threads its approver through, had one
 * on all five. A restaurant's audit trail earns its keep on exactly these
 * rows: the drawer is short, and somebody has to be able to ask who was on the
 * till. It cannot be answered retroactively.
 */
test('a sale records who rang it and who settled it', async () => {
    const staff = await one("SELECT id FROM users WHERE username = 'test_cashier'");
    assert.ok(staff, 'the suite seeds test_cashier');

    const order = await createOrder(
        [{ id: plain, name: 'Authority Naan', price: 120, qty: 1 }],
        { order_type: 'takeaway', payment_status: 'unpaid', userId: staff.id },
        randomUUID(),
    );
    await settleOrder(order.id, { method: 'cash', userId: staff.id, clientRequestId: randomUUID() });

    const rows = await q(
        'SELECT action, staff_id FROM audit_log WHERE order_id = ? ORDER BY id',
        [order.id],
    );
    const byAction = new Map(rows.map((r) => [r.action, r.staff_id]));
    assert.equal(byAction.get('create_order'), staff.id, 'the ring names the person');
    assert.equal(byAction.get('settle_order'), staff.id, 'so does the settle');
});

test('a void records who authorised it', async () => {
    const staff = await one("SELECT id, full_name FROM users WHERE username = 'test_admin'");
    const order = await createOrder(
        [{ id: plain, name: 'Authority Naan', price: 120, qty: 1 }],
        { order_type: 'takeaway', payment_status: 'unpaid' },
        randomUUID(),
    );
    const { voidOrder } = await import('../../src/lib/db/orders.mjs');
    await voidOrder(order.id, 'wrong table', staff.full_name, staff.id);

    const row = await one(
        "SELECT staff_id FROM audit_log WHERE order_id = ? AND action = 'void_order'", [order.id],
    );
    assert.equal(row.staff_id, staff.id);
    // The order row has always carried the name; now the trail carries the id.
    const o = await one('SELECT cancelled_by FROM orders WHERE id = ?', [order.id]);
    assert.equal(o.cancelled_by, staff.full_name);
});

test('a machine posting is still allowed to have no person', async () => {
    // A background hook, a worker, an FBR retry: NULL means "no person", not
    // "we did not bother to look", and must stay legal.
    const order = await createOrder(
        [{ id: plain, name: 'Authority Naan', price: 120, qty: 1 }],
        { order_type: 'takeaway', payment_status: 'unpaid' },
        randomUUID(),
    );
    const row = await one(
        "SELECT staff_id FROM audit_log WHERE order_id = ? AND action = 'create_order'", [order.id],
    );
    assert.equal(row.staff_id, null);
});

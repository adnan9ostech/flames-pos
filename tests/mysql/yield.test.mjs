/*
 * What you buy versus what you can cook with.
 *
 * A recipe line says what reaches the plate. The shelf gave up whatever had to
 * be trimmed to get there — bone, skin, peel, the ends of the onion. Yield is
 * the bridge, and the reason it needs a test of its own is that it is ONE
 * DIVISION THAT HAS TO HAPPEN EXACTLY ONCE. Apply it twice and the shelf
 * empties at 1.4x; apply it nowhere and the count drifts short every service,
 * which is what this system did before the column existed.
 *
 * So these assert the three places it must land — the ledger, the cost of what
 * left, and the price of a phantom made of it — and the one place it must not:
 * an item nobody has thought about, which must behave exactly as it did.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireSuiteLock, resetDb, closeDb, q, one, createOrder } from './helpers.mjs';
import { expandToRaw, effectiveCost, indexSubRecipes } from '../../src/lib/inventory/subrecipe.mjs';

before(async () => {
    await acquireSuiteLock();
    await resetDb();
});
after(closeDb);

const tag = randomUUID().slice(0, 8);
const mkItem = async (name, yieldPct = 100) => (await q(
    'INSERT INTO inventory_items (name, unit_id, is_active, yield_pct) VALUES (?, 1, 1, ?)',
    [`${name} ${tag}`, yieldPct],
)).insertId;

test('the expansion divides a leaf by its yield, exactly once', () => {
    const chicken = 1;
    const yields = new Map([[chicken, 70]]);

    const plain = expandToRaw([{ itemId: chicken, qty: 0.2 }]);
    assert.equal(plain[0].qty, 0.2, 'with no yields map, nothing is divided');

    const [trimmed] = expandToRaw([{ itemId: chicken, qty: 0.2 }], new Map(), yields);
    // 200 g on the plate needs 285.7 g of whole chicken off the shelf.
    assert.ok(Math.abs(trimmed.qty - 0.2 / 0.7) < 1e-9);
});

test('a nonsensical yield divides by one rather than emptying the shelf', () => {
    // A fat-fingered 0 must not divide by zero and consume the entire store;
    // a negative or a number over 100 is not a yield either.
    for (const bad of [0, -20, 150, null, undefined, NaN]) {
        const [out] = expandToRaw([{ itemId: 7, qty: 5 }], new Map(), new Map([[7, bad]]));
        assert.equal(out.qty, 5, `yield ${bad} is treated as no loss`);
    }
});

test('a phantom is priced from its parts AT THEIR YIELD, and is not itself trimmed', () => {
    const onion = 1;
    const salt = 2;
    const masala = 3;
    // 1 kg of masala is 0.5 kg onion + 0.5 kg salt.
    const map = indexSubRecipes([
        { parent_item_id: masala, component_item_id: onion, qty: 0.5 },
        { parent_item_id: masala, component_item_id: salt, qty: 0.5 },
    ]);
    const costs = new Map([[onion, 100], [salt, 40]]);
    // Onion at 80% usable: the masala carries the price of the peel.
    const yields = new Map([[onion, 80], [masala, 50]]);

    const cost = effectiveCost(masala, map, costs, yields);
    assert.ok(Math.abs(cost - (0.5 * (100 / 0.8) + 0.5 * 40)) < 1e-9);

    // The masala's own 50% is ignored: a phantom is never bought and never
    // trimmed, and applying it here would double-count its parts' losses.
    const raw = expandToRaw([{ itemId: masala, qty: 1 }], map, yields);
    const byItem = new Map(raw.map((r) => [r.itemId, r.qty]));
    assert.ok(Math.abs(byItem.get(onion) - 0.5 / 0.8) < 1e-9);
    assert.equal(byItem.get(salt), 0.5);
});

test('selling a dish takes the untrimmed quantity off the shelf', async () => {
    const { consumeForOrder } = await import('../../src/lib/inventory/consume.mjs');

    const chicken = await mkItem('Yield Chicken', 70);
    const rice = await mkItem('Yield Rice');   // 100%, the untouched case

    const dish = await one('SELECT id, name, price FROM menu_items LIMIT 1');
    await q('DELETE FROM recipe_lines WHERE menu_item_id = ?', [dish.id]);
    await q(
        'INSERT INTO recipes (menu_item_id, notes) VALUES (?, NULL) ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3)',
        [dish.id],
    );
    // One portion plates 200 g of chicken and 150 g of rice.
    await q(
        `INSERT INTO recipe_lines (menu_item_id, variant_name, inventory_item_id, qty)
         VALUES (?, '', ?, 0.2), (?, '', ?, 0.15)`,
        [dish.id, chicken, dish.id, rice],
    );

    const order = await createOrder(
        [{ id: dish.id, name: dish.name, price: Number(dish.price), qty: 1 }],
        { payment_status: 'paid', payment_mode: 'cash' },
    );
    await consumeForOrder(order);

    const moved = await q(
        `SELECT inventory_item_id AS id, SUM(delta) AS d FROM stock_ledger
          WHERE source_type = 'sale' AND source_id = ? GROUP BY inventory_item_id`,
        [order.id],
    );
    const byItem = new Map(moved.map((r) => [Number(r.id), Number(r.d)]));

    // 0.2 / 0.7 = 0.2857, rounded to the ledger's four places.
    assert.equal(byItem.get(chicken), -0.2857, 'the bone left the store too');
    assert.equal(byItem.get(rice), -0.15, 'an item at 100% is untouched by any of this');
});

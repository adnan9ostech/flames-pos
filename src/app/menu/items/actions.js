'use server';

/*
 * The dish editor's two server actions: everything the form needs to draw
 * itself, and the one save that writes it.
 *
 * The save is a single transaction on purpose. A dish is one thing to the
 * person editing it — name, photo, sizes, modifiers — and a half-saved dish
 * (sizes written, price not) is a dish the till would ring up wrong.
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '@/lib/db/pool.mjs';
import { requireUser, requirePermission } from '@/lib/db/auth.mjs';
import {
    audit, businessDate, requireUuid, cleanName, cleanPrice, cleanVariants,
    cleanModifierKeys, cleanImagePath, listPrice, RECIPE_COST_TABLE,
} from '@/lib/menu/kit.mjs';

const UNIT_MAX = 32;

const toDish = (r) => ({
    id: r.id,
    category_id: r.category_id,
    name: r.name,
    description: r.description || '',
    price: Number(r.price) || 0,
    unit: r.unit || '',
    image: r.image || '',
    variants: Array.isArray(r.variants) ? r.variants : [],
    modifiers: Array.isArray(r.modifiers) ? r.modifiers : [],
    is_available: Boolean(r.is_available),
    is_archived: Boolean(r.is_archived),
    variation_set_id: r.variation_set_id == null ? null : String(r.variation_set_id),
    sort_order: Number(r.sort_order) || 0,
});

const DISH_FIELDS = [
    'id', 'category_id', 'name', 'description', 'price', 'unit', 'image', 'variants',
    'modifiers', 'is_available', 'is_archived', 'variation_set_id', 'sort_order',
];
const DISH_COLUMNS = DISH_FIELDS.join(', ');
const DISH_COLUMNS_M = DISH_FIELDS.map((f) => `m.${f}`).join(', ');

/*
 * The recipe summary the editor shows: what the BASE recipe costs at today's
 * moving-average ingredient prices. Sizes may carry their own recipes and
 * their own costs — the editor says so rather than averaging them into one
 * number that would be true of no size.
 */
const readRecipe = async (dishId) => {
    const rows = await query(
        `SELECT rc.variant_name, rc.unit_cost, rc.line_count
           FROM (${RECIPE_COST_TABLE}) rc
          WHERE rc.menu_item_id = ?`,
        [dishId],
    );
    if (rows.length === 0) return null;
    const base = rows.find((r) => r.variant_name === '');
    return {
        base_cost: base ? Number(base.unit_cost) : null,
        base_lines: base ? Number(base.line_count) : 0,
        sized_variants: rows.filter((r) => r.variant_name !== '').map((r) => r.variant_name),
    };
};

/*
 * Everything the form draws from, in one round trip: the dish (or nothing,
 * for a new one), the categories, the size vocabularies, the modifiers, and
 * the names of all 125 dishes — the last so the editor can say "there is
 * already a Channay in Starters" while someone types, without a round trip
 * per keystroke. It is a warning, not a rule: Channay really is two dishes.
 */
export async function getDishEditorData(id = null) {
    try {
        await requireUser();
        const dishId = id ? requireUuid(id, 'dish') : null;

        const [categories, variationSets, modifiers, names, dishRows] = await Promise.all([
            query('SELECT id, name FROM categories ORDER BY sort_order, name'),
            query('SELECT id, name, options, is_active FROM variation_sets ORDER BY name'),
            query('SELECT id, `key`, name, type, options FROM modifiers ORDER BY name'),
            query('SELECT id, name, category_id FROM menu_items WHERE is_archived = 0'),
            dishId ? query(`SELECT ${DISH_COLUMNS} FROM menu_items WHERE id = ?`, [dishId]) : [],
        ]);

        if (dishId && dishRows.length === 0) return { error: 'That dish no longer exists' };

        return {
            data: {
                dish: dishId ? toDish(dishRows[0]) : null,
                categories,
                variationSets: variationSets.map((v) => ({
                    id: String(v.id),
                    name: v.name,
                    options: Array.isArray(v.options) ? v.options : [],
                    is_active: Boolean(v.is_active),
                })),
                modifiers: modifiers.map((m) => ({
                    key: m.key,
                    name: m.name,
                    type: m.type,
                    options: Array.isArray(m.options) ? m.options : [],
                })),
                dishNames: names,
                recipe: dishId ? await readRecipe(dishId) : null,
            },
        };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * The form's own validation is a courtesy; this is the enforcement. Same
 * rules module either side, so the two can never drift into disagreeing
 * about what a dish is.
 */
const cleanDish = (input) => {
    const name = cleanName(input?.name, 'The dish');
    const category_id = requireUuid(input?.category_id, 'category');

    const description = String(input?.description ?? '').trim();
    const unit = String(input?.unit ?? '').trim().replace(/\s+/g, ' ');
    if (unit.length > UNIT_MAX) throw new Error(`The unit label is too long (${UNIT_MAX} characters max)`);

    const image = cleanImagePath(input?.image);

    // The rows as they were typed, before cleanVariants sorts them.
    const typed = (input?.priceMode === 'sizes' && Array.isArray(input?.variants))
        ? input.variants.filter((v) => String(v?.name ?? '').trim() || String(v?.price ?? '').trim())
        : [];
    const variants = cleanVariants(typed);

    /*
     * The guard rail that matters most here. cleanVariants sorts by price,
     * and the till reads that order: the modifier modal opens on the first
     * entry and the tile shows the last. A size priced BELOW the one listed
     * before it means the names and the prices disagree — a Full cheaper
     * than a Half — and saving it would put "Full" on a tile at Half's
     * price. Refuse, and name the size that is wrong.
     */
    if (variants.length > 0) {
        const priceOf = new Map(variants.map((v) => [v.name.toLowerCase(), v.price]));
        let previous = -Infinity;
        for (const row of typed) {
            const rowName = String(row.name).trim().replace(/\s+/g, ' ');
            const rowPrice = priceOf.get(rowName.toLowerCase());
            if (rowPrice < previous) {
                throw new Error(
                    `${rowName} is priced below the size listed before it. Sizes run smallest to largest — the till opens on the first and puts the last on the tile. Saved as priced, these would read ${variants.map((v) => v.name).join(' → ')}.`,
                );
            }
            previous = rowPrice;
        }
    }

    // A sized dish's price is not typed at all; it IS the largest size.
    const price = listPrice(variants.length > 0 ? 0 : cleanPrice(input?.price, 'The price'), variants);

    return {
        name,
        category_id,
        description: description || null,
        unit: unit || null,
        image,
        variants,
        price,
        is_available: input?.is_available === undefined ? true : Boolean(input.is_available),
        variation_set_id: variants.length > 0 && input?.variation_set_id
            ? String(input.variation_set_id)
            : null,
    };
};

/* What the audit row records: the fields that actually moved, old → new. */
const diffOf = (before, after, categoryName) => {
    const changed = {};
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    if (before.name !== after.name) changed.name = { from: before.name, to: after.name };
    if (Number(before.price) !== after.price) changed.price = { from: Number(before.price), to: after.price };
    if (before.category_id !== after.category_id) {
        changed.category = { from: before.category_name || null, to: categoryName };
    }
    if ((before.description || null) !== after.description) {
        changed.description = { from: before.description || null, to: after.description };
    }
    if ((before.unit || null) !== after.unit) changed.unit = { from: before.unit || null, to: after.unit };
    if ((before.image || null) !== after.image) changed.image = { from: before.image || null, to: after.image };
    if (Boolean(before.is_available) !== after.is_available) {
        changed.is_available = { from: Boolean(before.is_available), to: after.is_available };
    }
    if (!same(before.variants ?? [], after.variants)) {
        changed.sizes = { from: before.variants ?? [], to: after.variants };
    }
    if (!same(before.modifiers ?? [], after.modifiers)) {
        changed.modifiers = { from: before.modifiers ?? [], to: after.modifiers };
    }
    const beforeSet = before.variation_set_id == null ? null : String(before.variation_set_id);
    if (beforeSet !== after.variation_set_id) {
        changed.variation_set_id = { from: beforeSet, to: after.variation_set_id };
    }
    return changed;
};

/*
 * Save a dish — new or existing — in one transaction.
 *
 * Nothing here deletes: an existing dish is updated in place so the bill
 * history that points at its id keeps pointing at the same dish.
 */
export async function saveDish(input) {
    try {
        const user = await requirePermission('menu');
        const clean = cleanDish(input);
        const dishId = input?.id ? requireUuid(input.id, 'dish') : null;
        const bd = await businessDate();

        const saved = await withTransaction(async (conn) => {
            const [cats] = await conn.query('SELECT id, name FROM categories WHERE id = ?', [clean.category_id]);
            if (cats.length === 0) throw new Error('That category no longer exists — pick another');

            // Modifier keys are checked against what exists rather than
            // trusted: the list is stored as keys, and a key nothing answers
            // to is a modal that opens empty at the till.
            const [mods] = await conn.query('SELECT `key` FROM modifiers');
            const modifiers = cleanModifierKeys(input?.modifiers, mods.map((m) => m.key));

            /*
             * A size set owns the names and their order; the dish owns the
             * prices. If the two no longer line up — the set was edited under
             * this dish — the link is what is wrong, not the prices, so say
             * so instead of silently storing a mismatch.
             */
            let variationSetId = null;
            if (clean.variation_set_id) {
                const [sets] = await conn.query(
                    'SELECT id, name, options, is_active FROM variation_sets WHERE id = ?',
                    [clean.variation_set_id],
                );
                if (sets.length === 0) throw new Error('That size set no longer exists — pick another, or use custom sizes');
                const options = Array.isArray(sets[0].options) ? sets[0].options : [];
                if (options.join('|') !== clean.variants.map((v) => v.name).join('|')) {
                    throw new Error(
                        `These sizes no longer match "${sets[0].name}" (${options.join(', ')}) — pick the set again, or switch to custom sizes`,
                    );
                }
                if (!sets[0].is_active) {
                    // A set switched off after a dish was linked to it stays
                    // usable on that dish — the switch is about what may be
                    // CHOSEN next, not a trap that blocks a name change.
                    const [was] = dishId
                        ? await conn.query('SELECT variation_set_id FROM menu_items WHERE id = ?', [dishId])
                        : [[]];
                    const kept = was.length > 0 && String(was[0].variation_set_id) === clean.variation_set_id;
                    if (!kept) throw new Error(`"${sets[0].name}" is switched off — pick an active set, or use custom sizes`);
                }
                variationSetId = Number(clean.variation_set_id);
            }

            if (dishId) {
                const [rows] = await conn.query(
                    `SELECT ${DISH_COLUMNS_M}, c.name AS category_name
                       FROM menu_items m
                       LEFT JOIN categories c ON c.id = m.category_id
                      WHERE m.id = ? FOR UPDATE`,
                    [dishId],
                );
                if (rows.length === 0) throw new Error('That dish no longer exists');

                const after = { ...clean, modifiers, variation_set_id: variationSetId == null ? null : String(variationSetId) };
                const changed = diffOf(rows[0], after, cats[0].name);

                // A save that changed nothing writes nothing — the audit log
                // is a record of changes, and "opened it and pressed Save" is
                // not one.
                if (Object.keys(changed).length === 0) {
                    return { row: rows[0], changed: {} };
                }

                await conn.query(
                    `UPDATE menu_items SET
                       category_id = ?, name = ?, description = ?, price = ?, unit = ?, image = ?,
                       variants = ?, modifiers = ?, is_available = ?, variation_set_id = ?,
                       updated_at = UTC_TIMESTAMP(3)
                     WHERE id = ?`,
                    [clean.category_id, clean.name, clean.description, clean.price, clean.unit, clean.image,
                        JSON.stringify(clean.variants), JSON.stringify(modifiers),
                        clean.is_available ? 1 : 0, variationSetId, dishId],
                );
                await audit(conn, {
                    bd,
                    action: 'menu_item_save',
                    details: { menu_item_id: dishId, mode: 'update', name: clean.name, changed },
                    userId: user.id,
                });
            } else {
                // New dishes land at the end of their category. Every dish
                // imported sits at 0, so +10 is behind all of them until
                // somebody reorders the category.
                const [tail] = await conn.query(
                    'SELECT COALESCE(MAX(sort_order), 0) AS top FROM menu_items WHERE category_id = ?',
                    [clean.category_id],
                );
                const id = randomUUID();
                await conn.query(
                    `INSERT INTO menu_items
                       (id, category_id, name, description, price, unit, image, variants, modifiers,
                        is_available, is_archived, variation_set_id, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
                    [id, clean.category_id, clean.name, clean.description, clean.price, clean.unit,
                        clean.image, JSON.stringify(clean.variants), JSON.stringify(modifiers),
                        clean.is_available ? 1 : 0, variationSetId, Number(tail[0].top) + 10],
                );
                await audit(conn, {
                    bd,
                    action: 'menu_item_save',
                    details: {
                        menu_item_id: id,
                        mode: 'create',
                        name: clean.name,
                        category: cats[0].name,
                        price: clean.price,
                        sizes: clean.variants,
                        modifiers,
                    },
                    userId: user.id,
                });
                const [fresh] = await conn.query(`SELECT ${DISH_COLUMNS} FROM menu_items WHERE id = ?`, [id]);
                return { row: fresh[0], changed: { created: true } };
            }

            const [fresh] = await conn.query(`SELECT ${DISH_COLUMNS} FROM menu_items WHERE id = ?`, [dishId]);
            return { row: fresh[0], changed: { updated: true } };
        });

        return {
            data: {
                dish: toDish(saved.row),
                created: !dishId,
                unchanged: Object.keys(saved.changed).length === 0,
            },
        };
    } catch (e) {
        return { error: e.message };
    }
}

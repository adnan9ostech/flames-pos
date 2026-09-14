'use server';

import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '@/lib/db/pool.mjs';
import { requirePermission, requireUser } from '@/lib/db/auth.mjs';
import {
    audit, businessDate, cleanName, cleanOptions, requireUuid, slugKey,
    MODIFIER_KEY_RE, MODIFIER_TYPES,
} from '@/lib/menu/kit.mjs';

/*
 * Modifiers — the choices and add-ons the till puts in front of a cashier:
 * a spice level (pick one) and a raita/salad list (add-ons). Two facts shape
 * every rule below.
 *
 * First, `key` is the join. menu_items.modifiers is a JSON array of key
 * STRINGS, not ids, so the key is the only thing tying a dish to a modifier —
 * change it under a dish and the till silently drops the modifier off that
 * dish with no error anywhere. So the key is editable while nothing links it
 * and frozen the moment something does.
 *
 * Second, nothing historical points at these rows. The till copies the chosen
 * options onto order_items.modifiers as text at the moment of ringing, so a
 * modifier that no dish links can be deleted for real — no bill loses a line
 * and no report loses a figure. One that IS linked cannot: menu_items.modifiers
 * would keep a key pointing at nothing, which the till drops without a word.
 *
 * `key` is a MySQL reserved word. Every statement here backticks it.
 */

const toRow = (r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    type: MODIFIER_TYPES.includes(r.type) ? r.type : 'select',
    options: Array.isArray(r.options) ? r.options : [],
    dishes: [],
});

/*
 * Which dishes link each modifier. JSON_CONTAINS with JSON_QUOTE is the exact
 * membership test — LIKE '%key%' would match "raita" inside "raita-extra".
 */
const listAll = async () => {
    const rows = await query('SELECT id, `key`, name, type, options FROM modifiers ORDER BY name');
    const out = rows.map(toRow);
    if (out.length === 0) return out;

    const links = await query(
        `SELECT mo.\`key\` AS k, m.id AS dish_id, m.name AS dish_name, m.is_archived
           FROM modifiers mo
           JOIN menu_items m ON JSON_CONTAINS(m.modifiers, JSON_QUOTE(mo.\`key\`))
          ORDER BY m.name`,
    );
    const byKey = new Map();
    for (const l of links) {
        if (!byKey.has(l.k)) byKey.set(l.k, []);
        byKey.get(l.k).push({ id: l.dish_id, name: l.dish_name, is_archived: Boolean(l.is_archived) });
    }
    for (const m of out) m.dishes = byKey.get(m.key) ?? [];
    return out;
};

/* The dishes linked to a key, on the caller's connection, for a guard. */
const linkedDishes = async (conn, key) => {
    const [rows] = await conn.query(
        'SELECT id, name FROM menu_items WHERE JSON_CONTAINS(modifiers, JSON_QUOTE(?)) ORDER BY name',
        [key],
    );
    return rows;
};

const nameList = (dishes, cap = 6) => {
    const names = dishes.slice(0, cap).map((d) => d.name);
    const more = dishes.length - names.length;
    return `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

export async function listModifiers() {
    try {
        await requireUser();
        return { data: await listAll() };
    } catch (e) {
        return { error: e.message };
    }
}

export async function saveModifier(input) {
    try {
        const user = await requirePermission('menu');
        const name = cleanName(input?.name, 'A modifier', 191);
        const type = MODIFIER_TYPES.includes(input?.type) ? input.type : 'select';
        // cleanOptions carries the type rule: pick-one needs two options or it
        // is not a choice; add-ons needs one or it offers nothing.
        const options = cleanOptions(input?.options, type);
        const key = slugKey(input?.key ?? input?.name);
        if (!MODIFIER_KEY_RE.test(key)) {
            throw new Error('The key must be lower-case letters, digits and single dashes (spice-level)');
        }
        const id = input?.id ? requireUuid(input.id, 'modifier') : null;
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            const [dupes] = await conn.query(
                'SELECT id FROM modifiers WHERE `key` = ? AND id <> ? LIMIT 1', [key, id ?? ''],
            );
            if (dupes.length) throw new Error(`Another modifier already uses the key "${key}"`);

            if (id) {
                const [existing] = await conn.query(
                    'SELECT * FROM modifiers WHERE id = ? FOR UPDATE', [id],
                );
                if (existing.length === 0) throw new Error('That modifier no longer exists');
                const was = existing[0];

                if (was.key !== key) {
                    const dishes = await linkedDishes(conn, was.key);
                    if (dishes.length > 0) {
                        throw new Error(
                            `The key "${was.key}" is frozen: ${dishes.length} dish`
                            + `${dishes.length === 1 ? '' : 'es'} store it by name (${nameList(dishes)}). `
                            + 'Changing it would leave those dishes pointing at nothing and the till would '
                            + 'drop the modifier without saying so. Rename the modifier instead. The name '
                            + 'is what staff read; the key is only plumbing.',
                        );
                    }
                }

                await conn.query(
                    'UPDATE modifiers SET `key` = ?, name = ?, type = ?, options = ? WHERE id = ?',
                    [key, name, type, JSON.stringify(options), id],
                );
                await audit(conn, {
                    bd,
                    action: 'menu_modifier_save',
                    details: {
                        modifier_id: id, mode: 'update', key, name, type, options,
                        was: {
                            key: was.key, name: was.name, type: was.type,
                            options: Array.isArray(was.options) ? was.options : [],
                        },
                    },
                    userId: user.id,
                });
            } else {
                const newId = randomUUID();
                await conn.query(
                    'INSERT INTO modifiers (id, `key`, name, type, options) VALUES (?, ?, ?, ?, ?)',
                    [newId, key, name, type, JSON.stringify(options)],
                );
                await audit(conn, {
                    bd,
                    action: 'menu_modifier_save',
                    details: { modifier_id: newId, mode: 'create', key, name, type, options },
                    userId: user.id,
                });
            }
        });

        return { data: await listAll() };
    } catch (e) {
        return { error: e.message };
    }
}

export async function deleteModifier(id) {
    try {
        const user = await requirePermission('menu');
        const modId = requireUuid(id, 'modifier');
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM modifiers WHERE id = ? FOR UPDATE', [modId]);
            if (rows.length === 0) throw new Error('That modifier no longer exists');
            const mod = rows[0];

            const dishes = await linkedDishes(conn, mod.key);
            if (dishes.length > 0) {
                throw new Error(
                    `"${mod.name}" is used by ${dishes.length} dish${dishes.length === 1 ? '' : 'es'} `
                    + `(${nameList(dishes)}). Those dishes store the key "${mod.key}", and deleting the `
                    + 'modifier would leave the key pointing at nothing. The till drops it silently, so '
                    + 'the choice would just stop being offered. Take it off those dishes first.',
                );
            }

            await audit(conn, {
                bd,
                action: 'menu_modifier_delete',
                details: {
                    modifier: {
                        id: mod.id, key: mod.key, name: mod.name, type: mod.type,
                        options: Array.isArray(mod.options) ? mod.options : [],
                    },
                },
                userId: user.id,
            });
            // A real delete, not an archive: no order history points at this
            // row — the till copies the chosen options onto order_items.modifiers
            // as text when the line is rung.
            await conn.query('DELETE FROM modifiers WHERE id = ?', [modId]);
        });

        return { data: await listAll() };
    } catch (e) {
        return { error: e.message };
    }
}

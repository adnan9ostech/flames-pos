'use server';

import { query, withTransaction } from '@/lib/db/pool.mjs';
import { requirePermission, requireUser } from '@/lib/db/auth.mjs';
import {
    audit, businessDate, cleanName, requireId, friendlyDup, VARIANT_NAME_MAX, MAX_VARIANTS,
} from '@/lib/menu/kit.mjs';

/*
 * Sizes as shared objects, the way Blink and ChowPOS model them: "Half / Full"
 * is ONE thing linked to many dishes, not a string retyped on each. The set
 * owns the option NAMES and their ORDER (smallest → largest); every dish owns
 * its own prices, and menu_items.variants stays the denormalised truth the
 * till, the KDS and the customer menu read.
 *
 * That split decides what may be edited here and what may not:
 *
 *  - RENAME is the interesting one and is done properly: the name changes in
 *    variation_sets.options, in every linked dish's menu_items.variants and in
 *    recipe_lines.variant_name for those dishes, all inside one transaction.
 *    order_items.variant is NOT touched — it is the size that was rung on a
 *    bill that has already been printed and filed, and rewriting it would
 *    change history to match today's vocabulary.
 *  - REMOVING an option, or REORDERING the list, is refused while any dish is
 *    linked. Both silently reprice: the order is smallest → largest and each
 *    dish's prices ascend in it, so flipping the order asserts that a Full is
 *    cheaper than a Half without a single price having been edited, and
 *    dropping an option leaves dishes carrying a size the set no longer knows.
 *  - ADDING is allowed on a set in use. The new size is deliberately NOT
 *    written into any dish: a variants entry with price 0 rings up free. The
 *    dish gains the size when somebody prices it, and until then this screen
 *    carries the gap — that is what the "needs a price" count is.
 */

const MIN_OPTIONS = 2;
const SENTINEL = 'fbi-tmp-';

const toSet = (r, index) => ({
    id: Number(r.id),
    name: r.name,
    options: Array.isArray(r.options) ? r.options.map(String) : [],
    is_active: Boolean(r.is_active),
    dishes: index.dishes.get(Number(r.id)) ?? [],
    recipe_lines: index.recipeLines.get(Number(r.id)) ?? {},
});

/* A set's option list, cleaned. Order is preserved exactly as typed — it is
 * the smallest-to-largest claim, not something to sort alphabetically. */
const cleanSetOptions = (rows) => {
    const out = [];
    const seen = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
        const name = String(r?.name ?? '').trim().replace(/\s+/g, ' ');
        if (!name) continue;
        if (name.length > VARIANT_NAME_MAX) throw new Error(`Size name "${name}" is too long`);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error(`Size "${name}" is listed twice`);
        seen.add(key);
        out.push({ orig: r?.orig ? String(r.orig) : null, name });
    }
    if (out.length < MIN_OPTIONS) throw new Error('A size set needs at least two options — one size is a price, not a choice');
    if (out.length > MAX_VARIANTS) throw new Error(`At most ${MAX_VARIANTS} sizes in a set`);
    return out;
};

/* Which dishes hang off each set, and which of the set's sizes they have no
 * price for. Archived dishes are included: they still carry the link, and an
 * un-archived dish with a stale size name is the same defect turning up later. */
const loadIndex = async () => {
    const dishRows = await query(
        `SELECT id, name, variants, is_archived, variation_set_id
           FROM menu_items WHERE variation_set_id IS NOT NULL
          ORDER BY name`,
    );
    const setRows = await query('SELECT id, options FROM variation_sets');
    const optionsById = new Map(setRows.map((s) => [
        Number(s.id), (Array.isArray(s.options) ? s.options : []).map(String),
    ]));

    const dishes = new Map();
    for (const d of dishRows) {
        const sid = Number(d.variation_set_id);
        const priced = new Set(
            (Array.isArray(d.variants) ? d.variants : []).map((v) => String(v?.name ?? '')),
        );
        const missing = (optionsById.get(sid) ?? []).filter((o) => !priced.has(o));
        if (!dishes.has(sid)) dishes.set(sid, []);
        dishes.get(sid).push({
            id: d.id, name: d.name, is_archived: Boolean(d.is_archived), missing,
        });
    }

    // Per-size recipe lines on those dishes: a rename moves these too, and the
    // number belongs in the confirmation rather than in a footnote.
    const recipeRows = await query(
        `SELECT m.variation_set_id AS sid, rl.variant_name AS vn, COUNT(*) AS n
           FROM recipe_lines rl
           JOIN menu_items m ON m.id = rl.menu_item_id
          WHERE m.variation_set_id IS NOT NULL AND rl.variant_name <> ''
          GROUP BY m.variation_set_id, rl.variant_name`,
    );
    const recipeLines = new Map();
    for (const r of recipeRows) {
        const sid = Number(r.sid);
        if (!recipeLines.has(sid)) recipeLines.set(sid, {});
        recipeLines.get(sid)[String(r.vn)] = Number(r.n) || 0;
    }

    return { dishes, recipeLines };
};

const listAll = async () => {
    const index = await loadIndex();
    const rows = await query('SELECT * FROM variation_sets ORDER BY name');
    return rows.map((r) => toSet(r, index));
};

export async function listVariationSets() {
    try {
        await requireUser();
        return { data: await listAll() };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * Create or edit a set. `rows` are the editor's option rows in order, each
 * `{ orig, name }` — `orig` is the name the row started life with, which is
 * what tells a rename apart from a remove-plus-add. A row with orig null is
 * new; an old option no row claims has been removed.
 */
export async function saveVariationSet(input) {
    try {
        const user = await requirePermission('menu');
        const name = cleanName(input?.name, 'A size set', 64);
        const rows = cleanSetOptions(input?.rows);
        const id = input?.id ? requireId(input.id, 'size set') : null;
        const isActive = input?.is_active === undefined ? true : Boolean(input.is_active);
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            if (!id) {
                const [result] = await conn.query(
                    'INSERT INTO variation_sets (name, options, is_active) VALUES (?, ?, ?)',
                    [name, JSON.stringify(rows.map((r) => r.name)), isActive ? 1 : 0],
                );
                await audit(conn, {
                    bd,
                    action: 'menu_variation_set_save',
                    details: {
                        set_id: result.insertId, mode: 'create', name,
                        options: rows.map((r) => r.name),
                    },
                    userId: user.id,
                });
                return;
            }

            const [existing] = await conn.query(
                'SELECT * FROM variation_sets WHERE id = ? FOR UPDATE', [id],
            );
            if (existing.length === 0) throw new Error('That size set no longer exists');
            const old = (Array.isArray(existing[0].options) ? existing[0].options : []).map(String);

            // Every claimed original must be one of the set's current options,
            // and no two rows may claim the same one.
            const claimed = new Set();
            for (const r of rows) {
                if (!r.orig) continue;
                if (!old.includes(r.orig)) throw new Error(`"${r.orig}" is not a size in this set any more — reload the screen`);
                if (claimed.has(r.orig)) throw new Error(`Two rows both claim to be "${r.orig}"`);
                claimed.add(r.orig);
            }

            const removed = old.filter((o) => !claimed.has(o));
            const added = rows.filter((r) => !r.orig).map((r) => r.name);
            const renames = rows
                .filter((r) => r.orig && r.orig !== r.name)
                .map((r) => ({ from: r.orig, to: r.name }));
            // The surviving originals, in the order the editor now has them.
            // Joined on NUL, not a space: a size name may itself contain
            // spaces ("8 pieces"), and two different orders must never be
            // able to render as one and the same string.
            const survivingOrder = rows.filter((r) => r.orig).map((r) => r.orig);
            const reordered = survivingOrder.join('\u0000')
                !== old.filter((o) => claimed.has(o)).join('\u0000');

            const [linkRows] = await conn.query(
                `SELECT id, name, variants, is_archived FROM menu_items
                  WHERE variation_set_id = ? FOR UPDATE`,
                [id],
            );

            if (linkRows.length > 0 && (removed.length > 0 || reordered)) {
                const names = linkRows.slice(0, 6).map((d) => d.name);
                const more = linkRows.length - names.length;
                const who = `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
                throw new Error(
                    removed.length > 0
                        ? `${removed.length === 1 ? `Size "${removed[0]}"` : `Those ${removed.length} sizes`} cannot be removed while `
                          + `${linkRows.length} dish${linkRows.length === 1 ? '' : 'es'} use this set — the dishes would `
                          + `keep a price for a size the set no longer knows. Detach ${who} first.`
                        : `The order cannot be changed while ${linkRows.length} dish${linkRows.length === 1 ? '' : 'es'} `
                          + 'use this set: the order is smallest to largest and every linked dish\'s prices ascend in it, '
                          + `so reordering says a larger size is now the cheaper one. Detach ${who} first.`,
                );
            }

            const options = rows.map((r) => r.name);
            await conn.query(
                'UPDATE variation_sets SET name = ?, options = ?, is_active = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [name, JSON.stringify(options), isActive ? 1 : 0, id],
            );

            let dishesTouched = 0;
            let linesTouched = 0;
            if (renames.length > 0 && linkRows.length > 0) {
                const map = new Map(renames.map((r) => [r.from, r.to]));
                const dishIds = linkRows.map((d) => d.id);

                // The dishes: rewritten in Node so a rename cannot disturb the
                // prices or their ascending order — only the name changes.
                for (const d of linkRows) {
                    const variants = Array.isArray(d.variants) ? d.variants : [];
                    if (!variants.some((v) => map.has(String(v?.name ?? '')))) continue;
                    const next = variants.map((v) => (map.has(String(v?.name ?? ''))
                        ? { ...v, name: map.get(String(v.name)) }
                        : v));
                    await conn.query(
                        'UPDATE menu_items SET variants = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                        [JSON.stringify(next), d.id],
                    );
                    dishesTouched += 1;
                }

                // The per-size recipes. Two passes through a sentinel because
                // recipe_lines is UNIQUE (menu_item_id, variant_name,
                // inventory_item_id) and a swap — Half→Full, Full→Half — would
                // collide with itself halfway through a one-pass rename.
                const places = dishIds.map(() => '?').join(',');
                for (const [i, r] of renames.entries()) {
                    const [res] = await conn.query(
                        `UPDATE recipe_lines SET variant_name = ?
                          WHERE variant_name = ? AND menu_item_id IN (${places})`,
                        [`${SENTINEL}${i}`, r.from, ...dishIds],
                    );
                    linesTouched += res.affectedRows;
                }
                for (const [i, r] of renames.entries()) {
                    await conn.query(
                        `UPDATE recipe_lines SET variant_name = ?
                          WHERE variant_name = ? AND menu_item_id IN (${places})`,
                        [r.to, `${SENTINEL}${i}`, ...dishIds],
                    );
                }
            }

            await audit(conn, {
                bd,
                action: 'menu_variation_set_save',
                details: {
                    set_id: id,
                    mode: 'update',
                    name,
                    was: { name: existing[0].name, options: old },
                    options,
                    renames,
                    added,
                    removed,
                    dishes_renamed: dishesTouched,
                    recipe_lines_renamed: linesTouched,
                    // Said out loud in the record too: history was left alone.
                    order_items_untouched: true,
                },
                userId: user.id,
            });
        });

        return { data: await listAll() };
    } catch (e) {
        return { error: friendlyDup(e, 'size set') };
    }
}

export async function toggleVariationSet(id) {
    try {
        const user = await requirePermission('menu');
        const setId = requireId(id, 'size set');
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM variation_sets WHERE id = ? FOR UPDATE', [setId]);
            if (rows.length === 0) throw new Error('That size set no longer exists');
            await conn.query(
                'UPDATE variation_sets SET is_active = 1 - is_active, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [setId],
            );
            await audit(conn, {
                bd,
                action: 'menu_variation_set_toggle',
                details: { set_id: setId, name: rows[0].name, is_active: !rows[0].is_active },
                userId: user.id,
            });
        });

        return { data: await listAll() };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * Delete only an unused set. A set in use is deactivated instead — the FK on
 * menu_items.variation_set_id has no ON DELETE clause on purpose, so the
 * database would refuse anyway; refusing here says why, and offers the thing
 * that actually works.
 */
export async function deleteVariationSet(id) {
    try {
        const user = await requirePermission('menu');
        const setId = requireId(id, 'size set');
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM variation_sets WHERE id = ? FOR UPDATE', [setId]);
            if (rows.length === 0) throw new Error('That size set no longer exists');

            const [links] = await conn.query(
                'SELECT name FROM menu_items WHERE variation_set_id = ? ORDER BY name', [setId],
            );
            if (links.length > 0) {
                const names = links.slice(0, 6).map((d) => d.name);
                const more = links.length - names.length;
                throw new Error(
                    `"${rows[0].name}" is used by ${links.length} dish${links.length === 1 ? '' : 'es'} `
                    + `(${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}). `
                    + 'Switch it off instead — it leaves every picker and every priced dish keeps its sizes.',
                );
            }

            await audit(conn, {
                bd,
                action: 'menu_variation_set_delete',
                details: {
                    set: {
                        id: setId,
                        name: rows[0].name,
                        options: Array.isArray(rows[0].options) ? rows[0].options : [],
                        is_active: Boolean(rows[0].is_active),
                    },
                },
                userId: user.id,
            });
            await conn.query('DELETE FROM variation_sets WHERE id = ?', [setId]);
        });

        return { data: await listAll() };
    } catch (e) {
        return { error: e.message };
    }
}

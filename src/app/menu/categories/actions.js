'use server';

import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '@/lib/db/pool.mjs';
import { requirePermission, requireUser } from '@/lib/db/auth.mjs';
import {
    audit, businessDate, cleanName, requireUuid, CATEGORY_ICON_NAMES,
} from '@/lib/menu/kit.mjs';

/*
 * Categories — the till grid's sections and, today, the kitchen stations:
 * KotSlips prints one slip per category and puts the category name at the top
 * as the station line, so the order these rows sit in is the order the passes
 * come off the printer, not decoration.
 *
 * Two rules do the real work here:
 *
 *  - sort_order is renumbered 10, 20, 30… on every move, in the same
 *    transaction as the move. The imported rows came in numbered 0..19 with no
 *    gaps, so a swap that only touched two rows would work until the first
 *    insert and then leave two categories sharing a number, tie-broken by name.
 *  - a category is deleted only when it holds no dishes AT ALL, archived
 *    included. `menu_items.category_id` is ON DELETE SET NULL, so deleting a
 *    category with dishes in it does not fail — it quietly unfiles them. They
 *    then vanish from every category tab on the till grid (they survive under
 *    "All") and their kitchen slips print on the catch-all "Kitchen" station.
 *    Nothing errors, nobody is told, and the loss shows up at service.
 */

const toRow = (r) => ({
    id: r.id,
    name: r.name,
    icon: CATEGORY_ICON_NAMES.includes(r.icon) ? r.icon : 'Utensils',
    sort_order: Number(r.sort_order) || 0,
    live_count: Number(r.live_count) || 0,
    archived_count: Number(r.archived_count) || 0,
});

const LIST_SQL = `
    SELECT c.id, c.name, c.icon, c.sort_order,
           COALESCE(n.live, 0)     AS live_count,
           COALESCE(n.archived, 0) AS archived_count
      FROM categories c
      LEFT JOIN (
            SELECT category_id,
                   SUM(is_archived = 0) AS live,
                   SUM(is_archived = 1) AS archived
              FROM menu_items
             GROUP BY category_id
      ) n ON n.category_id = c.id
     ORDER BY c.sort_order, c.name`;

/* The current order, on the caller's connection, locked. Every write that
 * renumbers reads through this so it renumbers what is actually there. */
const lockedOrder = async (conn) => {
    const [rows] = await conn.query(
        'SELECT id, name, sort_order FROM categories ORDER BY sort_order, name FOR UPDATE',
    );
    return rows;
};

/* 10, 20, 30… in one statement, in the order given. */
const renumber = async (conn, ids) => {
    if (ids.length === 0) return;
    const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
    const places = ids.map(() => '?').join(',');
    await conn.query(
        `UPDATE categories SET sort_order = CASE id ${cases} END, updated_at = UTC_TIMESTAMP(3)
          WHERE id IN (${places})`,
        [...ids.flatMap((id, i) => [id, (i + 1) * 10]), ...ids],
    );
};

/*
 * Names are kept unique, case-insensitively, even though the column is not.
 * Dish names are deliberately not unique ("Channay" is two dishes in two
 * categories) but a category name is printed alone at the top of a kitchen
 * slip as the station: two categories called "Karahi" would put two different
 * passes on identically-headed paper.
 */
const assertNameFree = async (conn, name, exceptId) => {
    const [dupes] = await conn.query(
        'SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id <> ? LIMIT 1',
        [name, exceptId ?? ''],
    );
    if (dupes.length) throw new Error(`A category called "${name}" already exists`);
};

export async function listCategories() {
    try {
        await requireUser();
        const rows = await query(LIST_SQL);
        // Dishes filed under no category at all: the state the delete guard
        // exists to prevent, so the screen has to be able to see it.
        const [unfiled] = await query(
            'SELECT COUNT(*) AS n FROM menu_items WHERE category_id IS NULL AND is_archived = 0',
        );
        return { data: { categories: rows.map(toRow), unfiled: Number(unfiled?.n) || 0 } };
    } catch (e) {
        return { error: e.message };
    }
}

export async function saveCategory(input) {
    try {
        const user = await requirePermission('menu');
        const name = cleanName(input?.name, 'A category', 191);
        const icon = CATEGORY_ICON_NAMES.includes(input?.icon) ? input.icon : 'Utensils';
        const id = input?.id ? requireUuid(input.id, 'category') : null;
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            if (id) {
                const [existing] = await conn.query(
                    'SELECT id, name, icon FROM categories WHERE id = ? FOR UPDATE', [id],
                );
                if (existing.length === 0) throw new Error('That category no longer exists');
                await assertNameFree(conn, name, id);
                await conn.query(
                    'UPDATE categories SET name = ?, icon = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                    [name, icon, id],
                );
                await audit(conn, {
                    bd,
                    action: 'menu_category_save',
                    details: {
                        category_id: id, mode: 'update', name, icon,
                        was: { name: existing[0].name, icon: existing[0].icon },
                    },
                    userId: user.id,
                });
            } else {
                await assertNameFree(conn, name, null);
                // A new station goes to the end of the printer's run, not
                // into the middle of one someone already arranged.
                const order = await lockedOrder(conn);
                const newId = randomUUID();
                await conn.query(
                    'INSERT INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)',
                    [newId, name, icon, (order.length + 1) * 10],
                );
                await renumber(conn, [...order.map((r) => r.id), newId]);
                await audit(conn, {
                    bd,
                    action: 'menu_category_save',
                    details: { category_id: newId, mode: 'create', name, icon },
                    userId: user.id,
                });
            }
        });

        const rows = await query(LIST_SQL);
        return { data: rows.map(toRow) };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * Up or down by one place. The server owns the arithmetic — it reads the real
 * order under a lock and renumbers the whole list — so two people reordering
 * at once cannot interleave into a list neither of them arranged.
 */
export async function moveCategory(id, direction) {
    try {
        const user = await requirePermission('menu');
        const catId = requireUuid(id, 'category');
        const step = direction === 'up' ? -1 : direction === 'down' ? 1 : null;
        if (step === null) throw new Error('Move a category up or down');
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            const order = await lockedOrder(conn);
            const at = order.findIndex((r) => r.id === catId);
            if (at === -1) throw new Error('That category no longer exists');
            const to = at + step;
            if (to < 0 || to >= order.length) return; // already at the end of the run

            const ids = order.map((r) => r.id);
            [ids[at], ids[to]] = [ids[to], ids[at]];
            await renumber(conn, ids);
            await audit(conn, {
                bd,
                action: 'menu_category_reorder',
                details: {
                    category_id: catId, name: order[at].name, direction,
                    order: ids.map((x, i) => ({ id: x, sort_order: (i + 1) * 10 })),
                },
                userId: user.id,
            });
        });

        const rows = await query(LIST_SQL);
        return { data: rows.map(toRow) };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * The alternative the delete refusal offers: re-file every dish, archived ones
 * included, then the category is empty and can go. This moves the dishes to a
 * different kitchen station as well as a different grid tab — the same fact
 * the screen says out loud before it is used.
 */
export async function moveCategoryDishes(fromId, toId) {
    try {
        const user = await requirePermission('menu');
        const from = requireUuid(fromId, 'category');
        const to = requireUuid(toId, 'category');
        if (from === to) throw new Error('Pick a different category to move the dishes into');
        const bd = await businessDate();

        const moved = await withTransaction(async (conn) => {
            const [cats] = await conn.query(
                'SELECT id, name FROM categories WHERE id IN (?, ?) FOR UPDATE', [from, to],
            );
            const byId = new Map(cats.map((c) => [c.id, c.name]));
            if (!byId.has(from) || !byId.has(to)) throw new Error('That category no longer exists');

            const [result] = await conn.query(
                'UPDATE menu_items SET category_id = ?, updated_at = UTC_TIMESTAMP(3) WHERE category_id = ?',
                [to, from],
            );
            await audit(conn, {
                bd,
                action: 'menu_category_move_dishes',
                details: {
                    from: { id: from, name: byId.get(from) },
                    to: { id: to, name: byId.get(to) },
                    dishes: result.affectedRows,
                },
                userId: user.id,
            });
            return result.affectedRows;
        });

        const rows = await query(LIST_SQL);
        return { data: { moved, categories: rows.map(toRow) } };
    } catch (e) {
        return { error: e.message };
    }
}

export async function deleteCategory(id) {
    try {
        const user = await requirePermission('menu');
        const catId = requireUuid(id, 'category');
        const bd = await businessDate();

        await withTransaction(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM categories WHERE id = ? FOR UPDATE', [catId]);
            if (rows.length === 0) throw new Error('That category no longer exists');
            const cat = rows[0];

            // Archived dishes count. They still carry the FK, so the SET NULL
            // would still fire, and un-archiving one later would bring back a
            // dish with no station.
            const [counts] = await conn.query(
                `SELECT SUM(is_archived = 0) AS live, SUM(is_archived = 1) AS archived
                   FROM menu_items WHERE category_id = ?`,
                [catId],
            );
            const live = Number(counts[0]?.live) || 0;
            const archived = Number(counts[0]?.archived) || 0;
            if (live + archived > 0) {
                const parts = [];
                if (live) parts.push(`${live} dish${live === 1 ? '' : 'es'} on the menu`);
                if (archived) parts.push(`${archived} archived`);
                throw new Error(
                    `"${cat.name}" still holds ${parts.join(' and ')}. `
                    + 'Move them to another category first. Deleting this one would unfile them: '
                    + 'they would drop off every tab on the till grid and their kitchen slips '
                    + 'would print on the catch-all "Kitchen" station.',
                );
            }

            // The whole row goes into the audit before it goes, the way a
            // deleted waiter's does — a delete with no record of what was
            // deleted is not an audit trail.
            await audit(conn, {
                bd,
                action: 'menu_category_delete',
                details: { category: { ...cat, sort_order: Number(cat.sort_order) || 0 } },
                userId: user.id,
            });
            await conn.query('DELETE FROM categories WHERE id = ?', [catId]);

            const remaining = await lockedOrder(conn);
            await renumber(conn, remaining.map((r) => r.id));
        });

        const rows = await query(LIST_SQL);
        return { data: rows.map(toRow) };
    } catch (e) {
        return { error: e.message };
    }
}

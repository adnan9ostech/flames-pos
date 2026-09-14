'use server';

/*
 * The dish list: what it reads, and the three things it writes that are not
 * an edit — archive, restore, and where a dish sits on the till grid.
 *
 * Availability is deliberately absent. `setMenuItemAvailability` in
 * orderActions already owns that verb (audited as `set_availability`, and
 * the till calls it from the grid); a second one here would be a second
 * place for "sold out" to mean something slightly different.
 */
import { query, withTransaction } from '@/lib/db/pool.mjs';
import { requireUser, requirePermission } from '@/lib/db/auth.mjs';
import { audit, businessDate, requireUuid } from '@/lib/menu/kit.mjs';

/*
 * A dish as the list draws it. price is already a number (the pool sets
 * decimalNumbers) and the two JSON columns are already arrays; what this
 * settles is the nulls — a dish whose category was deleted keeps its rows in
 * the bill history, so it must still render.
 */
const toRow = (r) => ({
    id: r.id,
    name: r.name,
    category_id: r.category_id,
    category_name: r.category_name || '',
    price: Number(r.price) || 0,
    unit: r.unit || '',
    image: r.image || '',
    variants: Array.isArray(r.variants) ? r.variants : [],
    modifiers: Array.isArray(r.modifiers) ? r.modifiers : [],
    is_available: Boolean(r.is_available),
    is_archived: Boolean(r.is_archived),
    sort_order: Number(r.sort_order) || 0,
});

/*
 * Every dish, archived ones included — this is the one screen that is
 * allowed to see them, and the Archived tab is how a dish comes back.
 * Ordered the way the till orders its grid, so the list and the tiles agree.
 */
export async function listDishes() {
    try {
        await requireUser();
        const [items, categories] = await Promise.all([
            query(
                `SELECT m.id, m.category_id, m.name, m.price, m.unit, m.image,
                        m.variants, m.modifiers, m.is_available, m.is_archived,
                        m.sort_order, c.name AS category_name
                   FROM menu_items m
                   LEFT JOIN categories c ON c.id = m.category_id
                  ORDER BY c.sort_order, c.name, m.sort_order, m.name`,
            ),
            query('SELECT id, name FROM categories ORDER BY sort_order, name'),
        ]);
        return { data: { dishes: items.map(toRow), categories } };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * Archive, or bring back. Never a delete: order_items.menu_item_id points at
 * this row, so deleting a dish deletes the bills it was sold on.
 *
 * A dish that is already in the state asked for writes nothing at all — the
 * audit log is a record of changes, and a double-click is not one.
 */
export async function setDishArchived(id, archived) {
    try {
        const user = await requirePermission('menu');
        const dishId = requireUuid(id, 'dish');
        const wanted = Boolean(archived);
        const bd = await businessDate();

        const row = await withTransaction(async (conn) => {
            const [rows] = await conn.query(
                'SELECT id, name, is_archived FROM menu_items WHERE id = ? FOR UPDATE',
                [dishId],
            );
            if (rows.length === 0) throw new Error('That dish no longer exists');
            if (Boolean(rows[0].is_archived) === wanted) return rows[0];

            await conn.query(
                'UPDATE menu_items SET is_archived = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [wanted ? 1 : 0, dishId],
            );
            await audit(conn, {
                bd,
                action: wanted ? 'menu_item_archive' : 'menu_item_restore',
                details: { menu_item_id: dishId, name: rows[0].name },
                userId: user.id,
            });
            return { ...rows[0], is_archived: wanted ? 1 : 0 };
        });

        return { data: { id: row.id, name: row.name, is_archived: Boolean(row.is_archived) } };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * Move a dish one place up or down inside its category.
 *
 * The whole category is renumbered 10, 20, 30… on every move rather than the
 * two rows swapping. Swapping works until two dishes share a sort_order (all
 * 125 start at 0), and then the name breaks the tie and the move appears not
 * to have happened. Renumbering also keeps the gaps from closing up over a
 * few hundred moves.
 *
 * Archived dishes are left out of the sequence: they are off the grid, and
 * counting them would leave holes in it.
 */
export async function moveDish(id, direction) {
    try {
        const user = await requirePermission('menu');
        const dishId = requireUuid(id, 'dish');
        const step = direction === 'up' ? -1 : 1;
        const bd = await businessDate();

        const result = await withTransaction(async (conn) => {
            const [dish] = await conn.query(
                'SELECT id, name, category_id FROM menu_items WHERE id = ? FOR UPDATE',
                [dishId],
            );
            if (dish.length === 0) throw new Error('That dish no longer exists');
            if (!dish[0].category_id) {
                throw new Error('This dish has no category, so there is no order to move it within. Give it one first');
            }

            const [siblings] = await conn.query(
                `SELECT id, name, sort_order FROM menu_items
                  WHERE category_id = ? AND is_archived = 0
                  ORDER BY sort_order, name
                  FOR UPDATE`,
                [dish[0].category_id],
            );

            const from = siblings.findIndex((s) => s.id === dishId);
            const to = from + step;
            // Already at the end it was asked to move towards: nothing to do,
            // and nothing to log.
            if (from < 0 || to < 0 || to >= siblings.length) {
                return { moved: false, order: siblings.map((s) => ({ id: s.id, sort_order: Number(s.sort_order) })) };
            }

            const ordered = [...siblings];
            [ordered[from], ordered[to]] = [ordered[to], ordered[from]];

            const order = [];
            for (let i = 0; i < ordered.length; i += 1) {
                const sortOrder = (i + 1) * 10;
                order.push({ id: ordered[i].id, sort_order: sortOrder });
                if (Number(ordered[i].sort_order) !== sortOrder) {
                    await conn.query(
                        'UPDATE menu_items SET sort_order = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                        [sortOrder, ordered[i].id],
                    );
                }
            }

            await audit(conn, {
                bd,
                action: 'menu_item_reorder',
                details: {
                    menu_item_id: dishId,
                    name: dish[0].name,
                    category_id: dish[0].category_id,
                    from: from + 1,
                    to: to + 1,
                    order: ordered.map((s) => s.name),
                },
                userId: user.id,
            });

            return { moved: true, order };
        });

        return { data: result };
    } catch (e) {
        return { error: e.message };
    }
}

'use server';

/*
 * What each outlet charges for a dish, and which dishes it does not have.
 *
 * One menu, one price, everywhere — and then the exceptions. `branch_menu_items`
 * holds ONLY those exceptions: a dish that costs the same at both outlets has
 * no row and cannot drift. That is the same grammar as branch_settings, and the
 * screen is built to make it visible rather than to hide it.
 *
 * TWO ASYMMETRIES WORTH KNOWING, both enforced by the reader in reads.mjs and
 * both mirrored in the UI rather than re-litigated here:
 *
 *   price        an override REPLACES the menu price. NULL means the menu's.
 *   availability a branch may only turn a dish OFF. `CASE WHEN b.is_available
 *                = 0 THEN 0 ELSE m.is_available END` — so a dish switched off
 *                menu-wide stays off everywhere, and no branch can quietly put
 *                a withdrawn dish back on sale.
 */
import { query, withTransaction } from '@/lib/db/pool.mjs';
import { requireUser, requirePermission } from '@/lib/db/auth.mjs';
import { requireUuid, branchMenuOverride, branchCellMenuPrice } from '@/lib/menu/kit.mjs';
import { writeAudit } from '@/lib/db/audit.mjs';

/*
 * Everything the grid draws, in one round trip: the outlets across the top,
 * the dishes down the side, and the exceptions between them.
 */
export async function listBranchMenu() {
    try {
        await requireUser();
        const [branches, dishes, overrides] = await Promise.all([
            query(
                `SELECT id, name, code FROM branches
                  WHERE is_active = 1 ORDER BY sort_order, id`,
            ),
            // Archived dishes are off every till already; showing them here
            // would invite pricing something nobody can sell.
            query(
                `SELECT m.id, m.name, m.price, m.variants, m.is_available, m.category_id,
                        c.name AS category_name
                   FROM menu_items m
                   LEFT JOIN categories c ON c.id = m.category_id
                  WHERE m.is_archived = 0
                  ORDER BY c.sort_order, c.name, m.sort_order, m.name`,
            ),
            query('SELECT branch_id, menu_item_id, variant_name, price, is_available FROM branch_menu_items'),
        ]);

        return {
            data: {
                branches: branches.map((b) => ({ id: Number(b.id), name: b.name, code: b.code })),
                /*
                 * One ROW PER PRICE, which for a sized dish means one per size.
                 *
                 * The screen used to show one box per dish, against the dish's
                 * base price — and a sized dish never charges its base price,
                 * so those boxes did nothing at all. 44 of 137 dishes here are
                 * sized. `variant` is '' for a dish priced whole.
                 */
                dishes: dishes.flatMap((d) => {
                    const sizes = Array.isArray(d.variants) ? d.variants : [];
                    const base = {
                        id: d.id,
                        name: d.name,
                        is_available: Boolean(d.is_available),
                        category_name: d.category_name || '',
                    };
                    if (sizes.length === 0) {
                        return [{ ...base, variant: '', price: Number(d.price) || 0 }];
                    }
                    return sizes.map((v) => ({
                        ...base,
                        variant: String(v?.name ?? ''),
                        price: Number(v?.price) || 0,
                    }));
                }),
                /*
                 * Keyed "branchId:dishId:size" rather than nested, because the
                 * grid looks up one cell at a time and a flat key is one lookup
                 * instead of three with a missing-object check between them.
                 */
                overrides: Object.fromEntries(overrides.map((o) => [
                    `${o.branch_id}:${o.menu_item_id}:${o.variant_name}`,
                    {
                        price: o.price == null ? null : Number(o.price),
                        is_available: o.is_available === 1,
                    },
                ])),
            },
        };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * One cell. `price` of null means "the menu's price"; `isAvailable` true means
 * "on, like the menu says". When both are back to the menu's answer the ROW IS
 * DELETED rather than stored as a pair of defaults — an exceptions table whose
 * rows say "no exception" is a table that cannot be read at a glance, and the
 * count of rows in it stops meaning anything.
 */
export async function setBranchMenuItem({ branchId, menuItemId, variantName = '', price, isAvailable } = {}) {
    try {
        const user = await requirePermission('menu');
        const branch = Number(branchId);
        const dishId = requireUuid(menuItemId, 'dish');
        if (!Number.isInteger(branch) || branch <= 0) throw new Error('Pick a branch');

        const saved = await withTransaction(async (conn) => {
            const [[branchRow] = []] = await conn.query(
                'SELECT id, name FROM branches WHERE id = ?', [branch],
            );
            if (!branchRow) throw new Error('That branch no longer exists');

            const [[dish] = []] = await conn.query(
                'SELECT id, name, price, variants FROM menu_items WHERE id = ?', [dishId],
            );
            if (!dish) throw new Error('That dish no longer exists');

            // The price this cell is an exception TO — the size's own, for a
            // size. The rule lives in menu/rules.mjs where the suite can
            // assert it; see branchCellMenuPrice for why it matters.
            const size = String(variantName || '');
            const menuPrice = branchCellMenuPrice(dish, size);

            // The rule itself lives in menu/rules.mjs, where the suite can
            // reach it: a 'use server' file cannot be loaded by node --test,
            // and a judgement this easy to get subtly wrong needs asserting.
            const { price: cleanPrice, isAvailable: on, isOverride } =
                branchMenuOverride(price, isAvailable, menuPrice);

            if (!isOverride) {
                await conn.query(
                    `DELETE FROM branch_menu_items
                      WHERE branch_id = ? AND menu_item_id = ? AND variant_name = ?`,
                    [branch, dishId, size],
                );
            } else {
                await conn.query(
                    `INSERT INTO branch_menu_items
                       (branch_id, menu_item_id, variant_name, price, is_available)
                     VALUES (?, ?, ?, ?, ?) AS new_row
                     ON DUPLICATE KEY UPDATE price = new_row.price,
                                             is_available = new_row.is_available`,
                    [branch, dishId, size, cleanPrice, on ? 1 : 0],
                );
            }

            /*
             * Filed under the branch being PRICED, not the branch the person
             * is standing in. A change to what Lahore charges belongs in
             * Lahore's log, whoever made it; who that was is in the details.
             */
            await writeAudit(conn, {
                branchId: branch,
                action: 'branch_menu_override',
                details: {
                    branch: branchRow.name,
                    menu_item_id: dishId,
                    dish: dish.name,
                    size: size || null,
                    menu_price: menuPrice,
                    branch_price: cleanPrice,
                    is_available: on,
                    by: user.id,
                },
            });

            return { branchId: branch, menuItemId: dishId, variantName: size, price: cleanPrice, is_available: on };
        });

        return { data: saved };
    } catch (e) {
        return { error: e.message };
    }
}

/*
 * Every exception this branch has, gone. The reason this exists rather than
 * asking someone to clear ninety boxes by hand: the usual mistake with a grid
 * like this is a branch that was set up wrong, and "put it back to the menu" is
 * the only reliable way out of that.
 */
export async function clearBranchMenu(branchId) {
    try {
        const user = await requirePermission('menu');
        const branch = Number(branchId);
        if (!Number.isInteger(branch) || branch <= 0) throw new Error('Pick a branch');

        const result = await withTransaction(async (conn) => {
            const [[branchRow] = []] = await conn.query(
                'SELECT id, name FROM branches WHERE id = ?', [branch],
            );
            if (!branchRow) throw new Error('That branch no longer exists');

            const [res] = await conn.query(
                'DELETE FROM branch_menu_items WHERE branch_id = ?', [branch],
            );
            const removed = Number(res.affectedRows) || 0;

            await writeAudit(conn, {
                branchId: branch,
                action: 'branch_menu_reset',
                details: { branch: branchRow.name, removed, by: user.id },
            });

            return { removed, name: branchRow.name };
        });

        return {
            data: { removed: result.removed },
            success: `${result.name} follows the menu again (${result.removed} cleared).`,
        };
    } catch (e) {
        return { error: e.message };
    }
}

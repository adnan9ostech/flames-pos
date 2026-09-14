'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
import { audit, businessDate, requireUuid, RECIPE_COST_TABLE } from '@/lib/menu/kit.mjs'

/*
 * Recipes: what one sold portion consumes, per SIZE.
 *
 * `recipe_lines.variant_name` is '' for the dish's base recipe and the size
 * name for a size's own. The rule the whole costing chain obeys — stated
 * once in `RECIPE_VARIANT_FOR_LINE` and enforced here by what this screen
 * is allowed to save — is: a sold line uses its own size's lines when that
 * size has any, otherwise the base. So a base recipe alone costs every
 * size, which is the sensible place to start, and a size only earns its own
 * lines when it genuinely differs. A Full karahi does not use a Half's
 * chicken; the base plus one exception is cheaper to maintain than two
 * recipes for every sized dish.
 *
 * A save replaces a (dish, size) line set wholesale inside one transaction —
 * a half-saved recipe can never price a plate. Saving an empty set removes
 * that size's lines, and the `recipes` row goes when no size has any left.
 */

/* Ingredient costs are DECIMAL(12,4); a plate's cost is their sum. */
const round4 = (n) => Math.round(Number(n) * 10000) / 10000

/* The size names a dish may carry a recipe for: '' (the base) plus its own
 * sizes. Lines already stored under a name the dish has since dropped stay
 * addressable so the screen can clear them — they cost nothing today
 * (nothing sells under that size any more) but they are not invisible. */
const allowedVariants = (variantsJson, existing = []) => {
    const names = new Set([''])
    const list = Array.isArray(variantsJson) ? variantsJson : []
    for (const v of list) {
        const name = String(v?.name ?? '').trim()
        if (name) names.add(name)
    }
    for (const name of existing) names.add(String(name))
    return names
}

const cleanLines = (input) => {
    const lines = []
    for (const l of Array.isArray(input) ? input : []) {
        const rawItem = String(l?.inventory_item_id ?? '').trim()
        const rawQty = String(l?.qty ?? '').trim()
        // A row the person opened and never filled is not an error.
        if (!rawItem && !rawQty) continue
        const inventoryItemId = Number(rawItem)
        const qty = Number(rawQty)
        if (!Number.isInteger(inventoryItemId) || inventoryItemId <= 0) {
            throw new Error('Every line needs an ingredient')
        }
        if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error('Every line needs a quantity above zero')
        }
        lines.push({ inventory_item_id: inventoryItemId, qty })
    }
    const seen = new Set(lines.map((l) => l.inventory_item_id))
    if (seen.size !== lines.length) {
        throw new Error('The same ingredient appears twice — combine the quantities')
    }
    return lines
}

/* Costed on the caller's connection so the audit row states what the recipe
 * was worth at the moment it was saved. */
const variantCost = async (conn, menuItemId, variantName) => {
    const [rows] = await conn.query(
        `SELECT COALESCE(SUM(rl.qty * ii.avg_cost), 0) AS cost, COUNT(*) AS line_count
           FROM recipe_lines rl
           JOIN inventory_items ii ON ii.id = rl.inventory_item_id
          WHERE rl.menu_item_id = ? AND rl.variant_name = ?`,
        [menuItemId, variantName],
    )
    return { cost: round4(rows[0]?.cost ?? 0), lineCount: Number(rows[0]?.line_count ?? 0) }
}

/*
 * The two lists the screen is built from: every live dish with its sizes and
 * whatever recipes it already carries — the gaps ARE the work list, so a
 * dish with no recipe is a row here, not an omission — and every active
 * ingredient at the cost the live math prices against.
 */
export async function getRecipeBoard() {
    try {
        await requireUser()
        const [dishes, costs, ingredients, units] = await Promise.all([
            query(
                `SELECT m.id, m.name, m.price, m.variants,
                        c.name AS category_name, c.sort_order AS category_sort
                   FROM menu_items m
                   LEFT JOIN categories c ON c.id = m.category_id
                  WHERE m.is_archived = 0
                  ORDER BY c.sort_order, c.name, m.name`,
            ),
            query(RECIPE_COST_TABLE),
            query(
                `SELECT i.id, i.name, i.category, i.avg_cost, u.abbrev AS unit_abbrev
                   FROM inventory_items i
                   JOIN units u ON u.id = i.unit_id
                  WHERE i.is_active = 1
                  ORDER BY i.name`,
            ),
            // The units too, so an ingredient nobody thought of yet can be
            // added from the recipe being written — the trip out to the
            // Ingredients screen and back was the most expensive part of
            // building a menu's recipes, 125 times over.
            query('SELECT id, name, abbrev FROM units ORDER BY id'),
        ])

        const byDish = new Map()
        for (const c of costs) {
            const list = byDish.get(c.menu_item_id) ?? []
            list.push({
                variant_name: c.variant_name,
                line_count: Number(c.line_count),
                unit_cost: round4(c.unit_cost),
            })
            byDish.set(c.menu_item_id, list)
        }

        return {
            data: {
                dishes: dishes.map((d) => ({
                    id: d.id,
                    name: d.name,
                    price: Number(d.price),
                    variants: Array.isArray(d.variants) ? d.variants : [],
                    category_name: d.category_name,
                    recipes: byDish.get(d.id) ?? [],
                })),
                ingredients: ingredients.map((i) => ({ ...i, avg_cost: Number(i.avg_cost) })),
                units,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * One dish, every size at once. Small enough to fetch whole (eight sizes of
 * a handful of lines), and fetching it whole is what lets the size tabs
 * switch without a round trip and the per-size margins be drawn together.
 */
export async function getRecipe(menuItemId) {
    try {
        await requireUser()
        const id = requireUuid(menuItemId)
        const [recipeRows, lines] = await Promise.all([
            query('SELECT notes FROM recipes WHERE menu_item_id = ?', [id]),
            query(
                `SELECT variant_name, inventory_item_id, qty
                   FROM recipe_lines WHERE menu_item_id = ? ORDER BY variant_name, id`,
                [id],
            ),
        ])
        return {
            data: {
                notes: recipeRows[0]?.notes ?? '',
                lines: lines.map((l) => ({
                    variant_name: l.variant_name,
                    inventory_item_id: l.inventory_item_id,
                    qty: Number(l.qty),
                })),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Save the sizes that changed — each one a wholesale replacement of its line
 * set, all of them in one transaction. The screen holds a draft per size, so
 * a person who edits the base, switches to Full and presses Save gets both;
 * saving only the visible tab would drop the other half silently.
 */
export async function saveRecipe({ menuItemId, variants, notes } = {}) {
    try {
        const user = await requirePermission('menu')
        const id = requireUuid(menuItemId)
        const payload = (Array.isArray(variants) ? variants : []).map((v) => ({
            variantName: String(v?.variantName ?? ''),
            lines: cleanLines(v?.lines),
        }))
        if (payload.length === 0) throw new Error('Nothing to save')
        const names = new Set(payload.map((v) => v.variantName))
        if (names.size !== payload.length) throw new Error('The same size is listed twice')
        const cleanNotes = String(notes ?? '').trim().slice(0, 191) || null
        const bd = await businessDate()

        const result = await withTransaction(async (conn) => {
            const [dishRows] = await conn.query(
                'SELECT name, variants FROM menu_items WHERE id = ?', [id],
            )
            if (dishRows.length === 0) throw new Error('That dish no longer exists')
            const dishName = dishRows[0].name

            const [stored] = await conn.query(
                'SELECT DISTINCT variant_name FROM recipe_lines WHERE menu_item_id = ?', [id],
            )
            const allowed = allowedVariants(dishRows[0].variants, stored.map((r) => r.variant_name))
            for (const v of payload) {
                if (!allowed.has(v.variantName)) {
                    throw new Error(`${dishName} has no size called "${v.variantName}"`)
                }
            }

            // The parent row first: recipe_lines FKs it, and its key is also
            // what serializes two people saving the same dish at once.
            const wantsLines = payload.some((v) => v.lines.length > 0)
            if (wantsLines || stored.length > 0) {
                await conn.query(
                    `INSERT INTO recipes (menu_item_id, notes) VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE notes = VALUES(notes), updated_at = UTC_TIMESTAMP(3)`,
                    [id, cleanNotes],
                )
            }

            const saved = []
            for (const v of payload) {
                await conn.query(
                    'DELETE FROM recipe_lines WHERE menu_item_id = ? AND variant_name = ?',
                    [id, v.variantName],
                )
                if (v.lines.length > 0) {
                    await conn.query(
                        `INSERT INTO recipe_lines (menu_item_id, variant_name, inventory_item_id, qty)
                         VALUES ?`,
                        [v.lines.map((l) => [id, v.variantName, l.inventory_item_id, l.qty])],
                    )
                }
                const { cost, lineCount } = await variantCost(conn, id, v.variantName)
                saved.push({ variant_name: v.variantName, line_count: lineCount, unit_cost: cost })
                await audit(conn, {
                    bd,
                    action: 'menu_recipe_save',
                    details: {
                        menu_item_id: id,
                        dish: dishName,
                        variant: v.variantName || '(base)',
                        lines: lineCount,
                        cost,
                        removed: lineCount === 0,
                    },
                    userId: user.id,
                })
            }

            // A dish whose last line has just gone loses the recipes row too;
            // ON DELETE CASCADE has nothing left to take with it.
            const [remaining] = await conn.query(
                'SELECT COUNT(*) AS n FROM recipe_lines WHERE menu_item_id = ?', [id],
            )
            if (Number(remaining[0].n) === 0) {
                await conn.query('DELETE FROM recipes WHERE menu_item_id = ?', [id])
            }

            const [after] = await conn.query(
                `SELECT rl.variant_name, COUNT(*) AS line_count,
                        SUM(rl.qty * ii.avg_cost) AS unit_cost
                   FROM recipe_lines rl
                   JOIN inventory_items ii ON ii.id = rl.inventory_item_id
                  WHERE rl.menu_item_id = ?
                  GROUP BY rl.variant_name`,
                [id],
            )
            return {
                saved,
                recipes: after.map((r) => ({
                    variant_name: r.variant_name,
                    line_count: Number(r.line_count),
                    unit_cost: round4(r.unit_cost),
                })),
            }
        })
        return { data: result }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Copy one size's lines onto another size, or onto another dish entirely.
 *
 * A hundred and twenty-five recipes typed by hand is the real cost of this
 * feature, and most of them differ from a neighbour by one line. Copying is
 * what makes the build-out survivable. It replaces the target wholesale, so
 * `overwrite` has to be sent once the target already has lines — the screen
 * asks, and the server asks again rather than trusting that it did.
 */
export async function copyRecipe({
    fromMenuItemId, fromVariant = '', toMenuItemId, toVariant = '', overwrite = false,
} = {}) {
    try {
        const user = await requirePermission('menu')
        const fromId = requireUuid(fromMenuItemId, 'dish to copy from')
        const toId = requireUuid(toMenuItemId, 'dish to copy to')
        const fromName = String(fromVariant ?? '')
        const toName = String(toVariant ?? '')
        if (fromId === toId && fromName === toName) {
            throw new Error('That is the same recipe — pick a different size or dish')
        }
        const bd = await businessDate()

        const result = await withTransaction(async (conn) => {
            const [dishes] = await conn.query(
                'SELECT id, name, variants FROM menu_items WHERE id IN (?, ?)', [fromId, toId],
            )
            const byId = new Map(dishes.map((d) => [d.id, d]))
            const source = byId.get(fromId)
            const target = byId.get(toId)
            if (!source) throw new Error('The dish to copy from no longer exists')
            if (!target) throw new Error('The dish to copy to no longer exists')

            const [stored] = await conn.query(
                'SELECT DISTINCT variant_name FROM recipe_lines WHERE menu_item_id = ?', [toId],
            )
            if (!allowedVariants(target.variants, stored.map((r) => r.variant_name)).has(toName)) {
                throw new Error(`${target.name} has no size called "${toName}"`)
            }

            const [lines] = await conn.query(
                'SELECT inventory_item_id, qty FROM recipe_lines WHERE menu_item_id = ? AND variant_name = ?',
                [fromId, fromName],
            )
            if (lines.length === 0) {
                throw new Error(`${source.name} ${fromName || '(base)'} has no lines to copy`)
            }

            const existing = await variantCost(conn, toId, toName)
            if (existing.lineCount > 0 && !overwrite) {
                throw new Error(
                    `${target.name} ${toName || '(base)'} already has ${existing.lineCount} `
                    + `${existing.lineCount === 1 ? 'line' : 'lines'} — confirm to replace them`,
                )
            }

            await conn.query(
                `INSERT INTO recipes (menu_item_id, notes) VALUES (?, NULL)
                 ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3)`,
                [toId],
            )
            await conn.query(
                'DELETE FROM recipe_lines WHERE menu_item_id = ? AND variant_name = ?',
                [toId, toName],
            )
            await conn.query(
                'INSERT INTO recipe_lines (menu_item_id, variant_name, inventory_item_id, qty) VALUES ?',
                [lines.map((l) => [toId, toName, l.inventory_item_id, l.qty])],
            )

            const { cost, lineCount } = await variantCost(conn, toId, toName)
            await audit(conn, {
                bd,
                action: 'menu_recipe_copy',
                details: {
                    from_menu_item_id: fromId,
                    from_dish: source.name,
                    from_variant: fromName || '(base)',
                    menu_item_id: toId,
                    dish: target.name,
                    variant: toName || '(base)',
                    lines: lineCount,
                    cost,
                    replaced: existing.lineCount,
                },
                userId: user.id,
            })
            return {
                menu_item_id: toId,
                dish: target.name,
                variant_name: toName,
                line_count: lineCount,
                unit_cost: cost,
                replaced: existing.lineCount,
            }
        })
        return { data: result }
    } catch (e) {
        return { error: e.message }
    }
}

'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { indexSubRecipes, effectiveCost, recomputeSubRecipeCosts, MAX_DEPTH } from '@/lib/inventory/subrecipe.mjs'

/*
 * Sub-recipes: the batches a kitchen makes before it cooks a dish — a karahi
 * masala, a ginger-garlic paste, a yakhni stock.
 *
 * They are phantoms: never bought, never counted. Selling a dish that calls
 * for 80g of masala takes the spices off the shelf, and the masala's own
 * `avg_cost` is a cached roll-up of its parts so every screen that already
 * prices a recipe becomes right without being taught anything.
 */

export async function getSubRecipeBoard() {
    try {
        await requirePermission('menu')
        const [items, lines] = await Promise.all([
            query(
                `SELECT i.id, i.name, i.avg_cost, u.abbrev AS unit_abbrev
                   FROM inventory_items i JOIN units u ON u.id = i.unit_id
                  WHERE i.is_active = 1 ORDER BY i.name`,
            ),
            query(
                `SELECT l.parent_item_id, l.component_item_id, l.qty,
                        i.name AS component_name, u.abbrev AS component_unit
                   FROM sub_recipe_lines l
                   JOIN inventory_items i ON i.id = l.component_item_id
                   JOIN units u ON u.id = i.unit_id
                  ORDER BY l.id`,
            ),
        ])
        const parents = [...new Set(lines.map((l) => Number(l.parent_item_id)))]
        return {
            data: {
                items,
                // Which ingredients are phantoms, with their parts. Everything
                // else on `items` is raw and can be a component.
                subRecipes: parents.map((id) => {
                    const item = items.find((i) => Number(i.id) === id)
                    return {
                        id,
                        name: item?.name ?? `#${id}`,
                        unit_abbrev: item?.unit_abbrev ?? '',
                        cost: Number(item?.avg_cost ?? 0),
                        lines: lines.filter((l) => Number(l.parent_item_id) === id),
                    }
                }),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Save one ingredient's recipe, replacing whatever it had.
 *
 * Two refusals worth naming, both of which would otherwise be found later as
 * wrong numbers rather than as errors:
 *  - an ingredient cannot be part of itself, at any depth. The expander
 *    survives a loop, but a loop is still a modelling mistake and this is
 *    where somebody can still fix it.
 *  - saving an empty list DELETES the sub-recipe, which turns the phantom back
 *    into a raw ingredient. That is the honest way to undo one.
 */
export async function saveSubRecipe({ parentId, lines } = {}) {
    try {
        await requirePermission('menu')
        const parent = Number(parentId)
        if (!Number.isInteger(parent) || parent <= 0) throw new Error('Pick the ingredient this recipe makes')

        const clean = (Array.isArray(lines) ? lines : [])
            .map((l) => ({ itemId: Number(l.itemId), qty: Math.round(Number(l.qty) * 10000) / 10000 }))
            .filter((l) => Number.isInteger(l.itemId) && l.itemId > 0 && l.qty > 0)

        if (clean.some((l) => l.itemId === parent)) {
            throw new Error('An ingredient cannot be part of itself')
        }

        await withTransaction(async (conn) => {
            const [existing] = await conn.query(
                'SELECT parent_item_id, component_item_id, qty FROM sub_recipe_lines WHERE parent_item_id <> ?',
                [parent],
            )
            // The cycle check runs against what the table WOULD hold, not what
            // it holds now: the loop a save creates is the one worth refusing.
            const map = indexSubRecipes([
                ...existing,
                ...clean.map((l) => ({ parent_item_id: parent, component_item_id: l.itemId, qty: l.qty })),
            ])
            const reaches = (from, target, depth = 0, seen = new Set()) => {
                if (depth > MAX_DEPTH || seen.has(from)) return false
                for (const part of map.get(from) ?? []) {
                    if (part.itemId === target) return true
                    if (reaches(part.itemId, target, depth + 1, new Set(seen).add(from))) return true
                }
                return false
            }
            if (reaches(parent, parent)) {
                throw new Error('That would make the ingredient part of itself, through another recipe')
            }

            await conn.query('DELETE FROM sub_recipe_lines WHERE parent_item_id = ?', [parent])
            if (clean.length) {
                await conn.query(
                    'INSERT INTO sub_recipe_lines (parent_item_id, component_item_id, qty) VALUES ?',
                    [clean.map((l) => [parent, l.itemId, l.qty])],
                )
            }
            await recomputeSubRecipeCosts(conn)

            // A recipe just deleted leaves a phantom priced at its old roll-up,
            // which would then read as a bought-in cost nobody can explain. It
            // goes back to zero, the same place a new ingredient starts.
            if (!clean.length) {
                await conn.query(
                    'UPDATE inventory_items SET avg_cost = 0, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                    [parent],
                )
            }
        })
        return { success: clean.length ? 'Sub-recipe saved' : 'Sub-recipe removed' }
    } catch (e) {
        return { error: e.message }
    }
}

/* What one unit would cost, for the editor's live total before saving. */
export async function priceSubRecipe(lines = []) {
    try {
        await requirePermission('menu')
        const [rows, items] = await Promise.all([
            query('SELECT parent_item_id, component_item_id, qty FROM sub_recipe_lines'),
            query('SELECT id, avg_cost, yield_pct FROM inventory_items'),
        ])
        const map = indexSubRecipes(rows)
        const costs = new Map(items.map((i) => [Number(i.id), Number(i.avg_cost)]))
        const yields = new Map(items.map((i) => [Number(i.id), Number(i.yield_pct)]))
        const total = lines.reduce(
            (sum, l) => sum + Number(l.qty || 0) * effectiveCost(Number(l.itemId), map, costs, yields),
            0,
        )
        return { data: { cost: Math.round(total * 10000) / 10000 } }
    } catch (e) {
        return { error: e.message }
    }
}

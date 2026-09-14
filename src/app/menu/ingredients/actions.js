'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
import { audit, businessDate, cleanName, friendlyDup, requireId } from '@/lib/menu/kit.mjs'

/*
 * The ingredient master, and the one screen allowed to type a cost.
 *
 * avg_cost is a moving average maintained by receivings, which is the right
 * answer the moment there IS purchase history — and no answer at all before
 * it. Every recipe on a fresh install therefore costs zero, and a zero cost
 * is not a cheap dish, it is a lie the gross-profit report repeats all day.
 * So the owner sets the opening cost here, and the first goods-in for that
 * item takes the column back: `receiveStock` blends it into the average and
 * a hand-set figure is gone. Each row says which of the two is currently
 * true, and overwriting a computed cost needs a deliberate second press.
 *
 * This action and `receiveStock` are the ONLY writers of avg_cost. Nothing
 * else in the tree may touch it — a third writer and "what does a plate
 * cost" stops having an answer.
 */

/*
 * Ingredient costs are per unit and genuinely fractional — Rs. 0.85 a gram —
 * so they round at the column's four places, not at money's two. `cleanPrice`
 * is the wrong tool here twice over: it rounds to paise, and it refuses a
 * blank. Blank is legal on an ingredient and means zero, which is the "not
 * priced yet" state the list flags in red — unlike a blank dish price, which
 * would quietly put a free plate on the menu.
 */
const cleanCost = (value, label = 'Cost per unit') => {
    const raw = String(value ?? '').trim()
    if (raw === '') return 0
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number`)
    if (n < 0) throw new Error(`${label} cannot be negative`)
    if (n > 99_999_999) throw new Error(`${label} is implausibly large`)
    return Math.round(n * 10000) / 10000
}

/* reorder_level is DECIMAL(12,3), and a reorder level of nothing is zero. */
const cleanQty = (value, label = 'Reorder level') => {
    const raw = String(value ?? '').trim()
    if (raw === '') return 0
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number`)
    if (n < 0) throw new Error(`${label} cannot be negative`)
    return Math.round(n * 1000) / 1000
}

/* Free text, grouped on rather than looked up — a table for six words
 * (Meat, Dairy, Spices…) would be ceremony. Blank means ungrouped. */
const cleanCategory = (value) => {
    const v = String(value ?? '').trim().replace(/\s+/g, ' ')
    if (!v) return null
    if (v.length > 64) throw new Error('Category is too long (64 characters max)')
    return v
}

const toRow = (r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    unit_id: r.unit_id,
    unit_abbrev: r.unit_abbrev,
    avg_cost: Number(r.avg_cost),
    reorder_level: Number(r.reorder_level),
    is_active: Boolean(r.is_active),
    on_hand: Number(r.on_hand ?? 0),
    // Which of the two owns the cost right now. Once a receiving has landed,
    // the moving average is the truth and a typed figure is a correction
    // that the next goods-in will overwrite.
    has_receipts: Boolean(r.has_receipts),
    recipe_count: Number(r.recipe_count ?? 0),
    made_in_house: Boolean(r.made_in_house),
})

/*
 * Everything the screen draws, in one round trip: the items with their
 * on-hand, their cost provenance and how many recipes lean on them, plus
 * the unit list the form picks from.
 */
export async function listIngredients() {
    try {
        await requireUser()
        const [items, units] = await Promise.all([
            query(
                `SELECT i.id, i.name, i.category, i.unit_id, i.avg_cost, i.reorder_level, i.is_active,
                        u.abbrev AS unit_abbrev,
                        COALESCE(q.qty, 0) AS on_hand,
                        EXISTS (SELECT 1 FROM stock_receiving_lines rl
                                 WHERE rl.inventory_item_id = i.id) AS has_receipts,
                        COALESCE(rc.n, 0) AS recipe_count,
                        -- Whether this ingredient is MADE rather than bought.
                        -- A sub-recipe is not a separate kind of thing, it is
                        -- a fact about an ingredient, so the list says so.
                        EXISTS (SELECT 1 FROM sub_recipe_lines sr
                                 WHERE sr.parent_item_id = i.id) AS made_in_house
                   FROM inventory_items i
                   JOIN units u ON u.id = i.unit_id
                   LEFT JOIN (SELECT inventory_item_id, SUM(delta) AS qty
                                FROM stock_ledger GROUP BY inventory_item_id) q
                     ON q.inventory_item_id = i.id
                   LEFT JOIN (SELECT inventory_item_id, COUNT(*) AS n
                                FROM recipe_lines GROUP BY inventory_item_id) rc
                     ON rc.inventory_item_id = i.id
                  ORDER BY i.name`,
            ),
            query('SELECT id, name, abbrev FROM units ORDER BY id'),
        ])
        return { data: { items: items.map(toRow), units } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Add or edit one ingredient. The cost is written only when it actually
 * changes, and a change to a cost the receivings computed needs
 * `confirmCostOverride` — the screen asks first, and the server asks again
 * rather than trusting that it did.
 */
export async function saveIngredient(input) {
    try {
        const user = await requirePermission('menu')
        const id = input?.id ? requireId(input.id, 'ingredient') : null
        const name = cleanName(input?.name, 'An ingredient')
        const category = cleanCategory(input?.category)
        const unitId = requireId(input?.unit_id, 'unit')
        const cost = cleanCost(input?.avg_cost)
        const reorder = cleanQty(input?.reorder_level)
        const isActive = input?.is_active === undefined ? true : Boolean(input.is_active)
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            const [unitRows] = await conn.query('SELECT id FROM units WHERE id = ?', [unitId])
            if (unitRows.length === 0) throw new Error('Pick a unit')

            let itemId = id
            let costChange = null

            try {
                if (id) {
                    const [existing] = await conn.query(
                        `SELECT i.name, i.avg_cost,
                                EXISTS (SELECT 1 FROM stock_receiving_lines rl
                                         WHERE rl.inventory_item_id = i.id) AS has_receipts
                           FROM inventory_items i WHERE i.id = ? FOR UPDATE`,
                        [id],
                    )
                    if (existing.length === 0) throw new Error('That ingredient no longer exists')
                    const oldCost = Number(existing[0].avg_cost)
                    if (cost !== oldCost) {
                        if (existing[0].has_receipts && !input?.confirmCostOverride) {
                            throw new Error(
                                `${existing[0].name} is costed from its receivings at Rs. ${oldCost}: `
                                + 'confirm to overwrite it by hand',
                            )
                        }
                        costChange = { from: oldCost, to: cost }
                    }
                    await conn.query(
                        `UPDATE inventory_items
                            SET name = ?, category = ?, unit_id = ?, avg_cost = ?,
                                reorder_level = ?, is_active = ?, updated_at = UTC_TIMESTAMP(3)
                          WHERE id = ?`,
                        [name, category, unitId, cost, reorder, isActive ? 1 : 0, id],
                    )
                } else {
                    const [res] = await conn.query(
                        `INSERT INTO inventory_items
                           (name, category, unit_id, avg_cost, reorder_level, is_active)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [name, category, unitId, cost, reorder, isActive ? 1 : 0],
                    )
                    itemId = res.insertId
                    if (cost > 0) costChange = { from: 0, to: cost }
                }
            } catch (e) {
                throw new Error(friendlyDup(e, 'ingredient'))
            }

            await audit(conn, {
                bd,
                action: id ? 'menu_ingredient_update' : 'menu_ingredient_create',
                details: {
                    ingredient_id: itemId, name, category, unit_id: unitId,
                    reorder_level: reorder, is_active: isActive,
                },
                userId: user.id,
            })
            // A price change is its own line in the log: "who repriced the
            // chicken" is the question a wrong margin starts with.
            if (costChange) {
                await audit(conn, {
                    bd,
                    action: 'menu_ingredient_cost',
                    details: {
                        ingredient_id: itemId, name,
                        old_cost: costChange.from, new_cost: costChange.to,
                        by_hand: true,
                    },
                    userId: user.id,
                })
            }

            const [after] = await conn.query(
                `SELECT i.id, i.name, i.category, i.unit_id, i.avg_cost, i.reorder_level, i.is_active,
                        u.abbrev AS unit_abbrev,
                        COALESCE((SELECT SUM(delta) FROM stock_ledger sl
                                   WHERE sl.inventory_item_id = i.id), 0) AS on_hand,
                        EXISTS (SELECT 1 FROM stock_receiving_lines rl
                                 WHERE rl.inventory_item_id = i.id) AS has_receipts,
                        (SELECT COUNT(*) FROM recipe_lines l
                          WHERE l.inventory_item_id = i.id) AS recipe_count
                   FROM inventory_items i
                   JOIN units u ON u.id = i.unit_id
                  WHERE i.id = ?`,
                [itemId],
            )
            return after[0]
        })
        return { data: toRow(row) }
    } catch (e) {
        return { error: e.message }
    }
}

/* Off the pickers, still on every report that already carries it. */
export async function toggleIngredient(id) {
    try {
        const user = await requirePermission('menu')
        const itemId = requireId(id, 'ingredient')
        const bd = await businessDate()

        const isActive = await withTransaction(async (conn) => {
            const [rows] = await conn.query(
                'SELECT name, is_active FROM inventory_items WHERE id = ? FOR UPDATE', [itemId],
            )
            if (rows.length === 0) throw new Error('That ingredient no longer exists')
            const next = rows[0].is_active ? 0 : 1
            await conn.query(
                'UPDATE inventory_items SET is_active = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [next, itemId],
            )
            await audit(conn, {
                bd,
                action: 'menu_ingredient_toggle',
                details: { ingredient_id: itemId, name: rows[0].name, is_active: Boolean(next) },
                userId: user.id,
            })
            return Boolean(next)
        })
        return { data: { id: itemId, is_active: isActive } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Delete, but only what nothing remembers. An ingredient a recipe names is
 * part of what a plate costs, and an ingredient the ledger has moved is part
 * of what the stock report says happened; either one deleted leaves a hole
 * somebody has to reconstruct. The refusal names the dishes, because "in use"
 * without saying where is a dead end. Everything else deactivates.
 */
export async function deleteIngredient(id) {
    try {
        const user = await requirePermission('menu')
        const itemId = requireId(id, 'ingredient')
        const bd = await businessDate()

        await withTransaction(async (conn) => {
            const [rows] = await conn.query(
                'SELECT name FROM inventory_items WHERE id = ? FOR UPDATE', [itemId],
            )
            if (rows.length === 0) throw new Error('That ingredient no longer exists')
            const name = rows[0].name

            const [used] = await conn.query(
                `SELECT DISTINCT mi.name
                   FROM recipe_lines rl
                   JOIN menu_items mi ON mi.id = rl.menu_item_id
                  WHERE rl.inventory_item_id = ?
                  ORDER BY mi.name`,
                [itemId],
            )
            if (used.length > 0) {
                const names = used.slice(0, 4).map((r) => r.name).join(', ')
                const more = used.length > 4 ? ` and ${used.length - 4} more` : ''
                throw new Error(
                    `${name} is in the recipe for ${names}${more}. Take it off those recipes first, `
                    + 'or switch it off instead',
                )
            }

            // Every table that can name an ingredient, not just the ledger:
            // a count line that matched the shelf posts paperwork and NO
            // ledger row, and a demand draft is a requisition that has not
            // moved anything yet. Either one deleted is a foreign-key error
            // in the person's face instead of a sentence they can act on.
            const [paperwork] = await conn.query(
                `SELECT
                   EXISTS (SELECT 1 FROM stock_ledger WHERE inventory_item_id = ?) AS ledger,
                   EXISTS (SELECT 1 FROM stock_receiving_lines WHERE inventory_item_id = ?) AS receipts,
                   EXISTS (SELECT 1 FROM stock_doc_lines WHERE inventory_item_id = ?) AS docs,
                   EXISTS (SELECT 1 FROM demand_draft_lines WHERE inventory_item_id = ?) AS drafts`,
                [itemId, itemId, itemId, itemId],
            )
            const p = paperwork[0]
            if (p.ledger || p.receipts || p.docs || p.drafts) {
                const where = [
                    p.receipts && 'a receiving',
                    p.docs && 'a stock document',
                    p.drafts && 'a demand draft',
                    p.ledger && 'the stock ledger',
                ].filter(Boolean).join(', ')
                throw new Error(
                    `${name} is named by ${where}. Switch it off instead, so the stock history `
                    + 'keeps the name it was recorded under',
                )
            }

            try {
                await conn.query('DELETE FROM inventory_items WHERE id = ?', [itemId])
            } catch (e) {
                // Backstop for a table added after this was written: a raw
                // foreign-key error is not a sentence anyone can act on.
                if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) {
                    throw new Error(`${name} is still referenced elsewhere. Switch it off instead`)
                }
                throw e
            }
            await audit(conn, {
                bd,
                action: 'menu_ingredient_delete',
                details: { ingredient_id: itemId, name },
                userId: user.id,
            })
        })
        return { data: { id: itemId } }
    } catch (e) {
        return { error: e.message }
    }
}

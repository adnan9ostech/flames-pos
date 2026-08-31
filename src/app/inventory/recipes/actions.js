'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })

/*
 * The trading day the audit row belongs to: the open business day once
 * day-close is in use, else the Karachi calendar day — the same resolution
 * the money verbs apply, restated here because the kernel keeps its copy
 * private.
 */
const auditLog = async (conn, action, details) => {
    const [rows] = await conn.query(
        `SELECT business_date FROM business_days
         WHERE branch_id = 1 AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
    )
    const d = rows[0]?.business_date
    const businessDate = d
        ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d))
        : karachiDay()
    await conn.query(
        `INSERT INTO audit_log (branch_id, business_date, action, details)
         VALUES (1, ?, ?, ?)`,
        [businessDate, action, JSON.stringify(details)],
    )
}

/*
 * The two lists the editor is built from: every dish (recipe or not — the
 * gaps are the work list), and every active ingredient with the cost the
 * live math prices against.
 */
export async function getRecipeBoard() {
    try {
        await requireUser()
        const [dishes, ingredients] = await Promise.all([
            query(
                `SELECT m.id, m.name, m.price, c.name AS category_name,
                        (r.menu_item_id IS NOT NULL) AS has_recipe
                 FROM menu_items m
                 LEFT JOIN categories c ON c.id = m.category_id
                 LEFT JOIN recipes r ON r.menu_item_id = m.id
                 ORDER BY c.sort_order, c.name, m.name`,
            ),
            query(
                `SELECT i.id, i.name, i.avg_cost, u.abbrev AS unit_abbrev
                 FROM inventory_items i
                 JOIN units u ON u.id = i.unit_id
                 WHERE i.is_active = 1
                 ORDER BY i.name`,
            ),
        ])
        return {
            data: {
                dishes: dishes.map((d) => ({ ...d, has_recipe: Boolean(d.has_recipe) })),
                ingredients,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function getRecipe(menuItemId) {
    try {
        await requireUser()
        if (!UUID_RE.test(String(menuItemId))) throw new Error('Pick a dish first')
        const [recipeRows, lines] = await Promise.all([
            query('SELECT notes FROM recipes WHERE menu_item_id = ?', [menuItemId]),
            query(
                `SELECT inventory_item_id, qty FROM recipe_lines
                 WHERE menu_item_id = ? ORDER BY id`,
                [menuItemId],
            ),
        ])
        return {
            data: {
                notes: recipeRows[0]?.notes ?? '',
                lines,
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Replaces the dish's lines wholesale — delete-and-reinsert under one
 * transaction, so a half-saved recipe can never price a plate. Saving with
 * no lines removes the recipe outright.
 */
export async function saveRecipe({ menuItemId, lines, notes }) {
    try {
        await requirePermission('inventory')
        if (!UUID_RE.test(String(menuItemId))) throw new Error('Pick a dish first')

        const cleanLines = (Array.isArray(lines) ? lines : []).map((line) => ({
            inventory_item_id: Number(line.inventory_item_id),
            qty: Number(line.qty),
        }))
        for (const line of cleanLines) {
            if (!Number.isInteger(line.inventory_item_id) || line.inventory_item_id <= 0) {
                throw new Error('Every line needs an ingredient')
            }
            if (!Number.isFinite(line.qty) || line.qty <= 0) {
                throw new Error('Every line needs a quantity above zero')
            }
        }
        const seen = new Set(cleanLines.map((l) => l.inventory_item_id))
        if (seen.size !== cleanLines.length) {
            throw new Error('The same ingredient appears twice — combine the quantities')
        }
        const cleanNotes = String(notes ?? '').trim().slice(0, 191) || null

        const result = await withTransaction(async (conn) => {
            const [dishRows] = await conn.query(
                'SELECT name FROM menu_items WHERE id = ?', [menuItemId],
            )
            if (dishRows.length === 0) throw new Error('That dish no longer exists')

            if (cleanLines.length === 0) {
                // ON DELETE CASCADE takes the lines with it.
                await conn.query('DELETE FROM recipes WHERE menu_item_id = ?', [menuItemId])
                await auditLog(conn, 'recipe_save', {
                    menu_item_id: menuItemId, dish: dishRows[0].name, lines: 0, removed: true,
                })
                return { cost: 0, lineCount: 0 }
            }

            await conn.query(
                `INSERT INTO recipes (menu_item_id, notes) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE notes = VALUES(notes), updated_at = UTC_TIMESTAMP(3)`,
                [menuItemId, cleanNotes],
            )
            await conn.query('DELETE FROM recipe_lines WHERE menu_item_id = ?', [menuItemId])
            await conn.query(
                'INSERT INTO recipe_lines (menu_item_id, inventory_item_id, qty) VALUES ?',
                [cleanLines.map((l) => [menuItemId, l.inventory_item_id, l.qty])],
            )

            // Costed inside the transaction so the audit row states what the
            // recipe was worth at the moment it was saved.
            const [costRows] = await conn.query(
                `SELECT COALESCE(SUM(rl.qty * i.avg_cost), 0) AS cost
                 FROM recipe_lines rl
                 JOIN inventory_items i ON i.id = rl.inventory_item_id
                 WHERE rl.menu_item_id = ?`,
                [menuItemId],
            )
            const cost = Number(costRows[0]?.cost ?? 0)
            await auditLog(conn, 'recipe_save', {
                menu_item_id: menuItemId, dish: dishRows[0].name,
                lines: cleanLines.length, cost,
            })
            return { cost, lineCount: cleanLines.length }
        })
        return { data: result }
    } catch (e) {
        return { error: e.message }
    }
}

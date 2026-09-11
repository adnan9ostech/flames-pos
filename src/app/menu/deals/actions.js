'use server'

import { randomUUID } from 'node:crypto'
import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'

/*
 * Deals: a set of dishes sold together for one price.
 *
 * Nothing here computes a saving. The saving is the deal's price against the
 * sum of its dishes' MENU prices worked out live at the till — so repricing a
 * dish reprices the saving, and a deal can never quietly drift into selling
 * above its own components. All this screen stores is the set and the price.
 */

const ORDER_TYPES = ['dine-in', 'takeaway', 'delivery']

export async function getDealsAdmin() {
    try {
        await requirePermission('menu')
        const [deals, lines, items] = await Promise.all([
            query('SELECT * FROM deals ORDER BY sort_order, name'),
            query(
                `SELECT dl.*, m.name AS item_name, m.price AS item_price, m.variants
                   FROM deal_lines dl JOIN menu_items m ON m.id = dl.menu_item_id
                  ORDER BY dl.id`,
            ),
            query(
                `SELECT id, name, price, variants FROM menu_items
                  WHERE is_archived = 0 ORDER BY name`,
            ),
        ])
        return {
            data: {
                items,
                deals: deals.map((d) => ({
                    ...d,
                    price: Number(d.price),
                    is_active: Boolean(d.is_active),
                    order_types: typeof d.order_types === 'string' ? JSON.parse(d.order_types || '[]') : (d.order_types || []),
                    lines: lines.filter((l) => l.deal_id === d.id),
                })),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveDeal({ id, name, description, price, orderTypes, isActive, lines } = {}) {
    try {
        await requirePermission('menu')
        const dealName = String(name ?? '').trim().slice(0, 191)
        if (!dealName) throw new Error('A deal needs a name')
        const dealPrice = Math.round(Number(price) * 100) / 100
        if (!Number.isFinite(dealPrice) || dealPrice <= 0) throw new Error('A deal needs a price above zero')

        const types = (Array.isArray(orderTypes) ? orderTypes : []).filter((t) => ORDER_TYPES.includes(t))
        const clean = (Array.isArray(lines) ? lines : [])
            .map((l) => ({
                menuItemId: String(l.menuItemId || ''),
                variantName: String(l.variantName || '').slice(0, 64),
                qty: Math.max(1, Math.round(Number(l.qty) || 1)),
            }))
            .filter((l) => l.menuItemId)
        if (clean.length === 0) throw new Error('A deal needs at least one dish')

        const dealId = id || randomUUID()
        await withTransaction(async (conn) => {
            if (id) {
                await conn.query(
                    `UPDATE deals SET name = ?, description = ?, price = ?, order_types = ?,
                            is_active = ?, updated_at = UTC_TIMESTAMP(3)
                      WHERE id = ?`,
                    [dealName, String(description ?? '').trim().slice(0, 512) || null,
                        dealPrice, JSON.stringify(types), isActive ? 1 : 0, id],
                )
            } else {
                await conn.query(
                    `INSERT INTO deals (id, name, description, price, order_types, is_active)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [dealId, dealName, String(description ?? '').trim().slice(0, 512) || null,
                        dealPrice, JSON.stringify(types), isActive ? 1 : 0],
                )
            }
            // Replaced wholesale: a deal's set is one thing, and diffing lines
            // to preserve ids buys nothing when nothing points at them.
            await conn.query('DELETE FROM deal_lines WHERE deal_id = ?', [dealId])
            await conn.query(
                'INSERT INTO deal_lines (deal_id, menu_item_id, variant_name, qty) VALUES ?',
                [clean.map((l) => [dealId, l.menuItemId, l.variantName, l.qty])],
            )
        })
        return { success: id ? 'Deal updated' : 'Deal created' }
    } catch (e) {
        return { error: /Duplicate entry/.test(e.message) ? 'A deal with that name already exists' : e.message }
    }
}

/*
 * Deleting a deal is safe in a way deleting a dish is not: no order points at
 * one. A sold deal left its dishes on the bill and its saving in the order's
 * discount, both of which stand on their own.
 */
export async function deleteDeal(id) {
    try {
        await requirePermission('menu')
        await query('DELETE FROM deals WHERE id = ?', [id])
        return { success: 'Deal deleted' }
    } catch (e) {
        return { error: e.message }
    }
}

'use server'

import { query, withTransaction } from '@/lib/db/pool.mjs'
import { requireUser, requirePermission } from '@/lib/db/auth.mjs'
import { openBusinessDate } from '@/lib/day/openDay.mjs'
import { writeAudit } from '@/lib/db/audit.mjs'

const SCOPES = ['order', 'category', 'item']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

/*
 * The trading day this write belongs to — the open business day once day
 * close exists, the Karachi calendar day until then. Same resolution the
 * money verbs use, restated here because the kernel keeps its copy private.
 */
const businessDate = async () => openBusinessDate()

const audit = (conn, bd, action, details) =>
    writeAudit(conn, { businessDate: bd, action, details })

/* The calendar day and wall clock in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })
const karachiClock = (d) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour12: false })

/* ISO weekday 1(Mon)–7(Sun) of a 'YYYY-MM-DD' string — the numbering `days` stores. */
const isoWeekday = (dateStr) => ((new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7) + 1
const dayBefore = (dateStr) =>
    new Date(Date.parse(`${dateStr}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

const toPlan = (r) => ({
    id: r.id,
    name: r.name,
    value_type: r.value_type,
    value: Number(r.value),
    starts_on: r.starts_on instanceof Date ? r.starts_on.toISOString().slice(0, 10) : r.starts_on ?? null,
    ends_on: r.ends_on instanceof Date ? r.ends_on.toISOString().slice(0, 10) : r.ends_on ?? null,
    start_time: r.start_time ?? null,
    end_time: r.end_time ?? null,
    days: Array.isArray(r.days) ? r.days.map(Number) : [],
    scope: r.scope,
    category_ids: Array.isArray(r.category_ids) ? r.category_ids : [],
    item_ids: Array.isArray(r.item_ids) ? r.item_ids : [],
    min_qty: Number(r.min_qty) || 0,
    max_value: r.max_value == null ? null : Number(r.max_value),
    is_active: Boolean(r.is_active),
})

const cleanPlan = (input) => {
    const name = String(input?.name ?? '').trim()
    if (!name) throw new Error('A discount plan needs a name')
    if (name.length > 64) throw new Error('Plan name is too long (64 characters max)')

    const value_type = ['percent', 'fixed'].includes(input?.value_type) ? input.value_type : null
    if (!value_type) throw new Error('Value type must be percent or fixed')

    const value = Number(input?.value)
    if (!Number.isFinite(value) || value <= 0) throw new Error('Value must be more than zero')
    if (value_type === 'percent' && value > 100) throw new Error('A percent discount cannot exceed 100')

    // Empty strings mean "no bound"; anything else must parse, because these
    // land in DATE/TIME columns and drive when the till offers the plan.
    const date = (key) => {
        const raw = String(input?.[key] ?? '').trim()
        if (!raw) return null
        if (!DATE_RE.test(raw)) throw new Error('Dates must be YYYY-MM-DD')
        return raw
    }
    const time = (key) => {
        const raw = String(input?.[key] ?? '').trim()
        if (!raw) return null
        if (!TIME_RE.test(raw)) throw new Error('Times must be HH:MM')
        return raw.length === 5 ? `${raw}:00` : raw
    }
    const starts_on = date('starts_on')
    const ends_on = date('ends_on')
    if (starts_on && ends_on && starts_on > ends_on) {
        throw new Error('The plan cannot end before it starts')
    }
    const start_time = time('start_time')
    const end_time = time('end_time')
    // A start with no end (or the reverse) has no answer for "is 3 PM in the
    // window" — refuse the half-window rather than guess. start > end is
    // fine: that is an overnight window.
    if (Boolean(start_time) !== Boolean(end_time)) {
        throw new Error('Give both a start and end time, or neither')
    }

    const days = [...new Set(
        (Array.isArray(input?.days) ? input.days : [])
            .map(Number)
            .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7),
    )].sort((a, b) => a - b)

    const scope = SCOPES.includes(input?.scope) ? input.scope : null
    if (!scope) throw new Error('Scope must be order, category, or item')

    const idList = (key) => [...new Set(
        (Array.isArray(input?.[key]) ? input[key] : [])
            .map((v) => String(v).trim())
            .filter(Boolean),
    )]
    const category_ids = scope === 'category' ? idList('category_ids') : []
    const item_ids = scope === 'item' ? idList('item_ids') : []
    if (scope === 'category' && category_ids.length === 0) {
        throw new Error('A category discount needs at least one category')
    }
    if (scope === 'item' && item_ids.length === 0) {
        throw new Error('An item discount needs at least one item')
    }

    const min_qty = Number(input?.min_qty ?? 0)
    if (!Number.isInteger(min_qty) || min_qty < 0) throw new Error('Minimum quantity must be a whole number')

    let max_value = null
    if (input?.max_value !== null && input?.max_value !== undefined && String(input.max_value).trim() !== '') {
        max_value = Number(input.max_value)
        if (!Number.isFinite(max_value) || max_value <= 0) throw new Error('The cap must be more than zero')
        max_value = Math.round(max_value * 100) / 100
    }

    return {
        name, value_type, value: Math.round(value * 100) / 100,
        starts_on, ends_on, start_time, end_time, days,
        scope, category_ids, item_ids, min_qty, max_value,
        is_active: input?.is_active === undefined ? true : Boolean(input.is_active),
    }
}

const requireId = (id) => {
    const n = Number(id)
    if (!Number.isInteger(n) || n <= 0) throw new Error('That discount plan no longer exists')
    return n
}

export async function listPlans() {
    try {
        await requirePermission('setup')
        const rows = await query('SELECT * FROM discount_plans ORDER BY is_active DESC, name')
        return { data: rows.map(toPlan) }
    } catch (e) {
        return { error: e.message }
    }
}

/* What the scope pickers choose from. Items carry their category so the form
 * can group a 100-dish menu into something scannable. */
export async function listScopeOptions() {
    try {
        await requirePermission('setup')
        const [categories, items] = await Promise.all([
            query('SELECT id, name FROM categories ORDER BY sort_order, name'),
            query('SELECT id, name, category_id FROM menu_items ORDER BY name'),
        ])
        return { data: { categories, items } }
    } catch (e) {
        return { error: e.message }
    }
}

export async function savePlan(input) {
    try {
        await requirePermission('setup')
        const clean = cleanPlan(input)
        const id = input?.id ? requireId(input.id) : null
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            const params = [
                clean.name, clean.value_type, clean.value,
                clean.starts_on, clean.ends_on, clean.start_time, clean.end_time,
                JSON.stringify(clean.days), clean.scope,
                JSON.stringify(clean.category_ids), JSON.stringify(clean.item_ids),
                clean.min_qty, clean.max_value, clean.is_active ? 1 : 0,
            ]
            let planId = id
            if (id) {
                const [result] = await conn.query(
                    `UPDATE discount_plans SET
                       name = ?, value_type = ?, value = ?,
                       starts_on = ?, ends_on = ?, start_time = ?, end_time = ?,
                       days = ?, scope = ?, category_ids = ?, item_ids = ?,
                       min_qty = ?, max_value = ?, is_active = ?,
                       updated_at = UTC_TIMESTAMP(3)
                     WHERE id = ?`,
                    [...params, id],
                )
                if (result.affectedRows === 0) throw new Error('That discount plan no longer exists')
            } else {
                const [result] = await conn.query(
                    `INSERT INTO discount_plans
                       (name, value_type, value, starts_on, ends_on, start_time, end_time,
                        days, scope, category_ids, item_ids, min_qty, max_value, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    params,
                )
                planId = result.insertId
            }

            // Audited because a plan quietly reshapes what customers pay for
            // as long as its window is open.
            await audit(conn, bd, 'save_discount_plan', {
                plan_id: planId, mode: id ? 'update' : 'create', ...clean,
            })

            const [rows] = await conn.query('SELECT * FROM discount_plans WHERE id = ?', [planId])
            return rows[0]
        })
        return { data: toPlan(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function togglePlan(id) {
    try {
        await requirePermission('setup')
        const planId = requireId(id)
        const bd = await businessDate()

        const row = await withTransaction(async (conn) => {
            const [result] = await conn.query(
                `UPDATE discount_plans SET is_active = 1 - is_active, updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [planId],
            )
            if (result.affectedRows === 0) throw new Error('That discount plan no longer exists')
            const [rows] = await conn.query('SELECT * FROM discount_plans WHERE id = ?', [planId])
            await audit(conn, bd, 'toggle_discount_plan', {
                plan_id: planId, name: rows[0].name, is_active: Boolean(rows[0].is_active),
            })
            return rows[0]
        })
        return { data: toPlan(row) }
    } catch (e) {
        return { error: e.message }
    }
}

export async function deletePlan(id) {
    try {
        await requirePermission('setup')
        const planId = requireId(id)
        const bd = await businessDate()

        await withTransaction(async (conn) => {
            // Safe to hard-delete: what lands on an order is a plain rupee
            // discount with the plan's name as its reason — no FK back here.
            const [rows] = await conn.query('SELECT name, value_type, value FROM discount_plans WHERE id = ?', [planId])
            if (rows.length === 0) throw new Error('That discount plan no longer exists')
            await conn.query('DELETE FROM discount_plans WHERE id = ?', [planId])
            await audit(conn, bd, 'delete_discount_plan', { plan_id: planId, ...rows[0] })
        })
        return { data: { id: planId } }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Is this plan on offer at this moment? Dates are checked against the trading
 * day, times against the Karachi wall clock. An overnight window (start >
 * end, e.g. 22:00–02:00) belongs to the day it STARTED: at 1 AM the evening's
 * deal still stands, and both its date window and its day-of-week are read
 * against that evening — which is also exactly what the business day says
 * once day close keeps it open past midnight.
 */
const planActiveAt = (plan, { tradingDay, calendarDay, time }) => {
    const dayOk = (ds) => plan.days.length === 0 || plan.days.includes(isoWeekday(ds))
    const dateOk = (ds) =>
        (!plan.starts_on || plan.starts_on <= ds) && (!plan.ends_on || ds <= plan.ends_on)

    // No times = all day. TIME columns come back 'HH:MM:SS', so plain string
    // comparison is chronological.
    const start = plan.start_time || '00:00:00'
    const end = plan.end_time || '23:59:59'

    if (start <= end) {
        return dateOk(tradingDay) && dayOk(tradingDay) && start <= time && time <= end
    }
    // Overnight, evening leg: tonight, anchored on the trading day.
    if (time >= start) return dateOk(tradingDay) && dayOk(tradingDay)
    // Overnight, small-hours leg: the window began yesterday evening. When an
    // open business day already lags the calendar it IS that evening; on the
    // calendar fallback, step back one day by hand.
    if (time <= end) {
        const anchor = tradingDay === calendarDay ? dayBefore(calendarDay) : tradingDay
        return dateOk(anchor) && dayOk(anchor)
    }
    return false
}

/*
 * The plans the till may offer as one-tap chips right now. `at` (ISO
 * timestamp) pins the evaluation moment for tests; omitted means now.
 * `orderType` is accepted for the till's calling contract — 002 plans carry
 * no order-type scoping yet, so today it does not narrow the list.
 */
export async function applicablePlans({ orderType, at } = {}) {
    try {
        await requireUser()
        const now = at ? new Date(at) : new Date()
        if (Number.isNaN(now.getTime())) throw new Error('Bad timestamp')

        const calendarDay = karachiDay(now)
        const time = karachiClock(now)
        // When `at` is pinned, trust its calendar day over the live open-day
        // row — a test asking about last Tuesday must not read this week.
        const tradingDay = at ? calendarDay : await businessDate(now)

        const rows = await query('SELECT * FROM discount_plans WHERE is_active = 1')
        const plans = rows.map(toPlan).filter((p) => planActiveAt(p, { tradingDay, calendarDay, time }))
        return { data: plans }
    } catch (e) {
        return { error: e.message }
    }
}

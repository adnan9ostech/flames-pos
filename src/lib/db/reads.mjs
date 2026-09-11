/*
 * Read-side queries (plus the two customer writes). Shapes match what the
 * pages consumed from PostgREST — same column names, same orderings, same
 * "return empty on failure" posture where the old layer had it.
 */
import { randomUUID } from 'node:crypto';
import { pool, query } from './pool.mjs';
import { serializeRow, serializeRows } from './serialize.mjs';

export const getCategories = async () =>
    serializeRows('categories', await query(
        'SELECT * FROM categories ORDER BY sort_order, name',
    ));

// Archived dishes are off the menu everywhere the menu is read — till, KDS
// lookups, customer view. They stay in the table for the bills that name them.
export const getMenuItems = async () =>
    serializeRows('menu_items', await query(
        `SELECT * FROM menu_items WHERE is_archived = 0
          ORDER BY sort_order, name`,
    ));

export const getModifiers = async () =>
    serializeRows('modifiers', await query('SELECT * FROM modifiers'));

export const getWaiters = async () =>
    serializeRows('waiters', await query(
        'SELECT * FROM waiters WHERE is_active = 1 ORDER BY name',
    ));

export const getStoreSettings = async () => {
    const rows = await query('SELECT * FROM store_settings LIMIT 1');
    return rows.length ? serializeRow('store_settings', rows[0]) : null;
};

const KITCHEN_STATUSES = ['new', 'preparing', 'ready'];

// Exactly the columns a ticket renders — totals and customer details stay
// off a screen that displays none of them.
const KITCHEN_COLUMNS =
    'id, order_number, token_no, status, order_type, table_number, waiter_name, ' +
    'payment_status, items, notes, round_count, created_at, last_round_at';

// Every live order reaches the kitchen the moment it is sent, paid or not: a
// dine-in table is cooked and served before it settles, so the ticket cannot
// wait on payment. Narrowed to the active kitchen statuses only.
export const getKitchenOrders = async () =>
    serializeRows('orders', await query(
        `SELECT ${KITCHEN_COLUMNS} FROM orders
         WHERE status IN (?)
         ORDER BY last_round_at ASC`,
        [KITCHEN_STATUSES],
    ));

export const getOpenTabs = async () =>
    serializeRows('orders', await query(
        `SELECT * FROM orders
         WHERE payment_status = 'unpaid' AND status <> 'cancelled'
         ORDER BY created_at ASC`,
    ));

export const getUnpaidOrdersCount = async () => {
    const rows = await query(
        `SELECT COUNT(*) AS n FROM orders
         WHERE payment_status = 'unpaid' AND status <> 'cancelled'`,
    );
    return rows[0].n;
};

export const getOrderById = async (orderId) => {
    const rows = await query('SELECT * FROM orders WHERE id = ?', [orderId]);
    return rows.length ? serializeRow('orders', rows[0]) : null;
};

/* What the polling hook watches: any insert or update to orders moves this. */
export const getOrdersVersion = async () => {
    const rows = await query(
        'SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM orders',
    );
    const latest = rows[0].latest instanceof Date ? rows[0].latest.getTime() : 0;
    return `${rows[0].n}:${latest}`;
};

export const ORDERS_PAGE_SIZES = [25, 50, 100];

const PAGE_SORTS = {
    newest: ['created_at', 'DESC'],
    oldest: ['created_at', 'ASC'],
    highest: ['total', 'DESC'],
    lowest: ['total', 'ASC'],
};

/*
 * Paged, filtered order history — same filters, sorts, and tie-breaks as the
 * PostgREST version, now as one WHERE builder shared by the count and the
 * page query.
 */
export const getOrdersPage = async ({
    page = 1, pageSize = 25, status = 'all', orderType = 'all',
    from = null, to = null, sort = 'newest', search = '',
    channel = 'all', paymentMode = 'all',
} = {}) => {
    const where = [];
    const params = [];

    // One box searches receipt number, name, phone, and table. Escape the
    // LIKE wildcards so a literal % in the term stays literal.
    const term = String(search).trim().replace(/[,()*%\\_]/g, '');
    if (term) {
        const like = `%${term}%`;
        where.push(`(o.order_number LIKE ? OR o.customer_name LIKE ?
                     OR o.customer_phone LIKE ? OR o.table_number LIKE ?)`);
        params.push(like, like, like, like);
    }

    if (status === 'unpaid') {
        // An open tab can be at any kitchen stage, including served, and
        // still owe money.
        where.push(`o.payment_status = 'unpaid' AND o.status <> 'cancelled'`);
    } else if (status !== 'all') {
        where.push('o.status = ?');
        params.push(status);
    }
    if (orderType !== 'all') { where.push('o.order_type = ?'); params.push(orderType); }
    // Where it came from, and how it was paid — the two questions a
    // reconciliation actually asks of a day's orders.
    if (channel !== 'all') { where.push('o.channel_id = ?'); params.push(Number(channel)); }
    if (paymentMode !== 'all') { where.push('o.payment_mode = ?'); params.push(paymentMode); }
    if (from) { where.push('o.created_at >= ?'); params.push(new Date(from)); }
    if (to) { where.push('o.created_at <= ?'); params.push(new Date(to)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [column, dir] = PAGE_SORTS[sort] || PAGE_SORTS.newest;
    // Tie-break on id so equal values can't shuffle rows between pages.
    const orderSql = column === 'created_at'
        ? `ORDER BY o.created_at ${dir}, o.id ASC`
        : `ORDER BY o.total ${dir}, o.created_at DESC, o.id ASC`;

    const countRows = await query(`SELECT COUNT(*) AS n FROM orders o ${whereSql}`, params);
    const rows = await query(
        `SELECT o.*, ch.name AS channel_name FROM orders o
           LEFT JOIN sales_channels ch ON ch.id = o.channel_id
         ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
        [...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)],
    );
    /*
     * The whole filtered set, not just this page: a cashier reconciling the
     * evening needs "what does this filter add up to", and paging through it
     * with a calculator is not that. Two aggregates, same WHERE.
     */
    const [sums] = await query(
        `SELECT COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN o.total END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN o.status <> 'cancelled' AND o.payment_status = 'unpaid' THEN o.total END), 0) AS unpaid
           FROM orders o ${whereSql}`,
        params,
    );
    return {
        rows: serializeRows('orders', rows),
        total: countRows[0].n,
        revenue: Number(sums?.revenue ?? 0),
        unpaid: Number(sums?.unpaid ?? 0),
    };
};

/*
 * Where orders can come from. Active only, default first — the till stamps the
 * first of these on a new bill unless the cashier says otherwise.
 */
export const getSalesChannels = async () => serializeRows(
    'sales_channels',
    await query(
        `SELECT id, name, is_default FROM sales_channels
          WHERE is_active = 1 ORDER BY is_default DESC, sort_order, id`,
    ),
);

/*
 * Dishes the kitchen has run out of, worked out from the shelf.
 *
 * A dish is out when any ingredient its recipe needs — down through
 * sub-recipes — is TRACKED and at or below zero. "Tracked" is the whole safety
 * of this: an ingredient with no stock movements at all has never been
 * received, counted or consumed, so nobody is keeping its count, and it can
 * never take a dish off the menu. Otherwise "we have not started counting
 * flour" and "we are out of flour" would be the same sentence, and the wrong
 * one would win — which, in a restaurant that has not opened yet, would be
 * every dish on the menu.
 *
 * Returns ids. Whether the till marks them or hides them is
 * `store_settings.stock_gate`, and the default is to do neither.
 */
export const getOutOfStockDishes = async () => {
    const [recipeLines, subLines, onHand] = await Promise.all([
        query('SELECT menu_item_id, inventory_item_id, qty FROM recipe_lines'),
        query('SELECT parent_item_id, component_item_id, qty FROM sub_recipe_lines'),
        query('SELECT inventory_item_id, SUM(delta) AS qty FROM stock_ledger GROUP BY inventory_item_id'),
    ]);
    if (recipeLines.length === 0 || onHand.length === 0) return [];

    const { indexSubRecipes, expandToRaw } = await import('../inventory/subrecipe.mjs');
    const subMap = indexSubRecipes(subLines);
    // Only ingredients the ledger has ever heard of, and of those, the ones at
    // or below zero.
    const empty = new Set(
        onHand.filter((r) => Number(r.qty) <= 0).map((r) => Number(r.inventory_item_id)),
    );
    if (empty.size === 0) return [];

    const out = new Set();
    const byDish = new Map();
    for (const l of recipeLines) {
        if (!byDish.has(l.menu_item_id)) byDish.set(l.menu_item_id, []);
        byDish.get(l.menu_item_id).push({ itemId: Number(l.inventory_item_id), qty: Number(l.qty) });
    }
    for (const [dish, lines] of byDish) {
        // Expanded, so a dish is out when the masala's chilli is out even
        // though no tub of masala was ever on a shelf.
        for (const raw of expandToRaw(lines, subMap)) {
            if (empty.has(raw.itemId)) { out.add(dish); break; }
        }
    }
    return [...out];
};

/*
 * The deals on offer, with their dishes. Read with the menu because that is
 * what a deal is — a way of selling the menu — and the till needs both in the
 * same breath to price one.
 *
 * Only active deals, and only lines whose dish is still on the menu: a deal
 * quietly missing a component would ring up short and nobody would know why.
 */
export const getDeals = async () => {
    const deals = await query(
        `SELECT id, name, description, price, order_types, sort_order
           FROM deals WHERE is_active = 1 ORDER BY sort_order, name`,
    );
    if (deals.length === 0) return [];
    const lines = await query(
        `SELECT dl.deal_id, dl.menu_item_id, dl.variant_name, dl.qty
           FROM deal_lines dl
           JOIN menu_items m ON m.id = dl.menu_item_id AND m.is_archived = 0
          WHERE dl.deal_id IN (?)
          ORDER BY dl.id`,
        [deals.map((d) => d.id)],
    );
    return deals.map((d) => ({
        ...d,
        price: Number(d.price),
        lines: lines.filter((l) => l.deal_id === d.id),
    }));
};

export const findCustomerByPhone = async (phone) => {
    if (!phone) return null;
    const rows = await query('SELECT * FROM customers WHERE phone = ?', [phone]);
    return rows.length ? serializeRow('customers', rows[0]) : null;
};

/*
 * Best-effort customer book-keeping after a sale commits. Never throws — a
 * failure here must not surface on a till that already took the money.
 */
export const recordCustomer = async ({ name, phone, address, total }) => {
    if (!phone) return;
    try {
        const existing = await query('SELECT id FROM customers WHERE phone = ?', [phone]);
        if (existing.length > 0) {
            await pool.query(
                `UPDATE customers SET
                   name = COALESCE(NULLIF(?, ''), name),
                   address = COALESCE(NULLIF(?, ''), address),
                   total_orders = total_orders + 1,
                   total_spent = total_spent + ?,
                   updated_at = UTC_TIMESTAMP(3)
                 WHERE id = ?`,
                [name || '', address || '', Number(total) || 0, existing[0].id],
            );
        } else {
            await pool.query(
                `INSERT INTO customers (id, name, phone, address, total_orders, total_spent)
                 VALUES (?, ?, ?, ?, 1, ?)`,
                [randomUUID(), name || 'Walk-in', phone, address || null, Number(total) || 0],
            );
        }
    } catch (e) {
        console.error('recordCustomer failed (non-fatal):', e.message);
    }
};

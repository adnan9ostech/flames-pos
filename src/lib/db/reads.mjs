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
} = {}) => {
    const where = [];
    const params = [];

    // One box searches receipt number, name, phone, and table. Escape the
    // LIKE wildcards so a literal % in the term stays literal.
    const term = String(search).trim().replace(/[,()*%\\_]/g, '');
    if (term) {
        const like = `%${term}%`;
        where.push(`(order_number LIKE ? OR customer_name LIKE ?
                     OR customer_phone LIKE ? OR table_number LIKE ?)`);
        params.push(like, like, like, like);
    }

    if (status === 'unpaid') {
        // An open tab can be at any kitchen stage, including served, and
        // still owe money.
        where.push(`payment_status = 'unpaid' AND status <> 'cancelled'`);
    } else if (status !== 'all') {
        where.push('status = ?');
        params.push(status);
    }
    if (orderType !== 'all') { where.push('order_type = ?'); params.push(orderType); }
    if (from) { where.push('created_at >= ?'); params.push(new Date(from)); }
    if (to) { where.push('created_at <= ?'); params.push(new Date(to)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [column, dir] = PAGE_SORTS[sort] || PAGE_SORTS.newest;
    // Tie-break on id so equal values can't shuffle rows between pages.
    const orderSql = column === 'created_at'
        ? `ORDER BY created_at ${dir}, id ASC`
        : `ORDER BY total ${dir}, created_at DESC, id ASC`;

    const countRows = await query(`SELECT COUNT(*) AS n FROM orders ${whereSql}`, params);
    const rows = await query(
        `SELECT * FROM orders ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
        [...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)],
    );
    return { rows: serializeRows('orders', rows), total: countRows[0].n };
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

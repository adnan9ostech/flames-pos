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
/*
 * The menu, as this branch sells it.
 *
 * One menu for the company, with the DIFFERENCES held per branch: a dish that
 * is off here, or costs more here. Everything else comes through untouched,
 * which is the point — a dish priced once stays priced once, and nobody has to
 * keep three menus in step.
 *
 * The override is applied in SQL rather than after the fact so that
 * "unavailable here" and "unavailable everywhere" arrive as the same field and
 * the till needs to know nothing about branches at all.
 */
/*
 * The menu as one outlet sells it.
 *
 * The branch's exceptions are laid over the company menu — and they reach the
 * SIZES too, which they did not until now. The overlay used to be a single
 * COALESCE on the base price, so a sized dish showed its branch price on the
 * card and rang the company price on the bill: the customer was quoted one
 * number and charged another, at the very outlet that had set the other
 * number. 44 of this menu's 137 dishes are sized, and they are the expensive
 * ones.
 *
 * Merged in JS rather than in SQL because the sizes live in a JSON column and
 * rewriting one element of a JSON array per row in SQL is unreadable for no
 * gain — this is one extra query over a table that holds only the differences.
 *
 * A row with variant_name = '' overrides the dish's own price; a row naming a
 * size overrides that size. `is_available = 0` on ANY of a dish's rows takes
 * the whole dish off this branch's till, which is the honest reading: a branch
 * that has switched a dish off has switched it off.
 */
export const getMenuItems = async (branchId = 1) => {
    const [dishes, overrides] = await Promise.all([
        query(
            `SELECT * FROM menu_items WHERE is_archived = 0 ORDER BY sort_order, name`,
        ),
        query(
            `SELECT menu_item_id, variant_name, price, is_available
               FROM branch_menu_items WHERE branch_id = ?`,
            [branchId],
        ),
    ]);

    const byDish = new Map();
    for (const o of overrides) {
        if (!byDish.has(o.menu_item_id)) byDish.set(o.menu_item_id, []);
        byDish.get(o.menu_item_id).push(o);
    }

    return serializeRows('menu_items', dishes.map((m) => {
        const rows = byDish.get(m.id);
        if (!rows) return m;

        const base = rows.find((r) => r.variant_name === '');
        const bySize = new Map(rows.filter((r) => r.variant_name !== '').map((r) => [r.variant_name, r]));

        const variants = Array.isArray(m.variants) ? m.variants.map((v) => {
            const o = bySize.get(v?.name);
            return o && o.price != null ? { ...v, price: Number(o.price) } : v;
        }) : m.variants;

        return {
            ...m,
            price: base?.price != null ? Number(base.price) : m.price,
            variants,
            is_available: rows.some((r) => r.is_available === 0) ? 0 : m.is_available,
        };
    }));
};

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
/*
 * How long a ticket stays on the board.
 *
 * Nothing in this app ever clears a live ticket by itself: bumpOrder is the
 * only path out of 'new'/'preparing'/'ready', and it needs somebody to press
 * it. So a ticket nobody bumps sits there for good, and the query that draws
 * the board grows without bound. It is not hypothetical — the development
 * database has eight live tickets right now and every one is over a day old,
 * the oldest from nine days back.
 *
 * Twenty-four hours is the honest line: food fired yesterday is not being
 * cooked. The older ones are COUNTED rather than dropped (see
 * getStaleKitchenCount) — silently retiring them would turn today's visible
 * clutter into an invisible backlog, which is a worse trade than the clutter.
 *
 * NOT a business_date filter, which was the obvious candidate and is a nightly
 * outage. This restaurant's open business day is whatever Day Close last left
 * open — currently twelve days behind the calendar — and where business_days is
 * empty the open day falls back to the Karachi CALENDAR day, which rolls at
 * midnight with nobody touching anything. Either way a ticket fired at 11:40pm
 * and still cooking at 00:01 would vanish off the screen while the food was on
 * the stove. Two independent measurements put the board at 22 tickets before a
 * Day Close and 1 after it.
 */
const KITCHEN_WINDOW_HOURS = 24;

/*
 * The NULL arm is load-bearing: last_round_at is nullable, so without it a
 * ticket that has one would be hidden from the kitchen entirely — the exact
 * failure this window exists to avoid.
 */
const KITCHEN_LIVE = `status IN (?)
           AND (last_round_at IS NULL
                OR last_round_at >= UTC_TIMESTAMP(3) - INTERVAL ? HOUR)`;

export const getKitchenOrders = async (branchId = 1) =>
    serializeRows('orders', await query(
        `SELECT ${KITCHEN_COLUMNS} FROM orders
         WHERE branch_id = ? AND ${KITCHEN_LIVE}
         ORDER BY last_round_at ASC`,
        [branchId, KITCHEN_STATUSES, KITCHEN_WINDOW_HOURS],
    ));

/*
 * Live tickets too old for the board. Reported so the kitchen display can say
 * "9 older tickets" instead of quietly forgetting them — a stale ticket is
 * usually a bill somebody never closed, which is a real thing to go and look
 * at, not noise to bury.
 */
export const getStaleKitchenCount = async (branchId = 1) => {
    const rows = await query(
        `SELECT COUNT(*) AS n FROM orders
          WHERE branch_id = ? AND status IN (?)
            AND last_round_at IS NOT NULL
            AND last_round_at < UTC_TIMESTAMP(3) - INTERVAL ? HOUR`,
        [branchId, KITCHEN_STATUSES, KITCHEN_WINDOW_HOURS],
    );
    return Number(rows[0].n) || 0;
};

export const getOpenTabs = async (branchId = 1) =>
    serializeRows('orders', await query(
        `SELECT * FROM orders
         WHERE branch_id = ? AND payment_status = 'unpaid' AND status <> 'cancelled'
         ORDER BY created_at ASC`,
        [branchId],
    ));

/*
 * The unpaid badge, polled on the same timer. Left counting the whole set on
 * purpose: open tabs are a small number that does not grow with history — a
 * restaurant with two hundred unsettled bills has a different problem — and
 * migration 052 gives it (branch_id, payment_status, status) so one outlet's
 * badge does not walk the other's orders.
 */
export const getUnpaidOrdersCount = async (branchId = 1) => {
    const rows = await query(
        `SELECT COUNT(*) AS n FROM orders
         WHERE branch_id = ? AND payment_status = 'unpaid' AND status <> 'cancelled'`,
        [branchId],
    );
    return rows[0].n;
};

export const getOrderById = async (orderId) => {
    const rows = await query('SELECT * FROM orders WHERE id = ?', [orderId]);
    return rows.length ? serializeRow('orders', rows[0]) : null;
};

/* What the polling hook watches: any insert or update to orders moves this. */
/*
 * "Has anything changed?" — the cheapest question in the app, asked most often.
 *
 * Every screen polls this every four seconds and only runs its expensive read
 * when the answer differs. Two things were wrong with the old one.
 *
 * IT WAS O(EVERY ORDER EVER TAKEN). `COUNT(*) ... WHERE branch_id = ?` has to
 * walk the branch's whole history to answer, so the cheap pre-check grew
 * without bound while the read it protects stayed the same size. Measured on a
 * 20,000-order copy: 9,901 rows examined, 0.750 ms average, 13.3 ms at worst,
 * four seconds apart, per screen. Bounded to a recent window it is 110 rows and
 * 0.015 ms — fifty times cheaper, and it stops growing.
 *
 * A WINDOW IS ENOUGH because of what the token is for. `updated_at` carries
 * ON UPDATE CURRENT_TIMESTAMP, so every insert and every edit lands inside the
 * window by definition; a row that has not changed in two days cannot be the
 * change we are looking for. Ageing out of the window moves the token once,
 * costing one spurious refetch on a quiet morning, and `latest` only ever moves
 * forward while anything is happening.
 *
 * AND A FUTURE TIMESTAMP USED TO BLIND EVERY SCREEN. `MAX(updated_at)` over the
 * whole table means one row dated 2030 — a clock skew, a hand-edited row, a
 * timezone slip — pins the maximum for four years. Proven: with such a row
 * present, moving a ticket from preparing to ready left the token byte for byte
 * identical, so the kitchen display and the till would never learn of any
 * status change again. Only an INSERT, which moves the count, would break the
 * spell. The upper bound excludes those rows, so the token cannot be pinned.
 *
 * Two days rather than one: this restaurant trades past midnight, and its
 * business day only advances when somebody runs Day Close — the open day is
 * routinely several days behind the calendar.
 */
const VERSION_WINDOW_DAYS = 2;

export const getOrdersVersion = async (branchId = 1) => {
    const rows = await query(
        `SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM orders
          WHERE branch_id = ?
            AND updated_at > UTC_TIMESTAMP(3) - INTERVAL ? DAY
            AND updated_at <= UTC_TIMESTAMP(3)`,
        [branchId, VERSION_WINDOW_DAYS],
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
    channel = 'all', paymentMode = 'all', branchId = 1,
} = {}) => {
    // First and unconditional: a screen must never show another outlet's
    // takings, whatever the rest of the filter says.
    const where = ['o.branch_id = ?'];
    const params = [branchId];

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
 * The brand this deployment wears.
 *
 * One vhost and one database per restaurant, so a deployment IS a brand: the
 * name, the logos and the one colour everything else is derived from. Blank
 * fields are not a problem to solve here — a missing logo draws the name as
 * text, and a missing colour leaves the built-in palette exactly as it is.
 */
export const getBrand = async () => {
    try {
        const rows = await query(
            `SELECT brand_name, brand_logo_light, brand_logo_dark, brand_colour,
                    brand_tagline, merchant_name
               FROM store_settings LIMIT 1`,
        );
        const r = rows[0] ?? {};
        return {
            name: r.brand_name || r.merchant_name || 'POS',
            logoLight: r.brand_logo_light || '',
            logoDark: r.brand_logo_dark || '',
            colour: r.brand_colour || '',
            tagline: r.brand_tagline || '',
        };
    } catch {
        // A database blip must cost the shell a name, not the whole page.
        return { name: 'POS', logoLight: '', logoDark: '', colour: '', tagline: '' };
    }
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

    const { indexSubRecipes, expandToRaw, loadYields } = await import('../inventory/subrecipe.mjs');
    const subMap = indexSubRecipes(subLines);
    const yields = await loadYields();
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
        for (const raw of expandToRaw(lines, subMap, yields)) {
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

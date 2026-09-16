/*
 * The order verbs — the only code that writes orders, rounds, items,
 * payments, or the invoice counter. A straight port of the plpgsql RPCs
 * (supabase migration 17, now retired): one transaction under one row lock
 * per verb, totals recomputed server-side every time, idempotency through
 * client_request_id, and the client's displayed total accepted only as a
 * cross-check.
 *
 * Two things are contracts, not style:
 *
 *   1. Error message strings. The till string-matches and displays them
 *      (`Total mismatch…`, `…already been settled.`), and the tests assert
 *      them. Change one and a screen breaks silently.
 *
 *   2. Money math. `calcTotals` here is the SAME module the till imports —
 *      not a mirror of it, the thing itself — so the two sides cannot drift.
 *      Tax is resolved by payment method at settle (ICT taxes card and cash
 *      differently); an unsettled order displays at the cash rate.
 */
import { randomUUID } from 'node:crypto';
import { pool, withTransaction, query } from './pool.mjs';
import { serializeRow } from './serialize.mjs';
import { calcTotals } from '../orderTotals.mjs';
import { taxRatesFor } from './branchSettings.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * The outlet this request is acting on, asked for lazily — the same pattern
 * openDay.mjs and db/audit.mjs use, and for the same reason: resolving it
 * reads a cookie, which needs next/headers, which does not exist in the plain
 * Node the suite and the FBR worker run this module under.
 */
const requestBranchId = async () => {
    try {
        const { currentBranchId } = await import('./branch.mjs');
        return await currentBranchId();
    } catch {
        return 1;
    }
};

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = (d = new Date()) =>
    d.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

/*
 * The trading day an order belongs to: the open business day if day-close is
 * in use (Phase F), else the Karachi calendar day. Never NULL.
 */
const resolveBusinessDate = async (conn, branchId) => {
    const [rows] = await conn.query(
        `SELECT business_date FROM business_days
         WHERE branch_id = ? AND closed_at IS NULL
         ORDER BY business_date DESC LIMIT 1`,
        [branchId],
    );
    if (rows.length === 0) return karachiDay();
    const d = rows[0].business_date;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
};

/*
 * How far the grand total is rounded down, in rupees. 0 is off, and off is the
 * default — see migration 035 for why it only ever rounds down.
 *
 * Read here, on the server, and NOT taken from the till: the till's own copy
 * is for showing the customer a number, and if the two ever disagreed the
 * expected-total check would refuse the sale. The server's answer is the one
 * that counts, and this is where it comes from.
 */
const getRoundingStep = async (conn) => {
    const [rows] = await conn.query('SELECT round_total FROM store_settings LIMIT 1');
    const mode = rows[0]?.round_total;
    return mode === '1' ? 1 : mode === '5' ? 5 : 0;
};

/*
 * The rates THIS OUTLET charges. A branch in Lahore answers to the Punjab
 * Revenue Authority and one in Islamabad to the FBR, at different percentages,
 * so the rate is a property of where the bill was rung — not of the company.
 * Outlets that have not departed from the company rate have no override row
 * and get the company's answer, which is every outlet today.
 */
const getTaxRates = (conn, branchId) => taxRatesFor(conn, branchId);

/* The rate a given payment method carries; anything unknown prices as cash
 * (a city-ledger credit sale taxes at the standard rate). */
const rateForMethod = (rates, method) => (method === 'card' ? rates.card : rates.cash);

/*
 * The auto-applied charges this order type carries (service charge on
 * dine-in, delivery fee on delivery). Empty order_types means every type.
 * The till loads the same list, so its expected total already includes them.
 */
const activeChargesFor = async (conn, orderType) => {
    const [rows] = await conn.query(
        'SELECT name, value_type, value, order_types, before_tax FROM charges WHERE is_active = 1 AND auto_apply = 1',
    );
    return rows.filter((c) => {
        const types = Array.isArray(c.order_types) ? c.order_types : [];
        return types.length === 0 || types.includes(orderType);
    });
};

const fetchOrder = async (conn, orderId, { forUpdate = false } = {}) => {
    const [rows] = await conn.query(
        `SELECT * FROM orders WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
        [orderId],
    );
    return rows[0] ?? null;
};

/*
 * The trail, with the hands on it.
 *
 * `staff_id` was never written from here, so every ring, every settle and
 * every void in the system was anonymous: 199 create_order rows and 159
 * settle_order rows with no actor, while remove_item — which threads its
 * approver through — had one on all five of its. The column existed and the
 * money paths were the ones not using it, which is the wrong way round. A
 * restaurant's audit trail earns its keep on exactly these rows: the drawer
 * is short and somebody has to be able to ask who was on the till.
 *
 * NULL is still legal and still means "no person" — a background posting, a
 * worker, the FBR retry — rather than "we did not bother to look".
 */
const auditLog = async (conn, {
    branchId, businessDate, action, orderId = null, details = null, staffId = null,
}) => {
    await conn.query(
        `INSERT INTO audit_log (branch_id, business_date, action, order_id, staff_id, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [branchId, businessDate, action, orderId, staffId,
            details ? JSON.stringify(details) : null],
    );
};

/*
 * Validates and inserts one round's lines. Create and append share this so
 * the two paths cannot drift. Errors are worded for the till's alert box.
 */
/*
 * WHAT A LINE COSTS. Decided here, from the menu, and nowhere else.
 *
 * This did not exist. `unit_price` was `Number(item.price)` — whatever the
 * browser sent — and the server never looked at the dish it claimed to be.
 * A crafted call rang Mutton White Qorma, menu price Rs 8,995, at Rs 1: the
 * line kept the real menu_item_id, the bill settled at Rs 2, a fiscal invoice
 * was minted and the sale journal posted Rs 2 to the books. Everything
 * downstream agreed with the tampered figure because nothing upstream ever
 * disagreed.
 *
 * So the price is now COMPUTED, using exactly the formula the till displays
 * (see ModifierModal.calculateTotal): the chosen size's price, or the dish's
 * price when no size is chosen, plus the price of every chosen modifier
 * option. The client's `price` is ignored entirely — not compared, ignored.
 * The till's number is still checked, but by `expectedTotal`, which is what
 * that mechanism is for: it catches a STALE SCREEN and says "reload", which
 * is a true and useful thing to tell a cashier. It was never an authority.
 *
 * A line must name a dish that is on the menu. Refusing an unknown one is
 * safe: the cart spreads a real menu item, so every genuine line carries its
 * uuid — of 164 order lines rung before this change, exactly one lacked an
 * id, and that one predates the MySQL migration.
 *
 * The branch price applies to the DISH's price, the same COALESCE the till
 * was served by getMenuItems, so the two agree. It does NOT reach a size's
 * own price: branch_menu_items has one price column and no size dimension,
 * which is a real gap in that feature and is fixed separately — what matters
 * here is that the server charges what the till showed.
 */
const pricedLines = async (conn, items, branchId) => {
    const ids = [...new Set(
        items.map((i) => String(i.id ?? '')).filter((id) => UUID_RE.test(id)),
    )];

    const [dishes] = ids.length === 0 ? [[]] : await conn.query(
        `SELECT m.id, m.name, m.variants, m.price
           FROM menu_items m
          WHERE m.id IN (?) AND m.is_archived = 0`,
        [ids],
    );
    const byId = new Map(dishes.map((d) => [d.id, d]));

    /*
     * This branch's exceptions, keyed (dish, size). A row with variant_name ''
     * overrides the dish's own price; a row naming a size overrides that size.
     *
     * The join this replaced could only reach the base price, so a sized dish
     * — 44 of 137 here, and the expensive ones — ignored its branch price
     * entirely: the tile showed a range built from the sizes and the bill rang
     * the chosen size, and neither ever looked at the override. The same
     * lookup now serves getMenuItems, so the card and the bill cannot part.
     */
    const [overrides] = ids.length === 0 ? [[]] : await conn.query(
        `SELECT menu_item_id, variant_name, price FROM branch_menu_items
          WHERE branch_id = ? AND menu_item_id IN (?)`,
        [branchId, ids],
    );
    const branchPrice = new Map(
        overrides.filter((o) => o.price != null).map((o) => [`${o.menu_item_id}|${o.variant_name}`, Number(o.price)]),
    );

    // Option prices come from the modifier definitions, never from the
    // option objects the browser echoes back. One small table, read once.
    const [mods] = await conn.query('SELECT id, options FROM modifiers');
    const optionPrice = new Map();
    for (const m of mods) {
        const options = Array.isArray(m.options) ? m.options : [];
        for (const o of options) optionPrice.set(`${m.id}|${o?.name}`, Number(o?.price) || 0);
    }

    return items.map((i) => {
        const dish = byId.get(String(i.id ?? ''));
        if (!dish) {
            throw new Error(`"${i.name}" is not on the menu — reload the till and ring it again`);
        }

        const wantedSize = i.selectedVariant?.name ?? null;
        let price = branchPrice.has(`${dish.id}|`) ? branchPrice.get(`${dish.id}|`) : Number(dish.price);
        if (wantedSize != null) {
            const variants = Array.isArray(dish.variants) ? dish.variants : [];
            const size = variants.find((v) => v?.name === wantedSize);
            if (!size) {
                throw new Error(`"${wantedSize}" is no longer a size of ${dish.name} — reload the till`);
            }
            // This branch's price for THIS size, or the size's company price.
            const own = branchPrice.get(`${dish.id}|${wantedSize}`);
            price = own !== undefined ? own : Number(size.price);
        }

        for (const [modifierId, chosen] of Object.entries(i.selectedModifiers || {})) {
            for (const option of (Array.isArray(chosen) ? chosen : [chosen])) {
                if (!option?.name) continue;
                const add = optionPrice.get(`${modifierId}|${option.name}`);
                if (add === undefined) {
                    throw new Error(`"${option.name}" is no longer an option on ${dish.name} — reload the till`);
                }
                price += add;
            }
        }

        // Paise-exact: the column is DECIMAL(10,2) and a float that does not
        // round-trip it makes the till's total disagree with the server's.
        return { ...i, menuItemId: dish.id, price: Math.round(price * 100) / 100 };
    });
};

const insertRoundItems = async (conn, { orderId, roundId, roundNo, branchId, items }) => {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('A round needs at least one item');
    }
    for (const item of items) {
        if (!item?.name || String(item.name).trim() === '') {
            throw new Error('Every line needs an item name');
        }
        if (!(Number(item.qty) >= 1)) {
            throw new Error(`Quantity must be at least 1 on "${item.name}"`);
        }
        /*
         * The claimed price no longer decides anything — pricedLines reads the
         * menu. This check stays because a negative or missing one is still the
         * mark of a malformed or tampered request, and refusing it early costs
         * nothing. The string is one the till matches on, so it is unchanged.
         */
        if (!(Number(item.price) >= 0)) {
            throw new Error(`Price missing or negative on "${item.name}"`);
        }
    }

    const lines = await pricedLines(conn, items, branchId);

    const values = lines.map((i) => {
        return [
            randomUUID(), orderId, roundId, branchId, roundNo,
            i.menuItemId,
            i.name,
            i.selectedVariant?.name ?? null,
            i.selectedModifiers != null ? JSON.stringify(i.selectedModifiers) : null,
            Number(i.price),
            Number(i.qty),
            i.notes ? String(i.notes) : null,
        ];
    });
    await conn.query(
        `INSERT INTO order_items
           (id, order_id, round_id, branch_id, round_no, menu_item_id,
            name, variant, modifiers, unit_price, qty, notes)
         VALUES ?`,
        [values],
    );
    return values.length;
};

/*
 * The one place money math lives on the server, plus the JSON snapshot the
 * KDS and receipts read — rebuilt from the lines so the two can never
 * disagree. Lines are ordered (round_no, seq): the order food was rung in.
 */
const recomputeOrder = async (conn, orderId, { taxRate }) => {
    const order = await fetchOrder(conn, orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const [lines] = await conn.query(
        `SELECT menu_item_id, name, variant, modifiers, unit_price, qty, round_no, notes
         FROM order_items WHERE order_id = ? ORDER BY round_no, seq`,
        [orderId],
    );

    const totals = calcTotals(
        lines.map((l) => ({ price: Number(l.unit_price), qty: l.qty })),
        Boolean(order.include_tax),
        {
            taxRate,
            discount: Number(order.discount) || 0,
            charges: await activeChargesFor(conn, order.order_type),
            roundTo: await getRoundingStep(conn),
        },
    );

    // jsonb_strip_nulls semantics: a key whose value is null is omitted.
    const snapshot = lines.map((l) => {
        const entry = {
            id: l.menu_item_id ?? undefined,
            name: l.name,
            price: Number(l.unit_price),
            qty: l.qty,
            round: l.round_no,
            selectedVariant: l.variant != null ? { name: l.variant } : undefined,
            selectedModifiers: l.modifiers ?? undefined,
            notes: l.notes ?? undefined,
        };
        for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
        return entry;
    });

    await conn.query(
        `UPDATE orders SET
           items = ?, subtotal = ?, discount = ?, charges = ?, charges_total = ?,
           tax = ?, rounding = ?, total = ?,
           updated_at = UTC_TIMESTAMP(3)
         WHERE id = ?`,
        [
            JSON.stringify(snapshot), totals.subtotal, totals.discount,
            JSON.stringify(totals.charges), totals.chargesTotal,
            totals.tax, totals.rounding ?? 0, totals.total, orderId,
        ],
    );
    return fetchOrder(conn, orderId);
};

const isDuplicateKey = (e) => e && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY');

/*
 * Thrown inside a transaction when a concurrent twin already inserted our
 * client_request_id. The twin's row CANNOT be read from inside the losing
 * transaction: under REPEATABLE READ its consistent-read snapshot predates
 * the winner's commit, so a plain re-select sees nothing (the bug the race
 * suite caught). The recovery read happens outside, on a fresh snapshot.
 */
class TwinExists extends Error {
    constructor() { super('twin exists'); this.name = 'TwinExists'; }
}

/*
 * Settle inside an existing transaction — create_order's pay-now path calls
 * this on its own uncommitted row (the FOR UPDATE is then a self-lock).
 */
const settleOrderTx = async (conn, orderId, {
    userId = null,
    method = 'cash', discount = null, discountReason = null,
    includeTax = null, expectedTotal = null, clientRequestId = null,
    companyId = null, cashReceived = null, cardReference = null,
} = {}) => {
    if (!['cash', 'card', 'city_ledger'].includes(method)) {
        throw new Error(`Unknown payment method ${method}`);
    }

    // A city-ledger settle is a credit sale charged to a company account —
    // the bill closes, the money arrives later through a receipt.
    if (method === 'city_ledger') {
        if (!companyId) throw new Error('A city-ledger bill needs a company');
        const [companies] = await conn.query(
            'SELECT is_active FROM companies WHERE id = ?', [companyId],
        );
        if (companies.length === 0) throw new Error('A city-ledger bill needs a company');
        if (!companies[0].is_active) throw new Error('That company account is inactive');
    }

    // The lock: of two terminals settling the same tab, one wins and the
    // other learns the truth instead of both charging the customer.
    let order = await fetchOrder(conn, orderId, { forUpdate: true });
    if (!order) throw new Error(`Order ${orderId} not found`);
    if (order.status === 'cancelled') throw new Error('This order was voided.');

    if (order.payment_status === 'paid') {
        // A replay of the settle that already succeeded is a success; a
        // second, distinct attempt is the double-charge this refuses.
        if (clientRequestId) {
            const [rows] = await conn.query(
                'SELECT 1 FROM payments WHERE order_id = ? AND client_request_id = ? LIMIT 1',
                [orderId, clientRequestId],
            );
            if (rows.length > 0) return order;
        }
        throw new Error('This bill has already been settled.');
    }

    const effectiveDiscount = discount ?? Number(order.discount) ?? 0;
    await conn.query(
        `UPDATE orders SET
           include_tax = ?,
           discount = ?,
           discount_reason = ?
         WHERE id = ?`,
        [
            includeTax ?? Boolean(order.include_tax),
            effectiveDiscount,
            effectiveDiscount > 0 ? (discountReason ?? order.discount_reason) : null,
            orderId,
        ],
    );

    // Tax at the rate this payment method carries — the ICT differential.
    // The rate is stamped on the row below, next to the method, so the
    // ledger and the tax report can say which rate produced `tax`.
    const rates = await getTaxRates(conn, order.branch_id);
    const taxRate = rateForMethod(rates, method);
    order = await recomputeOrder(conn, orderId, { taxRate });

    if (expectedTotal != null && Number(expectedTotal) !== Number(order.total)) {
        throw new Error(
            `Total mismatch: till shows ${expectedTotal}, server computed ${order.total} — reload before settling`,
        );
    }

    // Sequential invoice number per branch per business day, assigned exactly
    // once — a bill that already carries one keeps it, so a reprint is the
    // same document forever. The upsert X-locks the counter row until commit,
    // which is what serializes two same-moment settles on different orders.
    const businessDate = await resolveBusinessDate(conn, order.branch_id);
    if (order.invoice_number == null) {
        await conn.query(
            `INSERT INTO invoice_counters (branch_id, day, last_no) VALUES (?, ?, 1)
             ON DUPLICATE KEY UPDATE last_no = last_no + 1`,
            [order.branch_id, businessDate],
        );
        const [[{ last_no }]] = await conn.query(
            'SELECT last_no FROM invoice_counters WHERE branch_id = ? AND day = ?',
            [order.branch_id, businessDate],
        );
        const yymmdd = businessDate.slice(2).replaceAll('-', '');
        await conn.query(
            'UPDATE orders SET invoice_number = ? WHERE id = ?',
            [`FBR-${yymmdd}-${String(last_no).padStart(4, '0')}`, orderId],
        );
    }

    /*
     * The card slip's number, when this was a card sale. Kept against the
     * payment rather than the order: it is a fact about the tender, and the
     * store can insist on it so the terminal's batch can be reconciled at
     * close without matching slips to bills by amount and time.
     */
    let reference = null;
    if (method === 'card') {
        reference = String(cardReference ?? '').trim().slice(0, 32) || null;
        const [[cfg] = []] = await conn.query('SELECT card_ref_required FROM store_settings LIMIT 1');
        if (cfg?.card_ref_required && !reference) {
            throw new Error('This card sale needs the reference from the terminal slip');
        }
    }

    /*
     * A payment row records money that MOVED — which is why the column carries
     * CHECK (amount <> 0), and why a void writes a negative row rather than
     * deleting the original. A bill that comes to nothing (a fully comped
     * table, a 100% discount) moved no money, so there is nothing to record.
     *
     * Writing one anyway is what the settle path used to do, and the constraint
     * refused it — so a comped bill could not be closed at all and the cashier
     * was shown `Check constraint 'payments_amount_chk' is violated`, raw, at
     * the counter. The bill is still marked paid below: the order row, the
     * audit trail and the ledger carry the fact, and the drawer's expected cash
     * is a sum of payments, to which a zero row would have contributed nothing.
     */
    if (Number(order.total) !== 0) {
        await conn.query(
            `INSERT INTO payments (id, order_id, branch_id, method, amount, client_request_id, company_id, reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), orderId, order.branch_id, method, order.total, clientRequestId,
             method === 'city_ledger' ? companyId : null, reference],
        );
    }

    /*
     * The cash tender, when the till took one. Both halves or neither: a card
     * or city-ledger bill has no change, and storing zero there would be a
     * claim rather than an absence.
     *
     * Refused rather than clamped when it does not cover the bill. A cashier
     * who types 500 for a 5,000 bill has mistyped, and quietly recording a
     * 4,500 shortfall as "no change" would leave the drawer short at close
     * with nothing in the record to explain it.
     */
    let tendered = null;
    let change = null;
    if (method === 'cash' && cashReceived != null && cashReceived !== '') {
        tendered = Math.round(Number(cashReceived) * 100) / 100;
        if (!Number.isFinite(tendered)) throw new Error('Cash received is not a number');
        if (tendered < Number(order.total)) {
            throw new Error(`Cash received ${tendered} is less than the bill ${order.total}`);
        }
        change = Math.round((tendered - Number(order.total)) * 100) / 100;
    }

    await conn.query(
        `UPDATE orders SET
           payment_status = 'paid',
           payment_mode = ?,
           tax_rate = ?,
           cash_received = ?,
           change_due = ?,
           paid_at = UTC_TIMESTAMP(3),
           status = CASE WHEN status = 'ready' THEN 'completed' ELSE status END,
           updated_at = UTC_TIMESTAMP(3)
         WHERE id = ?`,
        [method, taxRate, tendered, change, orderId],
    );
    order = await fetchOrder(conn, orderId);

    await auditLog(conn, {
        branchId: order.branch_id,
        businessDate,
        action: 'settle_order',
        orderId,
        staffId: userId,
        details: { method, total: Number(order.total), invoice: order.invoice_number },
    });

    return order;
};

export const settleOrder = async (orderId, opts = {}) =>
    serializeRow('orders', await withTransaction((conn) => settleOrderTx(conn, orderId, opts)));

/*
 * One call: order row, round 1, its lines, recomputed totals — and for a
 * pay-at-counter sale, the payment and invoice number too, all or nothing.
 */
export const createOrder = async (items, opts = {}, clientRequestId = null, expectedTotal = null) => {
    // Idempotent replay: the same attempt returns the order it already made,
    // indistinguishable from the first success. The duplicate-key catch below
    // covers what this pre-check can't: two identical attempts in flight at
    // once (a double-tap under latency).
    if (clientRequestId) {
        const rows = await query('SELECT * FROM orders WHERE client_request_id = ?', [clientRequestId]);
        if (rows.length > 0) return serializeRow('orders', rows[0]);
    }

    const payNow = (opts.payment_status ?? 'paid') === 'paid';
    const orderId = randomUUID();

    let row;
    try {
        row = await createOrderTx(orderId, items, opts, clientRequestId, expectedTotal, payNow);
    } catch (e) {
        if (e instanceof TwinExists) {
            // Fresh pool read, fresh snapshot: the winner's commit is visible.
            const rows = await query('SELECT * FROM orders WHERE client_request_id = ?', [clientRequestId]);
            if (rows.length > 0) return serializeRow('orders', rows[0]);
        }
        throw e;
    }
    return serializeRow('orders', row);
};

const createOrderTx = (orderId, items, opts, clientRequestId, expectedTotal, payNow) =>
    withTransaction(async (conn) => {
        /*
         * Passed in, never decided here. Which outlet a sale belongs to is a
         * fact about the request (who is signed in, which branch they picked),
         * and this module deliberately knows nothing about requests — which is
         * also what lets the suite drive it directly. 1 is the single-outlet
         * answer and the one every existing row already carries.
         */
        const branchId = Number(opts.branch_id) || 1;
        const businessDate = await resolveBusinessDate(conn, branchId);
        try {
            await conn.query(
                `INSERT INTO orders
                   (id, order_number, items, subtotal, tax, total, status, payment_status,
                    order_type, include_tax, discount, discount_reason,
                    table_number, waiter_id, waiter_name,
                    customer_name, customer_phone, customer_address,
                    round_count, last_round_at, client_request_id, branch_id, business_date,
                    created_at, updated_at)
                 VALUES (?, ?, '[]', 0, 0, 0, 'new', 'unpaid',
                         ?, ?, ?, ?,
                         ?, ?, ?,
                         ?, ?, ?,
                         1, UTC_TIMESTAMP(3), ?, ?, ?,
                         UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
                [
                    orderId,
                    opts.order_number || String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
                    opts.order_type || 'dine-in',
                    opts.include_tax ?? true,
                    Number(opts.discount) || 0,
                    opts.discount_reason || null,
                    opts.table_number || null,
                    opts.waiter_id || null,
                    opts.waiter_name || null,
                    opts.customer_name || null,
                    opts.customer_phone || null,
                    opts.customer_address || null,
                    clientRequestId, branchId, businessDate,
                ],
            );
        } catch (e) {
            // Lost the race to our own twin: the other attempt's order is the
            // order. Anything else is a real error.
            if (isDuplicateKey(e) && clientRequestId) throw new TwinExists();
            throw e;
        }

        /*
         * The token, where the store calls them and the customer is waiting.
         *
         * Takeaway and delivery only: a dine-in bill already has a table, and
         * two names for one bill on one slip helps nobody. Minted here rather
         * than at settle because the customer is handed it when they order,
         * not when they pay — and an open takeaway tab must carry the same
         * number the counter will shout.
         *
         * Same counter shape as the invoice number: the upsert X-locks the
         * row until commit, so two tills ringing at the same moment queue
         * instead of both taking 12.
         */
        /*
         * Where the order came from. The till sends one; a caller that does
         * not (an older client, a script) gets the default channel rather than
         * NULL, because "nobody said" and "walk-in" are the same thing for a
         * new order — unlike the bills that predate the column, which stay
         * NULL and should.
         */
        const [[channel] = []] = await conn.query(
            // The one asked for if it exists, else the default — the ORDER BY
            // does both. Filtering on the id instead would leave an order with
            // NO channel whenever the till sent one that had since been
            // deleted, which is the opposite of a fallback.
            `SELECT id FROM sales_channels
              WHERE is_active = 1
              ORDER BY (id = ?) DESC, is_default DESC, sort_order, id LIMIT 1`,
            [opts.channel_id ?? null],
        );
        if (channel) {
            await conn.query('UPDATE orders SET channel_id = ? WHERE id = ?', [channel.id, orderId]);
        }

        const orderType = opts.order_type || 'dine-in';
        if (orderType !== 'dine-in') {
            const [[cfg] = []] = await conn.query('SELECT token_mode FROM store_settings LIMIT 1');
            if (cfg?.token_mode === 'auto') {
                await conn.query(
                    `INSERT INTO token_counters (branch_id, day, last_no) VALUES (?, ?, 1)
                     ON DUPLICATE KEY UPDATE last_no = last_no + 1`,
                    [branchId, businessDate],
                );
                const [[{ last_no }]] = await conn.query(
                    'SELECT last_no FROM token_counters WHERE branch_id = ? AND day = ?',
                    [branchId, businessDate],
                );
                await conn.query('UPDATE orders SET token_no = ? WHERE id = ?', [last_no, orderId]);
            }
        }

        const roundId = randomUUID();
        await conn.query(
            `INSERT INTO order_rounds (id, order_id, branch_id, round_no, fired_at, client_request_id)
             VALUES (?, ?, ?, 1, UTC_TIMESTAMP(3), ?)`,
            [roundId, orderId, branchId, clientRequestId],
        );

        await insertRoundItems(conn, { orderId, roundId, roundNo: 1, branchId, items });

        const rates = await getTaxRates(conn, branchId);
        let order = await recomputeOrder(conn, orderId, {
            // A pay-now sale prices at its method's rate from the start; an
            // open tab displays at the cash rate until it is settled.
            taxRate: payNow ? rateForMethod(rates, opts.payment_mode || 'cash') : rates.cash,
        });

        await auditLog(conn, {
            branchId, businessDate, action: 'create_order', orderId, staffId: opts.userId ?? null,
            details: { total: Number(order.total), type: order.order_type },
        });

        if (payNow) {
            // Same-transaction settle; the expected-total check happens there.
            order = await settleOrderTx(conn, orderId, {
                method: opts.payment_mode || 'cash',
                companyId: opts.company_id || null,
                cashReceived: opts.cash_received ?? null,
                cardReference: opts.card_reference ?? null,
                expectedTotal,
                clientRequestId,
            });
        } else if (expectedTotal != null && Number(expectedTotal) !== Number(order.total)) {
            throw new Error(
                `Total mismatch: till shows ${expectedTotal}, server computed ${order.total} — reload and re-ring`,
            );
        }
        return order;
    });

export const appendRound = async (orderId, items, clientRequestId = null, expectedTotal = null, opts = {}) => {
    // Replay of a round that already landed: hand back the order as it is.
    // A timed-out "send round" retried by the cashier must never cook and
    // bill the food twice.
    if (clientRequestId) {
        const rows = await query(
            'SELECT 1 FROM order_rounds WHERE client_request_id = ? LIMIT 1', [clientRequestId],
        );
        if (rows.length > 0) {
            const order = await query('SELECT * FROM orders WHERE id = ?', [orderId]);
            return serializeRow('orders', order[0]);
        }
    }

    const row = await withTransaction(async (conn) => {
        // The lock. Two terminals appending to one tab queue instead of
        // last-write-wins overwriting each other's food.
        const order = await fetchOrder(conn, orderId, { forUpdate: true });
        if (!order) throw new Error(`Order ${orderId} not found`);

        // Re-checked under the lock: a twin of this request that held the
        // lock first has committed its round by the time we get here, and
        // the pre-lock check above ran too early to see it. FOR SHARE, not a
        // plain read — a consistent read here would use this transaction's
        // pre-lock snapshot and miss the twin's commit; a locking read sees
        // latest-committed. (The duplicate-key catch below stays as the belt.)
        if (clientRequestId) {
            const [rows] = await conn.query(
                'SELECT 1 FROM order_rounds WHERE client_request_id = ? LIMIT 1 FOR SHARE',
                [clientRequestId],
            );
            if (rows.length > 0) return order;
        }

        if (order.payment_status === 'paid') throw new Error('This bill has already been settled.');
        if (order.status === 'cancelled') throw new Error('This order was voided.');

        const roundNo = (order.round_count || 1) + 1;
        const roundId = randomUUID();
        try {
            await conn.query(
                `INSERT INTO order_rounds (id, order_id, branch_id, round_no, fired_at, client_request_id)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?)`,
                [roundId, orderId, order.branch_id, roundNo, clientRequestId],
            );
        } catch (e) {
            if (isDuplicateKey(e) && clientRequestId) return order; // twin landed between the checks
            throw e;
        }

        await insertRoundItems(conn, { orderId, roundId, roundNo, branchId: order.branch_id, items });

        // Mid-sitting corrections the floor makes while adding food: table
        // moved, shift changed the waiter, tax toggled. Only these keys are
        // honoured, and only when present — `p_opts ? 'key'` semantics.
        await conn.query(
            `UPDATE orders SET
               round_count = ?,
               last_round_at = UTC_TIMESTAMP(3),
               status = 'new',
               include_tax = ?,
               table_number = ?,
               waiter_id = ?,
               waiter_name = ?
             WHERE id = ?`,
            [
                roundNo,
                opts.include_tax ?? Boolean(order.include_tax),
                'table_number' in opts ? (opts.table_number || null) : order.table_number,
                'waiter_id' in opts ? (opts.waiter_id || null) : order.waiter_id,
                'waiter_name' in opts ? (opts.waiter_name || null) : order.waiter_name,
                orderId,
            ],
        );

        const rates = await getTaxRates(conn, order.branch_id);
        const updated = await recomputeOrder(conn, orderId, { taxRate: rates.cash });

        if (expectedTotal != null && Number(expectedTotal) !== Number(updated.total)) {
            throw new Error(
                `Total mismatch: till shows ${expectedTotal}, server computed ${updated.total} — reload and re-ring`,
            );
        }

        await auditLog(conn, {
            branchId: updated.branch_id,
            businessDate: await resolveBusinessDate(conn, updated.branch_id),
            action: 'append_round',
            orderId,
            staffId: opts.userId ?? null,
            details: { round: roundNo, total: Number(updated.total) },
        });
        return updated;
    });

    return serializeRow('orders', row);
};

/*
 * Void. The caller (the server action) is responsible for the admin gate —
 * this function trusts it, matching how the RPC trusted its caller, but the
 * gate now lives on the server instead of in the browser.
 */
export const voidOrder = async (orderId, reason, by = null, userId = null) => {
    if (!reason || String(reason).trim() === '') throw new Error('A void needs a reason');

    const row = await withTransaction(async (conn) => {
        const order = await fetchOrder(conn, orderId, { forUpdate: true });
        if (!order) throw new Error(`Order ${orderId} not found`);
        if (order.status === 'cancelled') return order; // voiding a void is a no-op, not an error

        // Voiding a paid bill reverses the money in the ledger, so the day's
        // cash math nets to what is actually in the drawer — and a voided
        // city-ledger charge comes off the company's account the same way.
        if (order.payment_status === 'paid' && ['cash', 'card', 'city_ledger'].includes(order.payment_mode)) {
            let companyId = null;
            if (order.payment_mode === 'city_ledger') {
                const [rows] = await conn.query(
                    `SELECT company_id FROM payments
                     WHERE order_id = ? AND method = 'city_ledger' AND amount > 0 LIMIT 1`,
                    [orderId],
                );
                companyId = rows[0]?.company_id ?? null;
            }
            await conn.query(
                `INSERT INTO payments (id, order_id, branch_id, method, amount, company_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [randomUUID(), orderId, order.branch_id, order.payment_mode, -Number(order.total), companyId],
            );
        }

        await conn.query(
            `UPDATE orders SET
               status = 'cancelled',
               cancelled_at = UTC_TIMESTAMP(3),
               cancel_reason = ?,
               cancelled_by = ?,
               updated_at = UTC_TIMESTAMP(3)
             WHERE id = ?`,
            [String(reason).trim(), by ? String(by).trim() || null : null, orderId],
        );
        const updated = await fetchOrder(conn, orderId);

        await auditLog(conn, {
            branchId: updated.branch_id,
            businessDate: await resolveBusinessDate(conn, updated.branch_id),
            action: 'void_order',
            orderId,
            staffId: userId,
            details: {
                reason: updated.cancel_reason,
                by: updated.cancelled_by,
                was_paid: updated.paid_at != null,
                total: Number(updated.total),
            },
        });
        return updated;
    });

    return serializeRow('orders', row);
};

/*
 * Guarded KDS transition. No lock — the WHERE clause is the concurrency
 * control: a stale bump loses to an append_round re-fire instead of parking
 * a ticket with uncooked food in 'ready'. The UPDATE always touches
 * updated_at, so affectedRows 0 reliably means "did not match", never
 * "matched but nothing changed".
 */
export const bumpOrder = async (orderId, from, to) => {
    if (!['preparing', 'ready', 'completed'].includes(to)) {
        throw new Error(`Not a kitchen transition: ${to}`);
    }
    await pool.query(
        /*
         * `status <> 'cancelled'` is not redundant beside `status = ?`. Only the
         * TARGET status was ever validated, so a caller passing from='cancelled'
         * matched a voided row and silently revived it — leaving cancelled_at and
         * cancel_reason populated, the payments netted to zero, and the order back
         * on the board as a live sale. The action gates on requireUser() alone, so
         * any signed-in account could reach it.
         *
         * Deliberately still not an error: this function's contract is that the
         * WHERE clause IS the concurrency control, affectedRows 0 means "did not
         * match", and the caller re-reads the truth below. A bump against a void
         * now matches nothing and the board redraws it as cancelled.
         */
        `UPDATE orders SET status = ?, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND status = ? AND status <> 'cancelled'`,
        [to, orderId, from],
    );
    // Someone else moved it first (or a round re-fired it). Return the truth;
    // the board redraws from it instead of overwriting it.
    const rows = await query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (rows.length === 0) throw new Error(`Order ${orderId} not found`);
    return serializeRow('orders', rows[0]);
};

/*
 * 86 a dish. Any signed-in role — it's a floor act, not an admin one — and
 * audited, because "who took the biryani off at 8pm" is a real question the
 * morning after. Inherits the old menu_item_audit trigger's job too.
 */
export const setItemAvailability = async (itemId, available, userId = null) => {
    /*
     * Resolved BEFORE the transaction opens, deliberately. Working the branch
     * out reads from the pool, and a pool read taken while this transaction is
     * holding one of the pool's five connections is how the whole app wedges:
     * five of these at once and every one waits for a sixth connection that
     * the five of them are holding. withTransaction now refuses rather than
     * waiting forever, but the fix is not to ask in the first place.
     */
    const branchId = await requestBranchId();
    const row = await withTransaction(async (conn) => {
        const [result] = await conn.query(
            'UPDATE menu_items SET is_available = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
            [Boolean(available), itemId],
        );
        if (result.affectedRows === 0) throw new Error('That dish is no longer on the menu');
        const [rows] = await conn.query('SELECT * FROM menu_items WHERE id = ?', [itemId]);
        const item = rows[0];
        await auditLog(conn, {
            branchId,
            businessDate: await resolveBusinessDate(conn, branchId),
            action: 'set_availability',
            staffId: userId,
            details: { menu_item_id: item.id, name: item.name, available: Boolean(available) },
        });
        return item;
    });
    return serializeRow('menu_items', row);
};

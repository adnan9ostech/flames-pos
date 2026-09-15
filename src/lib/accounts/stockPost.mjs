/*
 * The cost side of the stock room, in the ledger.
 *
 * WHAT WAS MISSING, and it was the whole cost half of the books. Receiving
 * booked Dr Inventory / Cr Supplier, so the inventory asset only ever grew.
 * Nothing ever took it back out: a sold dish moved its ingredients on the
 * stock ledger and left the general ledger untouched, so the accounts showed
 * revenue with no cost of sales, a gross margin of one hundred per cent, and
 * an inventory balance that climbed forever. Waste, spoilage and count
 * variances were invisible in the same way.
 *
 * So four events now reach the ledger, all of them Cr Inventory:
 *
 *   sale        Dr Cost of Sales                 what the recipes consumed
 *   waste       Dr Wastage                       food cooked and binned
 *   stock doc   Dr Wastage / Cr Inventory Gain   misc consumption, adjustments,
 *                                                and count variances either way
 *
 * VALUED AT avg_cost AT POSTING TIME, which is moments after the movement:
 * these hooks fire immediately after their document commits, and avg_cost is
 * the moving average the receiving verb maintains. Not perfect period costing,
 * and it does not pretend to be — but it is the same number the Gross Profit
 * report and the stock valuation already use, so the three agree with each
 * other, which is what a restaurant's books actually need.
 *
 * Same posture as every other poster here: idempotent on (source_type,
 * source_id), gated on gl_settings, never throws at its caller. A ledger fault
 * must never un-sell a dish or un-bin a dropped plate.
 */
import { withTransaction } from '../db/pool.mjs';
import { money, ymd, clip, nextVoucherNo, audit } from './kit.mjs';

export const STOCK_SOURCE_TYPES = Object.freeze({
    cogs: 'order_cogs',                   // source_id = orders.id
    cogsReversal: 'order_cogs_reversal',  // source_id = orders.id
    waste: 'dish_waste',                  // source_id = waste_docs.id
    stockDoc: 'stock_doc',                // source_id = stock_docs.id
});


const posted = (vouchers) => ({ status: 'posted', reason: null, vouchers });
const skipped = (reason) => ({ status: 'skipped', reason, vouchers: [] });

const accountByLinkCode = async (conn, code) => {
    const [rows] = await conn.query(
        `SELECT id FROM accounts
          WHERE is_active = 1 AND JSON_CONTAINS(link_codes, ?)
          ORDER BY account_number LIMIT 1`,
        [JSON.stringify(code)],
    );
    return rows[0]?.id ?? null;
};

const need = (accountId, what) => {
    if (!accountId) throw new Error(`no account resolves for ${what}. Map it under Accounts before this can post`);
    return accountId;
};

const findJournal = async (conn, sourceType, sourceId) => {
    const [rows] = await conn.query(
        'SELECT id FROM gl_journals WHERE source_type = ? AND source_id = ?',
        [sourceType, String(sourceId)],
    );
    return rows[0] ?? null;
};

const gate = async (conn, bd) => {
    const [rows] = await conn.query('SELECT * FROM gl_settings WHERE id = 1');
    const settings = rows[0];
    if (!settings) return { skip: skipped('gl_settings has no row') };
    if (!settings.posting_enabled) return { skip: skipped('posting is switched off') };
    if (bd < ymd(settings.start_date)) return { skip: skipped('document predates the ledger start date') };
    return { skip: null };
};

/* Two lines, always: something against Inventory. */
const postPair = async (conn, {
    branchId, businessDate, sourceType, sourceId, description,
    debitAccount, creditAccount, amount, memo, userId,
}) => {
    /*
     * The branch comes from the DOCUMENT, never from whoever is looking. A
     * cost-of-sales journal belongs to the outlet that sold the food, and it
     * may well be posted by a background call with no request at all. This
     * used to be the constant `BRANCH_ID = 1` — the shape the sweep for
     * `branch_id = 1` could not see.
     */
    const voucherNo = await nextVoucherNo(conn, 'JV', businessDate, branchId);
    const [res] = await conn.query(
        `INSERT INTO gl_journals
           (branch_id, business_date, voucher_type, voucher_no, source_type, source_id,
            description, debit_total, credit_total, created_by)
         VALUES (?, ?, 'JV', ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [branchId, businessDate, voucherNo, sourceType, String(sourceId),
            clip(description), amount, amount, userId],
    );
    // insertId is the honest signal under CLIENT_FOUND_ROWS: 0 means the
    // duplicate key held and somebody else owns this journal.
    if (!res.insertId) return null;
    await conn.query(
        `INSERT INTO gl_journal_lines (journal_id, account_id, debit, credit, memo)
         VALUES (?, ?, ?, 0, ?), (?, ?, 0, ?, ?)`,
        [res.insertId, debitAccount, amount, clip(memo),
            res.insertId, creditAccount, amount, clip(memo)],
    );
    return voucherNo;
};

/* What a set of stock movements was worth, at today's moving average. */
const valueOf = async (conn, sourceType, sourceId) => {
    const [rows] = await conn.query(
        `SELECT COALESCE(SUM(ABS(l.delta) * i.avg_cost), 0) AS value, COUNT(*) AS n
           FROM stock_ledger l JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE l.source_type = ? AND l.source_id = ?`,
        [sourceType, String(sourceId)],
    );
    return { value: money(rows[0]?.value ?? 0), lines: Number(rows[0]?.n ?? 0) };
};

const run = (label, body) => (async () => {
    try {
        return await withTransaction(body);
    } catch (e) {
        const message = e?.message ?? String(e);
        console.error(`[accounts] ${label} posting failed (document unaffected):`, message);
        return { status: 'failed', reason: message, vouchers: [] };
    }
})();

/*
 * Cost of sales for one settled order. Fired after consumption, so the stock
 * rows it values are already committed.
 */
export const afterConsumeGl = (order, { userId = null } = {}) => run('cogs', async (conn) => {
    if (!order?.id) return skipped('no order');
    if (await findJournal(conn, STOCK_SOURCE_TYPES.cogs, order.id)) return posted([]);
    const { value, lines } = await valueOf(conn, 'sale', order.id);
    // A dish with no recipe consumes nothing and costs nothing — a half-mapped
    // menu is the normal state, not an error.
    if (lines === 0 || value <= 0) return skipped('nothing was consumed, or it is not costed yet');

    const bd = ymd(order.business_date);
    const { skip } = await gate(conn, bd);
    if (skip) return skip;

    const voucher = await postPair(conn, {
        branchId: Number(order.branch_id) || 1,
        businessDate: bd,
        sourceType: STOCK_SOURCE_TYPES.cogs,
        sourceId: order.id,
        description: `Cost of sales · order ${order.order_number ?? order.id}`,
        debitAccount: need(await accountByLinkCode(conn, 'COGS'), 'cost of sales (link code COGS)'),
        creditAccount: need(await accountByLinkCode(conn, 'INVENTORY'), 'the stock control account (link code INVENTORY)'),
        amount: value,
        memo: `${lines} ingredient${lines === 1 ? '' : 's'}`,
        userId,
    });
    if (!voucher) return posted([]);
    await audit(conn, { bd, action: 'gl_post_cogs', userId, details: { order_id: order.id, value, voucher } });
    return posted([voucher]);
});

/* And its reversal, when the bill is voided and the stock handed back. */
export const afterConsumeReversalGl = (order, { userId = null } = {}) => run('cogs reversal', async (conn) => {
    if (!order?.id) return skipped('no order');
    if (await findJournal(conn, STOCK_SOURCE_TYPES.cogsReversal, order.id)) return posted([]);
    const { value, lines } = await valueOf(conn, 'void', order.id);
    if (lines === 0 || value <= 0) return skipped('nothing was handed back');

    const bd = ymd(order.business_date);
    const { skip } = await gate(conn, bd);
    if (skip) return skip;

    const voucher = await postPair(conn, {
        branchId: Number(order.branch_id) || 1,
        businessDate: bd,
        sourceType: STOCK_SOURCE_TYPES.cogsReversal,
        sourceId: order.id,
        description: `Cost of sales reversed · order ${order.order_number ?? order.id}`,
        // The mirror image: stock came back, so the cost comes back out.
        debitAccount: need(await accountByLinkCode(conn, 'INVENTORY'), 'the stock control account (link code INVENTORY)'),
        creditAccount: need(await accountByLinkCode(conn, 'COGS'), 'cost of sales (link code COGS)'),
        amount: value,
        memo: `${lines} ingredient${lines === 1 ? '' : 's'} returned`,
        userId,
    });
    if (!voucher) return posted([]);
    await audit(conn, { bd, action: 'gl_post_cogs_reversal', userId, details: { order_id: order.id, value, voucher } });
    return posted([voucher]);
});

/* Food cooked and binned: a loss, not a cost of sale. */
export const afterWasteGl = (wasteDocId, { userId = null } = {}) => run('waste', async (conn) => {
    const id = Number(wasteDocId);
    if (!Number.isInteger(id) || id <= 0) return skipped('no waste document');
    if (await findJournal(conn, STOCK_SOURCE_TYPES.waste, id)) return posted([]);

    const [rows] = await conn.query(
        `SELECT d.branch_id, d.business_date, d.reason, COALESCE(SUM(l.cost), 0) AS cost
           FROM waste_docs d LEFT JOIN waste_lines l ON l.waste_doc_id = d.id
          WHERE d.id = ? GROUP BY d.id, d.branch_id, d.business_date, d.reason`,
        [id],
    );
    const w = rows[0];
    if (!w) return skipped('waste document not found');
    const amount = money(w.cost);
    // Dishes with no recipe cost nothing; the document still stands as the
    // record that it happened.
    if (amount <= 0) return skipped('the wasted dishes are not costed');

    const bd = ymd(w.business_date);
    const { skip } = await gate(conn, bd);
    if (skip) return skip;

    const voucher = await postPair(conn, {
        branchId: Number(w.branch_id) || 1,
        businessDate: bd,
        sourceType: STOCK_SOURCE_TYPES.waste,
        sourceId: id,
        description: `Wastage · ${w.reason}`,
        debitAccount: need(
            await accountByLinkCode(conn, 'WASTAGE') ?? await accountByLinkCode(conn, 'INV_GAIN'),
            'wastage (link code WASTAGE, or INV_GAIN)',
        ),
        creditAccount: need(await accountByLinkCode(conn, 'INVENTORY'), 'the stock control account (link code INVENTORY)'),
        amount,
        memo: w.reason,
        userId,
    });
    if (!voucher) return posted([]);
    await audit(conn, { bd, action: 'gl_post_waste', userId, details: { waste_doc_id: id, value: amount, voucher } });
    return posted([voucher]);
});

/*
 * Stock documents that change what the shelf is worth: misc consumption,
 * adjustments and counts. A transfer moves stock between warehouses and both
 * sides are the same account, so it is deliberately not booked.
 *
 * The sign decides the direction, and a count can go either way: stock found
 * is a gain, stock missing is a loss, and the same account carries both — which
 * is exactly what "Inventory Variance and Wastage" is for.
 */
export const afterStockDocGl = (docId, { userId = null } = {}) => run('stock document', async (conn) => {
    const id = Number(docId);
    if (!Number.isInteger(id) || id <= 0) return skipped('no stock document');
    if (await findJournal(conn, STOCK_SOURCE_TYPES.stockDoc, id)) return posted([]);

    const [rows] = await conn.query(
        'SELECT id, branch_id, doc_type, business_date, reason FROM stock_docs WHERE id = ?', [id],
    );
    const d = rows[0];
    if (!d) return skipped('stock document not found');
    if (d.doc_type === 'transfer') return skipped('a transfer moves stock between warehouses, not into or out of the books');

    const [sums] = await conn.query(
        `SELECT COALESCE(SUM(l.delta * i.avg_cost), 0) AS net, COUNT(*) AS n
           FROM stock_ledger l JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE l.source_type = ? AND l.source_id = ?`,
        [d.doc_type === 'misc' ? 'misc' : d.doc_type, String(id)],
    );
    const net = money(sums[0]?.net ?? 0);
    if (!sums[0] || Number(sums[0].n) === 0 || net === 0) return skipped('the document moved nothing worth booking');

    const bd = ymd(d.business_date);
    const { skip } = await gate(conn, bd);
    if (skip) return skip;

    const inventory = need(await accountByLinkCode(conn, 'INVENTORY'), 'the stock control account (link code INVENTORY)');
    const variance = need(
        await accountByLinkCode(conn, 'INV_GAIN') ?? await accountByLinkCode(conn, 'WASTAGE'),
        'inventory variance (link code INV_GAIN)',
    );
    // net < 0 is stock leaving: a loss. net > 0 is stock found: a gain.
    const lost = net < 0;
    const voucher = await postPair(conn, {
        branchId: Number(d.branch_id) || 1,
        businessDate: bd,
        sourceType: STOCK_SOURCE_TYPES.stockDoc,
        sourceId: id,
        description: `Stock ${d.doc_type} · ${d.reason || `document ${id}`}`,
        debitAccount: lost ? variance : inventory,
        creditAccount: lost ? inventory : variance,
        amount: Math.abs(net),
        memo: d.reason || d.doc_type,
        userId,
    });
    if (!voucher) return posted([]);
    await audit(conn, {
        bd, action: 'gl_post_stock_doc', userId,
        details: { stock_doc_id: id, doc_type: d.doc_type, net, voucher },
    });
    return posted([voucher]);
});

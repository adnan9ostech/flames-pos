/*
 * The stock verbs — the ONE writer of stock_ledger. Every document that
 * moves stock (receiving, transfer, adjustment, misc consumption, count)
 * and the sale/void consumption engine post their rows through postLedger
 * here, so "current stock" has exactly one version of the truth:
 * SUM(delta) per item per warehouse, with nothing cached to drift.
 *
 * Like orders.mjs, these verbs trust their caller for the permission gate
 * (the server actions hold requirePermission('inventory')); what they never trust is the
 * arithmetic — quantities are validated, averages recomputed, and every
 * document commits with its ledger rows and audit entry or not at all.
 */
import { withTransaction } from './pool.mjs';
import { writeAudit } from './audit.mjs';

// DECIMAL(12,2) money, (12,3) receiving qty, (12,4) ledger qty and cost —
// rounded before INSERT so "0.1+0.2" float dust never reaches a CHECK.
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10000) / 10000;

/* The calendar day in Asia/Karachi (fixed UTC+5, no DST). */
const karachiDay = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

/*
 * The trading day a stock document books to: the open business day once
 * day-close is in use, else the Karachi calendar day — the same resolution
 * the money verbs apply, so a 1 a.m. goods-in lands with the 1 a.m. sales.
 */
const resolveBusinessDate = async (conn, branchId = 1) => {
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

const auditLog = (conn, businessDate, action, details) =>
    writeAudit(conn, { businessDate, action, details });

const toId = (value, message) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(message);
    return n;
};

/*
 * The one door into stock_ledger. Rows: {itemId, warehouseId, delta,
 * unitCost?, sourceType, sourceId, businessDate}. Callers hand a delta that
 * is already signed and rounded; this only refuses a zero, which would be a
 * movement that moved nothing.
 */
export const postLedger = async (conn, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const values = rows.map((r) => {
        const delta = round4(Number(r.delta));
        if (!Number.isFinite(delta) || delta === 0) {
            throw new Error('A stock movement of zero has nothing to record');
        }
        return [
            r.itemId, r.warehouseId, delta,
            r.unitCost ?? null, r.sourceType, String(r.sourceId), r.businessDate,
        ];
    });
    await conn.query(
        `INSERT INTO stock_ledger
           (inventory_item_id, warehouse_id, delta, unit_cost, source_type, source_id, business_date)
         VALUES ?`,
        [values],
    );
    return values.length;
};

/*
 * Existence check on the items a document names, worded for the screen.
 * forUpdate serializes the verbs that rewrite avg_cost: two receivings for
 * the same item queue on the row instead of both averaging from stale stock.
 */
const fetchItems = async (conn, itemIds, { forUpdate = false } = {}) => {
    const [rows] = await conn.query(
        `SELECT id, name, avg_cost FROM inventory_items WHERE id IN (?)${forUpdate ? ' FOR UPDATE' : ''}`,
        [itemIds],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of itemIds) {
        if (!byId.has(id)) throw new Error('A line points at a stock item that no longer exists');
    }
    return byId;
};

const checkWarehouse = async (conn, warehouseId) => {
    const [rows] = await conn.query('SELECT id FROM warehouses WHERE id = ?', [warehouseId]);
    if (rows.length === 0) throw new Error('That warehouse no longer exists');
};

/* On-hand per item from the ledger, optionally scoped to one warehouse. */
const onHandByItem = async (conn, itemIds, warehouseId = null) => {
    const [rows] = await conn.query(
        `SELECT inventory_item_id, SUM(delta) AS qty FROM stock_ledger
         WHERE inventory_item_id IN (?)${warehouseId ? ' AND warehouse_id = ?' : ''}
         GROUP BY inventory_item_id`,
        warehouseId ? [itemIds, warehouseId] : [itemIds],
    );
    return new Map(rows.map((r) => [r.inventory_item_id, Number(r.qty)]));
};

/* Header + lines for transfer/adjustment/misc/count, which share one shape. */
const insertDoc = async (conn, { docType, warehouseId, toWarehouseId = null, businessDate, reason = null, lines }) => {
    const [res] = await conn.query(
        `INSERT INTO stock_docs (doc_type, warehouse_id, to_warehouse_id, business_date, reason)
         VALUES (?, ?, ?, ?, ?)`,
        [docType, warehouseId, toWarehouseId, businessDate, reason],
    );
    await conn.query(
        'INSERT INTO stock_doc_lines (doc_id, inventory_item_id, qty) VALUES ?',
        [lines.map((l) => [res.insertId, l.itemId, l.qty])],
    );
    return res.insertId;
};

/*
 * Goods in. One transaction: header + lines, positive ledger rows carrying
 * the paid cost, and the moving-average update that reprices every recipe:
 *
 *   new_avg = (current_qty × avg + received_qty × cost) / (current_qty + received_qty)
 *
 * with current_qty summed from the ledger across all warehouses — the
 * average is a property of the item, not of one store room. When current
 * stock is zero or negative (over-consumed before anyone counted), blending
 * would divide by nothing or reward the error, so the average floors at the
 * simple cost of what was just received.
 */
export const receiveStock = async ({
    supplierId, warehouseId, draftId = null, supplierInvoice = null, lines = [], notes = null,
    purchaseOrderId = null,
} = {}) =>
    withTransaction(async (conn) => {
        const supplier = toId(supplierId, 'Pick a supplier');
        const warehouse = toId(warehouseId, 'Pick a warehouse');
        if (!Array.isArray(lines) || lines.length === 0) {
            throw new Error('A receiving needs at least one line');
        }
        const clean = lines.map((l) => {
            const qty = round3(Number(l.qty));
            const unitCost = round4(Number(l.unitCost));
            if (!(qty > 0)) throw new Error('Every line needs a quantity above zero');
            if (!Number.isFinite(unitCost) || unitCost < 0) {
                throw new Error('Every line needs a unit cost of zero or more');
            }
            return { itemId: toId(l.itemId, 'A line is missing its item'), qty, unitCost };
        });

        const [supRows] = await conn.query('SELECT is_active FROM suppliers WHERE id = ?', [supplier]);
        if (supRows.length === 0) throw new Error('That supplier no longer exists');
        if (!supRows[0].is_active) throw new Error('That supplier is retired. Reactivate it first');
        await checkWarehouse(conn, warehouse);

        /*
         * The purchase order this delivery answers, if it answers one. Locked
         * and checked before the header lands, for the same reason the draft
         * is: a stale id should fail with a sentence, not a foreign key.
         *
         * Only an OPEN order can be answered. A GRN posted against one that is
         * already closed is either a duplicate or a second delivery somebody
         * meant to raise a new order for, and both are worth stopping.
         */
        let po = null;
        if (purchaseOrderId != null && purchaseOrderId !== '') {
            po = toId(purchaseOrderId, 'That purchase order no longer exists');
            const [poRows] = await conn.query(
                'SELECT status FROM purchase_orders WHERE id = ? FOR UPDATE', [po],
            );
            if (poRows.length === 0) throw new Error('That purchase order no longer exists');
            if (poRows[0].status !== 'open') throw new Error('That purchase order is already closed');
        }

        // Validated (and locked) before the header lands, so a stale draft id
        // fails with words instead of a foreign-key error.
        let draft = null;
        if (draftId != null && draftId !== '') {
            draft = toId(draftId, 'That demand draft no longer exists');
            const [draftRows] = await conn.query(
                'SELECT status FROM demand_drafts WHERE id = ? FOR UPDATE', [draft],
            );
            if (draftRows.length === 0) throw new Error('That demand draft no longer exists');
        }

        const itemIds = [...new Set(clean.map((l) => l.itemId))];
        const items = await fetchItems(conn, itemIds, { forUpdate: true });
        // On-hand BEFORE this receipt's rows land — the blend needs the old world.
        const onHand = await onHandByItem(conn, itemIds);

        const businessDate = await resolveBusinessDate(conn);
        const total = round2(clean.reduce((sum, l) => sum + l.qty * l.unitCost, 0));

        const [res] = await conn.query(
            `INSERT INTO stock_receivings
               (supplier_id, warehouse_id, draft_id, purchase_order_id, supplier_invoice,
                business_date, total, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [supplier, warehouse, draft, po,
                String(supplierInvoice ?? '').trim().slice(0, 64) || null,
                businessDate, total,
                String(notes ?? '').trim().slice(0, 191) || null],
        );
        const receivingId = res.insertId;

        await conn.query(
            'INSERT INTO stock_receiving_lines (receiving_id, inventory_item_id, qty, unit_cost) VALUES ?',
            [clean.map((l) => [receivingId, l.itemId, l.qty, l.unitCost])],
        );

        await postLedger(conn, clean.map((l) => ({
            itemId: l.itemId, warehouseId: warehouse, delta: l.qty, unitCost: l.unitCost,
            sourceType: 'receiving', sourceId: receivingId, businessDate,
        })));

        // Two batches of one item on the same GRN blend as one lot.
        for (const itemId of itemIds) {
            const batch = clean.filter((l) => l.itemId === itemId);
            const qty = batch.reduce((sum, l) => sum + l.qty, 0);
            const cost = batch.reduce((sum, l) => sum + l.qty * l.unitCost, 0);
            const current = onHand.get(itemId) ?? 0;
            const avg = Number(items.get(itemId).avg_cost);
            const newAvg = current > 0
                ? (current * avg + cost) / (current + qty)
                : cost / qty;
            await conn.query(
                'UPDATE inventory_items SET avg_cost = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?',
                [round4(newAvg), itemId],
            );
        }

        /*
         * And the order it answers is closed, one way. What actually arrived
         * is on the GRN's own lines; the PO keeps what was promised, and the
         * difference between the two is the conversation with the supplier.
         */
        if (po) {
            await conn.query(
                "UPDATE purchase_orders SET status = 'received', closed_at = UTC_TIMESTAMP(3) WHERE id = ?",
                [po],
            );
        }

        /*
         * A change in what chilli costs is a change in what the masala made of
         * it costs, and every screen prices a recipe from avg_cost. So the
         * phantoms are re-rolled here, inside the same transaction as the
         * moving average that moved them.
         */
        const { recomputeSubRecipeCosts } = await import('../inventory/subrecipe.mjs');
        await recomputeSubRecipeCosts(conn);

        // The requisition this GRN answers is done; a draft already closed
        // stays as it is — fulfilment is one-way.
        if (draft) {
            await conn.query(
                "UPDATE demand_drafts SET status = 'fulfilled' WHERE id = ? AND status = 'open'",
                [draft],
            );
        }

        await auditLog(conn, businessDate, 'stock_receiving', {
            receiving_id: receivingId,
            supplier_id: supplier,
            warehouse_id: warehouse,
            draft_id: draft,
            total,
            lines: clean.length,
        });

        return { id: receivingId, total, business_date: businessDate };
    });

export const transferStock = async ({ fromWarehouseId, toWarehouseId, lines = [], reason = null } = {}) =>
    withTransaction(async (conn) => {
        const from = toId(fromWarehouseId, 'Pick the warehouse the stock leaves');
        const to = toId(toWarehouseId, 'Pick the warehouse the stock enters');
        if (from === to) throw new Error('A transfer needs two different warehouses');
        if (!Array.isArray(lines) || lines.length === 0) {
            throw new Error('A transfer needs at least one line');
        }
        const clean = lines.map((l) => {
            const qty = round4(Number(l.qty));
            if (!(qty > 0)) throw new Error('Every line needs a quantity above zero');
            return { itemId: toId(l.itemId, 'A line is missing its item'), qty };
        });

        await checkWarehouse(conn, from);
        await checkWarehouse(conn, to);
        await fetchItems(conn, [...new Set(clean.map((l) => l.itemId))]);

        const businessDate = await resolveBusinessDate(conn);
        const docId = await insertDoc(conn, {
            docType: 'transfer', warehouseId: from, toWarehouseId: to, businessDate,
            reason: String(reason ?? '').trim().slice(0, 191) || null,
            lines: clean,
        });

        // Out of one door, into the other — the same document, two rows per
        // line, so the ledger nets to zero across the restaurant.
        await postLedger(conn, clean.flatMap((l) => [
            { itemId: l.itemId, warehouseId: from, delta: -l.qty, sourceType: 'transfer', sourceId: docId, businessDate },
            { itemId: l.itemId, warehouseId: to, delta: l.qty, sourceType: 'transfer', sourceId: docId, businessDate },
        ]));

        await auditLog(conn, businessDate, 'stock_transfer', {
            doc_id: docId, from_warehouse_id: from, to_warehouse_id: to, lines: clean.length,
        });
        return { id: docId, business_date: businessDate };
    });

/*
 * Signed corrections — a found sack of flour (+), a spoiled crate (−).
 * The reason is mandatory: an unexplained adjustment is exactly the hole
 * stock audits exist to catch.
 */
export const adjustStock = async ({ warehouseId, lines = [], reason } = {}) =>
    withTransaction(async (conn) => {
        const warehouse = toId(warehouseId, 'Pick a warehouse');
        const why = String(reason ?? '').trim().slice(0, 191);
        if (!why) throw new Error('An adjustment needs a reason');
        if (!Array.isArray(lines) || lines.length === 0) {
            throw new Error('An adjustment needs at least one line');
        }
        const clean = lines.map((l) => {
            const delta = round4(Number(l.delta));
            if (!Number.isFinite(delta) || delta === 0) {
                throw new Error('Every line needs a non-zero + or − quantity');
            }
            return { itemId: toId(l.itemId, 'A line is missing its item'), qty: delta };
        });

        await checkWarehouse(conn, warehouse);
        await fetchItems(conn, [...new Set(clean.map((l) => l.itemId))]);

        const businessDate = await resolveBusinessDate(conn);
        const docId = await insertDoc(conn, {
            docType: 'adjustment', warehouseId: warehouse, businessDate, reason: why, lines: clean,
        });
        await postLedger(conn, clean.map((l) => ({
            itemId: l.itemId, warehouseId: warehouse, delta: l.qty,
            sourceType: 'adjustment', sourceId: docId, businessDate,
        })));

        await auditLog(conn, businessDate, 'stock_adjustment', {
            doc_id: docId, warehouse_id: warehouse, reason: why, lines: clean.length,
        });
        return { id: docId, business_date: businessDate };
    });

/* Stock leaving outside a sale: staff meals, a marketing tasting, breakage. */
export const miscConsumption = async ({ warehouseId, lines = [], reason = null } = {}) =>
    withTransaction(async (conn) => {
        const warehouse = toId(warehouseId, 'Pick a warehouse');
        if (!Array.isArray(lines) || lines.length === 0) {
            throw new Error('A consumption needs at least one line');
        }
        const clean = lines.map((l) => {
            const qty = round4(Number(l.qty));
            if (!(qty > 0)) throw new Error('Every line needs a quantity above zero');
            return { itemId: toId(l.itemId, 'A line is missing its item'), qty };
        });

        await checkWarehouse(conn, warehouse);
        await fetchItems(conn, [...new Set(clean.map((l) => l.itemId))]);

        const businessDate = await resolveBusinessDate(conn);
        const docId = await insertDoc(conn, {
            docType: 'misc', warehouseId: warehouse, businessDate,
            reason: String(reason ?? '').trim().slice(0, 191) || null,
            lines: clean,
        });
        await postLedger(conn, clean.map((l) => ({
            itemId: l.itemId, warehouseId: warehouse, delta: -l.qty,
            sourceType: 'misc', sourceId: docId, businessDate,
        })));

        await auditLog(conn, businessDate, 'stock_misc_consumption', {
            doc_id: docId, warehouse_id: warehouse, lines: clean.length,
        });
        return { id: docId, business_date: businessDate };
    });

/*
 * Physical count. The document keeps what was counted; the ledger gets only
 * the correction, counted − system, so the movement history stays honest
 * about how far reality had drifted. Items are locked FOR UPDATE so a
 * receiving can't reprice-and-move stock between the system reading and the
 * correction landing; a sale firing mid-count is inherent to counting a
 * live kitchen and books after the count like any later movement.
 */
export const postCount = async ({ warehouseId, lines = [] } = {}) =>
    withTransaction(async (conn) => {
        const warehouse = toId(warehouseId, 'Pick a warehouse');
        if (!Array.isArray(lines) || lines.length === 0) {
            throw new Error('A count needs at least one counted line');
        }
        const clean = lines.map((l) => {
            const counted = round4(Number(l.countedQty));
            if (!Number.isFinite(counted) || counted < 0) {
                throw new Error('Counted quantity must be zero or more');
            }
            return { itemId: toId(l.itemId, 'A line is missing its item'), qty: counted };
        });

        await checkWarehouse(conn, warehouse);
        const itemIds = [...new Set(clean.map((l) => l.itemId))];
        await fetchItems(conn, itemIds, { forUpdate: true });
        const system = await onHandByItem(conn, itemIds, warehouse);

        const businessDate = await resolveBusinessDate(conn);
        const docId = await insertDoc(conn, {
            docType: 'count', warehouseId: warehouse, businessDate, lines: clean,
        });

        const variances = clean.map((l) => {
            const sys = system.get(l.itemId) ?? 0;
            return { itemId: l.itemId, system: round4(sys), counted: l.qty, delta: round4(l.qty - sys) };
        });
        // A shelf that matched the book needs no correction row.
        const corrections = variances.filter((v) => v.delta !== 0);
        if (corrections.length > 0) {
            await postLedger(conn, corrections.map((v) => ({
                itemId: v.itemId, warehouseId: warehouse, delta: v.delta,
                sourceType: 'count', sourceId: docId, businessDate,
            })));
        }

        await auditLog(conn, businessDate, 'stock_count', {
            doc_id: docId, warehouse_id: warehouse,
            lines: clean.length, corrections: corrections.length,
        });
        return { id: docId, business_date: businessDate, variances };
    });

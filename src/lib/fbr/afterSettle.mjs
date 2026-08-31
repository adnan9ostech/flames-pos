/*
 * Fire-and-forget FBR reporting, called by the settle path AFTER the money
 * has landed. The contract is one-directional: a settle must never fail, or
 * even slow past one timeout, because FBR is down — so this function never
 * throws, and its durable output is the fbr_invoices queue row, not the
 * network call. The single live attempt here is an optimisation (the number
 * usually makes it onto the first printed receipt); the fbr-worker owns the
 * retries.
 */

import { query } from '../db/pool.mjs';
import { buildFbrPayload } from './payload.mjs';
import { postInvoice } from './client.mjs';

/* `order` is the settled row as the verbs return it (serialized is fine —
 * the payload builder accepts paid_at as an ISO string or a Date). */
export const afterSettleFbr = async (order) => {
    try {
        if (process.env.FBR_ENABLED !== 'true') return;
        // Only a settled, numbered sale is an invoice; a replayed settle whose
        // order already carries its FBR number has nothing left to report.
        if (!order?.id || !order.invoice_number) return;
        if (order.fbr_invoice_number) return;

        const lines = await query(
            `SELECT menu_item_id, name, variant, unit_price, qty, line_total
             FROM order_items WHERE order_id = ? ORDER BY round_no, seq`,
            [order.id],
        );
        const [settings] = await query(
            'SELECT merchant_name, merchant_city FROM store_settings LIMIT 1',
        );

        // Enqueue exactly once per order (order_id is UNIQUE); a concurrent or
        // replayed settle leaves the existing row — and its payload — alone.
        const payload = buildFbrPayload(order, lines, settings ?? {});
        await query(
            `INSERT INTO fbr_invoices (order_id, usin, payload)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE id = id`,
            [order.id, order.invoice_number, JSON.stringify(payload)],
        );

        // Post only while the row is pending: if a twin already sent it, a
        // second post would mint a second FBR invoice for one sale.
        const [row] = await query(
            'SELECT status, payload FROM fbr_invoices WHERE order_id = ?', [order.id],
        );
        if (!row || row.status !== 'pending') return;

        // The stored payload is the document of record — post that, so what
        // FBR received is always exactly what the queue row says it received.
        const res = await postInvoice(row.payload);
        if (res.ok) {
            await query(
                `UPDATE fbr_invoices SET
                   status = 'sent', fbr_invoice_number = ?, attempts = attempts + 1,
                   last_error = NULL, sent_at = UTC_TIMESTAMP(3)
                 WHERE order_id = ?`,
                [res.fbrInvoiceNumber, order.id],
            );
            await query(
                'UPDATE orders SET fbr_invoice_number = ? WHERE id = ?',
                [res.fbrInvoiceNumber, order.id],
            );
        } else {
            await query(
                'UPDATE fbr_invoices SET attempts = attempts + 1, last_error = ? WHERE order_id = ?',
                [res.error, order.id],
            );
        }
    } catch (e) {
        // Swallowed by design: the queue row (if it landed) keeps the sale
        // reportable, and the worker will pick it up.
        console.error('FBR after-settle failed (settle unaffected):', e?.message || e);
    }
};

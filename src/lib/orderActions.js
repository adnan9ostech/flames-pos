'use server';

/*
 * The mutation seam between the till and the order verbs, plus the two reads
 * that ride along with a sale (waiters, customer lookup).
 *
 * Next.js redacts errors thrown from server actions in production, and the
 * till string-matches the verb errors ('Total mismatch…', '…already been
 * settled.') to decide what to tell the cashier. So nothing here throws to
 * the client: every action returns {data} on success or {error: message} on
 * failure, message verbatim, and the dataClient wrapper rethrows it intact.
 *
 * Authorization lives here, not in the verbs: requireUser on everything,
 * the `void` right on void — the gate that used to be a browser-side role
 * check.
 */
import { requireUser, requirePermission } from '@/lib/db/auth.mjs';
import {
    createOrder,
    appendRound,
    settleOrder as settleOrderVerb,
    voidOrder,
    bumpOrder as bumpOrderVerb,
    setItemAvailability,
} from '@/lib/db/orders.mjs';
import {
    getOrderById,
    getWaiters as readWaiters,
    findCustomerByPhone as readCustomerByPhone,
    recordCustomer,
} from '@/lib/db/reads.mjs';

/*
 * Hand a freshly settled bill to the FBR reporter, if there is one. The
 * module is being built alongside this file and may be absent or disabled;
 * a lazy import that swallows everything means fiscal reporting can never
 * take down a sale that already happened.
 */
const fireFbrAfterSettle = (order) => {
    import('@/lib/fbr/afterSettle.mjs').then(m => m.afterSettleFbr(order)).catch(() => {});
};

/*
 * Same posture for the stock room: a settled sale consumes its recipes'
 * ingredients, a void hands them back — but the kitchen's ledger must never
 * take down a sale. Both are idempotent inside the module.
 */
const fireInventoryAfterSettle = (order) => {
    import('@/lib/inventory/consume.mjs').then(m => m.consumeForOrder(order)).catch(() => {});
};
const fireInventoryAfterVoid = (order) => {
    import('@/lib/inventory/consume.mjs').then(m => m.reverseForOrder(order)).catch(() => {});
};

/*
 * And the general ledger. Same posture again: the journals are the
 * accountant's record of a sale that has already happened, so a ledger
 * fault logs and stops there. Idempotent on (source_type, source_id) in
 * the database, because the replay path fires this twice for one order.
 */
const fireGlAfterSettle = (order) => {
    import('@/lib/accounts/post.mjs').then(m => m.afterSettleGl(order)).catch(() => {});
};
const fireGlAfterVoid = (order) => {
    import('@/lib/accounts/post.mjs').then(m => m.afterVoidGl(order)).catch(() => {});
};

/*
 * One order object in, one stored order out — pay-now sales settle inside
 * the same call. The object is the till's own shape; it is unpacked into
 * verb arguments here so the pages did not have to change.
 */
export const addOrder = async (order) => {
    try {
        await requireUser();
        const data = await createOrder(
            order.items,
            {
                payment_status: order.payment_status,
                payment_mode: order.payment_mode,
                order_number: order.order_number,
                order_type: order.order_type,
                include_tax: order.include_tax,
                discount: order.discount,
                discount_reason: order.discount_reason,
                table_number: order.table_number,
                waiter_id: order.waiter_id,
                waiter_name: order.waiter_name,
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                customer_address: order.customer_address,
                company_id: order.company_id,
            },
            order.client_request_id || null,
            // The total the till showed the cashier; the verb refuses to
            // store a bill that disagrees with what the customer was told.
            order.total ?? null,
        );

        // Best-effort, and deliberately after the order is safely stored:
        // the customer record is useful, but nothing about it is worth
        // losing a sale over. The stored row's total, not the screen's —
        // that is the amount that actually went in the book.
        if (order.customer_phone && data) {
            recordCustomer({
                name: order.customer_name,
                phone: order.customer_phone,
                address: order.customer_address,
                total: data.total ?? order.total ?? 0,
            }).catch(() => {});
        }

        if (data?.payment_status === 'paid') {
            fireFbrAfterSettle(data);
            fireInventoryAfterSettle(data);
            fireGlAfterSettle(data);
        }
        return { data };
    } catch (e) {
        return { error: e.message };
    }
};

export const appendRoundToOrder = async (orderId, newItems, details = {}, { clientRequestId } = {}) => {
    try {
        await requireUser();
        // Only the keys the floor may correct mid-sitting, and only when the
        // till actually sent them — absent must stay absent, not become null.
        const opts = {
            ...(details.include_tax !== undefined && { include_tax: details.include_tax }),
            ...(details.table_number !== undefined && { table_number: details.table_number }),
            ...(details.waiter_id !== undefined && { waiter_id: details.waiter_id }),
            ...(details.waiter_name !== undefined && { waiter_name: details.waiter_name }),
        };
        // expectedTotal stays null: settle carries the money check.
        const data = await appendRound(orderId, newItems, clientRequestId || null, null, opts);
        return { data };
    } catch (e) {
        return { error: e.message };
    }
};

export const settleOrder = async (orderId, {
    paymentMode = 'cash', includeTax, discount, discountReason,
    expectedTotal, clientRequestId, companyId,
} = {}) => {
    try {
        await requireUser();
        const data = await settleOrderVerb(orderId, {
            method: paymentMode,
            companyId: companyId || null,
            discount: discount ?? null,
            discountReason: discountReason ?? null,
            includeTax: includeTax ?? null,
            expectedTotal: expectedTotal ?? null,
            clientRequestId: clientRequestId || null,
        });
        if (data?.payment_status === 'paid') {
            fireFbrAfterSettle(data);
            fireInventoryAfterSettle(data);
            fireGlAfterSettle(data);
        }
        return { data };
    } catch (e) {
        return { error: e.message };
    }
};

/*
 * Void. Needs the `void` right — the verb trusts its caller, so this is the
 * gate. A shift manager can hold it without holding the rest of admin.
 *
 * The three refusals below ran in the browser under Supabase; they keep
 * their exact wording (the till displays them) but now also run where they
 * cannot be bypassed. The paid-order refusal stays deliberate: voidOrder
 * CAN reverse a paid bill in the ledger, but offering that at the till is
 * a refund flow, which arrives with its own permissions.
 */
export const cancelOrder = async (orderId, { reason } = {}) => {
    try {
        /*
         * The return was being discarded and the browser's own `by` string was
         * written to orders.cancelled_by instead — so a crafted call could sign
         * somebody else's name to a void. Who did it is a fact the server holds;
         * it is never asked of the client.
         */
        const actor = await requirePermission('void');

        const order = await getOrderById(orderId);
        if (order?.status === 'cancelled') {
            throw new Error('This order is already voided.');
        }
        if (order?.payment_status === 'paid') {
            throw new Error('This bill is already settled — voiding it would need a refund.');
        }
        if (!reason || !reason.trim()) {
            throw new Error('A reason is required to void an order.');
        }

        const data = await voidOrder(orderId, reason.trim(), actor.name || actor.role);
        if (data) { fireInventoryAfterVoid(data); fireGlAfterVoid(data); }
        return { data };
    } catch (e) {
        return { error: e.message };
    }
};

export const bumpOrder = async (orderId, fromStatus, toStatus) => {
    try {
        await requireUser();
        const data = await bumpOrderVerb(orderId, fromStatus, toStatus);
        return { data };
    } catch (e) {
        return { error: e.message };
    }
};

// 86'ing is a floor act, not an admin one — any signed-in role may flip it.
export const setMenuItemAvailability = async (id, isAvailable) => {
    try {
        await requireUser();
        const data = await setItemAvailability(id, isAvailable);
        return { data };
    } catch (e) {
        return { error: e.message };
    }
};

export const findCustomerByPhone = async (phone) => {
    try {
        await requireUser();
        if (!phone) return { data: null };
        const data = await readCustomerByPhone(String(phone).trim());
        return { data };
    } catch (e) {
        return { error: e.message };
    }
};

export const getWaiters = async () => {
    try {
        await requireUser();
        return { data: await readWaiters() };
    } catch (e) {
        return { error: e.message };
    }
};

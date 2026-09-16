/*
 * Live tickets for the kitchen display — the still-cooking statuses fired in
 * the last day, oldest first, and only the columns a ticket renders. Anything
 * older is counted rather than drawn; see getKitchenOrders for why.
 */
import { currentBranchId } from '@/lib/db/branch.mjs';
import { requireUser } from '@/lib/db/auth.mjs';
import { getKitchenOrders, getStaleKitchenCount } from '@/lib/db/reads.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    // Declared outside the guard: the second block below reads it to work out
    // which branch this terminal is asking about.
    let user;
    try {
        user = await requireUser();
    } catch (e) {
        return Response.json({ error: e.message }, { status: e.status ?? 401 });
    }

    try {
        /*
         * An object, not the bare array it used to be. The board is windowed to
         * the last 24 hours — nothing clears a live ticket on its own, so an
         * unwindowed board grows for good — and the tickets that fall outside
         * it are counted so the screen can say they exist rather than quietly
         * forgetting them.
         */
        const branchId = await currentBranchId(user);
        const [orders, stale] = await Promise.all([
            getKitchenOrders(branchId),
            getStaleKitchenCount(branchId),
        ]);
        return Response.json({ orders, stale }, { headers: NO_STORE });
    } catch (e) {
        console.error('GET /api/orders/kitchen failed:', e);
        return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
    }
}

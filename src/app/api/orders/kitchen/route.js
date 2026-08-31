/*
 * Live tickets for the kitchen display — the still-cooking statuses only,
 * oldest fired first, and only the columns a ticket renders.
 */
import { requireUser } from '@/lib/db/auth.mjs';
import { getKitchenOrders } from '@/lib/db/reads.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    try {
        await requireUser();
    } catch (e) {
        return Response.json({ error: e.message }, { status: e.status ?? 401 });
    }

    try {
        return Response.json(await getKitchenOrders(), { headers: NO_STORE });
    } catch (e) {
        console.error('GET /api/orders/kitchen failed:', e);
        return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
    }
}

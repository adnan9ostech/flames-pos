/*
 * The unpaid badge's number. Counted apart from any page of rows: the badge
 * means "unpaid overall", not "unpaid among what you happen to be looking at".
 */
import { requireUser } from '@/lib/db/auth.mjs';
import { getUnpaidOrdersCount } from '@/lib/db/reads.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    try {
        await requireUser();
    } catch (e) {
        return Response.json({ error: e.message }, { status: e.status ?? 401 });
    }

    try {
        return Response.json({ count: await getUnpaidOrdersCount() }, { headers: NO_STORE });
    } catch (e) {
        console.error('GET /api/orders/unpaid-count failed:', e);
        return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
    }
}

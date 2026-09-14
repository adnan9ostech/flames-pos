/*
 * The unpaid badge's number. Counted apart from any page of rows: the badge
 * means "unpaid overall", not "unpaid among what you happen to be looking at".
 */
import { currentBranchId } from '@/lib/db/branch.mjs';
import { requireUser } from '@/lib/db/auth.mjs';
import { getUnpaidOrdersCount } from '@/lib/db/reads.mjs';

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
        return Response.json({ count: await getUnpaidOrdersCount(await currentBranchId(user)) }, { headers: NO_STORE });
    } catch (e) {
        console.error('GET /api/orders/unpaid-count failed:', e);
        return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
    }
}

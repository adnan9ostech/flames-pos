/*
 * Open tabs — orders nobody has paid for yet. Feeds the tabs rail at the till.
 */
import { requirePermission } from '@/lib/db/auth.mjs';
import { currentBranchId } from '@/lib/db/branch.mjs';
import { getOpenTabs } from '@/lib/db/reads.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    let user;
    try {
        user = await requirePermission('pos');
    } catch (e) {
        return Response.json({ error: e.message }, { status: e.status ?? 401 });
    }

    try {
        return Response.json(await getOpenTabs(await currentBranchId(user)), { headers: NO_STORE });
    } catch (e) {
        console.error('GET /api/orders/open failed:', e);
        return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
    }
}

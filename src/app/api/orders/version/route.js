import { currentBranchId } from '@/lib/db/branch.mjs';
import { requireUser } from '@/lib/db/auth.mjs';
import { getOrdersVersion } from '@/lib/db/reads.mjs';

/*
 * The polling replacement for the realtime socket: one cheap aggregate that
 * changes whenever any order is created or touched. Terminals compare the
 * string, not parse it — a change means "refetch", nothing more.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    try {
        const user = await requireUser();
        const version = await getOrdersVersion(await currentBranchId(user));
        return Response.json({ version }, { headers: NO_STORE });
    } catch (e) {
        // AuthError carries 401; anything else (the pool, mostly) is a 500.
        // Either way the till just marks the channel unhealthy.
        return Response.json(
            { error: e.message },
            { status: e.status ?? 500, headers: NO_STORE },
        );
    }
}

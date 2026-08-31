/*
 * Paged, filtered order history for the orders screen. Filtering and slicing
 * stay in the database — the till must not get slower every week it runs.
 */
import { requireUser } from '@/lib/db/auth.mjs';
import { getOrdersPage, ORDERS_PAGE_SIZES } from '@/lib/db/reads.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const MAX_PAGE_SIZE = Math.max(...ORDERS_PAGE_SIZES);

export async function GET(request) {
    try {
        await requireUser();
    } catch (e) {
        return Response.json({ error: e.message }, { status: e.status ?? 401 });
    }

    try {
        const sp = new URL(request.url).searchParams;

        // Absent params fall through to the reader's own defaults; page and
        // pageSize are clamped because a URL is typeable in a way the till's
        // pager buttons are not.
        const page = Math.max(1, Math.floor(Number(sp.get('page'))) || 1);
        const rawSize = Math.floor(Number(sp.get('pageSize'))) || ORDERS_PAGE_SIZES[0];
        const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));

        const data = await getOrdersPage({
            page,
            pageSize,
            status: sp.get('status') || 'all',
            orderType: sp.get('orderType') || 'all',
            from: sp.get('from') || null,
            to: sp.get('to') || null,
            sort: sp.get('sort') || 'newest',
            search: sp.get('search') || '',
        });
        return Response.json(data, { headers: NO_STORE });
    } catch (e) {
        console.error('GET /api/orders failed:', e);
        return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
    }
}

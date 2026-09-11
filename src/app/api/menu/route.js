/*
 * The menu, whole: categories, items, modifiers in one response, because no
 * screen ever wants just one of them. Public by design — the /customer page
 * renders this with no session, matching the old anon-read RLS policy.
 */
import { getCategories, getMenuItems, getModifiers, getDeals } from '@/lib/db/reads.mjs';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    try {
        const [categories, items, modifiers, deals] = await Promise.all([
            getCategories(),
            getMenuItems(),
            getModifiers(),
            getDeals(),
        ]);
        return Response.json({ categories, items, modifiers, deals }, { headers: NO_STORE });
    } catch (e) {
        // Public route: log the real failure, say something bland outward.
        console.error('GET /api/menu failed:', e);
        return Response.json(
            { error: 'Could not load the menu' },
            { status: 500, headers: NO_STORE },
        );
    }
}

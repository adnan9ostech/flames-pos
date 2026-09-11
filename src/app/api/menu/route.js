/*
 * The menu, whole: categories, items, modifiers in one response, because no
 * screen ever wants just one of them. Public by design — the /customer page
 * renders this with no session, matching the old anon-read RLS policy.
 */
import { getCategories, getMenuItems, getModifiers, getDeals, getOutOfStockDishes, getStoreSettings } from '@/lib/db/reads.mjs';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    try {
        const [categories, items, modifiers, deals, settings] = await Promise.all([
            getCategories(),
            getMenuItems(),
            getModifiers(),
            getDeals(),
            getStoreSettings(),
        ]);
        /*
         * The shelf, only when somebody asked. Skipped entirely when the gate
         * is off — which is the default — so the usual menu load stays three
         * queries and the till behaves exactly as it always has.
         */
        const stockGate = ['flag', 'hide'].includes(settings?.stock_gate) ? settings.stock_gate : 'off';
        const outOfStock = stockGate === 'off' ? [] : await getOutOfStockDishes();
        return Response.json(
            { categories, items, modifiers, deals, stockGate, outOfStock },
            { headers: NO_STORE },
        );
    } catch (e) {
        // Public route: log the real failure, say something bland outward.
        console.error('GET /api/menu failed:', e);
        return Response.json(
            { error: 'Could not load the menu' },
            { status: 500, headers: NO_STORE },
        );
    }
}

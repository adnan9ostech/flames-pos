'use client';

/*
 * The data seam the pages actually import — a drop-in for the retired
 * supabaseDb module, same nineteen names, same shapes, same temperament:
 * reads never throw (they log and return their empty shape — a till that
 * cannot refresh a list must still ring sales), mutations throw the server's
 * message verbatim because the screens string-match and display it.
 *
 * Reads travel over the GET routes; mutations over the server actions in
 * orderActions.js, whose {data}|{error} envelope is unwrapped here.
 */
import {
    addOrder as addOrderAction,
    appendRoundToOrder as appendRoundToOrderAction,
    settleOrder as settleOrderAction,
    cancelOrder as cancelOrderAction,
    bumpOrder as bumpOrderAction,
    setMenuItemAvailability as setMenuItemAvailabilityAction,
    findCustomerByPhone as findCustomerByPhoneAction,
    getWaiters as getWaitersAction,
} from '@/lib/orderActions';
import { getEffectiveSettings } from '@/app/settings/actions';
import { DEFAULT_TAX_RATE } from '@/lib/orderTotals.mjs';

// Mirrored as a literal: the server-side definition lives in a module that
// drags the MySQL driver with it, which has no place in a browser bundle.
export const ORDERS_PAGE_SIZES = [25, 50, 100];

const fetchJson = async (path) => {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try { message = (await res.json())?.error || message; } catch { /* not JSON */ }
        throw new Error(message);
    }
    return res.json();
};

// Envelope from a server action → the old call semantics: data through,
// error rethrown as a real Error for the page's catch/alert path.
const unwrap = (res) => {
    if (res?.error) throw new Error(res.error);
    return res?.data;
};

// ==================== MENU ====================

// The app consumes modifiers keyed by modifier key, not as rows.
const toModifierRecord = (rows) => {
    const record = {};
    for (const mod of rows || []) {
        record[mod.key] = { type: mod.type, name: mod.name, options: mod.options };
    }
    return record;
};

export const getCategories = async () => {
    try {
        return (await fetchJson('/api/menu')).categories || [];
    } catch (e) {
        console.error('Error fetching categories:', e);
        return [];
    }
};

/*
 * What the kitchen has run out of, and whether the till should say so. One
 * object rather than two calls, because the list means nothing without the
 * mode — an empty list and a switched-off gate look identical otherwise.
 */
export const getStockGate = async () => {
    try {
        const menu = await fetchJson('/api/menu');
        return { mode: menu.stockGate || 'off', outOfStock: menu.outOfStock || [] };
    } catch (e) {
        console.error('Error fetching stock gate:', e);
        // A failure must not empty the menu: the till behaves as if nobody
        // asked about stock, which is how it behaved yesterday.
        return { mode: 'off', outOfStock: [] };
    }
};

export const getSalesChannels = async () => {
    try {
        return (await fetchJson('/api/menu')).channels || [];
    } catch (e) {
        console.error('Error fetching channels:', e);
        return [];
    }
};

export const getDeals = async () => {
    try {
        return (await fetchJson('/api/menu')).deals || [];
    } catch (e) {
        console.error('Error fetching deals:', e);
        return [];
    }
};

export const getMenuItems = async () => {
    try {
        return (await fetchJson('/api/menu')).items || [];
    } catch (e) {
        console.error('Error fetching menu items:', e);
        return [];
    }
};

export const getModifiers = async () => {
    try {
        return toModifierRecord((await fetchJson('/api/menu')).modifiers);
    } catch (e) {
        console.error('Error fetching modifiers:', e);
        return [];
    }
};

// One request, not three: the route already returns the menu whole.
export const getFullMenuData = async () => {
    try {
        const { categories, items, modifiers } = await fetchJson('/api/menu');
        return {
            categories: categories || [],
            items: items || [],
            modifiers: toModifierRecord(modifiers),
        };
    } catch (e) {
        console.error('Error fetching menu data:', e);
        return { categories: [], items: [], modifiers: [] };
    }
};

// ==================== ORDER READS ====================

/*
 * THROWS on failure, and that is the whole point.
 *
 * This used to swallow the error and return [], which the kitchen display
 * could not tell from "there is no food to cook". One failed poll — a restart,
 * a pool hiccup, a 500 — therefore did two things: it blanked the board to
 * "No tickets" mid-service, and it emptied the board's memory of which
 * tickets it had already seen. The next successful poll then treated EVERY
 * live ticket as brand new: it chimed, and it spooled every one of them to the
 * kitchen printer as fresh food to cook, unmarked as a reprint.
 *
 * The caller now decides what a failure means, which is the only place that
 * can know: for the board it means "keep showing what you have and say you
 * have lost contact".
 */
export const getKitchenOrders = async () => fetchJson('/api/orders/kitchen');

export const getOpenTabs = async () => {
    try {
        const rows = await fetchJson('/api/orders/open');
        // The server reads tabs oldest-first; this rail has always shown the
        // newest tab first, so the old order is restored at the seam.
        return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } catch (e) {
        console.error('Error fetching open tabs:', e);
        return [];
    }
};

export const getUnpaidOrdersCount = async () => {
    try {
        return (await fetchJson('/api/orders/unpaid-count')).count ?? 0;
    } catch (e) {
        console.error('Error counting unpaid orders:', e);
        return 0;
    }
};

export const getOrdersPage = async ({
    page = 1,
    pageSize = 25,
    status = 'all',
    orderType = 'all',
    from = null,
    to = null,
    sort = 'newest',
    search = '',
    channel = 'all',
    paymentMode = 'all',
} = {}) => {
    try {
        const params = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            status,
            orderType,
            sort,
            search,
            channel: String(channel),
            paymentMode,
        });
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const { rows, total, revenue, unpaid } = await fetchJson(`/api/orders?${params}`);
        return { rows: rows || [], total: total ?? 0, revenue: revenue ?? 0, unpaid: unpaid ?? 0 };
    } catch (e) {
        console.error('Error fetching orders page:', e);
        return { rows: [], total: 0, revenue: 0, unpaid: 0 };
    }
};

// ==================== TAX RATES ====================

/*
 * Both live GST rates in one read, cached for the page's lifetime: consulted
 * on every price calculation, changed perhaps once a year. An admin who
 * edits a rate sees it on the till's next reload — the right trade against a
 * round trip per keystroke in the cart. Falls back rather than throwing: a
 * till that cannot read a setting must still be able to price an order.
 * (The single getTaxRate went with the single rate — tax is per payment
 * method now, and the till reprices as the selected mode changes.)
 */
let taxRatesCache = null;

export const getTaxRates = async () => {
    if (taxRatesCache !== null) return taxRatesCache;
    let row = null;
    try {
        row = await getEffectiveSettings();
    } catch (e) {
        console.error('Error fetching tax rates:', e);
    }
    taxRatesCache = {
        cash: row?.tax_rate_cash == null ? DEFAULT_TAX_RATE : Number(row.tax_rate_cash),
        card: row?.tax_rate_card == null ? DEFAULT_TAX_RATE : Number(row.tax_rate_card),
    };
    return taxRatesCache;
};

// ==================== MUTATIONS ====================

export const addOrder = async (order) =>
    unwrap(await addOrderAction(order));

export const appendRoundToOrder = async (orderId, newItems, details = {}, options = {}) =>
    unwrap(await appendRoundToOrderAction(orderId, newItems, details, options));

export const settleOrder = async (orderId, opts = {}) =>
    unwrap(await settleOrderAction(orderId, opts));

export const cancelOrder = async (orderId, opts = {}) =>
    unwrap(await cancelOrderAction(orderId, opts));

export const bumpOrder = async (orderId, fromStatus, toStatus) =>
    unwrap(await bumpOrderAction(orderId, fromStatus, toStatus));

export const setMenuItemAvailability = async (id, isAvailable) =>
    unwrap(await setMenuItemAvailabilityAction(id, isAvailable));

// ==================== SALE-ADJACENT READS ====================
// Served by actions rather than routes, but reads all the same: they log
// and fall back instead of throwing.

export const findCustomerByPhone = async (phone) => {
    if (!phone) return null;
    try {
        return unwrap(await findCustomerByPhoneAction(phone));
    } catch (e) {
        console.error('Error looking up customer:', e);
        return null;
    }
};

export const getWaiters = async () => {
    try {
        return unwrap(await getWaitersAction()) || [];
    } catch (e) {
        console.error('Error fetching waiters:', e);
        return [];
    }
};

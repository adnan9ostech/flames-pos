/*
 * The scanners behind the bell: everything the system can work out for itself
 * about the state of the shop, recomputed on every read.
 *
 * WHY ON READ, and not on a schedule. This app runs no worker — the day closes
 * because somebody presses a button, by the owner's decision, and the FBR queue
 * is a script somebody starts. Adding a cron to keep a notice board warm would
 * be the one background job in the building, and a notice board nobody is
 * looking at does not need to be up to date. So the bell scans when it is read:
 * four small aggregates, none of them on a hot path.
 *
 * Each scanner returns the WHOLE truth for the kinds it owns, and the caller
 * resolves anything it did not mention. That is what lets the list empty
 * itself when a problem goes away.
 */
import { query } from '../db/pool.mjs';
import { karachiDay } from '../day/karachi.mjs';
import { raiseNotification, resolveMissing, BRANCH_ID } from '../db/notifications.mjs';

// A tab this old is not a long dinner, it is a bill somebody forgot. Three
// hours clears a leisurely dine-in and still catches a table that walked.
const STALE_TAB_HOURS = 3;

// The kinds the scanners own outright — the caller resolves whatever these
// scans do not re-state. 'print_failed' is deliberately NOT here: it is an
// event with no live condition to re-test, and it is cleared by hand or by
// the end of its business day.
export const DERIVED_KINDS = ['low_stock', 'day_open', 'fbr_failed', 'tab_stale'];

const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK')}`;
const asDay = (v) => String(v instanceof Date ? v.toISOString().slice(0, 10) : v).slice(0, 10);

/*
 * Ingredients at or under their reorder level.
 *
 * Only items that HAVE a reorder level: zero means "nobody has said what low
 * is for this one", and treating that as "low at zero" would alarm on all 167
 * ingredients the moment a shelf count went negative. Today every level is
 * zero, so this scanner is correctly silent until the kitchen sets them.
 */
const scanLowStock = async () => {
    const rows = await query(
        `SELECT i.id, i.name, i.reorder_level, u.abbrev,
                COALESCE(SUM(l.delta), 0) AS on_hand
           FROM inventory_items i
           JOIN units u ON u.id = i.unit_id
           LEFT JOIN stock_ledger l ON l.inventory_item_id = i.id
          WHERE i.is_active = 1 AND i.reorder_level > 0
          GROUP BY i.id, i.name, i.reorder_level, u.abbrev
         HAVING on_hand <= i.reorder_level`,
    );
    return rows.map((r) => ({
        kind: 'low_stock',
        severity: Number(r.on_hand) <= 0 ? 'urgent' : 'warn',
        title: `${r.name} is ${Number(r.on_hand) <= 0 ? 'out of stock' : 'running low'}`,
        body: `${Number(r.on_hand).toLocaleString('en-PK')} ${r.abbrev} on hand, reorder at ${Number(r.reorder_level).toLocaleString('en-PK')} ${r.abbrev}.`,
        href: '/inventory/reports',
        permission: 'inventory',
        dedupeKey: `low_stock:${r.id}`,
    }));
};

/*
 * A business day still open after its own day is over.
 *
 * Not "open" on its own — the day is meant to be open all service. This is for
 * the morning after: yesterday never closed, so yesterday's cash was never
 * counted and today's takings are landing in it.
 */
const scanOpenDay = async () => {
    const today = karachiDay();
    const rows = await query(
        `SELECT business_date FROM business_days
          WHERE branch_id = ? AND closed_at IS NULL AND business_date < ?
          ORDER BY business_date`,
        [BRANCH_ID, today],
    );
    return rows.map((r) => {
        const day = asDay(r.business_date);
        return {
            kind: 'day_open',
            severity: 'urgent',
            title: `${day} was never closed`,
            body: 'Its cash has not been counted, and today’s sales are still landing in it. Close it from Day Close.',
            href: '/dayclose',
            permission: 'dayclose',
            dedupeKey: `day_open:${day}`,
        };
    });
};

/* Invoices the FBR queue has given up on. One notice, however many rows. */
const scanFbrFailures = async () => {
    const [row] = await query(
        "SELECT COUNT(*) AS n, MAX(last_error) AS last_error FROM fbr_invoices WHERE status = 'failed'",
    );
    if (!row || !Number(row.n)) return [];
    return [{
        kind: 'fbr_failed',
        severity: 'warn',
        title: `${row.n} invoice${Number(row.n) === 1 ? '' : 's'} failed to reach FBR`,
        body: (row.last_error || 'The queue stopped retrying them.').slice(0, 480),
        href: '/settings/tax',
        permission: 'settings',
        dedupeKey: 'fbr_failed',
    }];
};

/*
 * Unpaid tabs sitting too long. One notice per table, because "three tables
 * are stale" is not actionable and "order #41, table 6, Rs. 8,400, four hours"
 * is somebody walking over to table 6.
 */
const scanStaleTabs = async () => {
    const rows = await query(
        `SELECT id, order_number, table_number, total,
                TIMESTAMPDIFF(MINUTE, COALESCE(last_round_at, created_at), UTC_TIMESTAMP(3)) AS mins
           FROM orders
          WHERE payment_status = 'unpaid' AND status NOT IN ('cancelled', 'void')
         HAVING mins >= ?`,
        [STALE_TAB_HOURS * 60],
    );
    return rows.map((r) => ({
        kind: 'tab_stale',
        severity: 'warn',
        title: `Order #${r.order_number} has been open ${Math.floor(r.mins / 60)}h`,
        body: `${r.table_number ? `Table ${r.table_number}` : 'No table'} — ${money(r.total)} unpaid.`,
        href: '/orders',
        permission: null,
        dedupeKey: `tab_stale:${r.id}`,
    }));
};

/*
 * Yesterday's raised events, swept.
 *
 * A print that failed is real and worth shouting about while the shift can
 * still reprint it. The next morning it is noise, and noise at the top of a
 * notice board is how a notice board dies.
 */
const sweepStaleEvents = async () => {
    await query(
        `UPDATE notifications
            SET resolved_at = UTC_TIMESTAMP(3)
          WHERE resolved_at IS NULL AND kind = 'print_failed'
            AND (business_date IS NULL OR business_date < ?)`,
        [karachiDay()],
    );
};

/*
 * Run every scanner and reconcile. Returns nothing — the caller reads the
 * board afterwards, filtered by what that person is allowed to see.
 */
export const scanNotifications = async () => {
    const found = (await Promise.all([
        scanLowStock(), scanOpenDay(), scanFbrFailures(), scanStaleTabs(),
    ])).flat();

    for (const n of found) await raiseNotification(n);
    await resolveMissing(DERIVED_KINDS, found.map((n) => n.dedupeKey));
    await sweepStaleEvents();
};

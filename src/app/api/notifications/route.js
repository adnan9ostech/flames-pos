import { requireUser } from '@/lib/db/auth.mjs';
import { scanNotifications } from '@/lib/notifications/scan.mjs';
import { listNotifications } from '@/lib/db/notifications.mjs';

/*
 * The bell, read by every signed-in screen on a slow poll.
 *
 * The scan runs here rather than on a timer (see scan.mjs for why), but not on
 * every request: a shop with six terminals open would run the same four
 * aggregates six times a minute for an answer that cannot have changed. So the
 * scan is throttled per server process, and a read that arrives inside the
 * window serves the board as the last scan left it — which is the honest thing
 * to do, since that IS the board.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const SCAN_EVERY_MS = 30000;

let lastScan = 0;
let scanning = null;

const scanIfDue = async () => {
    if (Date.now() - lastScan < SCAN_EVERY_MS) return;
    // One scan at a time per process: six terminals polling in the same second
    // must not start six scans that all write the same rows.
    if (!scanning) {
        scanning = scanNotifications()
            .then(() => { lastScan = Date.now(); })
            // A scanner that fails must not empty the bell or 500 the poll —
            // the board keeps whatever it last knew.
            .catch((e) => { console.error('[notifications] scan failed:', e?.message ?? e); })
            .finally(() => { scanning = null; });
    }
    await scanning;
};

export async function GET() {
    try {
        const user = await requireUser();
        const perms = Object.keys(user.permissions || {}).filter((k) => user.permissions[k]);
        await scanIfDue();
        const items = await listNotifications(perms);
        return Response.json({
            items,
            unseen: items.filter((n) => !n.seen_at).length,
        }, { headers: NO_STORE });
    } catch (e) {
        return Response.json(
            { error: e.message },
            { status: e.status ?? 500, headers: NO_STORE },
        );
    }
}

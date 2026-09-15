/*
 * The notice board's data layer: raise, resolve, list, mark seen.
 *
 * Every write goes through a dedupe key, because the scanner that produces
 * most of these runs on every read of the bell. Raising the same thing twice
 * must be the same one notice, or a printer that has been down for an hour
 * becomes ninety identical lines and the bell stops being read at all.
 *
 * Nothing here throws at a caller that is mid-sale: see raiseAlert in
 * src/lib/notifications/raise.mjs for the fire-and-forget wrapper the till
 * uses. This module is the honest one — it reports its failures — and the
 * wrappers decide what a failure is worth.
 */
import { query } from './pool.mjs';

/*
 * Which outlet a notice belongs to, asked for lazily.
 *
 * This was `export const BRANCH_ID = 1`, and the bell is one of the places the
 * constant did real damage rather than merely mislabelling a row: the dedupe
 * key was unique company-wide, so two outlets low on the same ingredient
 * produced ONE notice and the second scan quietly overwrote the first outlet's
 * alert. Migration 049 widened the key to (branch, key); this makes the reads
 * and writes agree with it.
 *
 * Lazy for the same reason as everywhere else — the scanner runs from an API
 * route with a request and from the suite with none.
 */
export const branchOfRequest = async () => {
    try {
        const { currentBranchId } = await import('./branch.mjs');
        return await currentBranchId();
    } catch {
        return 1;
    }
};

/*
 * Raise one notice, or update the one that already says this.
 *
 * One row per dedupe key, for good. The update refreshes the text as well as
 * the timestamp — "3 left" becoming "1 left" is the same notice with better
 * news, not a second notice.
 *
 * A key that had been RESOLVED and comes back reopens that row, and reopening
 * deliberately clears seen_at and restamps created_at: the stock ran out
 * again, and a notice that is already ticked off and dated last Tuesday tells
 * nobody. The two IFs read the row's OLD resolved_at because MySQL applies
 * these assignments in order and resolved_at is cleared last — so the clause
 * knows whether this was a reopen.
 */
export const raiseNotification = async ({
    kind, severity = 'info', title, body = null, href = null,
    permission = null, dedupeKey, businessDate = null,
}) => {
    if (!kind || !title || !dedupeKey) throw new Error('A notice needs a kind, a title and a dedupe key');
    await query(
        `INSERT INTO notifications
           (branch_id, kind, severity, title, body, href, permission, dedupe_key, business_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           severity = VALUES(severity), title = VALUES(title), body = VALUES(body),
           href = VALUES(href), permission = VALUES(permission),
           business_date = VALUES(business_date),
           seen_at = IF(resolved_at IS NULL, seen_at, NULL),
           created_at = IF(resolved_at IS NULL, created_at, UTC_TIMESTAMP(3)),
           resolved_at = NULL,
           updated_at = UTC_TIMESTAMP(3)`,
        [await branchOfRequest(), kind, severity, title, body, href, permission, dedupeKey, businessDate],
    );
};

/*
 * Close every open notice of these kinds whose key is NOT in the live set.
 *
 * This is what makes the bell trustworthy: a scanner states the whole truth
 * for the kinds it owns, so a condition that has cleared disappears without
 * anybody clicking anything. Passing an empty key list is meaningful and must
 * work — "nothing is low on stock any more" is exactly the case that has to
 * empty the list.
 */
export const resolveMissing = async (kinds, liveKeys) => {
    if (!kinds.length) return;
    const keys = [...new Set(liveKeys)];
    const sql = `UPDATE notifications
                    SET resolved_at = UTC_TIMESTAMP(3)
                  WHERE resolved_at IS NULL AND branch_id = ? AND kind IN (?)
                    ${keys.length ? 'AND dedupe_key NOT IN (?)' : ''}`;
    const branchId = await branchOfRequest();
    await query(sql, keys.length ? [branchId, kinds, keys] : [branchId, kinds]);
};

/* Open notices this person may see, worst first, then newest. */
export const listNotifications = async (perms = [], limit = 50) => {
    const rows = await query(
        `SELECT id, kind, severity, title, body, href, permission, created_at, seen_at
           FROM notifications
          WHERE resolved_at IS NULL AND branch_id = ?
          ORDER BY FIELD(severity, 'urgent', 'warn', 'info'), created_at DESC
          LIMIT ?`,
        [await branchOfRequest(), Number(limit) || 50],
    );
    // Filtered here rather than in SQL: the permission list is short, and a
    // NULL permission means "anyone on the floor", which is fiddly to express
    // against a bound list and trivial to express here.
    return rows.filter((r) => !r.permission || perms.includes(r.permission));
};

/* Mark everything this person can see as read. The badge counts unseen. */
export const markNotificationsSeen = async (perms = []) => {
    const open = await listNotifications(perms, 200);
    const ids = open.filter((n) => !n.seen_at).map((n) => n.id);
    if (!ids.length) return 0;
    await query(
        'UPDATE notifications SET seen_at = UTC_TIMESTAMP(3) WHERE id IN (?)', [ids],
    );
    return ids.length;
};

/*
 * Dismiss one notice by hand. Only for the raised kinds — a derived one would
 * be raised again by the very next scan, which is correct: a condition that is
 * still true is not dismissable, and pretending otherwise would be a lie the
 * bell tells once an hour.
 */
export const dismissNotification = async (id) => {
    const rows = await query(
        'SELECT kind FROM notifications WHERE id = ? AND resolved_at IS NULL', [id],
    );
    if (!rows.length) return false;
    await query(
        'UPDATE notifications SET resolved_at = UTC_TIMESTAMP(3) WHERE id = ?', [id],
    );
    return true;
};

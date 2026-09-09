/*
 * The Menu kit: rules.mjs plus the server-only pieces a menu action needs.
 * Plain Node and relative imports, like the Accounts kit, so a bare
 * `node --test` can load it. The audit writer, business-day resolver and
 * rupee rounding come from the Accounts kit rather than being restated — the
 * cleanup audit counted nineteen copies of the audit writer; this is not
 * the twentieth.
 */
import path from 'node:path';
import { audit, businessDate, currentBusinessDate, money, requireId } from '../accounts/kit.mjs';

export * from './rules.mjs';
export { audit, businessDate, currentBusinessDate, money, requireId };

/*
 * Where uploaded photos live: UPLOAD_DIR, or ./uploads beside the checkout.
 * Outside public/ on purpose — `next start` serves only what public/ held at
 * build time (probed: a file dropped in afterwards 404s) — and outside the
 * git tree so a deploy never carries or clobbers them.
 */
export const uploadDir = () => path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
export const menuImageDir = () => path.join(uploadDir(), 'menu-images');

/* MySQL's duplicate-key error, worded for the person at the screen. */
export const friendlyDup = (e, what) =>
    (e?.code === 'ER_DUP_ENTRY' ? `A ${what} with that name already exists` : e?.message);

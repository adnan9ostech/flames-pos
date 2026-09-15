import 'server-only';
import { audit as auditKit } from './kit.mjs';

/*
 * The Next-side face of the Accounts kit. Everything lives in kit.mjs (plain
 * Node, so the posting engines and the test suite can load it); this file
 * exists so a server action can say `import ... from '@/lib/accounts/helpers.mjs'`
 * and be certain it is running on the server.
 */
export {
    requestBranchId, money, ymd, todayKarachi, karachiDayOf, clip,
    currentBusinessDate, businessDate, nextVoucherNo, requireId, requireDate,
} from './kit.mjs';

/* The positional form the action files were written against. */
export const audit = (conn, bd, action, details, userId = null) =>
    auditKit(conn, { bd, action, details, userId });

'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { businessDate, money, ymd } from '@/lib/accounts/helpers.mjs'

/*
 * The four numbers on the hub. One round trip: the cards are read as one
 * screen and must never disagree with each other while they load.
 */
export async function getAccountsOverview() {
    try {
        await requirePermission('accounts')
        const bd = await businessDate()

        const [[journals], [settings], [unposted], [payables], [drafts], [chart]] = await Promise.all([
            query(
                `SELECT COUNT(*) AS n, COALESCE(SUM(debit_total), 0) AS amount
                   FROM gl_journals WHERE business_date = ? AND status = 'posted'`,
                [bd],
            ),
            query('SELECT start_date, posting_enabled FROM gl_settings WHERE id = 1'),
            // Settled bills the ledger has not caught up with. Zero is the
            // only good number; anything else is the Health screen's job.
            query(
                `SELECT COUNT(*) AS n
                   FROM orders o
                   LEFT JOIN gl_journals j
                     ON j.source_type = 'order_sale' AND j.source_id = o.id
                  WHERE o.payment_status = 'paid'
                    AND o.business_date >= (SELECT start_date FROM gl_settings WHERE id = 1)
                    AND j.id IS NULL`,
            ),
            query(
                `SELECT COUNT(*) AS n, COALESCE(SUM(total - paid_total), 0) AS amount
                   FROM expense_vouchers
                  WHERE status = 'posted' AND paid_total < total`,
            ),
            query(`SELECT COUNT(*) AS n FROM expense_vouchers WHERE status = 'draft'`),
            query(`SELECT COUNT(*) AS n FROM accounts WHERE is_active = 1`),
        ])

        return {
            data: {
                businessDate: bd,
                startDate: settings ? ymd(settings.start_date) : null,
                postingEnabled: Boolean(settings?.posting_enabled),
                journalsToday: { count: Number(journals.n), amount: money(journals.amount) },
                unpostedSettled: Number(unposted.n),
                openPayables: { count: Number(payables.n), amount: money(payables.amount) },
                draftVouchers: Number(drafts.n),
                activeAccounts: Number(chart.n),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

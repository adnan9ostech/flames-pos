'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { businessDate, requireDate, todayKarachi, ymd } from '@/lib/accounts/helpers.mjs'
import { postManualJournal } from './manualJournal.mjs'

/*
 * The manual journal voucher (ChowPOS "Add Transaction"). Reading the form's
 * pickers needs `accounts`; posting needs `accounts_admin`, because a hand-
 * written journal can move anything anywhere and there is no draft to
 * review first.
 */

/* What the form needs before it can draw: the pickable accounts, the day
 * to default the date to, and the opening-equity account for opening mode. */
export async function getJournalForm() {
    try {
        await requirePermission('accounts')
        const [accounts, settings, bd] = await Promise.all([
            query(
                `SELECT id, account_number, name, account_group
                   FROM accounts
                  WHERE is_active = 1
                  ORDER BY account_number`,
            ),
            query('SELECT start_date, opening_equity_account_id FROM gl_settings WHERE id = 1'),
            businessDate(),
        ])
        return {
            data: {
                businessDate: bd,
                today: todayKarachi(),
                startDate: settings[0] ? ymd(settings[0].start_date) : null,
                openingEquityAccountId: settings[0] ? Number(settings[0].opening_equity_account_id) : null,
                accounts: accounts.map((a) => ({
                    id: Number(a.id),
                    account_number: a.account_number,
                    name: a.name,
                    account_group: a.account_group,
                })),
            },
        }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Post it. The browser has already refused an unbalanced voucher; the
 * server refuses again in cleanLines, and the CHECK constraint on
 * gl_journals would refuse a third time. Returns the header written, so
 * the page can go straight to the voucher.
 */
export async function postJournalVoucher(input) {
    try {
        const user = await requirePermission('accounts_admin')
        const bd = requireDate(input?.business_date, 'voucher date')

        // Not ahead of the books: the later of today and the open trading
        // day (which can be tomorrow's date after a late-night close).
        const limit = [await businessDate(), todayKarachi()].sort().at(-1)
        if (bd > limit) throw new Error(`The voucher date cannot be after ${limit}`)

        const posted = await postManualJournal({
            businessDate: bd,
            description: input?.description,
            reference: input?.reference,
            notes: input?.notes,
            lines: input?.lines,
            userId: user.id,
        })
        return { data: posted }
    } catch (e) {
        return { error: e.message }
    }
}

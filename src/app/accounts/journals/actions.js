'use server'

import { requirePermission } from '@/lib/db/auth.mjs'
import { currentBranchId } from '@/lib/db/branch.mjs'
import { requireId, requireDate } from '@/lib/accounts/helpers.mjs'
import { VOUCHER_TYPES } from '@/lib/accounts/constants.mjs'
import {
    ledgerLines, journalList, journalById, accountOptions, reverseJournal as reverseJournalTx,
    PAGE_SIZE, EXPORT_LIMIT,
} from '../ledger/gl.mjs'

/*
 * Reading the books: the ledger, the voucher list, one voucher. Anyone with
 * `accounts` may look. The one write here — reverseJournal — is a contra
 * journal, never an edit, and needs `accounts_admin` because it changes what
 * every statement says from that day on.
 */

/*
 * What a browser form sends, checked before it reaches SQL. A blank range
 * means "the current business day" and is resolved server-side, so the
 * screen learns the day from the response rather than guessing it.
 */
const cleanFilters = (input = {}, branchId = null) => {
    const from = String(input.from || '').trim()
    const to = String(input.to || '').trim()
    const voucherType = String(input.voucherType || '').trim().toUpperCase()
    if (voucherType && voucherType !== 'ALL' && !VOUCHER_TYPES[voucherType]) {
        throw new Error('Unknown voucher type')
    }
    return {
        from: from ? requireDate(from, 'from date') : null,
        to: to ? requireDate(to, 'to date') : null,
        voucherType: voucherType && voucherType !== 'ALL' ? voucherType : null,
        accountId: input.accountId ? requireId(input.accountId, 'account') : null,
        // The outlet whose ledger this is. gl.mjs refuses without it rather
        // than defaulting, because a screen that forgot would otherwise show
        // another outlet's journals under this outlet's name.
        branchId,
    }
}

const cleanPage = (input = {}) => ({
    offset: Math.max(0, Math.trunc(Number(input.offset) || 0)),
    limit: Math.min(EXPORT_LIMIT, Math.max(1, Math.trunc(Number(input.limit) || PAGE_SIZE))),
})

/*
 * GL Transaction: posted lines for a date range, optionally one account
 * and/or one voucher type. Paged; totals cover the whole filtered set.
 * { from, to, accountId, voucherType, offset, limit }
 */
export async function listLedgerLines(input) {
    try {
        const user = await requirePermission('accounts')
        const data = await ledgerLines(cleanFilters(input, await currentBranchId(user)), cleanPage(input))
        return { data }
    } catch (e) {
        return { error: e.message }
    }
}

/* Voucher list: one row per journal. { from, to, voucherType, offset, limit } */
export async function listJournals(input) {
    try {
        const user = await requirePermission('accounts')
        const data = await journalList(cleanFilters(input, await currentBranchId(user)), cleanPage(input))
        return { data }
    } catch (e) {
        return { error: e.message }
    }
}

/* One voucher with its lines, its reversal (if any) and what it reverses. */
export async function getJournal(id) {
    try {
        await requirePermission('accounts')
        const journal = await journalById(requireId(id, 'voucher'))
        if (!journal) throw new Error('That voucher no longer exists')
        return { data: journal }
    } catch (e) {
        return { error: e.message }
    }
}

/* Accounts offered in the ledger's account filter. */
export async function listAccountOptions() {
    try {
        await requirePermission('accounts')
        return { data: await accountOptions() }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * Reverse a posted voucher with a contra JV dated the current open business
 * day. Returns the new voucher's summary. Refused with the reversing
 * voucher's number if it has already been done.
 */
export async function reverseJournal(id) {
    try {
        const user = await requirePermission('accounts_admin')
        const data = await reverseJournalTx(requireId(id, 'voucher'), { userId: user.id })
        return { data }
    } catch (e) {
        return { error: e.message }
    }
}

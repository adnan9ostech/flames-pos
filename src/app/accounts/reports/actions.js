'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { currentBranchId } from '@/lib/db/branch.mjs'
import { businessDate, requireDate, requireId } from '@/lib/accounts/helpers.mjs'
import {
    trialBalance, incomeStatement, balanceSheet, cashAccounts, cashRegister,
} from '@/lib/accounts/statements.mjs'

/*
 * The four statements, read by anyone with `accounts`. Every figure comes
 * from statements.mjs, which the Excel route also reads — so what is on
 * the screen, in the CSV and in the workbook is one computation.
 *
 * Each response carries `meta`: the restaurant's name for the printed
 * heading and the open business day, which is the default "as at" date.
 */
const meta = async () => {
    const [settings, bd] = await Promise.all([
        query('SELECT merchant_name, brand_name FROM store_settings LIMIT 1'),
        businessDate(),
    ])
    return {
        merchantName: settings[0]?.merchant_name || settings[0]?.brand_name || '',
        businessDate: bd,
    }
}

/* A from/to pair as 'YYYY-MM-DD', in order. */
const cleanRange = (input) => {
    const from = requireDate(input?.from, 'start date')
    const to = requireDate(input?.to, 'end date')
    if (from > to) throw new Error('The start date must be on or before the end date')
    return { from, to }
}

export async function getTrialBalance(input) {
    try {
        const user = await requirePermission('accounts')
        // The outlet these books belong to. The ledger is written per branch;
        // reading it consolidated showed neither outlet's books, only their sum.
        const branchId = await currentBranchId(user)
        const range = cleanRange(input)
        const [data, m] = await Promise.all([trialBalance({ ...range, branchId }), meta()])
        return { data: { ...data, meta: m } }
    } catch (e) {
        return { error: e.message }
    }
}

export async function getIncomeStatement(input) {
    try {
        const user = await requirePermission('accounts')
        // The outlet these books belong to. The ledger is written per branch;
        // reading it consolidated showed neither outlet's books, only their sum.
        const branchId = await currentBranchId(user)
        const range = cleanRange(input)
        const [data, m] = await Promise.all([incomeStatement({ ...range, branchId }), meta()])
        return { data: { ...data, meta: m } }
    } catch (e) {
        return { error: e.message }
    }
}

export async function getBalanceSheet(input) {
    try {
        const user = await requirePermission('accounts')
        // The outlet these books belong to. The ledger is written per branch;
        // reading it consolidated showed neither outlet's books, only their sum.
        const branchId = await currentBranchId(user)
        const m = await meta()
        // No date means the open business day — the position as of now.
        const asAt = input?.asAt ? requireDate(input.asAt, 'as-at date') : m.businessDate
        const data = await balanceSheet({ asAt, branchId })
        return { data: { ...data, meta: m } }
    } catch (e) {
        return { error: e.message }
    }
}

export async function getCashRegister(input) {
    try {
        const user = await requirePermission('accounts')
        // The outlet these books belong to. The ledger is written per branch;
        // reading it consolidated showed neither outlet's books, only their sum.
        const branchId = await currentBranchId(user)
        const range = cleanRange(input)
        let accountId = input?.accountId ? requireId(input.accountId, 'account') : null
        const offered = await cashAccounts()
        if (!accountId) accountId = offered.defaultId
        if (!accountId) throw new Error('No cash account is set up: an active asset account needs both AR_PAID and AP_PAID')
        // The selector only offers drawer/safe/bank accounts, and the query
        // honours the same list — a hand-typed id cannot read another account.
        if (!offered.accounts.some((a) => a.id === accountId)) {
            throw new Error('That account is not a cash or bank account')
        }
        const [data, m] = await Promise.all([cashRegister({ accountId, ...range, branchId }), meta()])
        return { data: { ...data, accounts: offered.accounts, meta: m } }
    } catch (e) {
        return { error: e.message }
    }
}

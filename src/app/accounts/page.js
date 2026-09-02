'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import styles from './accounts.module.css'
import { getAccountsOverview } from './actions'
import {
    BookOpen, ScrollText, FilePlus2, Files,
    ReceiptText, FolderOpen, Hash, FileSpreadsheet, Scale, TrendingUp, Landmark, Banknote,
    BookMarked, AlertTriangle, Loader2, ChevronRight, CheckCircle2, Wallet, PenLine,
} from 'lucide-react'

/*
 * The hub, laid out the way ChowPOS lays out its Accounts Dashboard — the
 * owner walked that screen and asked for every tile on it, so the four groups
 * and sixteen destinations are reproduced rather than reorganised. The strip
 * above is where the reorganising happened.
 */
const GROUPS = [
    {
        title: 'GL Transactions',
        tiles: [
            { href: '/accounts/chart', Icon: BookOpen, title: 'Chart of Accounts', blurb: 'Every account the books are kept in' },
            { href: '/accounts/ledger', Icon: ScrollText, title: 'GL Transaction', blurb: 'Every posted line, filtered by date and account' },
            { href: '/accounts/journals/new', Icon: FilePlus2, title: 'Add Transaction', blurb: 'A manual journal voucher — debits must equal credits' },
            { href: '/accounts/journals', Icon: Files, title: 'Voucher List', blurb: 'All vouchers, machine-posted and manual' },
        ],
    },
    {
        title: 'Expense',
        tiles: [
            { href: '/accounts/expense-vouchers/new', Icon: ReceiptText, title: 'Add Expense Voucher', blurb: 'Record spending — draft until you post it' },
            { href: '/accounts/expense-vouchers', Icon: Files, title: 'Expense Voucher List', blurb: 'Drafts, posted, and what is still owed' },
            { href: '/accounts/expense-categories?new=1', Icon: FolderOpen, title: 'Add Expense Category', blurb: 'A heading codes are grouped under' },
            { href: '/accounts/expense-categories', Icon: FolderOpen, title: 'Expense Category List', blurb: 'Utilities, salaries, rent…' },
            { href: '/accounts/expense-codes?new=1', Icon: Hash, title: 'Add Expense Code', blurb: 'What a voucher line picks; carries its accounts' },
            { href: '/accounts/expense-codes', Icon: Hash, title: 'Expense Code List', blurb: 'Every code and the account it posts to' },
        ],
    },
    {
        title: 'Expense Reports',
        tiles: [
            { href: '/accounts/reports/expenses', Icon: FileSpreadsheet, title: 'Expense Report', blurb: 'Spending by code and category, for a date range' },
            { href: '/accounts/reports/payables', Icon: FileSpreadsheet, title: 'Expense Payables Report', blurb: 'Posted vouchers not yet fully paid' },
        ],
    },
    {
        title: 'Account Reports',
        tiles: [
            { href: '/accounts/reports/trial-balance', Icon: Scale, title: 'Trial Balance', blurb: 'Opening, movement and closing for every account' },
            { href: '/accounts/reports/income-statement', Icon: TrendingUp, title: 'Income Statement', blurb: 'Revenue, cost of sales, expenses, net profit' },
            { href: '/accounts/reports/balance-sheet', Icon: Landmark, title: 'Balance Sheet', blurb: 'Assets, liabilities and equity at a date' },
            { href: '/accounts/reports/cash-register', Icon: Banknote, title: 'Cash Register', blurb: 'Every rupee into and out of cash, by day' },
        ],
    },
]

const rupees = (n) => `Rs. ${Number(n).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export default function AccountsHub() {
    const [stats, setStats] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        getAccountsOverview().then((res) => {
            if (res.error) setError(res.error)
            else setStats(res.data)
        })
    }, [])

    const loading = <Loader2 size={18} className={styles.spinner} />
    const healthy = stats && stats.unpostedSettled === 0

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Accounts</h1>
                    <p className={styles.subtitle}>
                        Double-entry books. Sales post themselves at settle; expenses post when you post the voucher.
                    </p>
                </div>
            </div>

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    {error}
                </div>
            )}

            <div className={styles.statsRow}>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}><BookMarked size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Posted today</div>
                        <div className={styles.statValue}>
                            {stats ? stats.journalsToday.count : loading}
                        </div>
                        <div className={styles.statHint}>
                            {stats ? `${rupees(stats.journalsToday.amount)} across the journals for ${stats.businessDate}` : 'vouchers on the open business day'}
                        </div>
                    </div>
                </div>

                <div className={styles.statCard}>
                    <div className={`${styles.statIcon} ${stats && !healthy ? styles.warnIcon : ''}`}>
                        {healthy ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
                    </div>
                    <div>
                        <div className={styles.statLabel}>Bills not in the ledger</div>
                        <div className={`${styles.statValue} ${stats && !healthy ? styles.warnValue : ''}`}>
                            {stats ? stats.unpostedSettled : loading}
                        </div>
                        <div className={styles.statHint}>
                            {healthy ? 'Every settled bill has posted' : 'Settled bills with no sale journal yet'}
                        </div>
                    </div>
                </div>

                <div className={styles.statCard}>
                    <div className={styles.statIcon}><Wallet size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Owed on expenses</div>
                        <div className={styles.statValue}>
                            {stats ? rupees(stats.openPayables.amount) : loading}
                        </div>
                        <div className={styles.statHint}>
                            {stats ? `${stats.openPayables.count} posted voucher${stats.openPayables.count === 1 ? '' : 's'} not fully paid` : 'posted vouchers not fully paid'}
                        </div>
                    </div>
                </div>

                <div className={styles.statCard}>
                    <div className={styles.statIcon}><PenLine size={20} /></div>
                    <div>
                        <div className={styles.statLabel}>Draft vouchers</div>
                        <div className={styles.statValue}>
                            {stats ? stats.draftVouchers : loading}
                        </div>
                        <div className={styles.statHint}>Saved but not yet posted — not in the books</div>
                    </div>
                </div>
            </div>

            {GROUPS.map((group) => (
                <section key={group.title} className={styles.group}>
                    <h2 className={styles.groupTitle}>{group.title}</h2>
                    <div className={styles.tileGrid}>
                        {group.tiles.map(({ href, Icon, title, blurb }) => (
                            <Link key={href} href={href} className={styles.tile}>
                                <div className={styles.tileIcon}><Icon size={22} /></div>
                                <div className={styles.tileBody}>
                                    <div className={styles.tileTitle}>{title}</div>
                                    <div className={styles.tileBlurb}>{blurb}</div>
                                </div>
                                <ChevronRight size={18} className={styles.tileArrow} aria-hidden="true" />
                            </Link>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    )
}

'use client'

import Link from 'next/link'
import styles from '../accounts.module.css'
import {
    FileSpreadsheet, Scale, TrendingUp, Landmark, Banknote, ChevronRight,
} from 'lucide-react'

/*
 * The reports hub: the six report tiles ChowPOS's Accounts Dashboard
 * carries, in its two groups. The Expense group's pages belong to the
 * expense-voucher work; the Account group's four are the statements.
 */
const GROUPS = [
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
            { href: '/accounts/reports/cash-register', Icon: Banknote, title: 'Cash Register', blurb: 'Every rupee into and out of cash, with a running balance' },
        ],
    },
]

export default function AccountReportsHub() {
    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Account Reports</h1>
                    <p className={styles.subtitle}>
                        Every report reads the posted ledger as it stands. Print any of them, or take the figures out as CSV or Excel.
                    </p>
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

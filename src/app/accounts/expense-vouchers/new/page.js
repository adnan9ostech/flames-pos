'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import styles from '../../accounts.module.css'
import own from '../voucher.module.css'
import VoucherEditor from '../VoucherEditor'
import { getVoucherFormData } from '../actions'
import { Loader2, AlertTriangle, ArrowLeft } from 'lucide-react'

/*
 * Add Expense Voucher. Both buttons end on the voucher's own page: Save
 * lands on the draft (still editable), Save & Post on the posted document.
 * The one-line confirmation travels in sessionStorage rather than the URL,
 * so the destination needs no useSearchParams and no Suspense boundary.
 */
export default function NewExpenseVoucherPage() {
    const router = useRouter()
    const [formData, setFormData] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        getVoucherFormData().then((res) => {
            if (res.error) setError(res.error)
            else setFormData(res.data)
        })
    }, [])

    const done = (kind, voucher) => {
        try {
            sessionStorage.setItem('ev-flash', kind === 'post'
                ? `${voucher.voucher_no} posted — journal ${voucher.journals.map((j) => j.voucher_no).join(', ')}`
                : `${voucher.voucher_no} saved as a draft`)
        } catch { /* private mode: the page itself says what state it is in */ }
        router.push(`/accounts/expense-vouchers/${voucher.id}`)
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <div className={own.titleRow}>
                        <h1 className={styles.title}>New Expense Voucher</h1>
                        <span className={`${styles.status} ${styles.statusDraft}`}>draft</span>
                    </div>
                    <p className={styles.subtitle}>
                        Each line picks an expense code; the code says which account is debited and which payable is credited until it is paid.
                    </p>
                </div>
                <div className={styles.headerActions}>
                    <Link href="/accounts/expense-vouchers" className={styles.secondaryBtn}>
                        <ArrowLeft size={15} /> Vouchers
                    </Link>
                </div>
            </div>

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            {!formData ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The form could not be prepared.' : 'Loading expense codes…'}</p>
                    </div>
                </div>
            ) : formData.codes.length === 0 ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <AlertTriangle size={28} />
                        <p>There are no active expense codes to pick from.</p>
                        <Link href="/accounts/expense-codes?new=1" className={styles.secondaryBtn}>Add an expense code</Link>
                    </div>
                </div>
            ) : (
                <VoucherEditor formData={formData} onDone={done} />
            )}
        </div>
    )
}

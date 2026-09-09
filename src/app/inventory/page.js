'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import styles from './inventory.module.css'
import { getInventoryOverview } from './actions'
import { usePermissions } from '@/components/Layout/AppLayout'
import {
    Boxes, ChefHat, Truck, ArrowRightLeft, BarChart3,
    Wallet, AlertTriangle, PackageSearch, Loader2, ChevronRight,
} from 'lucide-react'

/* Every inventory surface hangs off this hub. */
const SURFACES = [
    {
        href: '/inventory/masters', Icon: Boxes, title: 'Masters',
        blurb: 'Stock items, units, suppliers and warehouses',
    },
    {
        // Recipes moved under Menu, where the dishes and their sizes live —
        // a recipe is now per size, and it is edited next to the size list
        // that defines it. The shortcut stays here because that is where the
        // hands go, and it needs the `menu` right rather than `inventory`.
        href: '/menu/recipes', Icon: ChefHat, title: 'Recipes', perm: 'menu',
        blurb: 'In Menu — what one sold portion of each size consumes',
    },
    {
        href: '/inventory/receiving', Icon: Truck, title: 'Receiving',
        blurb: 'Goods in — sets average cost and the supplier payable',
    },
    {
        href: '/inventory/docs', Icon: ArrowRightLeft, title: 'Stock Documents',
        blurb: 'Transfers, adjustments, counts and misc consumption',
    },
    {
        href: '/inventory/reports', Icon: BarChart3, title: 'Reports',
        blurb: 'Stock on hand, movement and consumption',
    },
]

const rupees = (n) => `Rs. ${Number(n).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export default function InventoryPage() {
    const { can } = usePermissions()
    const [stats, setStats] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        getInventoryOverview().then((res) => {
            if (res.error) setError(res.error)
            else setStats(res.data)
        })
    }, [])

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Inventory</h1>
                <p className={styles.subtitle}>
                    Stock, recipes and supplier money in one place.
                </p>
            </div>

            {error && (
                <div className={styles.errorNote}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    {error}
                </div>
            )}

            <div className={styles.statsRow}>
                <div className={styles.statCard}>
                    <div className={styles.statIcon}>
                        <PackageSearch size={20} />
                    </div>
                    <div>
                        <div className={styles.statLabel}>Stock value</div>
                        <div className={styles.statValue}>
                            {stats ? rupees(stats.stockValue) : <Loader2 size={18} className={styles.spinner} />}
                        </div>
                        <div className={styles.statHint}>On hand at average cost</div>
                    </div>
                </div>

                <div className={styles.statCard}>
                    <div className={`${styles.statIcon} ${stats?.belowReorder > 0 ? styles.warnIcon : ''}`}>
                        <AlertTriangle size={20} />
                    </div>
                    <div>
                        <div className={styles.statLabel}>Below reorder level</div>
                        <div className={`${styles.statValue} ${stats?.belowReorder > 0 ? styles.warnValue : ''}`}>
                            {stats ? stats.belowReorder : <Loader2 size={18} className={styles.spinner} />}
                        </div>
                        <div className={styles.statHint}>Items due for purchase</div>
                    </div>
                </div>

                <div className={styles.statCard}>
                    <div className={styles.statIcon}>
                        <Wallet size={20} />
                    </div>
                    <div>
                        <div className={styles.statLabel}>Owed to suppliers</div>
                        <div className={styles.statValue}>
                            {stats ? rupees(stats.supplierPayables) : <Loader2 size={18} className={styles.spinner} />}
                        </div>
                        <div className={styles.statHint}>Receivings less payments</div>
                    </div>
                </div>
            </div>

            <div className={styles.tileGrid}>
                {/* A tile that would bounce off the route gate is not a tile. */}
                {SURFACES.filter((s) => !s.perm || can(s.perm)).map(({ href, Icon, title, blurb }) => (
                    <Link key={href} href={href} className={styles.tile}>
                        <div className={styles.tileIcon}>
                            <Icon size={22} />
                        </div>
                        <div className={styles.tileBody}>
                            <div className={styles.tileTitle}>{title}</div>
                            <div className={styles.tileBlurb}>{blurb}</div>
                        </div>
                        <ChevronRight size={18} className={styles.tileArrow} aria-hidden="true" />
                    </Link>
                ))}
            </div>
        </div>
    )
}

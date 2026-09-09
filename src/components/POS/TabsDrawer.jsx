'use client';
import { X, Armchair, UserRound, Layers, Receipt, Plus, ClipboardList } from 'lucide-react';
import { formatNumber as money } from '@/lib/money';
import { formatOrderDate, getOrderNumber } from '@/lib/orderDisplay';
import styles from './TabsDrawer.module.css';

const ORDER_TYPE_LABEL = {
    'dine-in': 'Dine-in',
    'takeaway': 'Takeaway',
    'delivery': 'Delivery'
};

const STATUS_LABEL = {
    new: 'In kitchen',
    preparing: 'Preparing',
    ready: 'Ready to serve',
    completed: 'Served'
};

/*
 * Every unpaid check, so the floor can pick one back up. "Add items" attaches
 * the POS to that tab and the next thing sent becomes its new round; "Settle"
 * jumps straight to the bill.
 */
const TabsDrawer = ({ tabs, activeTabId, onClose, onAttach, onSettle }) => (
    <div className={styles.overlay} onClick={onClose}>
        <aside className={styles.drawer} onClick={e => e.stopPropagation()}>
            <header className={styles.header}>
                <div>
                    <h2>Open Tabs</h2>
                    <p className={styles.sub}>
                        {tabs.length === 0
                            ? 'Nothing waiting to be paid'
                            : `${tabs.length} unpaid ${tabs.length === 1 ? 'check' : 'checks'}`}
                    </p>
                </div>
                <button className={styles.closeBtn} onClick={onClose} aria-label="Close open tabs">
                    <X size={20} />
                </button>
            </header>

            <div className={styles.list}>
                {tabs.length === 0 ? (
                    <div className={styles.empty}>
                        <ClipboardList size={30} />
                        <p>No open tabs.</p>
                        <span>Send an order with &ldquo;Open Tab&rdquo; to start one.</span>
                    </div>
                ) : tabs.map(tab => {
                    const rounds = tab.round_count || 1;
                    const itemCount = tab.items.reduce((sum, i) => sum + i.qty, 0);

                    return (
                        <article
                            key={tab.id}
                            className={`${styles.card} ${tab.id === activeTabId ? styles.cardActive : ''}`}
                        >
                            <div className={styles.cardTop}>
                                <div>
                                    <div className={styles.tabNumber}>#{getOrderNumber(tab)}</div>
                                    <div className={styles.opened}>
                                        Opened {formatOrderDate(tab.created_at)}
                                    </div>
                                </div>
                                <div className={styles.amount}>
                                    Rs. {money(tab.total)}
                                </div>
                            </div>

                            <div className={styles.chips}>
                                <span className={styles.chip}>
                                    {ORDER_TYPE_LABEL[tab.order_type] || tab.order_type}
                                </span>
                                {tab.table_number && (
                                    <span className={styles.chip}>
                                        <Armchair size={12} aria-hidden="true" />
                                        {tab.table_number}
                                    </span>
                                )}
                                {tab.waiter_name && (
                                    <span className={styles.chip}>
                                        <UserRound size={12} aria-hidden="true" />
                                        {tab.waiter_name}
                                    </span>
                                )}
                                <span className={styles.chip}>
                                    <Layers size={12} aria-hidden="true" />
                                    {rounds} {rounds === 1 ? 'round' : 'rounds'} · {itemCount} items
                                </span>
                                <span className={`${styles.chip} ${styles.statusChip}`}>
                                    {STATUS_LABEL[tab.status] || tab.status}
                                </span>
                            </div>

                            <div className={styles.actions}>
                                <button className={styles.addBtn} onClick={() => onAttach(tab)}>
                                    <Plus size={15} aria-hidden="true" />
                                    Add items
                                </button>
                                <button className={styles.settleBtn} onClick={() => onSettle(tab)}>
                                    <Receipt size={15} aria-hidden="true" />
                                    Settle bill
                                </button>
                            </div>
                        </article>
                    );
                })}
            </div>
        </aside>
    </div>
);

export default TabsDrawer;

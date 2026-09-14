'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
    startOfDay, endOfDay, subDays, startOfWeek, endOfWeek,
    startOfMonth, endOfMonth, subMonths, parseISO, isValid
} from 'date-fns';
import styles from './orders.module.css';
import {
    getOrdersPage, getUnpaidOrdersCount, bumpOrder, getMenuItems,
    cancelOrder, ORDERS_PAGE_SIZES, getSalesChannels
} from '@/lib/dataClient';
import PrintButton from '@/components/Reports/PrintButton';
import ReceiptPreview from '@/components/POS/ReceiptPreview';
import OrderDetail from './OrderDetail';
import { printReceipt } from '@/lib/printReceipt';
import { printReceiptViaAgent } from '@/lib/thermalAgent';
import { formatNumber as money } from '@/lib/money';
import { useRole, usePermissions } from '@/components/Layout/AppLayout';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import {
    getOrderNumber, formatOrderDate, buildImageMap, resolveItemImage, formatModifiers
} from '@/lib/orderDisplay';
import LiveClock from '@/components/Layout/LiveClock';
import {
    UtensilsCrossed, ArrowRight, LayoutGrid, List, UserRound, Armchair,
    ShoppingBag, Bike, Loader2, ClipboardList, Layers, Wallet,
    ChevronLeft, ChevronRight, CalendarRange, ArrowUpDown, RotateCcw,
    Search, X, Ban, Printer, AlertTriangle, PanelRightOpen
} from 'lucide-react';

const ORDER_TYPE = {
    'dine-in': { label: 'Dine-in', Icon: UtensilsCrossed },
    'takeaway': { label: 'Takeaway', Icon: ShoppingBag },
    'delivery': { label: 'Delivery', Icon: Bike }
};

const STATUS_LABEL = {
    new: 'New',
    preparing: 'Preparing',
    ready: 'Ready',
    completed: 'Completed',
    cancelled: 'Cancelled'
};

const VIEWS = [
    { key: 'grid', label: 'Grid view', Icon: LayoutGrid },
    { key: 'list', label: 'List view', Icon: List }
];

// Kitchen status filters, plus one for money still owed
const FILTERS = ['all', 'unpaid', 'new', 'preparing', 'ready', 'completed'];

const FILTER_LABEL = { all: 'All', unpaid: 'Unpaid' };

const isOpenTab = (order) => order.payment_status === 'unpaid';

const PERIODS = [
    { key: 'all', label: 'All time' },
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'week', label: 'This week' },
    { key: 'month', label: 'This month' },
    { key: 'lastMonth', label: 'Last month' },
    { key: 'custom', label: 'Custom range' },
];

const SORTS = [
    { key: 'newest', label: 'Newest first' },
    { key: 'oldest', label: 'Oldest first' },
    { key: 'highest', label: 'Highest total' },
    { key: 'lowest', label: 'Lowest total' },
];

const TYPES = [
    { key: 'all', label: 'All types' },
    { key: 'dine-in', label: 'Dine-in' },
    { key: 'takeaway', label: 'Takeaway' },
    { key: 'delivery', label: 'Delivery' },
];

/*
 * Turns a period choice into the timestamp bounds the query needs.
 *
 * Boundaries are the operator's local day, not UTC: "Today" has to mean the
 * shift they are standing in. created_at is a timestamptz, so converting local
 * day edges to ISO lines the comparison up correctly on the server.
 */
const resolvePeriod = (period, customFrom, customTo) => {
    const now = new Date();

    switch (period) {
        case 'today':
            return { from: startOfDay(now), to: endOfDay(now) };
        case 'yesterday': {
            const day = subDays(now, 1);
            return { from: startOfDay(day), to: endOfDay(day) };
        }
        case 'week':
            // Monday start: a restaurant week is read Mon-Sun, not Sun-Sat.
            return { from: startOfWeek(now, { weekStartsOn: 1 }), to: endOfWeek(now, { weekStartsOn: 1 }) };
        case 'month':
            return { from: startOfMonth(now), to: endOfMonth(now) };
        case 'lastMonth': {
            const prev = subMonths(now, 1);
            return { from: startOfMonth(prev), to: endOfMonth(prev) };
        }
        case 'custom': {
            const start = customFrom ? parseISO(customFrom) : null;
            const end = customTo ? parseISO(customTo) : null;
            return {
                from: start && isValid(start) ? startOfDay(start) : null,
                // A single date means that whole day rather than an empty window.
                to: end && isValid(end) ? endOfDay(end) : (start && isValid(start) ? endOfDay(start) : null),
            };
        }
        default:
            return { from: null, to: null };
    }
};

export default function OrdersPage() {
    const role = useRole();
    const { can } = usePermissions();
    const [orders, setOrders] = useState([]);
    const [total, setTotal] = useState(0);
    /*
     * What the current filter adds up to, over the WHOLE set rather than this
     * page: reconciling an evening means "what does this come to", and paging
     * through it with a calculator is not an answer.
     */
    const [sums, setSums] = useState({ revenue: 0, unpaid: 0 });
    // Where orders came from, and how they were paid — the two questions a
    // reconciliation asks. The channel filter hides itself until there is more
    // than one channel to choose between.
    const [channels, setChannels] = useState([]);
    const [channel, setChannel] = useState('all');
    const [paymentMode, setPaymentMode] = useState('all');
    const [unpaidCount, setUnpaidCount] = useState(0);
    const [itemImages, setItemImages] = useState({});
    const [view, setView] = useState('grid');
    const [isLoading, setIsLoading] = useState(true);
    const [isFetching, setIsFetching] = useState(false);

    // Filters
    const [activeTab, setActiveTab] = useState('all');
    const [orderType, setOrderType] = useState('all');
    const [sort, setSort] = useState('newest');
    const [period, setPeriod] = useState('all');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');

    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(ORDERS_PAGE_SIZES[0]);

    // Typed term vs the one actually queried. Debounced so a four-digit order
    // number is one request instead of four.
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');

    // Void and reprint
    const [voidTarget, setVoidTarget] = useState(null);
    const [voidReason, setVoidReason] = useState('');
    const [voidError, setVoidError] = useState('');
    const [voiding, setVoiding] = useState(false);
    const [receiptOrder, setReceiptOrder] = useState(null);

    /*
     * The open order, by id — never a copy of the row it was opened from. The
     * panel refetches the whole order whenever `dataVersion` moves, which the
     * loader below bumps on every successful read. So the same 4s version poll
     * that keeps this list current keeps the open panel current too: a KDS bump
     * touches updated_at, the poll sees it, the list reloads, the panel follows.
     */
    const [detailId, setDetailId] = useState(null);
    const [dataVersion, setDataVersion] = useState(0);

    const { from, to } = resolvePeriod(period, customFrom, customTo);
    const fromISO = from ? from.toISOString() : null;
    const toISO = to ? to.toISOString() : null;

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const load = useCallback(async () => {
        setIsFetching(true);
        try {
            const [{ rows, total: count, revenue, unpaid: owed }, unpaid] = await Promise.all([
                getOrdersPage({
                    page, pageSize, status: activeTab, orderType,
                    from: fromISO, to: toISO, sort, search, channel, paymentMode,
                }),
                getUnpaidOrdersCount(),
            ]);
            setOrders(rows);
            setTotal(count);
            setSums({ revenue, unpaid: owed });
            setUnpaidCount(unpaid);
            // Whatever moved the orders table moved this too — the open detail
            // panel reloads off it rather than holding a stale row.
            setDataVersion(v => v + 1);
        } catch (error) {
            console.error('Failed to load orders', error);
        } finally {
            setIsLoading(false);
            setIsFetching(false);
        }
    }, [page, pageSize, activeTab, orderType, fromISO, toISO, sort, search, channel, paymentMode]);

    // The channel list, once: it changes when somebody edits Settings, not
    // while a shift is running.
    useEffect(() => {
        getSalesChannels().then(setChannels).catch(() => {});
    }, []);

    // Debounce the search box, and send the query back to page 1 — a term that
    // matches three orders has no page 4.
    useEffect(() => {
        const timer = setTimeout(() => {
            setSearch(searchInput);
            setPage(1);
        }, 350);
        return () => clearTimeout(timer);
    }, [searchInput]);

    // Refetch whenever the query changes — filters, sort, or page.
    useEffect(() => {
        load();
    }, [load]);

    /*
     * The subscription must outlive filter changes: re-running it on every
     * dropdown touch would tear down and rebuild the socket. It reads the
     * loader through a ref so it always refetches the query currently on
     * screen rather than the one that existed when it subscribed.
     */
    const loadRef = useRef(load);
    useEffect(() => {
        loadRef.current = load;
    }, [load]);

    /*
     * Session-aware subscription that refetches the query currently on screen —
     * both on a change and after a reconnect, so a dropped socket doesn't leave
     * this list quietly missing the orders taken while it was down.
     */
    useRealtimeTable({
        table: 'orders',
        channel: 'orders_channel',
        onChange: () => loadRef.current?.(),
    });

    useEffect(() => {
        getMenuItems().then(items => setItemImages(buildImageMap(items)));

        // Restore the operator's last view choice
        const saved = localStorage.getItem('orders:view');
        if (saved === 'grid' || saved === 'list') setView(saved);
    }, []);

    // A page that no longer exists (filters narrowed the result set) would
    // otherwise render as empty rather than as the last page of results.
    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [page, totalPages]);

    const changeView = (next) => {
        setView(next);
        localStorage.setItem('orders:view', next);
    };

    // Any filter change invalidates the current page number: staying on page 4
    // of a result set that now has two pages shows nothing.
    const applyFilter = (setter) => (value) => {
        setter(value);
        setPage(1);
    };

    const resetFilters = () => {
        setActiveTab('all');
        setOrderType('all');
        setSort('newest');
        setPeriod('all');
        setCustomFrom('');
        setCustomTo('');
        setSearchInput('');
        setSearch('');
        setChannel('all');
        setPaymentMode('all');
        setPage(1);
    };

    const filtersActive =
        activeTab !== 'all' || orderType !== 'all' || sort !== 'newest'
        || period !== 'all' || search.trim() !== ''
        || channel !== 'all' || paymentMode !== 'all';

    /*
     * Voiding is admin-only. Staff can advance a ticket but not make a sale
     * disappear. Accounts are people now, so the void records who did it and
     * the capability follows the 'void' right rather than a shared login.
     */
    // The right, not the role: a manager holds 'void' without being an
    // admin, and the server gates the action on exactly this key.
    const canVoid = can('void');

    const submitVoid = async () => {
        if (!voidTarget) return;
        setVoiding(true);
        setVoidError('');
        try {
            await cancelOrder(voidTarget.id, { reason: voidReason });
            setVoidTarget(null);
            setVoidReason('');
            await load();
        } catch (error) {
            setVoidError(error.message || 'Could not void this order');
        } finally {
            setVoiding(false);
        }
    };

    // Rebuilt from what was stored, so a reprint shows the bill as charged —
    // including its original invoice number and any discount given.
    const receiptTotals = receiptOrder && {
        subtotal: Number(receiptOrder.subtotal) || 0,
        discount: Number(receiptOrder.discount) || 0,
        tax: Number(receiptOrder.tax) || 0,
        total: Number(receiptOrder.total) || 0,
    };

    const handleStatusUpdate = async (orderId, currentStatus) => {
        const flow = ['new', 'preparing', 'ready', 'completed'];
        const currentIndex = flow.indexOf(currentStatus);
        if (currentIndex < flow.length - 1) {
            const nextStatus = flow[currentIndex + 1];
            try {
                await bumpOrder(orderId, currentStatus, nextStatus);
                // State will auto-update via subscription, but for instant feedback:
                load();
            } catch (error) {
                console.error("Failed to update status", error);
            }
        }
    };

    const getStatusLabel = (status) => STATUS_LABEL[status] || status;

    const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const lastRow = Math.min(page * pageSize, total);

    // Rounds and payment state — an open tab reads differently to a paid order
    const PaymentChips = ({ order }) => {
        const rounds = order.round_count || 1;
        return (
            <>
                {rounds > 1 && (
                    <span className={styles.metaChip}>
                        <Layers size={13} aria-hidden="true" />
                        {rounds} rounds
                    </span>
                )}
                {isOpenTab(order) ? (
                    <span className={`${styles.metaChip} ${styles.unpaidChip}`}>
                        <Wallet size={13} aria-hidden="true" />
                        Unpaid tab
                    </span>
                ) : order.payment_mode && (
                    <span className={styles.metaChip}>
                        <Wallet size={13} aria-hidden="true" />
                        {order.payment_mode === 'card' ? 'Card' : 'Cash'}
                    </span>
                )}
            </>
        );
    };

    // Order type, table and server — shown on both views
    const OrderMeta = ({ order }) => {
        const type = ORDER_TYPE[order.order_type];
        return (
            <div className={styles.metaRow}>
                {type && (
                    <span className={styles.metaChip}>
                        <type.Icon size={13} aria-hidden="true" />
                        {type.label}
                    </span>
                )}
                {order.table_number && (
                    <span className={styles.metaChip}>
                        <Armchair size={13} aria-hidden="true" />
                        {order.table_number}
                    </span>
                )}
                {order.waiter_name && (
                    <span className={`${styles.metaChip} ${styles.waiterChip}`}>
                        <UserRound size={13} aria-hidden="true" />
                        {order.waiter_name}
                    </span>
                )}
                <PaymentChips order={order} />
            </div>
        );
    };

    const ItemThumb = ({ item, size = 36 }) => {
        const image = resolveItemImage(item, itemImages);
        return image
            ? <img src={image} alt="" className={styles.itemThumb} style={{ width: size, height: size }} />
            : (
                <div className={styles.itemThumbFallback} style={{ width: size, height: size }}>
                    <UtensilsCrossed size={Math.round(size * 0.45)} />
                </div>
            );
    };

    const NextStatusBtn = ({ order }) => (
        <button
            className={styles.actionBtn}
            onClick={(e) => { e.stopPropagation(); handleStatusUpdate(order.id, order.status); }}
        >
            Next Status
            <ArrowRight size={15} aria-hidden="true" />
        </button>
    );

    /*
     * Reprint is always available; voiding only for an admin, and only while the
     * bill is still open — a settled one would need a refund.
     *
     * Every button here stops the click: the row and the card open the detail
     * panel now, and pressing Void must not do both.
     */
    const RowActions = ({ order }) => {
        const voidable = canVoid && order.status !== 'cancelled' && order.payment_status !== 'paid';

        return (
            <div className={styles.rowActions}>
                {order.status !== 'completed' && order.status !== 'cancelled' && (
                    <NextStatusBtn order={order} />
                )}
                {/* The keyboard's way in. The row itself opens on a click, but a
                    click is not an affordance a keyboard or a screen reader has. */}
                <button
                    className={styles.iconBtn}
                    onClick={(e) => { e.stopPropagation(); setDetailId(order.id); }}
                    title="Open order"
                    aria-label={`Open order ${getOrderNumber(order)}`}
                >
                    <PanelRightOpen size={15} />
                </button>
                <button
                    className={styles.iconBtn}
                    onClick={(e) => { e.stopPropagation(); setReceiptOrder(order); }}
                    title="Reprint receipt"
                    aria-label="Reprint receipt"
                >
                    <Printer size={15} />
                </button>
                {voidable && (
                    <button
                        className={`${styles.iconBtn} ${styles.voidBtn}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setVoidTarget(order); setVoidReason(''); setVoidError('');
                        }}
                        title="Void order"
                        aria-label="Void order"
                    >
                        <Ban size={15} />
                    </button>
                )}
            </div>
        );
    };

    return (
        <div className={`${styles.container} print-root`}>
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Orders</h1>
                    <LiveClock className={styles.clock} />
                </div>

                <div className={styles.headerRight}>
                    <div className={styles.filters}>
                        {FILTERS.map(tab => (
                            <button
                                key={tab}
                                className={`${styles.filterTab} ${activeTab === tab ? styles.active : ''}`}
                                onClick={() => applyFilter(setActiveTab)(tab)}
                            >
                                {FILTER_LABEL[tab] || tab.charAt(0).toUpperCase() + tab.slice(1)}
                                {tab === 'unpaid' && unpaidCount > 0 && (
                                    <span className={styles.filterCount}>{unpaidCount}</span>
                                )}
                            </button>
                        ))}
                    </div>

                    <div className={styles.viewToggle}>
                        {VIEWS.map(({ key, label, Icon }) => (
                            <button
                                key={key}
                                className={`${styles.viewBtn} ${view === key ? styles.activeView : ''}`}
                                onClick={() => changeView(key)}
                                title={label}
                                aria-label={label}
                                aria-pressed={view === key}
                            >
                                <Icon size={18} />
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ===== Search / period / type / sort ===== */}
            <div className={styles.toolbar}>
                <div className={styles.searchControl}>
                    <Search size={15} className={styles.searchIcon} aria-hidden="true" />
                    <input
                        type="search"
                        className={styles.searchInput}
                        placeholder="Order #, name, phone or table"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        aria-label="Search orders"
                    />
                    {searchInput && (
                        <button
                            type="button"
                            className={styles.searchClear}
                            onClick={() => setSearchInput('')}
                            aria-label="Clear search"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>

                <label className={styles.control}>
                    <CalendarRange size={14} aria-hidden="true" />
                    <select
                        className={styles.select}
                        value={period}
                        onChange={(e) => applyFilter(setPeriod)(e.target.value)}
                        aria-label="Period"
                    >
                        {PERIODS.map(p => (
                            <option key={p.key} value={p.key}>{p.label}</option>
                        ))}
                    </select>
                </label>

                {period === 'custom' && (
                    <div className={styles.dateRange}>
                        <input
                            type="date"
                            className={styles.dateInput}
                            value={customFrom}
                            max={customTo || undefined}
                            onChange={(e) => applyFilter(setCustomFrom)(e.target.value)}
                            aria-label="From date"
                        />
                        <span className={styles.dateSep}>to</span>
                        <input
                            type="date"
                            className={styles.dateInput}
                            value={customTo}
                            min={customFrom || undefined}
                            onChange={(e) => applyFilter(setCustomTo)(e.target.value)}
                            aria-label="To date"
                        />
                    </div>
                )}

                <label className={styles.control}>
                    <select
                        className={styles.select}
                        value={orderType}
                        onChange={(e) => applyFilter(setOrderType)(e.target.value)}
                        aria-label="Order type"
                    >
                        {TYPES.map(t => (
                            <option key={t.key} value={t.key}>{t.label}</option>
                        ))}
                    </select>
                </label>

                {/* How it was paid — the filter a card batch or a cash count
                    is actually reconciled against. */}
                <label className={styles.control}>
                    <select
                        className={styles.select}
                        value={paymentMode}
                        onChange={(e) => applyFilter(setPaymentMode)(e.target.value)}
                        aria-label="Payment method"
                    >
                        <option value="all">Any payment</option>
                        <option value="cash">Cash</option>
                        <option value="card">Card</option>
                        <option value="city_ledger">City ledger</option>
                    </select>
                </label>

                {/* Hidden until there is more than one channel: a filter with
                    one option is furniture, same as the till's picker. */}
                {channels.length > 1 && (
                    <label className={styles.control}>
                        <select
                            className={styles.select}
                            value={channel}
                            onChange={(e) => applyFilter(setChannel)(e.target.value)}
                            aria-label="Sales channel"
                        >
                            <option value="all">Any channel</option>
                            {channels.map((c) => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                        </select>
                    </label>
                )}

                <label className={styles.control}>
                    <ArrowUpDown size={14} aria-hidden="true" />
                    <select
                        className={styles.select}
                        value={sort}
                        onChange={(e) => applyFilter(setSort)(e.target.value)}
                        aria-label="Sort order"
                    >
                        {SORTS.map(s => (
                            <option key={s.key} value={s.key}>{s.label}</option>
                        ))}
                    </select>
                </label>

                {filtersActive && (
                    <button type="button" className={styles.resetBtn} onClick={resetFilters}>
                        <RotateCcw size={13} aria-hidden="true" />
                        Reset
                    </button>
                )}

                <div className={styles.resultCount}>
                    {isFetching && !isLoading && <Loader2 className={styles.inlineSpinner} size={13} />}
                    {total === 0 ? 'No orders' : `${firstRow}–${lastRow} of ${total}`}
                    {/* What this filter comes to, over every page of it —
                        voids excluded, because a cancelled bill is not money. */}
                    {total > 0 && (
                        <span className={styles.resultSum}>
                            · Rs. {money(sums.revenue)}
                            {sums.unpaid > 0 && ` · Rs. ${money(sums.unpaid)} unpaid`}
                        </span>
                    )}
                </div>
                <PrintButton label="Save as PDF" />
            </div>

            {isLoading ? (
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading orders…</p>
                </div>
            ) : orders.length === 0 ? (
                <div className={styles.stateBlock}>
                    <ClipboardList size={32} />
                    <p>
                        {filtersActive
                            ? 'No orders match these filters.'
                            : 'No orders yet.'}
                    </p>
                    {filtersActive && (
                        <button type="button" className={styles.resetBtn} onClick={resetFilters}>
                            <RotateCcw size={13} aria-hidden="true" />
                            Clear filters
                        </button>
                    )}
                </div>
            ) : view === 'grid' ? (
                /* ===== GRID ===== */
                <div className={`${styles.ordersGrid} ${isFetching ? styles.stale : ''}`}>
                    {orders.map(order => (
                        <div
                            key={order.id}
                            className={`${styles.orderCard} ${styles.openable} ${detailId === order.id ? styles.openCard : ''}`}
                            onClick={() => setDetailId(order.id)}
                            title="Open order"
                        >
                            <div className={styles.cardHeader}>
                                <div>
                                    <div className={styles.orderId}>Order #{getOrderNumber(order)}</div>
                                    <div className={styles.orderTime}>
                                        {formatOrderDate(order.created_at)}
                                    </div>
                                </div>
                                <span className={`${styles.statusBadge} ${styles[`status_${order.status}`]}`}>
                                    {getStatusLabel(order.status)}
                                </span>
                            </div>

                            <OrderMeta order={order} />

                            <div className={styles.itemsList}>
                                {order.items.map((item, idx) => {
                                    const mods = formatModifiers(item);
                                    return (
                                        <div key={idx} className={styles.itemRow}>
                                            <ItemThumb item={item} />
                                            <div className={styles.itemInfo}>
                                                <div className={styles.itemName}>
                                                    <span className={styles.itemQty}>{item.qty}x</span>
                                                    {item.name}
                                                </div>
                                                {mods && (
                                                    <div className={styles.itemModifiers}>{mods}</div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            <div className={styles.cardFooter}>
                                <div className={styles.totalAmount}>
                                    Rs. {money(order.total)}
                                    {Number(order.discount) > 0 && (
                                        <span className={styles.discountNote}>
                                            after Rs. {money(order.discount)} off
                                        </span>
                                    )}
                                </div>
                                <RowActions order={order} />
                            </div>

                            {order.status === 'cancelled' && order.cancel_reason && (
                                <div className={styles.voidNote}>
                                    <Ban size={13} aria-hidden="true" />
                                    Voided: {order.cancel_reason}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                /* ===== LIST ===== */
                <div className={`${styles.listWrap} ${isFetching ? styles.stale : ''}`}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Order</th>
                                <th>Placed</th>
                                <th>Type / Table</th>
                                <th>Waiter</th>
                                <th>Items</th>
                                <th>Status</th>
                                <th className={styles.alignRight}>Total</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {orders.map(order => {
                                const type = ORDER_TYPE[order.order_type];
                                return (
                                    <tr
                                        key={order.id}
                                        className={`${styles.openable} ${detailId === order.id ? styles.openRow : ''}`}
                                        onClick={() => setDetailId(order.id)}
                                        title="Open order"
                                    >
                                        <td className={styles.cellStrong}>
                                            #{getOrderNumber(order)}
                                        </td>
                                        <td className={styles.cellMuted}>
                                            {formatOrderDate(order.created_at)}
                                        </td>
                                        <td>
                                            <span className={styles.cellInline}>
                                                {type && <type.Icon size={14} aria-hidden="true" />}
                                                {type?.label || order.order_type}
                                                {order.table_number && ` · ${order.table_number}`}
                                            </span>
                                        </td>
                                        <td className={styles.cellMuted}>
                                            {order.waiter_name || '—'}
                                        </td>
                                        <td>
                                            <div className={styles.listThumbs}>
                                                {order.items.slice(0, 4).map((item, idx) => (
                                                    <ItemThumb key={idx} item={item} size={28} />
                                                ))}
                                                {order.items.length > 4 && (
                                                    <span className={styles.moreCount}>
                                                        +{order.items.length - 4}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td>
                                            <span className={`${styles.statusBadge} ${styles[`status_${order.status}`]}`}>
                                                {getStatusLabel(order.status)}
                                            </span>
                                        </td>
                                        <td className={`${styles.cellStrong} ${styles.alignRight}`}>
                                            Rs. {money(order.total)}
                                            {isOpenTab(order) && (
                                                <div className={styles.unpaidNote}>
                                                    Unpaid
                                                    {(order.round_count || 1) > 1 &&
                                                        ` · ${order.round_count} rounds`}
                                                </div>
                                            )}
                                        </td>
                                        <td className={styles.alignRight}>
                                            <RowActions order={order} />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/*
                One order, opened. It reads its own detail off `detailId` and
                reloads on `dataVersion`, so the kitchen's progress arrives here
                on the same 4s poll that refreshes the list behind it.

                Reprint and Void hand back up to the dialogs this screen already
                owns — same receipt, same void path, same error strings.
            */}
            {detailId && (
                <OrderDetail
                    orderId={detailId}
                    refreshKey={dataVersion}
                    canVoid={canVoid}
                    onClose={() => setDetailId(null)}
                    onReprint={(order) => setReceiptOrder(order)}
                    onVoid={(order) => { setVoidTarget(order); setVoidReason(''); setVoidError(''); }}
                    onChanged={load}
                />
            )}

            {/* Void: a reason is mandatory, because a void with no reason tells
                nobody anything three weeks later when the books don't balance. */}
            {voidTarget && (
                <div className={styles.modalOverlay} onClick={() => !voiding && setVoidTarget(null)}>
                    <div className={styles.modal} onClick={e => e.stopPropagation()}>
                        <h3 className={styles.modalTitle}>
                            <AlertTriangle size={18} aria-hidden="true" />
                            Void order #{getOrderNumber(voidTarget)}?
                        </h3>
                        <p className={styles.modalBody}>
                            It stops counting towards sales and drops off the kitchen board.
                            This can&apos;t be undone.
                        </p>

                        <input
                            type="text"
                            className={styles.modalInput}
                            placeholder="Reason (wrong table, duplicate, walk-out)"
                            value={voidReason}
                            onChange={(e) => { setVoidReason(e.target.value); setVoidError(''); }}
                            maxLength={120}
                            autoFocus
                            disabled={voiding}
                        />

                        {voidError && <p className={styles.modalError}>{voidError}</p>}

                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.modalCancel}
                                onClick={() => setVoidTarget(null)}
                                disabled={voiding}
                            >
                                Keep order
                            </button>
                            <button
                                type="button"
                                className={styles.modalConfirm}
                                onClick={submitVoid}
                                disabled={voiding || !voidReason.trim()}
                            >
                                {voiding ? <Loader2 size={14} className={styles.inlineSpinner} /> : <Ban size={14} />}
                                {voiding ? 'Voiding…' : 'Void order'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Reprint. Prints the bill as it was charged, with its stored
                invoice number, rather than minting a new document. */}
            {receiptOrder && (
                <ReceiptPreview
                    order={receiptOrder}
                    cart={receiptOrder.items || []}
                    totals={receiptTotals}
                    includeTax={receiptOrder.include_tax ?? true}
                    /* The rate the bill was settled at, stamped on the order.
                       Null on a pre-migration bill — the receipt then prints
                       the tax line without a percentage. */
                    taxRate={receiptOrder.tax_rate ?? null}
                    invoiceNumber={receiptOrder.invoice_number || undefined}
                    /* The bill's own date: when it was paid, or failing that
                       when it was taken — never the day of the reprint. */
                    orderDate={receiptOrder.paid_at || receiptOrder.created_at}
                    reprint
                    meta={{
                        orderNumber: getOrderNumber(receiptOrder),
                        table: receiptOrder.table_number,
                        waiter: receiptOrder.waiter_name,
                        rounds: receiptOrder.round_count || 1,
                    }}
                    printLabel="Print"
                    role={role}
                    busy={false}
                    onClose={() => setReceiptOrder(null)}
                    /* The thermal agent when one is running, the browser
                       otherwise — and the paper says REPRINT either way. */
                    onPrint={async () => {
                        if (await printReceiptViaAgent(receiptOrder.id, { reprint: true })) return;
                        printReceipt();
                    }}
                />
            )}

            {/* Hidden on a single page of results: a pager that can't page is noise */}
            {!isLoading && totalPages > 1 && (
                <div className={styles.pager}>
                    <label className={styles.control}>
                        <select
                            className={styles.select}
                            value={pageSize}
                            onChange={(e) => applyFilter(setPageSize)(Number(e.target.value))}
                            aria-label="Orders per page"
                        >
                            {ORDERS_PAGE_SIZES.map(size => (
                                <option key={size} value={size}>{size} per page</option>
                            ))}
                        </select>
                    </label>

                    <div className={styles.pagerNav}>
                        <button
                            type="button"
                            className={styles.pagerBtn}
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            disabled={page <= 1 || isFetching}
                            aria-label="Previous page"
                        >
                            <ChevronLeft size={16} />
                            Prev
                        </button>

                        <span className={styles.pagerInfo}>
                            Page {page} of {totalPages}
                        </span>

                        <button
                            type="button"
                            className={styles.pagerBtn}
                            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages || isFetching}
                            aria-label="Next page"
                        >
                            Next
                            <ChevronRight size={16} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

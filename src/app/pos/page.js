'use client';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import styles from './pos.module.css';
import {
    getMenuItems, getCategories, addOrder, getModifiers, getWaiters,
    getOpenTabs, appendRoundToOrder, settleOrder, getTaxRates, findCustomerByPhone,
    setMenuItemAvailability
} from '@/lib/dataClient';
import { groupRoundByCategory, printKotSlip, runPrintQueue } from '@/lib/kotPrint';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { calcTotals, itemRound, DEFAULT_TAX_RATE } from '@/lib/orderTotals.mjs';
import { getOrderNumber, formatOrderDate } from '@/lib/orderDisplay';
import { loadCartDraft, saveCartDraft, clearCartDraft } from '@/lib/cartDraft';
import { getSettings } from '@/app/settings/actions';
import { printReceipt } from '@/lib/printReceipt';

import ModifierModal from '@/components/POS/ModifierModal';
import ReceiptPreview from '@/components/POS/ReceiptPreview';
import KotSlips from '@/components/POS/KotSlips';
import TabsDrawer from '@/components/POS/TabsDrawer';
import LiveClock from '@/components/Layout/LiveClock';
import { useRole } from '@/components/Layout/AppLayout';

import {
    Soup, Flame, Utensils, Cookie, GlassWater, Plus, CirclePlus,
    Search, Banknote, CreditCard, X, Minus, UserRound, Armchair, Phone, MapPin,
    UtensilsCrossed, ShoppingBag, Bike, Loader2, Layers, Receipt, Send, EyeOff, Eye
} from 'lucide-react';

const ORDER_TYPES = [
    { key: 'dine-in', label: 'Dine-in', Icon: UtensilsCrossed },
    { key: 'takeaway', label: 'Takeaway', Icon: ShoppingBag },
    { key: 'delivery', label: 'Delivery', Icon: Bike }
];

const CategoryIcon = ({ name, size = 18 }) => {
    const icons = {
        'Soup': Soup,
        'Flame': Flame,
        'Utensils': Utensils,
        'Cookie': Cookie,
        'GlassWater': GlassWater,
        'Plus': CirclePlus
    };
    const Icon = icons[name] || Utensils;
    return <Icon size={size} />;
};

export default function POSPage() {
    const role = useRole();
    const [menuData, setMenuData] = useState({ categories: [], items: [], modifiers: {} });
    const [activeCategory, setActiveCategory] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [cart, setCart] = useState([]);
    const [modifyingItem, setModifyingItem] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [loadedItemCount, setLoadedItemCount] = useState(null);

    // Checkout State
    const [receiptMode, setReceiptMode] = useState(null); // 'pay-now' | 'settle'
    const [paymentMode, setPaymentMode] = useState('cash'); // 'cash' or 'card'
    const [isSending, setIsSending] = useState(false);
    const [notice, setNotice] = useState('');

    // Open tabs — unpaid checks the floor can add rounds to and settle later
    const [openTabs, setOpenTabs] = useState([]);
    const [showTabs, setShowTabs] = useState(false);
    const [activeTabId, setActiveTabId] = useState(null);
    const [pendingInvoiceNo, setPendingInvoiceNo] = useState(null);

    // The KOT slip currently being printed; null keeps the hidden print root
    // out of the DOM so the customer receipt owns the paper again.
    const [kotJob, setKotJob] = useState(null);

    /*
     * One id per basket, reused on every retry of that basket's checkout.
     *
     * Without it a timeout during checkout is unrecoverable: the cashier can't
     * tell whether the order landed, retries, and gets a second order because
     * addOrder mints a fresh order_number each call.
     *
     * Minted when the first line lands rather than when the receipt opens, and
     * saved with the cart draft — closing the receipt and reopening it, or a
     * reload mid-sale, used to mint a fresh id, which is the same as having
     * none. Deliberately NOT cleared in an error path: reusing it there is the
     * entire point. It IS cleared once the basket is stored, and when the cart
     * is emptied, so a new basket can never inherit an id the server has
     * already accepted.
     *
     * A ref rather than state: nothing renders it, and the handlers need the
     * value that is true now, not the one from the last render.
     */
    const requestIdRef = useRef(null);

    const ensureRequestId = () => {
        if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
        return requestIdRef.current;
    };

    /*
     * Same idea, per action: one id per round-send and one per settle
     * attempt, reused if the call fails so the retry replays instead of
     * duplicating, cleared when the action succeeds or the context changes.
     */
    const roundRequestIdRef = useRef(null);
    const settleRequestIdRef = useRef(null);

    // Order details
    const [waiters, setWaiters] = useState([]);
    const [waiterId, setWaiterId] = useState('');
    const [tableNumber, setTableNumber] = useState('');
    const [orderType, setOrderType] = useState('dine-in');
    const [includeTax, setIncludeTax] = useState(true);
    /*
     * Both rates, because ICT taxes card and cash differently and the sheet
     * must show what this payment will actually cost. The effective rate
     * follows the selected payment mode, so switching cash↔card reprices the
     * bill on screen — and the expected total sent to the server is computed
     * with the same rate the server will settle at.
     */
    const [taxRates, setTaxRates] = useState({ cash: DEFAULT_TAX_RATE, card: DEFAULT_TAX_RATE });
    // Absent column reads as enabled, matching how qr_enabled degrades
    const [autoPrint, setAutoPrint] = useState(true);

    // Discount on the bill being paid
    const [discountMode, setDiscountMode] = useState('amount'); // 'amount' | 'percent'
    const [discountValue, setDiscountValue] = useState('');
    const [discountReason, setDiscountReason] = useState('');

    // Who the order is for. Needed for delivery, useful for takeaway callbacks.
    const [customerName, setCustomerName] = useState('');
    const [customerPhone, setCustomerPhone] = useState('');
    const [customerAddress, setCustomerAddress] = useState('');
    const [customerFound, setCustomerFound] = useState(false);

    // Load menu data from Supabase
    useEffect(() => {
        const loadData = async () => {
            setIsLoading(true);
            setLoadError(null);
            try {
                const [categories, items, modifiers] = await Promise.all([
                    getCategories(),
                    getMenuItems(),
                    getModifiers()
                ]);

                console.debug('POS loadData:', { categoriesCount: categories.length, itemsCount: items.length, modifiersCount: Object.keys(modifiers).length });
                setMenuData({ categories, items, modifiers });
                setLoadedItemCount(items.length);
            } catch (error) {
                console.error("Failed to load POS data", error);
                setLoadError(error?.message || 'Failed to load menu data');
                setLoadedItemCount(0);
            } finally {
                setIsLoading(false);
            }
        };
        loadData();
        getWaiters().then(setWaiters);

        /*
         * Restore an unsent basket. Done here rather than in a useState
         * initialiser because localStorage doesn't exist during the server
         * render, and seeding state from it there would hydrate mismatched.
         */
        const draft = loadCartDraft();
        if (draft) {
            setCart(draft.cart);
            setOrderType(draft.orderType || 'dine-in');
            setTableNumber(draft.tableNumber || '');
            setWaiterId(draft.waiterId || '');
            setCustomerName(draft.customerName || '');
            setCustomerPhone(draft.customerPhone || '');
            setCustomerAddress(draft.customerAddress || '');
            setIncludeTax(draft.includeTax ?? true);
            // Recovering the basket without its id would let a checkout that
            // already landed before the crash be rung up a second time.
            requestIdRef.current = draft.requestId || null;
            // The tab itself is deliberately not restored: it may have been
            // settled on another terminal while this one was away, and
            // reattaching to a closed bill is worse than starting detached.
            setNotice('Recovered an unsent order from this device.');
        }
        // Rates come from store_settings so a rate change needs no deploy;
        // both fall back to the default if they can't be read.
        getTaxRates().then(r => r && setTaxRates(r));
        getSettings().then(s => setAutoPrint(s?.auto_print !== false));
    }, []);

    const loadTabs = useCallback(async () => {
        const tabs = await getOpenTabs();
        setOpenTabs(tabs);
        return tabs;
    }, []);

    // Tabs can move under us: the kitchen bumps a ticket, or another terminal
    // settles a bill. Follow the table rather than trusting our own snapshot.
    useEffect(() => {
        loadTabs();
    }, [loadTabs]);

    // Tabs can move under us — the kitchen bumps a ticket, another terminal
    // settles a bill — including while this terminal's socket was down.
    useRealtimeTable({ table: 'orders', channel: 'pos_tabs_channel', onChange: loadTabs });

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(''), 3500);
        return () => clearTimeout(timer);
    }, [notice]);

    const draftMirrored = useRef(false);

    /*
     * Mirror the unsent basket to the device on every change. Cheap enough to do
     * eagerly — the alternative is debouncing and losing the last few seconds,
     * which is exactly the window a crash happens in.
     */
    useEffect(() => {
        /*
         * Skipped on mount. The restore above lands in a later commit, so this
         * render still holds an empty cart — mirroring it would wipe the very
         * draft being recovered.
         */
        if (!draftMirrored.current) {
            draftMirrored.current = true;
            return;
        }

        // An emptied cart is a basket that never happened, and its id must not
        // carry into the next one: the server would dedupe a genuinely new
        // order against the abandoned one and hand back the wrong receipt.
        if (cart.length === 0) requestIdRef.current = null;

        saveCartDraft({
            cart,
            orderType,
            tableNumber,
            waiterId,
            customerName,
            customerPhone,
            customerAddress,
            includeTax,
            requestId: requestIdRef.current,
        });
    }, [cart, orderType, tableNumber, waiterId, customerName, customerPhone, customerAddress, includeTax]);

    /*
     * The attached tab is derived, never stored: if it gets settled on another
     * terminal it simply drops away instead of leaving the POS pointed at a
     * bill that is already closed.
     */
    const tab = useMemo(
        () => openTabs.find(t => t.id === activeTabId) || null,
        [openTabs, activeTabId]
    );

    // Filter items based on category and search
    const filteredItems = useMemo(() => {
        let items = activeCategory === 'all'
            ? menuData.items
            : menuData.items.filter(item => item.category_id === activeCategory);

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            items = items.filter(item =>
                item.name.toLowerCase().includes(query) ||
                item.description?.toLowerCase().includes(query)
            );
        }

        return items;
    }, [menuData.items, activeCategory, searchQuery]);

    /*
     * Mark a dish sold out, or back on.
     *
     * Optimistic, because the kitchen shouts and the floor answers — a
     * round trip before the tile greys out is a round trip too many. Reverted
     * and reported if the write fails, so nobody is left believing a dish is
     * off when the till will still sell it.
     *
     * Deliberately not admin-gated: whoever notices the shortage is whoever
     * is standing at the till, and P2's permissions will give this its own
     * verb rather than borrowing the admin PIN.
     */
    const toggleSoldOut = async (item, event) => {
        event.stopPropagation(); // the tile behind this adds to the cart
        const next = item.is_available === false;

        setMenuData(prev => ({
            ...prev,
            items: prev.items.map(i => (i.id === item.id ? { ...i, is_available: next } : i)),
        }));

        try {
            await setMenuItemAvailability(item.id, next);
            setNotice(next ? `${item.name} is back on.` : `${item.name} marked sold out.`);
        } catch (error) {
            console.error('Could not change availability', error);
            setMenuData(prev => ({
                ...prev,
                items: prev.items.map(i => (i.id === item.id ? { ...i, is_available: !next } : i)),
            }));
            setNotice(`Could not change ${item.name} — it is unchanged.`);
        }
    };

    // Handle Item Click
    const handleItemClick = (item) => {
        // Sold-out items stay on the grid so staff can tell a customer it's off
        // tonight, but they can't be rung up.
        if (item.is_available === false) return;

        if ((item.variants && item.variants.length > 0) || (item.modifiers && item.modifiers.length > 0)) {
            setModifyingItem(item);
        } else {
            addToCart({ ...item, uniqueId: item.id }); // Simple item
        }
    };

    // Add Item to Cart (from Modal or Direct)
    const addToCart = (item) => {
        // The basket starts here, so its checkout id does too.
        ensureRequestId();
        setCart(prev => {
            const existingIndex = prev.findIndex(i => i.uniqueId === item.uniqueId);

            if (existingIndex >= 0) {
                const newCart = [...prev];
                newCart[existingIndex].qty += 1;
                return newCart;
            }
            return [...prev, { ...item, qty: 1 }];
        });
        setModifyingItem(null);
    };

    // Update Cart Quantity
    const updateQty = (index, change) => {
        setCart(prev => {
            const newCart = [...prev];
            const item = newCart[index];
            const newQty = item.qty + change;

            if (newQty <= 0) {
                return prev.filter((_, i) => i !== index);
            }
            newCart[index] = { ...item, qty: newQty };
            return newCart;
        });
    };

    // Remove Item
    const removeItem = (index) => {
        setCart(prev => prev.filter((_, i) => i !== index));
    };

    /*
     * Three amounts matter once a tab is in play: what is already on it, what
     * this round adds, and the bill the customer will actually pay.
     */
    const discountAmount = useMemo(() => {
        const value = Number(discountValue) || 0;
        if (value <= 0) return 0;
        // Percentages are an input convenience; what gets stored and charged is
        // always the resulting rupee amount.
        if (discountMode === 'percent') {
            const base = [...(tab?.items || []), ...cart]
                .reduce((sum, i) => sum + i.price * i.qty, 0);
            return Math.round(base * Math.min(value, 100) / 100);
        }
        return Math.round(value);
    }, [discountValue, discountMode, tab, cart]);

    const taxRate = (paymentMode === 'card' ? taxRates.card : taxRates.cash) ?? DEFAULT_TAX_RATE;
    const priceOpts = useMemo(() => ({ taxRate }), [taxRate]);

    // The round on its own is never discounted — a discount applies to the bill
    // being paid, and applying it here as well would double-count it.
    const roundTotals = useMemo(() => calcTotals(cart, includeTax, priceOpts), [cart, includeTax, priceOpts]);
    const tabTotals = useMemo(
        () => calcTotals(tab?.items || [], includeTax, priceOpts),
        [tab, includeTax, priceOpts]
    );
    const billItems = useMemo(() => [...(tab?.items || []), ...cart], [tab, cart]);
    const billTotals = useMemo(
        () => calcTotals(billItems, includeTax, { ...priceOpts, discount: discountAmount }),
        [billItems, includeTax, priceOpts, discountAmount]
    );

    /*
     * calcTotals hands back `taxable` for display; the orders table has no such
     * column, and `discount` only exists once migration 11 has run, so writes
     * are narrowed to the columns that are actually there.
     */
    const billColumns = (totals) => ({
        subtotal: totals.subtotal,
        tax: totals.tax,
        total: totals.total,
        ...(totals.discount > 0 && { discount: totals.discount }),
    });

    /*
     * Sends the receipt on screen to the printer.
     *
     * Called after the save resolves and before the modal closes, which is the
     * only correct order: printing first could hand a customer paper for an
     * order that failed to store, and closing first unmounts the very thing
     * being printed. That sequencing is safe because window.print() blocks
     * within the current task, and React won't flush the state update that
     * unmounts the receipt until the task finishes.
     *
     * With Chrome launched --kiosk-printing this goes straight to the default
     * printer with no dialog. Without that flag it opens the normal print
     * preview, which is the visible sign the terminal isn't set up yet.
     */
    const printIfEnabled = () => {
        if (!autoPrint) return;
        printReceipt();
    };

    /*
     * One kitchen slip per category in the round just sent — four sections in
     * the order means four cuts, handed out by the runner. Runs only after
     * the server accepted the round (kitchen must never cook food that was
     * never stored) and always before the customer receipt, whose print CSS
     * the slip root deliberately overrides while mounted. Gated on autoPrint
     * with the receipt: without --kiosk-printing each slip would raise its
     * own dialog.
     */
    const printKotSlips = async (sentItems, order, roundNo) => {
        if (!autoPrint || !order) return;
        const slips = groupRoundByCategory(sentItems, menuData.items, menuData.categories);
        const meta = {
            orderNumber: getOrderNumber(order),
            table: order.table_number,
            waiter: order.waiter_name,
            orderType: order.order_type,
            roundNo,
            at: new Date(),
        };
        await runPrintQueue(slips, (slip) => {
            // flushSync, not a queued set: printKotSlip() reads the DOM on
            // the next line, and a queued render would print the prior slip.
            flushSync(() => setKotJob({ slip, meta }));
            printKotSlip();
        });
        flushSync(() => setKotJob(null));
    };

    // "16%" from a 0.16 rate, without a trailing ".00" on whole percentages
    const taxPercentLabel = `${Number((taxRate * 100).toFixed(2))}%`;

    const nextRound = (tab?.round_count || 0) + 1;
    const selectedWaiter = waiters.find(w => w.id === waiterId);
    const canSettle = Boolean(tab) && cart.length === 0;

    /*
     * Shown in the receipt. billTotals covers both cases: with a tab it's the
     * tab's lines plus anything unsent, and without one billItems is just the
     * cart. Using roundTotals here would drop the discount from a pay-now bill.
     */
    const receiptTotals = billTotals;

    const orderDetails = () => ({
        table_number: orderType === 'dine-in' ? tableNumber.trim() || null : null,
        waiter_id: waiterId || null,
        // Denormalised so the ticket still names the server if staff change
        waiter_name: selectedWaiter?.name || null,
        customer_name: customerName.trim() || null,
        customer_phone: customerPhone.trim() || null,
        // Only meaningful for delivery, and stored on the order rather than only
        // on the customer: people move, and a past delivery should still say
        // where it actually went.
        customer_address: orderType === 'delivery' ? customerAddress.trim() || null : null
    });

    const clearOrderFields = () => {
        setActiveTabId(null);
        setCart([]);
        setTableNumber('');
        setWaiterId('');
        setOrderType('dine-in');
        setDiscountValue('');
        setDiscountReason('');
        setDiscountMode('amount');
        setCustomerName('');
        setCustomerPhone('');
        setCustomerAddress('');
        setCustomerFound(false);
        setPendingInvoiceNo(null);
        requestIdRef.current = null;
        roundRequestIdRef.current = null;
        settleRequestIdRef.current = null;
        // The order is on the server now, so the local copy is no longer a
        // recovery aid — leaving it would resurrect a completed sale.
        clearCartDraft();
    };

    /*
     * Prefill a returning caller from their phone number. Deliberately manual
     * rather than firing on every keystroke: a lookup per digit is a query per
     * digit, and the operator knows when they've finished typing.
     */
    const lookupCustomer = async () => {
        const phone = customerPhone.trim();
        if (!phone) return;

        const found = await findCustomerByPhone(phone);
        if (found) {
            setCustomerName(found.name === 'Walk-in' ? '' : found.name || '');
            if (found.address) setCustomerAddress(found.address);
            setCustomerFound(true);
            setNotice(`Found ${found.name} — ${found.total_orders || 0} previous orders.`);
        } else {
            setCustomerFound(false);
            setNotice('No previous orders for that number.');
        }
    };

    const attachTab = (target, mode = null) => {
        /*
         * Settling over a cart with unsent lines in it would print a bill that
         * doesn't include them and close the tab underneath them: the kitchen
         * never cooks that food and nobody is charged for it. The round has to
         * be sent (or cleared) first, so the drawer's Settle refuses here
         * rather than opening a receipt that is already wrong. Attaching
         * without settling is left alone — carrying a round onto a tab is
         * exactly what it's for.
         */
        if (mode === 'settle' && cart.length > 0) {
            setNotice(`Send or clear the ${cart.length} unsent item${cart.length === 1 ? '' : 's'} in the cart before settling this tab.`);
            return;
        }

        setActiveTabId(target.id);
        setOrderType(target.order_type || 'dine-in');
        setTableNumber(target.table_number || '');
        setWaiterId(target.waiter_id || '');
        setIncludeTax(target.include_tax ?? true);
        setCustomerName(target.customer_name || '');
        setCustomerPhone(target.customer_phone || '');
        setCustomerAddress(target.customer_address || '');
        /*
         * A discount already agreed on this tab is part of its bill. Settling
         * recomputes the total from what's on screen, so leaving the fields
         * blank quietly charged the money back — and cleared discount_reason
         * with it. Always assigned, never only when there's a discount to
         * restore: a figure typed for the previous bill must not follow the
         * cashier onto this one.
         */
        const tabDiscount = Number(target.discount) || 0;
        setDiscountMode('amount'); // stored as rupees, whatever was typed to get there
        setDiscountValue(tabDiscount > 0 ? String(tabDiscount) : '');
        setDiscountReason(tabDiscount > 0 ? target.discount_reason || '' : '');
        // A different bill: this settle gets its own idempotency id, and any
        // number on screen belongs to the order that already carries it.
        settleRequestIdRef.current = null;
        setPendingInvoiceNo(null);
        setShowTabs(false);
        setReceiptMode(mode);
    };

    /*
     * Step away from a tab without closing it. Anything not yet sent stays in
     * the cart — the usual reason to detach is that the round belongs on a
     * different tab, and throwing those lines away would be its own bug.
     */
    const detachTab = () => {
        setActiveTabId(null);
        setTableNumber('');
        setWaiterId('');
        setOrderType('dine-in');
        /*
         * The discount belongs to the bill being walked away from, not to
         * whatever is rung up next — left in state, a comp agreed for table 4
         * silently priced the next stranger's order. (Opening or attaching a
         * tab keeps the fields on purpose: there they mirror the discount the
         * tab itself stores.)
         */
        setDiscountValue('');
        setDiscountReason('');
        setDiscountMode('amount');
        settleRequestIdRef.current = null;
        setNotice(cart.length > 0
            ? 'Tab left open. The unsent items are still in the cart.'
            : 'Tab left open — find it again under Open Tabs.');
    };

    // ---- Sending food and taking money -------------------------------------

    const handleCheckout = () => {
        if (cart.length === 0) return;
        // The invoice number is the server's to give: settle_order mints it
        // sequentially and returns it, and the receipt fills in just before
        // printing. Nothing is promised on screen that the store didn't issue.
        // Normally already minted with the first line; a draft saved by an
        // older build has none, so mint lazily rather than checking out unsafe.
        ensureRequestId();
        setReceiptMode('pay-now');
    };

    // Pay-at-the-counter: one round, settled on the spot (the original flow)
    const handlePayNow = async () => {
        setIsSending(true);
        try {
            const saved = await addOrder({
                items: cart.map(item => ({ ...item, round: 1 })),
                ...billColumns(billTotals),
                discount_reason: discountAmount > 0 ? discountReason.trim() || null : null,
                client_request_id: ensureRequestId(),
                include_tax: includeTax,
                order_type: orderType,
                ...orderDetails(),
                status: 'new', // fires the ticket to the kitchen display
                payment_status: 'paid',
                payment_mode: paymentMode
            });
            /*
             * The server minted the invoice number inside the settle; the
             * receipt on screen must show it before the paper does. flushSync
             * because printReceipt() reads the DOM synchronously next line —
             * a queued render would print the placeholder.
             */
            flushSync(() => setPendingInvoiceNo(saved?.invoice_number || null));
            // Stored, so it's safe to hand over paper. Kitchen slips first,
            // then the customer receipt — and both before clearOrderFields,
            // which unmounts the receipt being printed.
            await printKotSlips(cart, saved, 1);
            printIfEnabled();
            clearOrderFields();
            setReceiptMode(null);
            setNotice('Paid. Order sent to the kitchen.');
        } catch (error) {
            console.error("Failed to save order", error);
            alert("Failed to save order");
        } finally {
            setIsSending(false);
        }
    };

    // Open a tab: food fires now, the bill stays open until they leave
    const handleOpenTab = async () => {
        if (cart.length === 0) return;
        setIsSending(true);
        // Same protection as checkout — opening a tab twice would have the
        // kitchen cook the first round twice.
        const requestId = ensureRequestId();
        try {
            const created = await addOrder({
                items: cart.map(item => ({ ...item, round: 1 })),
                client_request_id: requestId,
                ...billColumns(billTotals),
                include_tax: includeTax,
                order_type: orderType,
                ...orderDetails(),
                status: 'new',
                payment_status: 'unpaid'
            });
            // Slips for round 1 go out now; the bill prints at settle time.
            await printKotSlips(cart, created, 1);
            await loadTabs();
            setActiveTabId(created.id);
            setCart([]);
            requestIdRef.current = null;
            setNotice(`Tab #${getOrderNumber(created)} opened — add rounds any time, pay at the end.`);
        } catch (error) {
            console.error('Failed to open tab', error);
            alert('Failed to open tab');
        } finally {
            setIsSending(false);
        }
    };

    // Another round on an existing tab
    const handleSendRound = async () => {
        if (!tab || cart.length === 0) return;
        setIsSending(true);
        // One id per round-send, reused on retry: a timeout followed by a
        // second tap must cook this food once.
        if (!roundRequestIdRef.current) roundRequestIdRef.current = crypto.randomUUID();
        try {
            await appendRoundToOrder(tab.id, cart, {
                include_tax: includeTax,
                ...orderDetails()
            }, { clientRequestId: roundRequestIdRef.current });
            roundRequestIdRef.current = null;
            // Only this round's food goes to the sections — earlier rounds
            // are already cooking.
            await printKotSlips(cart, tab, nextRound);
            await loadTabs();
            setCart([]);
            setNotice(`Round ${nextRound} sent to the kitchen.`);
        } catch (error) {
            console.error('Failed to send round', error);
            alert(error.message || 'Failed to send round');
        } finally {
            setIsSending(false);
        }
    };

    const handleSettle = async () => {
        if (!tab) return;
        // Same rule as attachTab, held at the point money moves: a receipt can
        // be on screen while lines are still being added behind it. Closing it
        // rather than failing silently, so a tap that does nothing says why.
        if (cart.length > 0) {
            setReceiptMode(null);
            setNotice('Send or clear the unsent items in the cart before settling this tab.');
            return;
        }
        setIsSending(true);
        if (!settleRequestIdRef.current) settleRequestIdRef.current = crypto.randomUUID();
        try {
            const settled = await settleOrder(tab.id, {
                paymentMode,
                includeTax,
                discount: discountAmount,
                discountReason: discountAmount > 0 ? discountReason.trim() || null : null,
                // The bill as shown; the server refuses to settle a different one.
                expectedTotal: billTotals.total,
                clientRequestId: settleRequestIdRef.current,
            });
            settleRequestIdRef.current = null;
            // Same as pay-now: the paper must carry the number the server
            // issued, so flush it into the receipt before printing.
            flushSync(() => setPendingInvoiceNo(settled?.invoice_number || null));
            printIfEnabled();
            await loadTabs();
            clearOrderFields();
            setReceiptMode(null);
            setNotice('Bill settled.');
        } catch (error) {
            console.error('Failed to settle bill', error);
            alert(error.message || 'Failed to settle bill');
        } finally {
            setIsSending(false);
        }
    };

    const showCartPanel = cart.length > 0 || Boolean(tab);
    const activeType = ORDER_TYPES.find(t => t.key === orderType);

    return (
        <div className={styles.container}>
            {/* Hidden while null; while printing it owns the paper. */}
            <KotSlips job={kotJob} />

            {/* Modals */}
            {modifyingItem && (
                <ModifierModal
                    /* Keyed by item so picking a different dish remounts with that
                       dish's defaults rather than inheriting the last one's. */
                    key={modifyingItem.id}
                    item={modifyingItem}
                    modifiersData={menuData.modifiers}
                    onClose={() => setModifyingItem(null)}
                    onConfirm={addToCart}
                />
            )}

            {/* The tab can vanish under us — settled on another terminal — while
                its bill is on screen, so never render a settle receipt without one */}
            {receiptMode && (receiptMode !== 'settle' || tab) && (
                <ReceiptPreview
                    cart={receiptMode === 'settle' ? tab.items : cart}
                    totals={receiptTotals}
                    includeTax={includeTax}
                    /* A tab already settled once keeps its stored number so a
                       reprint matches the original paper. */
                    invoiceNumber={tab?.invoice_number || pendingInvoiceNo || undefined}
                    meta={tab ? {
                        orderNumber: getOrderNumber(tab),
                        table: tab.table_number,
                        waiter: tab.waiter_name,
                        rounds: tab.round_count || 1
                    } : {
                        table: orderType === 'dine-in' ? tableNumber.trim() : null,
                        waiter: selectedWaiter?.name
                    }}
                    printLabel={receiptMode === 'settle' ? 'Print Bill & Settle' : 'Print & Close'}
                    role={role}
                    busy={isSending}
                    onClose={() => setReceiptMode(null)}
                    onPrint={receiptMode === 'settle' ? handleSettle : handlePayNow}
                />
            )}

            {showTabs && (
                <TabsDrawer
                    tabs={openTabs}
                    activeTabId={activeTabId}
                    onClose={() => setShowTabs(false)}
                    onAttach={target => attachTab(target)}
                    onSettle={target => attachTab(target, 'settle')}
                />
            )}

            {notice && <div className={styles.toast}>{notice}</div>}

            {/* Main Content (Left Side) */}
            <div className={styles.mainContent}>
                <header className={styles.header}>
                    <div className={styles.searchBar}>
                        <Search className={styles.searchIcon} size={18} aria-hidden="true" />
                        <input
                            type="text"
                            placeholder="Search menu..."
                            className={styles.searchInput}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>

                    <div className={styles.headerRight}>
                        <button
                            className={`${styles.tabsBtn} ${openTabs.length > 0 ? styles.tabsBtnActive : ''}`}
                            onClick={() => setShowTabs(true)}
                        >
                            <Layers size={18} aria-hidden="true" />
                            Open Tabs
                            {openTabs.length > 0 && (
                                <span className={styles.tabsCount}>{openTabs.length}</span>
                            )}
                        </button>

                        <div className={styles.customerInfo}>
                            <LiveClock className={styles.headerClock} />
                        </div>
                    </div>
                </header>

                {/* Category Tabs */}
                <div className={styles.categories}>
                    <button
                        className={`${styles.categoryTab} ${activeCategory === 'all' ? styles.active : ''}`}
                        onClick={() => setActiveCategory('all')}
                    >
                        All
                    </button>
                    {menuData.categories.map(cat => (
                        <button
                            key={cat.id}
                            className={`${styles.categoryTab} ${activeCategory === cat.id ? styles.active : ''}`}
                            onClick={() => setActiveCategory(cat.id)}
                        >
                            <CategoryIcon name={cat.icon} />
                            {cat.name}
                        </button>
                    ))}
                </div>

                {/* Menu Grid */}
                <div className={styles.menuGrid}>
                    {filteredItems.map(item => {
                        const soldOut = item.is_available === false;
                        return (
                            <div
                                key={item.id}
                                className={`${styles.menuItem} ${soldOut ? styles.soldOut : ''}`}
                                onClick={() => handleItemClick(item)}
                                aria-disabled={soldOut}
                            >
                                <div className={styles.imageContainer}>
                                    {item.image && (
                                        <img
                                            src={item.image}
                                            alt={item.name}
                                            /* 114 photos at ~190KB each is 21MB if they all load
                                               at once; lazy fetches only what is on screen */
                                            loading="lazy"
                                            decoding="async"
                                        />
                                    )}
                                    {soldOut && <span className={styles.soldOutTag}>Sold out</span>}
                                    <button
                                        type="button"
                                        className={`${styles.soldOutBtn} ${soldOut ? styles.soldOutBtnOn : ''}`}
                                        onClick={(e) => toggleSoldOut(item, e)}
                                        title={soldOut ? `Put ${item.name} back on` : `Mark ${item.name} sold out`}
                                        aria-label={soldOut ? `Put ${item.name} back on` : `Mark ${item.name} sold out`}
                                    >
                                        {soldOut ? <Eye size={15} /> : <EyeOff size={15} />}
                                    </button>
                                </div>
                                <div className={styles.itemContent}>
                                    <div className={styles.itemHeader}>
                                        <h3>{item.name}</h3>
                                        <span className={styles.itemPrice}>Rs. {item.price}</span>
                                    </div>

                                    <p className={styles.itemDesc}>{item.description}</p>

                                    {item.variants?.length > 0 && <span className={styles.badge}>Variants</span>}
                                </div>
                                {!soldOut && <button className={styles.addBtn}><Plus size={16} /></button>}
                            </div>
                        );
                    })}
                    {isLoading ? (
                        <div className={styles.emptyState}>
                            <Loader2 className={styles.loadingSpinner} size={28} />
                            <h3>Loading menu...</h3>
                        </div>
                    ) : filteredItems.length === 0 && (
                        <div className={styles.emptyState}>
                            {loadError ? (
                                <>
                                    <h3>Unable to load menu items</h3>
                                    <p>{loadError}</p>
                                </>
                            ) : loadedItemCount === 0 ? (
                                <>
                                    <h3>No menu items returned</h3>
                                    <p>Check Supabase row access, policies, or the correct project environment.</p>
                                </>
                            ) : (
                                <h3>No items found</h3>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Cart Section (Right Side) — once there are items, or while a tab is attached */}
            {showCartPanel && (
            <div className={styles.cartSection}>
                <div className={styles.cartHeader}>
                    <div>
                        <h2>{tab ? 'Open Tab' : 'Current Order'}</h2>
                        {tab && (
                            <div className={styles.cartSubtitle}>
                                Opened {formatOrderDate(tab.created_at)} · unpaid
                            </div>
                        )}
                    </div>
                    <div className={styles.cartHeaderRight}>
                        <span className={styles.orderId}>
                            {tab ? `#${getOrderNumber(tab)}` : 'New'}
                        </span>
                        {tab && (
                            <button
                                className={styles.detachBtn}
                                onClick={detachTab}
                                title="Leave this tab open and start a fresh order"
                                aria-label="Leave this tab"
                            >
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Order details: who is serving, and where */}
                <div className={styles.orderDetails}>
                    {tab ? (
                        // A tab's type is fixed once it is open — it is the same sitting
                        <div className={styles.typeLocked}>
                            {activeType && <activeType.Icon size={15} aria-hidden="true" />}
                            {activeType?.label || orderType}
                            <span className={styles.typeLockedNote}>· paying at the end</span>
                        </div>
                    ) : (
                        <div className={styles.orderTypeRow}>
                            {ORDER_TYPES.map(({ key, label, Icon }) => (
                                <button
                                    key={key}
                                    type="button"
                                    className={`${styles.typeBtn} ${orderType === key ? styles.activeType : ''}`}
                                    onClick={() => setOrderType(key)}
                                >
                                    <Icon size={16} aria-hidden="true" />
                                    {label}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className={styles.detailFields}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>
                                <UserRound size={14} aria-hidden="true" />
                                Waiter
                            </span>
                            <select
                                className={styles.fieldInput}
                                value={waiterId}
                                onChange={(e) => setWaiterId(e.target.value)}
                            >
                                <option value="">Unassigned</option>
                                {waiters.map(w => (
                                    <option key={w.id} value={w.id}>
                                        {w.code ? `${w.code} · ${w.name}` : w.name}
                                    </option>
                                ))}
                            </select>
                        </label>

                        {orderType === 'dine-in' && (
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>
                                    <Armchair size={14} aria-hidden="true" />
                                    Table
                                </span>
                                <input
                                    type="text"
                                    className={styles.fieldInput}
                                    placeholder="e.g. T4"
                                    value={tableNumber}
                                    onChange={(e) => setTableNumber(e.target.value)}
                                />
                            </label>
                        )}
                    </div>

                    {/* Customer details. Optional for dine-in, but delivery has
                        nowhere to send the food without them. */}
                    {orderType !== 'dine-in' && (
                        <div className={styles.detailsRow}>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>
                                    <Phone size={14} aria-hidden="true" />
                                    Phone
                                    {customerFound && <span className={styles.returningTag}>returning</span>}
                                </span>
                                <div className={styles.phoneRow}>
                                    <input
                                        type="tel"
                                        inputMode="tel"
                                        className={styles.fieldInput}
                                        placeholder="03xx xxxxxxx"
                                        value={customerPhone}
                                        onChange={(e) => { setCustomerPhone(e.target.value); setCustomerFound(false); }}
                                        onBlur={lookupCustomer}
                                    />
                                </div>
                            </label>

                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>
                                    <UserRound size={14} aria-hidden="true" />
                                    Name
                                </span>
                                <input
                                    type="text"
                                    className={styles.fieldInput}
                                    placeholder="Customer name"
                                    value={customerName}
                                    onChange={(e) => setCustomerName(e.target.value)}
                                />
                            </label>
                        </div>
                    )}

                    {orderType === 'delivery' && (
                        <label className={`${styles.field} ${styles.fieldWide}`}>
                            <span className={styles.fieldLabel}>
                                <MapPin size={14} aria-hidden="true" />
                                Delivery address
                            </span>
                            <textarea
                                className={styles.fieldInput}
                                rows={2}
                                placeholder="House / street / area"
                                value={customerAddress}
                                onChange={(e) => setCustomerAddress(e.target.value)}
                            />
                        </label>
                    )}
                </div>

                <div className={styles.cartItems}>
                    {/* Already fired to the kitchen — read-only history of the tab */}
                    {tab && tab.items.length > 0 && (
                        <div className={styles.sentBlock}>
                            <div className={styles.sectionLabel}>
                                <span>Already sent</span>
                                <span>
                                    {tab.round_count || 1} {(tab.round_count || 1) === 1 ? 'round' : 'rounds'}
                                </span>
                            </div>
                            {tab.items.map((item, idx) => (
                                <div key={idx} className={styles.sentRow}>
                                    <span className={styles.sentQty}>{item.qty}x</span>
                                    <span className={styles.sentName}>
                                        {item.name}
                                        <span className={styles.roundTag}>R{itemRound(item)}</span>
                                    </span>
                                    <span className={styles.sentPrice}>
                                        Rs. {(item.price * item.qty).toLocaleString()}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {cart.length > 0 && tab && (
                        <div className={styles.sectionLabel}>
                            <span>Not sent yet</span>
                            <span>Round {nextRound}</span>
                        </div>
                    )}

                    {cart.map((item, idx) => (
                        <div key={idx} className={styles.cartItemRow}>
                            <div className={styles.cartItemInfo}>
                                <h4>{item.name}</h4>
                                {item.selectedModifiers && (
                                    <div className={styles.modifiersList} style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                                        {Object.values(item.selectedModifiers).flat().map((m, i) => (
                                            <span key={i}>{m.name}{i < Object.values(item.selectedModifiers).flat().length - 1 ? ', ' : ''}</span>
                                        ))}
                                    </div>
                                )}
                                <div className={styles.qtyControls}>
                                    <button onClick={() => updateQty(idx, -1)} aria-label="Decrease quantity">
                                        <Minus size={14} />
                                    </button>
                                    <span>{item.qty}</span>
                                    <button onClick={() => updateQty(idx, 1)} aria-label="Increase quantity">
                                        <Plus size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className={styles.cartItemRight}>
                                <div className={styles.cartItemTotal}>
                                    Rs. {item.price * item.qty}
                                </div>
                                <button
                                    className={styles.removeBtn}
                                    onClick={() => removeItem(idx)}
                                    aria-label={`Remove ${item.name}`}
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        </div>
                    ))}

                    {tab && cart.length === 0 && (
                        <div className={styles.tabHint}>
                            Tap menu items to add another round, or settle the bill below.
                        </div>
                    )}
                </div>

                <div className={styles.cartSummary}>
                    {/* Payment Mode */}
                    <div className={styles.paymentMode}>
                        <button
                            className={`${styles.modeBtn} ${paymentMode === 'cash' ? styles.activeMode : ''}`}
                            onClick={() => setPaymentMode('cash')}
                        >
                            <Banknote size={18} aria-hidden="true" />
                            Cash
                        </button>
                        <button
                            className={`${styles.modeBtn} ${paymentMode === 'card' ? styles.activeMode : ''}`}
                            onClick={() => setPaymentMode('card')}
                        >
                            <CreditCard size={18} aria-hidden="true" />
                            Card
                        </button>
                    </div>

                    {/* FBR Tax Toggle */}
                    <label className={styles.taxToggle}>
                        <input
                            type="checkbox"
                            checked={includeTax}
                            onChange={(e) => setIncludeTax(e.target.checked)}
                        />
                        <span>Include FBR Tax ({taxPercentLabel})</span>
                    </label>

                    {/* Discount. Amount or percent, with a reason, because a
                        discount nobody can account for later is how a till
                        quietly leaks money. */}
                    <div className={styles.discountBlock}>
                        <div className={styles.discountRow}>
                            <div className={styles.discountModes}>
                                <button
                                    type="button"
                                    className={`${styles.discountMode} ${discountMode === 'amount' ? styles.activeMode : ''}`}
                                    onClick={() => setDiscountMode('amount')}
                                >
                                    Rs.
                                </button>
                                <button
                                    type="button"
                                    className={`${styles.discountMode} ${discountMode === 'percent' ? styles.activeMode : ''}`}
                                    onClick={() => setDiscountMode('percent')}
                                >
                                    %
                                </button>
                            </div>
                            <input
                                type="number"
                                min="0"
                                max={discountMode === 'percent' ? 100 : undefined}
                                step="1"
                                inputMode="numeric"
                                className={styles.discountInput}
                                placeholder="Discount"
                                value={discountValue}
                                onChange={(e) => setDiscountValue(e.target.value)}
                            />
                        </div>
                        {discountAmount > 0 && (
                            <input
                                type="text"
                                className={styles.discountReason}
                                placeholder="Reason (staff meal, comp, manager)"
                                value={discountReason}
                                onChange={(e) => setDiscountReason(e.target.value)}
                                maxLength={60}
                            />
                        )}
                    </div>

                    {tab && (
                        <>
                            <div className={styles.summaryRow}>
                                <span>Already on tab</span>
                                <span>Rs. {tabTotals.subtotal.toLocaleString()}</span>
                            </div>
                            {cart.length > 0 && (
                                <div className={styles.summaryRow}>
                                    <span>This round</span>
                                    <span>Rs. {roundTotals.subtotal.toLocaleString()}</span>
                                </div>
                            )}
                        </>
                    )}

                    <div className={styles.summaryRow}>
                        <span>Subtotal</span>
                        <span>Rs. {receiptTotals.subtotal.toLocaleString()}</span>
                    </div>
                    {receiptTotals.discount > 0 && (
                        <div className={`${styles.summaryRow} ${styles.discountSummary}`}>
                            <span>Discount{discountReason.trim() ? ` · ${discountReason.trim()}` : ''}</span>
                            <span>− Rs. {receiptTotals.discount.toLocaleString()}</span>
                        </div>
                    )}
                    <div className={styles.summaryRow}>
                        <span>Tax ({taxPercentLabel})</span>
                        <span>Rs. {receiptTotals.tax.toLocaleString()}</span>
                    </div>
                    <div className={`${styles.summaryRow} ${styles.totalRow}`}>
                        <span>{tab ? 'Bill total' : 'Total'}</span>
                        <span>Rs. {receiptTotals.total.toLocaleString()}</span>
                    </div>

                    {tab ? (
                        <>
                            <button
                                className={styles.checkoutBtn}
                                onClick={handleSendRound}
                                disabled={cart.length === 0 || isSending}
                            >
                                <Send size={17} aria-hidden="true" />
                                Send Round {nextRound} to Kitchen
                            </button>
                            <button
                                className={styles.secondaryBtn}
                                onClick={() => setReceiptMode('settle')}
                                disabled={!canSettle || isSending}
                                title={canSettle
                                    ? 'Print the bill and take payment'
                                    : 'Send this round to the kitchen first'}
                            >
                                <Receipt size={17} aria-hidden="true" />
                                Settle Bill (Rs. {tabTotals.total.toLocaleString()})
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                className={styles.checkoutBtn}
                                onClick={handleCheckout}
                                disabled={cart.length === 0 || isSending}
                            >
                                Send &amp; Pay Now (Rs. {roundTotals.total.toLocaleString()})
                            </button>
                            <button
                                className={styles.secondaryBtn}
                                onClick={handleOpenTab}
                                disabled={cart.length === 0 || isSending}
                                title="Send the food now and keep the bill open"
                            >
                                <Layers size={17} aria-hidden="true" />
                                Open Tab · Pay at the End
                            </button>
                        </>
                    )}
                </div>
            </div>
            )}
        </div>
    );
}

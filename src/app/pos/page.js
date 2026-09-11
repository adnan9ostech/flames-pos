'use client';
import { useState, useEffect, useMemo, useCallback, useRef, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import styles from './pos.module.css';
import {
    getMenuItems, getCategories, addOrder, getModifiers, getWaiters,
    getOpenTabs, appendRoundToOrder, settleOrder, getTaxRates, findCustomerByPhone,
} from '@/lib/dataClient';
import { buildKotSlips, printKotSlip, runPrintQueue, DEFAULT_KOT_MODE } from '@/lib/kotPrint';
import { listActiveCharges } from '@/app/charges/actions';
import { approveVoid } from './voidActions';
import { applicablePlans } from '@/app/discounts/actions';
import { listActiveTables } from '@/app/floor/actions';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { calcTotals, itemRound, DEFAULT_TAX_RATE } from '@/lib/orderTotals.mjs';
import { getOrderNumber, formatOrderDate } from '@/lib/orderDisplay';
import { loadCartDraft, saveCartDraft, clearCartDraft } from '@/lib/cartDraft';
import { getSettings } from '@/app/settings/actions';
import { printReceipt, applyPaperWidth } from '@/lib/printReceipt';
import { printReceiptViaAgent, printKotViaAgent, openCashDrawerViaAgent } from '@/lib/thermalAgent';
import { formatNumber as money, formatPriceRange } from '@/lib/money';

import ModifierModal from '@/components/POS/ModifierModal';
import ReceiptPreview from '@/components/POS/ReceiptPreview';
import KotSlips from '@/components/POS/KotSlips';
import CompanyPicker from '@/components/POS/CompanyPicker';
import VoidPinDialog from '@/components/POS/VoidPinDialog';
import DiscountPlans from '@/components/POS/DiscountPlans';
import TabsDrawer from '@/components/POS/TabsDrawer';
import LiveClock from '@/components/Layout/LiveClock';
import { useRole } from '@/components/Layout/AppLayout';

import {
    Soup, Flame, Utensils, Cookie, GlassWater, Plus, CirclePlus,
    Search, Banknote, CreditCard, X, Minus, UserRound, Armchair, Phone, MapPin,
    UtensilsCrossed, ShoppingBag, Bike, Loader2, Layers, Receipt, Send,
    BadgePercent, LayoutGrid, Rows3
} from 'lucide-react';

const ORDER_TYPES = [
    { key: 'dine-in', label: 'Dine-in', Icon: UtensilsCrossed },
    { key: 'takeaway', label: 'Takeaway', Icon: ShoppingBag },
    { key: 'delivery', label: 'Delivery', Icon: Bike }
];

/*
 * Grid or list, remembered per till.
 *
 * Photographs sell food, so the grid is the default and stays the default. The
 * list is for the shift that already knows the menu: names and prices, four
 * times as many dishes on screen, no scrolling past pictures to reach the
 * chai. Which one a terminal wants is a property of that terminal — the
 * counter till and the phone-order desk disagree — so the choice lives in
 * localStorage, not in store settings.
 *
 * Read through a store rather than an effect for the same reason the sidebar's
 * collapse state is: an effect would paint the grid first and snap to the list
 * a frame later, and the server render has to be allowed to disagree with the
 * client without React calling it a hydration error.
 */
const VIEW_KEY = 'fbi.posView';
const viewListeners = new Set();

const viewStore = {
    subscribe(onChange) {
        viewListeners.add(onChange);
        window.addEventListener('storage', onChange);
        return () => {
            viewListeners.delete(onChange);
            window.removeEventListener('storage', onChange);
        };
    },
    getSnapshot() {
        try {
            return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
        } catch {
            // A till with site data blocked still has to sell food.
            return 'grid';
        }
    },
    getServerSnapshot: () => 'grid',
    set(mode) {
        try {
            window.localStorage.setItem(VIEW_KEY, mode);
        } catch { /* ignore — the toggle still works for this session */ }
        viewListeners.forEach((onChange) => onChange());
    },
};

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
    const viewMode = useSyncExternalStore(
        viewStore.subscribe, viewStore.getSnapshot, viewStore.getServerSnapshot,
    );
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

    // Auto-applied charges and the discount plans valid right now — both
    // loaded once and repriced locally, so the till's expected total matches
    // what the server will compute at settle.
    const [activeCharges, setActiveCharges] = useState([]);
    const [discountPlans, setDiscountPlans] = useState([]);
    const [floorTables, setFloorTables] = useState([]);

    // City-ledger settles charge a company account instead of taking money.
    const [company, setCompany] = useState(null);
    const [showCompanyPicker, setShowCompanyPicker] = useState(false);

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
    /*
     * How a round is cut into slips: one per section, or one per dish. Read
     * once at mount and again on nothing — a mode change is a settings save,
     * and the till picks it up on its next load, which is how the paper width
     * and the auto-print switch already behave.
     */
    const [kotMode, setKotMode] = useState(DEFAULT_KOT_MODE);
    /*
     * Where the kitchen ticket prints. 'kds' (the default) leaves the slips to
     * the kitchen screen and keeps the till on the receipt alone, so the two
     * printers never contend; 'till' is the single-printer counter, where the
     * till prints the slips itself exactly as it always did.
     */
    const [kotRoute, setKotRoute] = useState('kds');
    /*
     * How this terminal reaches paper. 'agent' means a local print agent
     * writing raw ESC/POS to a thermal printer, and browser printing is then
     * never used as a fallback — a browser job reaches a raw ESC/POS printer as
     * PostScript and prints as pages of source code.
     */
    const [printTransport, setPrintTransport] = useState('agent');
    // When on, removing a line from the cart needs a manager PIN.
    const [voidRequiresPin, setVoidRequiresPin] = useState(false);
    // The line-removal a PIN dialog is standing in front of: { index }.
    const [pendingVoid, setPendingVoid] = useState(null);

    // Discount on the bill being paid
    const [discountMode, setDiscountMode] = useState('amount'); // 'amount' | 'percent'
    const [discountValue, setDiscountValue] = useState('');
    const [discountReason, setDiscountReason] = useState('');
    /*
     * The discount editor is folded away until asked for. Most bills carry no
     * discount, and its three controls were costing the item list ~100px of
     * height on every order that would never use them. It opens on request and
     * stays open while a discount is on the bill, so an applied discount is
     * never edited blind.
     */
    const [showDiscount, setShowDiscount] = useState(false);

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
        listActiveCharges().then(r => r?.data && setActiveCharges(r.data)).catch(() => {});
        listActiveTables().then(r => r?.data && setFloorTables(r.data)).catch(() => {});
        getSettings().then(s => {
            setAutoPrint(s?.auto_print !== false);
            // normalizeKotMode inside buildKotSlips guards the value, so an
            // older row with no column simply prints the default.
            setKotMode(s?.kot_mode || DEFAULT_KOT_MODE);
            // Anything but an explicit 'till' means the kitchen screen prints,
            // so an older row with no column keeps the two-device default.
            setKotRoute(s?.kot_route === 'till' ? 'till' : 'kds');
            setPrintTransport(s?.print_transport === 'browser' ? 'browser' : 'agent');
            setVoidRequiresPin(s?.void_requires_pin === true);
            // The kitchen slips print before any receipt is mounted, so the
            // till has to publish the paper width itself.
            applyPaperWidth(s?.receipt_width_mm);
        });
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
     * Availability is no longer flipped from the till.
     *
     * It used to be a switch on every tile, on the reasoning that whoever
     * notices the shortage is whoever is standing at the counter. Menu
     * Management owns it now (Menu > Dishes), beside the price, the sizes and
     * the recipe it belongs with — one switch in one place, rather than the
     * same fact editable from two screens with two different audiences.
     * `setMenuItemAvailability` still exists; that screen is what calls it.
     */

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
                // Replace the line, never mutate it: the spread above is a
                // shallow copy, so `prev[existingIndex].qty += 1` edited the
                // object React still holds as the previous state. Same shape
                // as updateQty below.
                const line = newCart[existingIndex];
                newCart[existingIndex] = { ...line, qty: line.qty + 1 };
                return newCart;
            }
            return [...prev, { ...item, qty: 1 }];
        });
        setModifyingItem(null);
    };

    // Actually drop a line, once anyone allowed to has said so.
    const dropLine = (index) => setCart(prev => prev.filter((_, i) => i !== index));

    // Update Cart Quantity
    const updateQty = (index, change) => {
        // Stepping the last unit off a line is a removal, so it goes through
        // the same manager gate a tap on the bin does — otherwise the minus
        // button would be the way around it.
        if (change < 0 && (cart[index]?.qty ?? 0) + change <= 0) {
            requestRemove(index);
            return;
        }
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

    // Remove Item — gated behind a manager PIN when the store asks for one,
    // otherwise dropped straight away.
    const removeItem = (index) => requestRemove(index);

    const requestRemove = (index) => {
        if (voidRequiresPin) {
            setPendingVoid({ index });
            return;
        }
        dropLine(index);
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

    // The bill belongs to the tab's order type once one exists; the toggle
    // only steers a fresh sale. Charges scope by that type, so a dine-in tab
    // keeps its service charge even while the toggle sits on takeaway.
    const effectiveOrderType = tab?.order_type ?? orderType;
    const chargesForOrder = useMemo(
        () => activeCharges.filter((c) => {
            const types = Array.isArray(c.order_types) ? c.order_types : [];
            return types.length === 0 || types.includes(effectiveOrderType);
        }),
        [activeCharges, effectiveOrderType]
    );

    const priceOpts = useMemo(() => ({ taxRate, charges: chargesForOrder }), [taxRate, chargesForOrder]);

    // Plans depend on the order type and the clock; refetch when the type
    // moves rather than pretending yesterday's list still applies.
    useEffect(() => {
        applicablePlans({ orderType: effectiveOrderType })
            .then(r => setDiscountPlans(r?.data || []))
            .catch(() => setDiscountPlans([]));
    }, [effectiveOrderType]);

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
    const printIfEnabled = async (order = null) => {
        if (!autoPrint) return;
        /*
         * The local thermal agent first, when one is running: it writes the
         * bill to the printer as text, which is the only way to reach a
         * Bluetooth printer the operating system refuses to make a queue for,
         * and is far faster than a rasterised page over a serial link either
         * way. It returns false the moment anything is wrong — no agent, no
         * printer, no confirmation.
         */
        if (order?.id && await printReceiptViaAgent(order.id)) return;

        /*
         * On a thermal terminal that is the end of it. The counter printer only
         * speaks ESC/POS, and window.print() hands CUPS a page that reaches it
         * as PostScript, which it prints as source code — one such fallback ran
         * off most of a roll on 10 Sep 2026. So say what went wrong and let the
         * operator reprint from Orders once the agent is up. The sale is
         * already stored; only the paper is missing.
         */
        if (printTransport === 'agent') {
            setNotice('Receipt not printed — the print agent is not running. Start it, then reprint from Orders.');
            return;
        }
        printReceipt();
    };

    /*
     * The cash drawer, on a sale that is finished and stored.
     *
     * Not gated on auto-print: paper and the drawer are separate promises to
     * the cashier, and a jammed printer is no reason to make somebody unlock a
     * till by hand. Which sales open it — cash only, all, or none — is the
     * agent's call from Settings, so every terminal answers the same way.
     *
     * A browser-printing terminal is skipped outright: the pulse that opens a
     * drawer is a control code, and there is no way to put one into a page the
     * operating system rasterises.
     */
    const openDrawerIfEnabled = async (order = null) => {
        if (printTransport !== 'agent') return;
        await openCashDrawerViaAgent(order?.id || null);
    };

    /*
     * The kitchen slips for the round just sent, cut the way Settings says:
     * one per section, or one per dish. Runs only after the server accepted
     * the round (kitchen must never cook food that was never stored) and
     * always before the customer receipt, whose print CSS the slip root
     * deliberately overrides while mounted. Gated on autoPrint with the
     * receipt: without --kiosk-printing each slip would raise its own dialog.
     */
    const printKotSlips = async (sentItems, order, roundNo) => {
        // Under the two-device setup the kitchen screen prints the ticket on
        // its own printer, so the till stays out of it — printing here is what
        // put the kitchen slips and the receipt through one printer and made
        // them fight. On a single-printer counter (route 'till') the till
        // prints them as it always did.
        if (kotRoute === 'kds') return;
        if (!autoPrint || !order) return;

        /*
         * A thermal terminal prints the slips through the agent, from the
         * stored round — same rule as the receipt, and for the same reason:
         * the browser path would reach this printer as PostScript. No fallback.
         */
        if (printTransport === 'agent') {
            const printed = await printKotViaAgent(order.id, { round: roundNo });
            if (!printed) setNotice('Kitchen ticket not printed — the print agent is not running.');
            return;
        }

        const slips = buildKotSlips(kotMode, sentItems, menuData.items, menuData.categories);
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
        setCompany(null);
        setPaymentMode('cash');
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
        if (paymentMode === 'city_ledger' && !company) {
            setShowCompanyPicker(true);
            return;
        }
        setIsSending(true);
        try {
            const saved = await addOrder({
                items: cart.map(item => ({ ...item, round: 1 })),
                company_id: paymentMode === 'city_ledger' ? company.id : undefined,
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
            await printIfEnabled(saved);
            await openDrawerIfEnabled(saved);
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
                // Same expression handlePayNow uses. Without it a tab opened
                // with a discount stored the rupees and no reason — the one
                // path in the till where money came off a bill unexplained —
                // and attachTab had nothing to restore into the reason box.
                discount_reason: discountAmount > 0 ? discountReason.trim() || null : null,
                include_tax: includeTax,
                order_type: orderType,
                ...orderDetails(),
                status: 'new',
                payment_status: 'unpaid'
            });
            // Slips for round 1 go out now; the bill stays open and prints at
            // settle time.
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
            setNotice('Send or clear the unsent items in the cart before completing this order.');
            return;
        }
        if (paymentMode === 'city_ledger' && !company) {
            setShowCompanyPicker(true);
            return;
        }
        setIsSending(true);
        if (!settleRequestIdRef.current) settleRequestIdRef.current = crypto.randomUUID();
        try {
            const settled = await settleOrder(tab.id, {
                paymentMode,
                companyId: paymentMode === 'city_ledger' ? company.id : undefined,
                includeTax,
                discount: discountAmount,
                discountReason: discountAmount > 0 ? discountReason.trim() || null : null,
                // The bill as shown; the server refuses to settle a different one.
                expectedTotal: billTotals.total,
                clientRequestId: settleRequestIdRef.current,
            });
            settleRequestIdRef.current = null;
            // The kitchen already has every round — each fired when it was
            // sent — so settling only takes the money and prints the bill.
            // Same as pay-now: the paper must carry the number the server
            // issued, so flush it into the receipt before printing.
            flushSync(() => setPendingInvoiceNo(settled?.invoice_number || null));
            await printIfEnabled(settled);
            await openDrawerIfEnabled(settled);
            await loadTabs();
            clearOrderFields();
            setReceiptMode(null);
            setNotice('Order completed.');
        } catch (error) {
            console.error('Failed to settle bill', error);
            alert(error.message || 'Failed to complete the order');
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

            {showCompanyPicker && (
                <CompanyPicker
                    onSelect={(c) => {
                        setCompany(c);
                        setShowCompanyPicker(false);
                    }}
                    onClose={() => {
                        setShowCompanyPicker(false);
                        // Backed out without choosing: a companyless
                        // city-ledger sale cannot exist, so fall back to cash.
                        if (!company) setPaymentMode('cash');
                    }}
                />
            )}

            {pendingVoid && (
                <VoidPinDialog
                    itemName={cart[pendingVoid.index]?.name}
                    verify={({ pin, reason }) => approveVoid({
                        pin,
                        reason,
                        // The line being taken off, and the tab it belongs to
                        // (null for an unsent walk-in cart), so the audit entry
                        // says exactly what was removed and from where.
                        item: cart[pendingVoid.index] || null,
                        orderId: activeTabId || null,
                    })}
                    onApprove={() => {
                        dropLine(pendingVoid.index);
                        setPendingVoid(null);
                    }}
                    onCancel={() => setPendingVoid(null)}
                />
            )}

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
                    /* The rate this bill was actually priced at — the payment
                       mode's, not a store-wide one. */
                    taxRate={taxRate}
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
                    printLabel={receiptMode === 'settle' ? 'Print & Complete Order' : 'Print & Close'}
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
                        {/* Grid or list. A segmented pair rather than one
                            toggling button: staff should see which view they
                            are in without having to work it out from the
                            screen behind it. */}
                        <div className={styles.viewToggle} role="group" aria-label="Menu layout">
                            <button
                                type="button"
                                className={`${styles.viewBtn} ${viewMode === 'grid' ? styles.viewBtnOn : ''}`}
                                onClick={() => viewStore.set('grid')}
                                aria-pressed={viewMode === 'grid'}
                                title="Show dishes as cards with photos"
                            >
                                <LayoutGrid size={17} aria-hidden="true" />
                                <span className={styles.viewLabel}>Grid</span>
                            </button>
                            <button
                                type="button"
                                className={`${styles.viewBtn} ${viewMode === 'list' ? styles.viewBtnOn : ''}`}
                                onClick={() => viewStore.set('list')}
                                aria-pressed={viewMode === 'list'}
                                title="Show dishes as a compact list"
                            >
                                <Rows3 size={17} aria-hidden="true" />
                                <span className={styles.viewLabel}>List</span>
                            </button>
                        </div>

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

                {/* One markup, two layouts: the list is a CSS variant of the
                    same cards, so a dish behaves identically either way —
                    same tap to add, same 86 switch, same sold-out state. */}
                <div className={`${styles.menuGrid} ${viewMode === 'list' ? styles.menuList : ''}`}>
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
                                </div>
                                {/*
                                  * The tag stays; the switch is gone. A dish being off has
                                  * to be visible to whoever is selling — a cashier
                                  * promising food the kitchen cannot cook is the failure
                                  * this guards against — but turning it off and on is a
                                  * menu decision, made on Menu > Dishes beside the price,
                                  * the sizes and the recipe it belongs with. One switch,
                                  * one place, one audit trail.
                                  */}
                                {soldOut && <span className={styles.soldOutTag}>Sold out</span>}
                                <div className={styles.itemContent}>
                                    <div className={styles.itemHeader}>
                                        <h3>{item.name}</h3>
                                        {/* The list shows the span a sized dish can ring
                                            at, instead of a "Variants" chip beside the
                                            name: it says the same thing in the space the
                                            price already occupies, and gives the name back
                                            the width it was losing. The grid has room for
                                            both, so it keeps the chip. */}
                                        <span className={styles.itemPrice}>
                                            {viewMode === 'list'
                                                ? formatPriceRange(item.price, item.variants)
                                                : `Rs. ${money(item.price)}`}
                                        </span>
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
                    <div className={styles.cartHeaderLeft}>
                        <h2>{tab ? 'Open Tab' : 'Current Order'}</h2>
                        {/* Line count, because the list now scrolls: the
                            cashier must be able to tell at a glance that
                            there is more bill than screen. */}
                        {cart.length > 0 && (
                            <span className={styles.lineCount}>
                                {cart.length} {cart.length === 1 ? 'line' : 'lines'}
                            </span>
                        )}
                        {tab && (
                            <span className={styles.cartSubtitle}>
                                {formatOrderDate(tab.created_at)} · unpaid
                            </span>
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

                    {/*
                        Each field wears its icon inside the control instead of
                        a stacked uppercase label above it. The label row was
                        costing ~22px per field and said nothing the icon and
                        placeholder don't — that height belongs to the item
                        list. The name still reaches a screen reader by
                        aria-label.
                    */}
                    <div className={styles.detailFields}>
                        <div className={styles.compactField}>
                            <UserRound size={14} aria-hidden="true" />
                            <select
                                className={styles.bareInput}
                                aria-label="Waiter"
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
                        </div>

                        {orderType === 'dine-in' && (
                            <div className={styles.compactField}>
                                <Armchair size={14} aria-hidden="true" />
                                {/* Suggests the floor's real tables while
                                    still accepting a typed one — a table
                                    added mid-service must not block a sale. */}
                                <input
                                    type="text"
                                    list="floor-tables"
                                    className={styles.bareInput}
                                    aria-label="Table"
                                    placeholder="Table"
                                    value={tableNumber}
                                    onChange={(e) => setTableNumber(e.target.value)}
                                />
                                <datalist id="floor-tables">
                                    {floorTables.map((t) => (
                                        <option key={t.name} value={t.name}>
                                            {t.area || ''}
                                        </option>
                                    ))}
                                </datalist>
                            </div>
                        )}
                    </div>

                    {/* Customer details. Optional for dine-in, but delivery has
                        nowhere to send the food without them. */}
                    {orderType !== 'dine-in' && (
                        <div className={styles.detailFields}>
                            <div className={styles.compactField}>
                                <Phone size={14} aria-hidden="true" />
                                <input
                                    type="tel"
                                    inputMode="tel"
                                    className={styles.bareInput}
                                    aria-label="Customer phone"
                                    placeholder="03xx xxxxxxx"
                                    value={customerPhone}
                                    onChange={(e) => { setCustomerPhone(e.target.value); setCustomerFound(false); }}
                                    onBlur={lookupCustomer}
                                />
                                {customerFound && <span className={styles.returningTag}>returning</span>}
                            </div>

                            <div className={styles.compactField}>
                                <UserRound size={14} aria-hidden="true" />
                                <input
                                    type="text"
                                    className={styles.bareInput}
                                    aria-label="Customer name"
                                    placeholder="Customer name"
                                    value={customerName}
                                    onChange={(e) => setCustomerName(e.target.value)}
                                />
                            </div>
                        </div>
                    )}

                    {orderType === 'delivery' && (
                        <div className={`${styles.compactField} ${styles.fieldWide}`}>
                            <MapPin size={14} aria-hidden="true" />
                            <textarea
                                className={styles.bareInput}
                                aria-label="Delivery address"
                                rows={2}
                                placeholder="House / street / area"
                                value={customerAddress}
                                onChange={(e) => setCustomerAddress(e.target.value)}
                            />
                        </div>
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
                                        Rs. {money(item.price * item.qty)}
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

                    {/*
                        One line per line. The stepper moved from under the
                        dish name to beside it, which halves the row: its 44px
                        height now sets the row's height instead of stacking on
                        top of it, so roughly twice as many lines of the bill
                        are on screen at once. The 44px touch target itself is
                        untouched — it is the reason the row is 52px and not
                        36px, and these buttons decide what a customer pays.
                    */}
                    {cart.map((item, idx) => (
                        <div key={idx} className={styles.cartItemRow}>
                            <div className={styles.qtyControls}>
                                <button onClick={() => updateQty(idx, -1)} aria-label={`One fewer ${item.name}`}>
                                    <Minus size={14} />
                                </button>
                                <span>{item.qty}</span>
                                <button onClick={() => updateQty(idx, 1)} aria-label={`One more ${item.name}`}>
                                    <Plus size={14} />
                                </button>
                            </div>
                            <div className={styles.cartItemInfo}>
                                <h4>{item.name}</h4>
                                {item.selectedModifiers && (
                                    <div className={styles.modifiersList}>
                                        {Object.values(item.selectedModifiers).flat().map((m, i) => (
                                            <span key={i}>{m.name}{i < Object.values(item.selectedModifiers).flat().length - 1 ? ', ' : ''}</span>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className={styles.cartItemTotal}>
                                Rs. {money(item.price * item.qty)}
                            </div>
                            <button
                                className={styles.removeBtn}
                                onClick={() => removeItem(idx)}
                                aria-label={`Remove ${item.name}`}
                            >
                                <X size={15} />
                            </button>
                        </div>
                    ))}

                    {tab && cart.length === 0 && (
                        <div className={styles.tabHint}>
                            Tap menu items to add another round, or settle the bill below.
                        </div>
                    )}
                </div>

                <div className={styles.cartSummary}>
                    {/* One-tap scheduled promos — a chip fills the rupee
                        amount and the reason, nothing more magical. Renders
                        nothing at all when no plan is on offer, so it costs
                        the bill no height on an ordinary night. */}
                    <DiscountPlans
                        plans={discountPlans}
                        billItems={billItems}
                        subtotal={billTotals.subtotal}
                        onApply={(planName, rupees) => {
                            setDiscountMode('amount');
                            setDiscountValue(String(rupees));
                            setDiscountReason(planName);
                            setShowDiscount(true);
                        }}
                    />

                    {/* Discount. Amount or percent, with a reason, because a
                        discount nobody can account for later is how a till
                        quietly leaks money. Folded away until wanted — but
                        never while one is applied, so money already off the
                        bill is always editable in place. */}
                    {(showDiscount || discountAmount > 0) ? (
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
                                <button
                                    type="button"
                                    className={styles.discountClose}
                                    onClick={() => {
                                        setDiscountValue('');
                                        setDiscountReason('');
                                        setShowDiscount(false);
                                    }}
                                    aria-label="Clear the discount"
                                >
                                    <X size={15} />
                                </button>
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
                    ) : (
                        <button
                            type="button"
                            className={styles.discountToggle}
                            onClick={() => setShowDiscount(true)}
                        >
                            <BadgePercent size={13} aria-hidden="true" />
                            Add a discount
                        </button>
                    )}

                    {tab && (
                        <>
                            <div className={styles.summaryRow}>
                                <span>Already on tab</span>
                                <span>Rs. {money(tabTotals.subtotal)}</span>
                            </div>
                            {cart.length > 0 && (
                                <div className={styles.summaryRow}>
                                    <span>This round</span>
                                    <span>Rs. {money(roundTotals.subtotal)}</span>
                                </div>
                            )}
                        </>
                    )}

                    <div className={styles.summaryRow}>
                        <span>Subtotal</span>
                        <span>Rs. {money(receiptTotals.subtotal)}</span>
                    </div>
                    {receiptTotals.discount > 0 && (
                        <div className={`${styles.summaryRow} ${styles.discountSummary}`}>
                            <span>Discount{discountReason.trim() ? ` · ${discountReason.trim()}` : ''}</span>
                            <span>− Rs. {money(receiptTotals.discount)}</span>
                        </div>
                    )}
                    {(receiptTotals.charges || []).map((c) => (
                        <div className={styles.summaryRow} key={c.name}>
                            <span>{c.name}</span>
                            <span>Rs. {money(c.amount)}</span>
                        </div>
                    ))}
                    {/* The FBR tax switch lives on the row it governs. It used
                        to be a separate labelled checkbox above the bill, which
                        cost a row of its own and put the control a long way
                        from the number it changes. */}
                    <label className={`${styles.summaryRow} ${styles.taxRow}`}>
                        <span className={styles.taxLabel}>
                            <input
                                type="checkbox"
                                checked={includeTax}
                                onChange={(e) => setIncludeTax(e.target.checked)}
                            />
                            FBR Tax ({taxPercentLabel})
                        </span>
                        <span>Rs. {money(receiptTotals.tax)}</span>
                    </label>
                    <div className={`${styles.summaryRow} ${styles.totalRow}`}>
                        <span>{tab ? 'Bill total' : 'Total'}</span>
                        <span>Rs. {money(receiptTotals.total)}</span>
                    </div>

                    {/* How they are paying sits directly above the button that
                        takes the money — one decision, one place. Cash and card
                        carry different tax rates, so switching a chip repoints
                        the tax row above it. */}
                    <div className={styles.paymentMode}>
                        <button
                            className={`${styles.modeBtn} ${paymentMode === 'cash' ? styles.activeMode : ''}`}
                            onClick={() => setPaymentMode('cash')}
                        >
                            <Banknote size={16} aria-hidden="true" />
                            Cash
                        </button>
                        <button
                            className={`${styles.modeBtn} ${paymentMode === 'card' ? styles.activeMode : ''}`}
                            onClick={() => setPaymentMode('card')}
                        >
                            <CreditCard size={16} aria-hidden="true" />
                            Card
                        </button>
                        <button
                            className={`${styles.modeBtn} ${paymentMode === 'city_ledger' ? styles.activeMode : ''}`}
                            onClick={() => {
                                setPaymentMode('city_ledger');
                                if (!company) setShowCompanyPicker(true);
                            }}
                            title="Charge to a company account — settled later by receipt"
                        >
                            <Layers size={16} aria-hidden="true" />
                            Company
                        </button>
                    </div>

                    {paymentMode === 'city_ledger' && (
                        <button
                            type="button"
                            className={styles.companyBtn}
                            onClick={() => setShowCompanyPicker(true)}
                        >
                            {company ? `Charging: ${company.name} — change` : 'Choose the company…'}
                        </button>
                    )}

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
                                Complete Order (Rs. {money(tabTotals.total)})
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                className={styles.checkoutBtn}
                                onClick={handleCheckout}
                                disabled={cart.length === 0 || isSending}
                            >
                                Send &amp; Pay Now (Rs. {money(roundTotals.total)})
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

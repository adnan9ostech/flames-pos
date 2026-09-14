'use client';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useBrand } from '@/components/Layout/BrandProvider';
import { flushSync } from 'react-dom';
import Image from 'next/image';
import styles from './kds.module.css';
import { getKitchenOrders, bumpOrder, getFullMenuData } from '@/lib/dataClient';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import {
    getOrderNumber, buildImageMap, resolveItemImage, formatModifiers
} from '@/lib/orderDisplay';
import { isLatestRound } from '@/lib/orderTotals.mjs';
import { buildKotSlips, printKotSlip, runPrintQueue, DEFAULT_KOT_MODE } from '@/lib/kotPrint';
import { applyPaperWidth } from '@/lib/printReceipt';
import { printKotViaAgent } from '@/lib/thermalAgent';
import KotSlips from '@/components/POS/KotSlips';
import { getSettings } from '@/app/settings/actions';
import LiveClock from '@/components/Layout/LiveClock';
import { UtensilsCrossed, Volume2, VolumeX, Maximize2, UserRound, Layers, Printer, Loader2 } from 'lucide-react';

// Kitchen lanes, in the order tickets flow across the screen. These keys are
// the statuses getKitchenOrders() fetches (KITCHEN_STATUSES in src/lib/db/reads.mjs) —
// a lane added here without adding it there would render permanently empty.
const LANES = [
    { key: 'new', label: 'New', next: 'preparing', action: 'Start' },
    { key: 'preparing', label: 'Preparing', next: 'ready', action: 'Ready' },
    { key: 'ready', label: 'Ready', next: 'completed', action: 'Serve' }
];

// Minutes since an order landed, used to escalate a ticket's urgency
const WARN_AFTER = 5;
const LATE_AFTER = 10;

/*
 * How long a primed print button stays primed.
 *
 * The reprint is guarded by a second tap rather than a modal: a confirm dialog
 * on a kitchen screen is a thing to dismiss with a wet glove mid-service, and a
 * bare button is a stack of paper away from a sleeve brushing the display. The
 * first tap turns the button into "Print N tickets?" — which is also where the
 * cost of per-item mode is stated — and it disarms itself if nobody follows
 * through, so a half-press never sits waiting to fire later.
 */
const ARM_MS = 4000;

/*
 * Feeds one pass of slips through the printer, then unmounts the slip root
 * whatever happened — while #kot-print-root is in the DOM its print CSS owns
 * the paper, so a pass that died halfway would leave nothing else on the board
 * printable. Paper is never worth breaking the board over, so nothing here is
 * allowed to escape.
 *
 * At module scope rather than in the component for a mechanical reason: a
 * try/finally inside a component makes the React Compiler bail on the whole
 * FILE, which silently switches off the react-hooks lint rules for every effect
 * on this page. Out here it costs nothing and the board keeps its safety net.
 */
const feedSlipsToPrinter = async (slips, meta, setJob) => {
    try {
        await runPrintQueue(slips, (slip) => {
            // flushSync, not a queued set: printKotSlip() reads the DOM on the
            // next line, and a queued render would print the prior slip.
            flushSync(() => setJob({ slip, meta }));
            printKotSlip();
        });
    } catch (error) {
        console.error('Could not reprint kitchen tickets', error);
    } finally {
        flushSync(() => setJob(null));
    }
};

/*
 * Drains the auto-print queue one order at a time through the single printer,
 * so two rounds arriving in the same poll never interleave their slips. At
 * module scope for the same reason feedSlipsToPrinter is: a try/finally inside
 * a component makes the React Compiler bail on the whole file. The pumping ref
 * is the re-entry guard — a second caller while a drain is already running
 * just returns, and the running loop picks up whatever it enqueued.
 */
const drainAutoQueue = async (queueRef, pumpingRef, setJob) => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
        while (queueRef.current.length) {
            const { slips, meta } = queueRef.current.shift();
            await feedSlipsToPrinter(slips, meta, setJob);
        }
    } finally {
        pumpingRef.current = false;
    }
};

const ORDER_TYPE_LABEL = {
    'dine-in': 'Dine-in',
    'takeaway': 'Takeaway',
    'delivery': 'Delivery'
};

/*
 * When a round is added to an open tab the ticket is re-fired, so the clock
 * that matters is when the *newest* food was ordered — not when the table sat
 * down. Without this a round added an hour into a sitting lands on the board
 * already flagged as an hour late.
 */
const firedAt = (order) => new Date(order.last_round_at || order.created_at).getTime();

export default function KDSPage() {
    const brand = useBrand();
    const [orders, setOrders] = useState([]);
    const [imageMap, setImageMap] = useState({});
    // The menu, kept whole: the slip builder resolves a line's station through
    // menu_items.category_id, so the board needs categories as well as photos.
    const [menu, setMenu] = useState({ items: [], categories: [] });
    const [kotMode, setKotMode] = useState(DEFAULT_KOT_MODE);
    // Whether this board prints incoming rounds itself. True only when the
    // store routes tickets to the kitchen ('kds') AND the kitchen hasn't
    // paused its own printing (a jam, a roll change).
    const [autoPrintTickets, setAutoPrintTickets] = useState(false);
    // The slip being printed right now; null keeps #kot-print-root unmounted,
    // which is what leaves the rest of the app printable.
    const [kotJob, setKotJob] = useState(null);
    // {id, count} — the ticket whose print button is primed for its second tap
    const [armed, setArmed] = useState(null);
    const [printingId, setPrintingId] = useState(null);
    const armTimer = useRef(null);
    const [now, setNow] = useState(null); // null until mounted, to avoid SSR drift
    const [soundOn, setSoundOn] = useState(true);
    const knownIds = useRef(null);

    /*
     * loadOrders mounts once for the whole service (see the subscription
     * effect), so anything it reads that CAN change — the menu, the cut mode,
     * whether this board auto-prints, whether the printer is mid-job — is read
     * through a ref kept in sync by the effects below rather than closed over,
     * or the board would tear down and rebuild its socket every time one moved.
     */
    const menuRef = useRef(menu);
    const kotModeRef = useRef(kotMode);
    const autoPrintRef = useRef(autoPrintTickets);
    const transportRef = useRef('agent');
    const printingIdRef = useRef(printingId);
    // Orders whose newest round is waiting to print, and the guard that keeps
    // the drain loop single.
    const autoQueue = useRef([]);
    const autoPumping = useRef(false);
    useEffect(() => { menuRef.current = menu; }, [menu]);
    useEffect(() => { kotModeRef.current = kotMode; }, [kotMode]);
    useEffect(() => { autoPrintRef.current = autoPrintTickets; }, [autoPrintTickets]);
    useEffect(() => { printingIdRef.current = printingId; }, [printingId]);

    /*
     * Declared above the effects that use them, and deliberately identity-stable:
     * the subscription effect below must mount exactly once for the whole
     * service, so anything it closes over has to keep the same identity across
     * renders or the board would tear down and rebuild its socket on every tick.
     *
     * That stability is why the mute setting is read through a ref rather than
     * straight off state — a plain `soundOn` read here would freeze at its
     * initial value for the life of the board.
     */
    const soundOnRef = useRef(soundOn);
    useEffect(() => {
        // Synced in an effect, not assigned during render: a render-phase ref
        // write is discarded work if React re-renders without committing.
        soundOnRef.current = soundOn;
    }, [soundOn]);

    // Short two-tone beep via Web Audio, so no asset is needed
    const chime = useCallback(() => {
        if (!soundOnRef.current) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            [880, 1320].forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = freq;
                osc.type = 'sine';
                const start = ctx.currentTime + i * 0.18;
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
                osc.start(start);
                osc.stop(start + 0.18);
            });
            setTimeout(() => ctx.close(), 800);
        } catch {
            // Audio is a nicety; never let it break the board
        }
    }, []);

    const loadOrders = useCallback(async () => {
        try {
            // Already narrowed to the live statuses by the query, so what
            // comes back is the board.
            const active = await getKitchenOrders();

            /*
             * Chime for food the kitchen has not been told about yet: a ticket
             * we have never seen, or a known tab that just had another round
             * added. Tracking rounds as well as ids matters — an added round
             * re-uses the same ticket, so an id-only check would stay silent.
             * The first load seeds the map instead of firing for every ticket.
             */
            const rounds = new Map(active.map(o => [o.id, o.round_count || 1]));
            if (knownIds.current === null) {
                knownIds.current = rounds;
            } else {
                const fresh = active
                    .map(o => ({ o, seen: knownIds.current.get(o.id) }))
                    .filter(({ o, seen }) => seen === undefined || (o.round_count || 1) > seen);
                knownIds.current = rounds;
                if (fresh.length) {
                    chime();
                    // Print the food this board is responsible for the moment
                    // it arrives. A brand-new order prints in full (a first
                    // sighting is its whole first round); a round added to an
                    // order already on the board prints only that new round.
                    // The till stays off the kitchen slips, so this is the only
                    // place they print under the two-device setup.
                    if (autoPrintRef.current) {
                        /*
                         * A thermal kitchen printer only speaks ESC/POS, so the
                         * ticket goes through the local agent from the stored
                         * order — never through the browser, which would reach
                         * it as PostScript and print pages of source code. A
                         * first sighting prints the whole order; an added round
                         * prints only that round.
                         */
                        if (transportRef.current === 'agent') {
                            for (const { o, seen } of fresh) {
                                const printed = await printKotViaAgent(o.id, {
                                    round: seen === undefined ? null : (o.round_count || 1),
                                });
                                if (!printed) console.warn('Kitchen ticket not printed. The print agent is not running.');
                            }
                            setOrders(active);
                            return;
                        }
                        for (const { o, seen } of fresh) {
                            const roundNo = o.round_count || 1;
                            const items = seen === undefined
                                ? (o.items || [])
                                : (o.items || []).filter(it => (it.round || 1) > seen);
                            const slips = buildKotSlips(kotModeRef.current, items, menuRef.current.items, menuRef.current.categories);
                            if (!slips.length) continue;
                            autoQueue.current.push({
                                slips,
                                meta: {
                                    orderNumber: getOrderNumber(o),
                                    tokenNo: o.token_no,
                                    table: o.table_number,
                                    waiter: o.waiter_name,
                                    orderType: o.order_type,
                                    roundNo,
                                    at: new Date(),
                                    // A fresh fire, not a reprint — the kitchen
                                    // cooks this, so no knockout band.
                                    reprint: false,
                                },
                            });
                        }
                        // Not while a manual reprint owns the printer; its slips
                        // stay queued and drain on the next poll.
                        if (!printingIdRef.current) drainAutoQueue(autoQueue, autoPumping, setKotJob);
                    }
                }
            }

            setOrders(active);
        } catch (error) {
            console.error('Failed to load KDS orders', error);
        }
    }, [chime]);

    /*
     * Version polling that also refetches after a gap — the board runs
     * unattended for a whole service, and changes made while a poll was
     * failing would otherwise never arrive. The hook polls every ~4s, which
     * also retires the old belt-and-braces 15s interval this effect carried.
     */
    useRealtimeTable({ table: 'orders', channel: 'kds_channel', onChange: loadOrders });

    useEffect(() => {
        // One request for the whole menu rather than two: /api/menu returns
        // categories, items and modifiers together anyway.
        getFullMenuData().then(({ items, categories }) => {
            setImageMap(buildImageMap(items));
            setMenu({ items: items || [], categories: categories || [] });
        });
        /*
         * The board prints kitchen slips too, so it needs the same two print
         * settings the till reads: which way to cut a round, and how wide the
         * paper is. Neither is fatal — an unreadable settings row leaves the
         * defaults, and the reprint still produces paper.
         */
        getSettings().then(settings => {
            setKotMode(settings?.kot_mode || DEFAULT_KOT_MODE);
            // This board prints incoming rounds only when the store routes
            // tickets here (anything but an explicit 'till') and the kitchen
            // hasn't paused its own printing. An older row with neither column
            // keeps the two-device default of printing.
            const routed = settings?.kot_route !== 'till';
            const kitchenPrints = settings?.kds_auto_print !== false;
            setAutoPrintTickets(routed && kitchenPrints);
            // Read into the ref directly: loadOrders mounts once and reads this
            // on every poll, so it must not wait for a re-render to see it.
            transportRef.current = settings?.print_transport === 'browser' ? 'browser' : 'agent';
            applyPaperWidth(settings?.receipt_width_mm);
        }).catch(() => {});
        // loadOrders is async and awaits a fetch before it touches state, so
        // nothing is set synchronously here — the rule can't see past the call.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadOrders();
    }, [loadOrders]);

    // A primed button must not outlive the board being closed
    useEffect(() => () => clearTimeout(armTimer.current), []);

    // Ticket age drives the colour coding, so keep a ticking clock
    useEffect(() => {
        // `now` starts null so server and client render the same markup; seeding
        // it on mount is the point. Dropping this would show every ticket as
        // "--:--" for a second on a board the kitchen reads at a glance.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    const handleBump = async (order, nextStatus) => {
        // Optimistic: the board must feel instant under a busy pass
        setOrders(prev => nextStatus === 'completed'
            ? prev.filter(o => o.id !== order.id)
            : prev.map(o => (o.id === order.id ? { ...o, status: nextStatus } : o))
        );
        try {
            // Guarded by the status the board believed: if a new round
            // re-fired this ticket first, the bump loses and the refetch
            // shows the truth instead of parking uncooked food in Ready.
            const result = await bumpOrder(order.id, order.status, nextStatus);
            if (result && result.status !== nextStatus) loadOrders();
        } catch (error) {
            console.error('Failed to bump order', error);
            loadOrders(); // resync on failure
        }
    };

    /*
     * Reprint one order's kitchen slips, cut the way Settings says — the same
     * builder, queue and hidden slip the till uses, so a reprinted ticket is
     * the ticket and not a second rendering of it. It prints the whole order
     * (every round), because a slip gets reprinted when the paper is lost or
     * illegible and the section wants all the food it is missing.
     *
     * Deliberately NOT gated on the auto-print setting: this is an explicit
     * tap, and the reason auto-print gets switched off — a jam, an empty roll —
     * is exactly when someone comes here to print the ticket again.
     */
    const printTickets = async (order) => {
        // First tap primes, second tap fires. See ARM_MS.
        if (armed?.id !== order.id) {
            clearTimeout(armTimer.current);
            const count = buildKotSlips(kotMode, order.items, menu.items, menu.categories).length;
            setArmed({ id: order.id, count });
            armTimer.current = setTimeout(() => setArmed(null), ARM_MS);
            return;
        }

        clearTimeout(armTimer.current);
        setArmed(null);
        // One queue at a time: two orders printing at once would interleave
        // slips through the single printer and hand the runner a shuffled pile.
        // That includes the auto-print drain — wait for it to finish rather
        // than talk over it.
        if (printingId || autoPumping.current) return;
        setPrintingId(order.id);

        // Same transport rule as the auto-print: on a thermal kitchen printer
        // the agent renders the whole order from the database (round omitted),
        // stamped as a reprint. The browser path is not a fallback here.
        if (transportRef.current === 'agent') {
            const printed = await printKotViaAgent(order.id, { reprint: true });
            if (!printed) console.warn('Reprint failed: the print agent is not running.');
            setPrintingId(null);
            return;
        }

        const slips = buildKotSlips(kotMode, order.items, menu.items, menu.categories);
        await feedSlipsToPrinter(slips, {
            orderNumber: getOrderNumber(order),
            tokenNo: order.token_no,
            table: order.table_number,
            waiter: order.waiter_name,
            orderType: order.order_type,
            roundNo: order.round_count || 1,
            at: new Date(),
            // Prints the knockout band. Without it a reprint is
            // indistinguishable from a fresh fire, and the dish is cooked a
            // second time.
            reprint: true,
        }, setKotJob);
        setPrintingId(null);
    };

    const elapsedMinutes = (order) =>
        now === null ? null : (now - firedAt(order)) / 60000;

    const formatElapsed = (order) => {
        const mins = elapsedMinutes(order);
        if (mins === null) return '--:--';
        const total = Math.max(0, Math.floor(mins * 60));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    };

    const urgency = (order) => {
        const mins = elapsedMinutes(order);
        if (mins === null) return '';
        if (mins >= LATE_AFTER) return styles.late;
        if (mins >= WARN_AFTER) return styles.warn;
        return '';
    };

    // Oldest first: the kitchen works tickets FIFO, by when the food was fired
    const lanes = useMemo(() => {
        const byLane = {};
        LANES.forEach(lane => {
            byLane[lane.key] = orders
                .filter(o => o.status === lane.key)
                .sort((a, b) => firedAt(a) - firedAt(b));
        });
        return byLane;
    }, [orders]);

    const goFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
    };

    return (
        <div className={styles.screen}>
            <header className={styles.topBar}>
                <div className={styles.brand}>
                    <Image
                        src={brand.logoLight}
                        alt={brand.name}
                        width={180}
                        height={54}
                        priority
                        className={styles.logo}
                    />
                    <span className={styles.divider} />
                    <div>
                        <h1 className={styles.title}>Kitchen Display</h1>
                        <div className={styles.subtitle}>
                            <span className={styles.liveDot} />
                            Live service
                        </div>
                    </div>
                </div>

                <div className={styles.topRight}>
                    <LiveClock className={styles.clock} showSeconds iconSize={18} />
                    <button
                        className={styles.iconBtn}
                        onClick={() => setSoundOn(v => !v)}
                        title={soundOn ? 'Mute new-order alert' : 'Unmute new-order alert'}
                    >
                        {soundOn ? <Volume2 size={20} /> : <VolumeX size={20} />}
                    </button>
                    <button className={styles.iconBtn} onClick={goFullscreen} title="Fullscreen">
                        <Maximize2 size={20} />
                    </button>
                </div>
            </header>

            <div className={styles.lanes}>
                {LANES.map(lane => (
                    <section key={lane.key} className={styles.lane}>
                        <div className={`${styles.laneHeader} ${styles[`lane_${lane.key}`]}`}>
                            <span className={styles.laneLabel}>{lane.label}</span>
                            <span className={styles.laneCount}>{lanes[lane.key].length}</span>
                        </div>

                        <div className={styles.laneBody}>
                            {lanes[lane.key].map(order => (
                                <article key={order.id} className={`${styles.ticket} ${urgency(order)}`}>
                                    <div className={styles.ticketHead}>
                                        <div>
                                            <div className={styles.ticketNumber}>
                                                #{getOrderNumber(order)}
                                                {(order.round_count || 1) > 1 && (
                                                    <span className={styles.roundBadge}>
                                                        <Layers size={12} aria-hidden="true" />
                                                        Round {order.round_count}
                                                    </span>
                                                )}
                                            </div>
                                            <div className={styles.ticketMeta}>
                                                {ORDER_TYPE_LABEL[order.order_type] || order.order_type}
                                                {/* The number the pass will shout when this is up. */}
                                                {order.token_no != null && ` · Token ${order.token_no}`}
                                                {order.table_number && ` · ${order.table_number}`}
                                                {order.payment_status === 'unpaid' && ' · open tab'}
                                            </div>
                                            {order.waiter_name && (
                                                <div className={styles.ticketWaiter}>
                                                    <UserRound size={13} aria-hidden="true" />
                                                    {order.waiter_name}
                                                </div>
                                            )}
                                        </div>
                                        <div className={styles.timer}>{formatElapsed(order)}</div>
                                    </div>

                                    <ul className={styles.items}>
                                        {/* Only a re-fired tab needs old rounds played down */}
                                        {order.items.map((item, idx) => {
                                            const image = resolveItemImage(item, imageMap);
                                            const mods = formatModifiers(item);
                                            // Lines from earlier rounds are already cooked; only
                                            // the newest round is work still to do. A
                                            // single-round ticket is all work, so it is left plain.
                                            const multiRound = (order.round_count || 1) > 1;
                                            const isNew = isLatestRound(item, order);
                                            const emphasis = !multiRound ? ''
                                                : isNew ? styles.itemNew : styles.itemDone;
                                            return (
                                                <li
                                                    key={idx}
                                                    className={`${styles.item} ${emphasis}`}
                                                >
                                                    {image ? (
                                                        <img src={image} alt="" className={styles.thumb} />
                                                    ) : (
                                                        <span className={styles.thumbFallback}>
                                                            <UtensilsCrossed size={18} />
                                                        </span>
                                                    )}
                                                    <span className={styles.itemText}>
                                                        <span className={styles.qty}>{item.qty}</span>
                                                        {item.name}
                                                        {mods && <span className={styles.mods}>{mods}</span>}
                                                    </span>
                                                    {isNew && <span className={styles.newTag}>NEW</span>}
                                                </li>
                                            );
                                        })}
                                    </ul>

                                    {order.notes && (
                                        <div className={styles.notes}>{order.notes}</div>
                                    )}

                                    <div className={styles.actions}>
                                        {/* Reprint. Icon only until it is primed,
                                            so it never competes with the bump
                                            button the pass actually works.

                                            Disabled while ANY ticket is
                                            printing, not just the others: one
                                            queue owns the printer for the length
                                            of a pass. And the aria-label is
                                            dropped once the button carries its
                                            own words, or it would talk over
                                            them. */}
                                        <button
                                            className={`${styles.printBtn} ${armed?.id === order.id ? styles.printArmed : ''}`}
                                            onClick={() => printTickets(order)}
                                            disabled={printingId !== null}
                                            aria-label={armed?.id === order.id ? undefined
                                                : `Reprint kitchen tickets for order ${getOrderNumber(order)}`}
                                        >
                                            {printingId === order.id ? (
                                                <>
                                                    <Loader2 size={18} className={styles.spin} aria-hidden="true" />
                                                    Printing
                                                </>
                                            ) : armed?.id === order.id ? (
                                                <>
                                                    <Printer size={18} aria-hidden="true" />
                                                    Print {armed.count} {armed.count === 1 ? 'ticket' : 'tickets'}?
                                                </>
                                            ) : (
                                                <Printer size={18} aria-hidden="true" />
                                            )}
                                        </button>

                                        <button
                                            className={styles.bumpBtn}
                                            onClick={() => handleBump(order, lane.next)}
                                        >
                                            {lane.action}
                                        </button>
                                    </div>
                                </article>
                            ))}

                            {lanes[lane.key].length === 0 && (
                                <div className={styles.emptyLane}>No tickets</div>
                            )}
                        </div>
                    </section>
                ))}
            </div>

            {/* The slip being printed, hidden off-screen. Mounted at the board
                level rather than per ticket: exactly one may exist at a time,
                because its print CSS claims the paper for whatever is inside
                it. */}
            <KotSlips job={kotJob} />
        </div>
    );
}

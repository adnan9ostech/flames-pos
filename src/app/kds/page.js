'use client';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Image from 'next/image';
import styles from './kds.module.css';
import { getKitchenOrders, bumpOrder, getMenuItems } from '@/lib/dataClient';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import {
    getOrderNumber, buildImageMap, resolveItemImage, formatModifiers
} from '@/lib/orderDisplay';
import { isLatestRound } from '@/lib/orderTotals.mjs';
import LiveClock from '@/components/Layout/LiveClock';
import { UtensilsCrossed, Volume2, VolumeX, Maximize2, UserRound, Layers } from 'lucide-react';

// Kitchen lanes, in the order tickets flow across the screen. These keys are
// the statuses getKitchenOrders() fetches (KITCHEN_STATUSES in dataClient.js) —
// a lane added here without adding it there would render permanently empty.
const LANES = [
    { key: 'new', label: 'New', next: 'preparing', action: 'Start' },
    { key: 'preparing', label: 'Preparing', next: 'ready', action: 'Ready' },
    { key: 'ready', label: 'Ready', next: 'completed', action: 'Serve' }
];

// Minutes since an order landed, used to escalate a ticket's urgency
const WARN_AFTER = 5;
const LATE_AFTER = 10;

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
    const [orders, setOrders] = useState([]);
    const [imageMap, setImageMap] = useState({});
    const [now, setNow] = useState(null); // null until mounted, to avoid SSR drift
    const [soundOn, setSoundOn] = useState(true);
    const knownIds = useRef(null);

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
                const isNew = active.some(o => {
                    const seen = knownIds.current.get(o.id);
                    return seen === undefined || (o.round_count || 1) > seen;
                });
                knownIds.current = rounds;
                if (isNew) chime();
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
        getMenuItems().then(items => setImageMap(buildImageMap(items)));
        // loadOrders is async and awaits a fetch before it touches state, so
        // nothing is set synchronously here — the rule can't see past the call.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadOrders();
    }, [loadOrders]);

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
                        src="/flames-by-the-indus-logo.svg"
                        alt="Flames by the Indus"
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

                                    <button
                                        className={styles.bumpBtn}
                                        onClick={() => handleBump(order, lane.next)}
                                    >
                                        {lane.action}
                                    </button>
                                </article>
                            ))}

                            {lanes[lane.key].length === 0 && (
                                <div className={styles.emptyLane}>No tickets</div>
                            )}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}

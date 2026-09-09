'use client';

/*
 * The dish list — the screen the owner lives in. 125 dishes today, so
 * everything here is in service of finding one fast: a live search over name
 * and category, a category filter, four status tabs, and a table that says
 * in one line what a dish costs, how many sizes it has and whether the till
 * will sell it tonight.
 *
 * Two verbs sit on the row itself because walking into the editor for them
 * would be absurd: the sold-out switch (the kitchen shouts, the floor
 * answers) and Archive. Everything else is an edit.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from './menu.module.css';
import own from './dishes.module.css';
import { listDishes, setDishArchived, moveDish } from './actions';
import { setMenuItemAvailability } from '@/lib/orderActions';
import { usePermissions } from '@/components/Layout/AppLayout';
import { formatPriceRange } from '@/lib/money';
import {
    AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, CheckCircle2, Camera,
    ImageOff, Loader2, Pencil, Plus, Search, Utensils, X,
} from 'lucide-react';

const TABS = [
    { key: 'all', label: 'All' },
    { key: 'live', label: 'On the menu' },
    { key: 'sold', label: 'Sold out' },
    { key: 'archived', label: 'Archived' },
];

/* Which dishes a tab is about. "All" means the live menu: an archived dish
 * is off the menu, and its own tab is how it comes back. */
const inScope = (d, tab) => {
    if (tab === 'archived') return d.is_archived;
    if (d.is_archived) return false;
    if (tab === 'live') return d.is_available;
    if (tab === 'sold') return !d.is_available;
    return true;
};

/* The one-line confirmation the editor left behind, and the dish to light up. */
const takeFlash = () => {
    try {
        const text = sessionStorage.getItem('menu-flash') || '';
        const id = sessionStorage.getItem('menu-new') || '';
        sessionStorage.removeItem('menu-flash');
        sessionStorage.removeItem('menu-new');
        return { text, id };
    } catch { return { text: '', id: '' }; }
};

export default function DishesPage() {
    const { can } = usePermissions();
    const canEdit = can('menu');

    const [dishes, setDishes] = useState([]);
    const [categories, setCategories] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [highlight, setHighlight] = useState('');

    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('all');
    const [tab, setTab] = useState('all');

    const [confirming, setConfirming] = useState(null); // the dish being archived
    const [busyId, setBusyId] = useState('');

    /*
     * The list, once. The state lands in the promise callback rather than in
     * the effect body — the shape the Accounts document pages use — and the
     * flash the editor left behind is only shown if the list actually
     * arrived, so a failed load reports the failure instead of a stale
     * congratulation.
     */
    useEffect(() => {
        let alive = true;
        listDishes().then((res) => {
            if (!alive) return;
            const flash = takeFlash();
            if (res.error) setMessage({ type: 'error', text: res.error });
            else {
                setDishes(res.data.dishes);
                setCategories(res.data.categories);
                if (flash.text) setMessage({ type: 'success', text: flash.text });
                if (flash.id) setHighlight(flash.id);
            }
            setIsLoading(false);
        });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (message.type !== 'success') return undefined;
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 6000);
        return () => clearTimeout(t);
    }, [message]);

    const counts = useMemo(() => ({
        all: dishes.filter((d) => inScope(d, 'all')).length,
        live: dishes.filter((d) => inScope(d, 'live')).length,
        sold: dishes.filter((d) => inScope(d, 'sold')).length,
        archived: dishes.filter((d) => d.is_archived).length,
        noPhoto: dishes.filter((d) => !d.is_archived && !d.image).length,
    }), [dishes]);

    const scoped = useMemo(() => dishes.filter((d) => inScope(d, tab)), [dishes, tab]);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return scoped.filter((d) =>
            (category === 'all' || d.category_id === category)
            && (!q || d.name.toLowerCase().includes(q) || d.category_name.toLowerCase().includes(q)));
    }, [scoped, category, search]);

    /*
     * Reordering only makes sense inside one category — the till grid is per
     * category, and moving a dish "up" through a mixed or searched list would
     * move it past dishes it will never sit beside. So the arrows appear only
     * when the list on screen IS a category, in its stored order.
     */
    const canReorder = canEdit && category !== 'all' && tab !== 'archived' && !search.trim();

    const flip = async (dish) => {
        const next = !dish.is_available;
        setDishes((prev) => prev.map((d) => (d.id === dish.id ? { ...d, is_available: next } : d)));
        const res = await setMenuItemAvailability(dish.id, next);
        if (res?.error) {
            setDishes((prev) => prev.map((d) => (d.id === dish.id ? { ...d, is_available: !next } : d)));
            setMessage({ type: 'error', text: `${dish.name} is unchanged — ${res.error}` });
        } else {
            setMessage({ type: 'success', text: next ? `${dish.name} is back on the menu.` : `${dish.name} marked sold out.` });
        }
    };

    const archive = async (dish, archived) => {
        setBusyId(dish.id);
        const res = await setDishArchived(dish.id, archived);
        setBusyId('');
        setConfirming(null);
        if (res.error) { setMessage({ type: 'error', text: res.error }); return; }
        setDishes((prev) => prev.map((d) => (d.id === dish.id ? { ...d, is_archived: archived } : d)));
        setMessage({
            type: 'success',
            text: archived
                ? `${dish.name} archived — off the till, and on every bill it was ever sold on.`
                : `${dish.name} is back on the menu.`,
        });
    };

    // The category order the server listed in, so a moved dish lands where
    // the next reload would have put it.
    const categoryRank = useMemo(() => {
        const rank = new Map(categories.map((c, i) => [c.id, i]));
        return (id) => (id && rank.has(id) ? rank.get(id) : -1);
    }, [categories]);

    const move = async (dish, direction) => {
        setBusyId(dish.id);
        const res = await moveDish(dish.id, direction);
        setBusyId('');
        if (res.error) { setMessage({ type: 'error', text: res.error }); return; }
        const order = new Map(res.data.order.map((o) => [o.id, o.sort_order]));
        setDishes((prev) => [...prev.map((d) => (order.has(d.id) ? { ...d, sort_order: order.get(d.id) } : d))]
            .sort((a, b) =>
                categoryRank(a.category_id) - categoryRank(b.category_id)
                || a.sort_order - b.sort_order
                || a.name.localeCompare(b.name)));
    };

    const stat = (icon, label, value, hint, warn = false) => (
        <div className={styles.statCard}>
            <div className={`${styles.statIcon} ${warn ? styles.warnIcon : ''}`}>{icon}</div>
            <div>
                <div className={styles.statLabel}>{label}</div>
                <div className={styles.statValue}>{value}</div>
                <div className={styles.statHint}>{hint}</div>
            </div>
        </div>
    );

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>Dishes</h1>
                    <p className={styles.subtitle}>
                        Everything the till can sell. A dish is never deleted — archive it, and the bills
                        it was sold on keep it.
                    </p>
                </div>
                {canEdit && (
                    <div className={styles.headerActions}>
                        <Link href="/menu/items/new" className={styles.primaryBtn}>
                            <Plus size={16} /> Add dish
                        </Link>
                    </div>
                )}
            </div>

            {message.type && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`${styles.note} ${message.type === 'error' ? styles.noteError : styles.noteSuccess}`}
                >
                    {message.type === 'error'
                        ? <AlertTriangle size={16} aria-hidden="true" />
                        : <CheckCircle2 size={16} aria-hidden="true" />}
                    {message.text}
                </div>
            )}

            <div className={styles.statsRow}>
                {stat(<Utensils size={20} />, 'On the menu', counts.live, `of ${counts.all} dishes`)}
                {stat(<AlertTriangle size={20} />, 'Sold out today', counts.sold,
                    counts.sold ? 'switch one back on below' : 'nothing is off tonight', counts.sold > 0)}
                {stat(<Archive size={20} />, 'Archived', counts.archived, 'off the till, still on old bills')}
                {stat(<ImageOff size={20} />, 'Without a photo', counts.noPhoto,
                    counts.noPhoto ? 'the till shows a blank tile' : 'every dish has one', counts.noPhoto > 0)}
            </div>

            <div className={styles.filterRow}>
                <div className={styles.filterTabs} role="tablist" aria-label="Dish status">
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={tab === t.key}
                            className={`${styles.filterTab} ${tab === t.key ? styles.filterActive : ''}`}
                            onClick={() => setTab(t.key)}
                        >
                            {t.label} · {counts[t.key]}
                        </button>
                    ))}
                </div>
                <label className={styles.searchBox}>
                    <Search size={15} aria-hidden="true" />
                    <input
                        type="search"
                        placeholder="Dish or category"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search dishes"
                    />
                </label>
                <select
                    className={styles.select}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    aria-label="Category"
                >
                    <option value="all">All categories</option>
                    {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </select>
                <span className={styles.count}>{visible.length} of {scoped.length}</span>
            </div>

            {canEdit && category !== 'all' && tab !== 'archived' && search.trim() && (
                <p className={styles.hint} style={{ marginTop: '-0.5rem', marginBottom: '0.75rem' }}>
                    Clear the search to reorder this category.
                </p>
            )}

            <div className={styles.listWrap}>
                {isLoading ? (
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={28} />
                        <p>Loading the menu…</p>
                    </div>
                ) : visible.length === 0 ? (
                    <div className={styles.stateBlock}>
                        <Utensils size={28} />
                        <p>{dishes.length === 0 ? 'There are no dishes yet.' : 'No dish matches.'}</p>
                        {canEdit && dishes.length === 0 && (
                            <Link href="/menu/items/new" className={styles.secondaryBtn}><Plus size={15} /> Add the first dish</Link>
                        )}
                    </div>
                ) : (
                    <table className={`${styles.table} ${canReorder ? own.dishTableOrdered : own.dishTable}`}>
                        <thead>
                            <tr>
                                {canReorder && <th aria-label="Order" />}
                                <th aria-label="Photo" />
                                <th>Dish</th>
                                <th className={styles.alignRight}>Price</th>
                                <th className={styles.cellCenter}>Sizes</th>
                                <th className={styles.cellCenter}>Modifiers</th>
                                <th>Available</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((d, i) => (
                                <tr
                                    key={d.id}
                                    className={`${d.is_archived ? styles.rowInactive : ''} ${d.id === highlight ? own.rowNew : ''}`}
                                >
                                    {canReorder && (
                                        <td className={own.thumbCell}>
                                            <div className={own.orderCell}>
                                                <button
                                                    type="button"
                                                    className={own.orderBtn}
                                                    onClick={() => move(d, 'up')}
                                                    disabled={i === 0 || busyId === d.id}
                                                    aria-label={`Move ${d.name} up`}
                                                    title="Move up the till grid"
                                                >
                                                    <ArrowUp size={15} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={own.orderBtn}
                                                    onClick={() => move(d, 'down')}
                                                    disabled={i === visible.length - 1 || busyId === d.id}
                                                    aria-label={`Move ${d.name} down`}
                                                    title="Move down the till grid"
                                                >
                                                    <ArrowDown size={15} />
                                                </button>
                                            </div>
                                        </td>
                                    )}
                                    <td className={own.thumbCell}>
                                        {d.image
                                            ? <img src={d.image} alt="" className={styles.thumb} />
                                            : (
                                                <div className={`${styles.thumb} ${styles.thumbEmpty}`} title="No photo">
                                                    <Camera size={16} aria-hidden="true" />
                                                </div>
                                            )}
                                    </td>
                                    <td className={styles.cellName}>
                                        <Link href={`/menu/items/${d.id}`} className={own.dishLink}>
                                            <span className={styles.cellStrong}>{d.name}</span>
                                        </Link>
                                        <span className={styles.cellSub}>
                                            {d.category_name || 'No category'}
                                            {d.unit ? ` · ${d.unit}` : ''}
                                            {d.is_archived ? ' · archived' : ''}
                                        </span>
                                    </td>
                                    <td className={styles.cellNum}>{formatPriceRange(d.price, d.variants)}</td>
                                    <td className={styles.cellCenter}>
                                        {d.variants.length > 0
                                            ? <span className={`${styles.chip} ${styles.chipPrimary}`}>{d.variants.length} sizes</span>
                                            : <span className={styles.cellMuted}>—</span>}
                                    </td>
                                    <td className={styles.cellCenter}>
                                        {d.modifiers.length > 0
                                            ? <span className={styles.chip}>{d.modifiers.length}</span>
                                            : <span className={styles.cellMuted}>—</span>}
                                    </td>
                                    <td>
                                        <span className={own.switchCell}>
                                            <button
                                                type="button"
                                                className={`${styles.switch} ${d.is_available ? styles.switchOn : ''}`}
                                                onClick={() => flip(d)}
                                                disabled={d.is_archived}
                                                aria-pressed={d.is_available}
                                                aria-label={`${d.name} is ${d.is_available ? 'on the menu' : 'sold out'}`}
                                                title={d.is_archived ? 'Archived dishes are off the till entirely' : 'Sold out / back on'}
                                            />
                                            <span className={own.switchLabel}>{d.is_available ? 'On' : 'Sold out'}</span>
                                        </span>
                                    </td>
                                    <td className={styles.cellActions}>
                                        <div className={styles.rowActions}>
                                            <Link
                                                href={`/menu/items/${d.id}`}
                                                className={styles.iconBtn}
                                                aria-label={`Edit ${d.name}`}
                                                title="Edit dish"
                                            >
                                                <Pencil size={15} />
                                            </Link>
                                            {canEdit && (d.is_archived ? (
                                                <button
                                                    type="button"
                                                    className={styles.iconBtn}
                                                    onClick={() => archive(d, false)}
                                                    disabled={busyId === d.id}
                                                    aria-label={`Restore ${d.name}`}
                                                    title="Put back on the menu"
                                                >
                                                    <ArchiveRestore size={15} />
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className={`${styles.iconBtn} ${styles.dangerBtn}`}
                                                    onClick={() => setConfirming(d)}
                                                    disabled={busyId === d.id}
                                                    aria-label={`Archive ${d.name}`}
                                                    title="Take off the menu"
                                                >
                                                    <Archive size={15} />
                                                </button>
                                            ))}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {confirming && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="archive-title">
                    <div className={styles.modal}>
                        <h2 id="archive-title" className={styles.modalTitle}>Archive {confirming.name}?</h2>
                        <p className={styles.modalBody}>
                            It comes off the till, off the customer menu and off the kitchen screen, so nobody
                            can order it again. Every bill it has already been sold on keeps it exactly as it
                            was — nothing is deleted. You can restore it from the Archived tab whenever you like.
                        </p>
                        <div className={styles.modalActions}>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setConfirming(null)}
                                disabled={busyId === confirming.id}
                            >
                                <X size={15} /> Keep it
                            </button>
                            <button
                                type="button"
                                className={`${styles.secondaryBtn} ${styles.dangerOutline}`}
                                onClick={() => archive(confirming, true)}
                                disabled={busyId === confirming.id}
                            >
                                {busyId === confirming.id
                                    ? <Loader2 size={15} className={styles.spinner} />
                                    : <Archive size={15} />}
                                Archive dish
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

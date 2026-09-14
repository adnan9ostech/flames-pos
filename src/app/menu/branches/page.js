'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
    Building2, Loader2, AlertTriangle, CheckCircle2, Search, RotateCcw, Info,
} from 'lucide-react';
import styles from '../menu.module.css';
import local from './branchMenu.module.css';
import { usePermissions } from '@/components/Layout/AppLayout';
import { formatRupees } from '@/lib/money';
import { listBranchMenu, setBranchMenuItem, clearBranchMenu } from './actions';

/*
 * What each outlet charges, and what it does not sell.
 *
 * One menu, one price everywhere, and then the exceptions — so an empty box
 * means "the menu's price" and shows that price greyed out behind it. Clearing
 * a box is how an exception is removed, which is the same grammar as the
 * branch settings screen and the reason neither needs a "use default" switch
 * to fall out of step with the value beside it.
 *
 * Branches are COLUMNS because the question this screen answers is comparative
 * — what does the karahi cost at each of them — and that question has no
 * answer in a layout that shows one outlet at a time. Many outlets scroll
 * sideways inside the table rather than widening the page.
 */

const key = (branchId, dishId) => `${branchId}:${dishId}`;

export default function BranchMenuPage() {
    // `can(key)`, not a property lookup: usePermissions returns { perms, can },
    // so `perms.menu` is undefined and every control renders disabled.
    const { can } = usePermissions();
    const canEdit = can('menu');

    const [data, setData] = useState(null);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [search, setSearch] = useState('');
    const [onlyDiffs, setOnlyDiffs] = useState(false);
    const [saving, setSaving] = useState('');
    // What is in each price box while somebody types, keyed the same way as
    // the overrides. Kept apart from the saved value so a half-typed "12" on the
    // way to "1200" is never mistaken for a price.
    const [drafts, setDrafts] = useState({});

    const load = useCallback(() => listBranchMenu().then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error });
        else setData(res.data);
    }), []);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (message.type !== 'success') return undefined;
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000);
        return () => clearTimeout(t);
    }, [message]);

    const rows = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        return data.dishes.filter((d) => {
            if (q && !d.name.toLowerCase().includes(q)
                && !d.category_name.toLowerCase().includes(q)) return false;
            if (!onlyDiffs) return true;
            return data.branches.some((b) => data.overrides[key(b.id, d.id)]);
        });
    }, [data, search, onlyDiffs]);

    const save = async (branchId, dish, price, isAvailable) => {
        const k = key(branchId, dish.id);
        setSaving(k);
        const res = await setBranchMenuItem({ branchId, menuItemId: dish.id, price, isAvailable });
        setSaving('');
        if (res.error) { setMessage({ type: 'error', text: res.error }); return; }

        setData((prev) => {
            const overrides = { ...prev.overrides };
            // A cell back at the menu's answer has no row, so the UI drops it
            // too — otherwise "only differences" would keep listing a dish
            // that no longer differs.
            if (res.data.price === null && res.data.is_available) delete overrides[k];
            else overrides[k] = { price: res.data.price, is_available: res.data.is_available };
            return { ...prev, overrides };
        });
        setDrafts((prev) => { const next = { ...prev }; delete next[k]; return next; });
    };

    const resetBranch = async (branch) => {
        setSaving(`reset:${branch.id}`);
        const res = await clearBranchMenu(branch.id);
        setSaving('');
        if (res.error) { setMessage({ type: 'error', text: res.error }); return; }
        setMessage({ type: 'success', text: res.success });
        load();
    };

    if (!data) {
        return (
            <div className={styles.container}>
                <div className={local.loading}><Loader2 className={styles.spinner} size={22} /></div>
            </div>
        );
    }

    /*
     * One outlet means there is nothing to compare and no second price to set.
     * Rather than draw an empty grid with one column that can only ever agree
     * with itself, the screen says so and points at where a branch is made.
     */
    if (data.branches.length < 2) {
        return (
            <div className={styles.container}>
                <header className={styles.header}>
                    <div>
                        <h1 className={styles.title}>Branch prices</h1>
                        <p className={styles.subtitle}>
                            What each outlet charges, and what it does not sell.
                        </p>
                    </div>
                </header>
                <div className={local.empty}>
                    <Building2 size={28} />
                    <h2>There is only one outlet</h2>
                    <p>
                        With one branch the menu price <em>is</em> the price, everywhere. This screen
                        starts working the moment there is a second one to differ from it.
                    </p>
                    <Link href="/settings/branches" className={local.emptyLink}>
                        Add a branch in Settings
                    </Link>
                </div>
            </div>
        );
    }

    const counts = Object.fromEntries(data.branches.map((b) => [
        b.id,
        Object.keys(data.overrides).filter((k) => k.startsWith(`${b.id}:`)).length,
    ]));

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div>
                    <h1 className={styles.title}>Branch prices</h1>
                    <p className={styles.subtitle}>
                        One menu, one price everywhere — and then the exceptions. An empty box means
                        the outlet charges what the menu says, so clearing a box is how you take an
                        exception back.
                    </p>
                </div>
            </header>

            {message.type && (
                <div className={`${local.banner} ${message.type === 'error' ? local.bannerError : local.bannerOk}`}>
                    {message.type === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                    <span>{message.text}</span>
                </div>
            )}

            <div className={local.controls}>
                <div className={local.searchWrap}>
                    <Search size={16} className={local.searchIcon} />
                    <input
                        className={local.search}
                        placeholder="Find a dish or category…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <label className={local.check}>
                    <input
                        type="checkbox"
                        checked={onlyDiffs}
                        onChange={(e) => setOnlyDiffs(e.target.checked)}
                    />
                    Only what differs
                </label>
                <span className={local.count}>
                    {rows.length} of {data.dishes.length} dishes
                </span>
            </div>

            <p className={local.rule}>
                <Info size={15} aria-hidden="true" />
                <span>
                    A branch can take a dish <strong>off</strong> its till, but cannot put one back on
                    that is switched off across the whole menu. That way a withdrawn dish stays
                    withdrawn everywhere.
                </span>
            </p>

            {/* Wide content scrolls inside its own box; the page never does. */}
            <div className={local.tableWrap}>
                <table className={local.table}>
                    <thead>
                        <tr>
                            <th className={local.dishCol}>Dish</th>
                            <th className={local.menuCol}>Menu price</th>
                            {data.branches.map((b) => (
                                <th key={b.id} className={local.branchCol}>
                                    <span className={local.branchName}>{b.name}</span>
                                    <span className={local.branchMeta}>
                                        {counts[b.id]
                                            ? `${counts[b.id]} exception${counts[b.id] === 1 ? '' : 's'}`
                                            : 'follows the menu'}
                                        {canEdit && counts[b.id] > 0 && (
                                            <button
                                                type="button"
                                                className={local.resetBtn}
                                                onClick={() => resetBranch(b)}
                                                disabled={saving === `reset:${b.id}`}
                                                title={`Clear every exception at ${b.name}`}
                                            >
                                                <RotateCcw size={12} aria-hidden="true" />
                                                reset
                                            </button>
                                        )}
                                    </span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 ? (
                            <tr>
                                <td colSpan={2 + data.branches.length} className={local.noRows}>
                                    {onlyDiffs
                                        ? 'Every outlet charges the menu price for everything.'
                                        : 'No dish matches that search.'}
                                </td>
                            </tr>
                        ) : rows.map((dish) => (
                            <tr key={dish.id} className={dish.is_available ? '' : local.offMenu}>
                                <td className={local.dishCell}>
                                    <span className={local.dishName}>{dish.name}</span>
                                    {dish.category_name && (
                                        <span className={local.dishCat}>{dish.category_name}</span>
                                    )}
                                    {!dish.is_available && (
                                        <span className={local.offChip}>off the menu</span>
                                    )}
                                </td>
                                <td className={local.menuCell}>{formatRupees(dish.price)}</td>

                                {data.branches.map((b) => {
                                    const k = key(b.id, dish.id);
                                    const over = data.overrides[k];
                                    const busy = saving === k;
                                    const on = over ? over.is_available : true;
                                    const draft = drafts[k];
                                    const shown = draft !== undefined
                                        ? draft
                                        : (over?.price != null ? String(over.price) : '');

                                    return (
                                        <td key={b.id} className={local.cell}>
                                            <div className={local.cellInner}>
                                                <input
                                                    className={`${local.price} ${over?.price != null ? local.priceSet : ''}`}
                                                    inputMode="decimal"
                                                    disabled={!canEdit || busy}
                                                    value={shown}
                                                    placeholder={String(dish.price)}
                                                    onChange={(e) => setDrafts((p) => ({ ...p, [k]: e.target.value }))}
                                                    // Saved on blur and on Enter, not per keystroke:
                                                    // "12" on the way to "1200" is not a price anybody
                                                    // meant, and writing it would audit a change that
                                                    // never happened.
                                                    onBlur={() => {
                                                        if (draft === undefined) return;
                                                        save(b.id, dish, draft, on);
                                                    }}
                                                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                                    aria-label={`${dish.name} price at ${b.name}`}
                                                />
                                                <button
                                                    type="button"
                                                    className={`${local.toggle} ${on ? local.toggleOn : local.toggleOff}`}
                                                    disabled={!canEdit || busy || !dish.is_available}
                                                    onClick={() => save(b.id, dish, over?.price ?? null, !on)}
                                                    title={!dish.is_available
                                                        ? 'This dish is off across the whole menu'
                                                        : on ? `Take off sale at ${b.name}` : `Put back on sale at ${b.name}`}
                                                    aria-pressed={on}
                                                    aria-label={`${dish.name} on sale at ${b.name}`}
                                                >
                                                    {busy ? <Loader2 size={13} className={styles.spinner} /> : (on ? 'on' : 'off')}
                                                </button>
                                            </div>
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

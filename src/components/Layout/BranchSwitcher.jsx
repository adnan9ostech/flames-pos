'use client';
import { useEffect, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';
import styles from './BranchSwitcher.module.css';
import { branchPicker, switchBranch } from '@/app/settings/branches/actions';

/*
 * Which outlet you are looking at.
 *
 * INVISIBLE ON A SINGLE-BRANCH RESTAURANT, which is the whole design: a
 * control with one option is furniture, and every screen in this app was built
 * for a restaurant that has one. It appears when there is a second outlet, and
 * it appears as a LABEL rather than a menu for anyone tied to a branch — a
 * waiter at Gulberg is told where they are, not offered a choice the reader
 * would refuse anyway.
 *
 * Switching reloads the whole app rather than re-fetching in place. That is
 * deliberate and it is the honest behaviour: the branch decides what nearly
 * every server component on screen just read — the open orders, the day, the
 * tables, the stock — and swapping the cookie without re-reading them would
 * leave one outlet's tables sitting above another outlet's totals.
 */
export default function BranchSwitcher({ collapsed = false }) {
    const [state, setState] = useState(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        branchPicker().then((res) => { if (res?.data) setState(res.data); });
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        const close = () => setOpen(false);
        // Any click that is not on the menu closes it; the menu stops its own
        // propagation, so this can stay a single document-level listener.
        document.addEventListener('click', close);
        return () => document.removeEventListener('click', close);
    }, [open]);

    if (!state || state.branches.length < 2) return null;

    const here = state.branches.find((b) => b.id === state.current) || state.branches[0];

    const pick = async (id) => {
        if (id === state.current || busy) return;
        setBusy(true);
        const res = await switchBranch(id);
        if (res?.error) { setBusy(false); setOpen(false); return; }
        window.location.reload();
    };

    if (!state.canSwitch) {
        return (
            <div className={`${styles.fixed} ${collapsed ? styles.collapsed : ''}`} title={here.name}>
                <Building2 size={collapsed ? 22 : 16} className={styles.icon} />
                {!collapsed && <span className={styles.name}>{here.name}</span>}
            </div>
        );
    }

    return (
        <div className={styles.wrap} onClick={(e) => e.stopPropagation()}>
            <button
                type="button"
                className={`${styles.trigger} ${collapsed ? styles.collapsed : ''}`}
                onClick={() => setOpen((v) => !v)}
                title={collapsed ? here.name : undefined}
                aria-haspopup="listbox"
                aria-expanded={open}
                disabled={busy}
            >
                <Building2 size={collapsed ? 22 : 16} className={styles.icon} />
                {!collapsed && (
                    <>
                        <span className={styles.name}>{here.name}</span>
                        <ChevronDown size={14} className={styles.chevron} />
                    </>
                )}
            </button>

            {open && (
                <ul className={styles.menu} role="listbox">
                    {state.branches.map((b) => (
                        <li key={b.id}>
                            <button
                                type="button"
                                role="option"
                                aria-selected={b.id === state.current}
                                className={styles.option}
                                onClick={() => pick(b.id)}
                            >
                                <span className={styles.optionName}>{b.name}</span>
                                {b.code && <span className={styles.code}>{b.code}</span>}
                                {b.id === state.current && <Check size={14} className={styles.tick} />}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

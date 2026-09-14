'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, CornerDownLeft, ArrowUp, ArrowDown, X, Clock3 } from 'lucide-react';
import styles from './CommandPalette.module.css';
import { searchableNav } from '@/lib/navIndex.mjs';
import { navIcon } from './navIcons';
import { searchNav, labelMatch } from '@/lib/navSearch.mjs';

const RECENTS_KEY = 'fbi_nav_recents';
const RECENTS_MAX = 5;

/*
 * Recents live per device, which is the right scope for a restaurant: the till
 * by the door and the manager's laptop are used for different jobs by different
 * people, and a shared "recently visited" would be noise on both. localStorage
 * can throw outright in a locked-down browser, so every touch of it is guarded
 * — a palette that crashes because a preference could not be read would be a
 * poor trade for remembering which report someone opened yesterday.
 */
const readRecents = () => {
    try {
        const raw = window.localStorage.getItem(RECENTS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((h) => typeof h === 'string') : [];
    } catch {
        return [];
    }
};

const pushRecent = (href) => {
    try {
        const next = [href, ...readRecents().filter((h) => h !== href)].slice(0, RECENTS_MAX);
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
        /* Not being able to remember is survivable; failing to navigate is not. */
    }
};

/* Label with the matched span marked, so the eye lands on why a row is here. */
const Highlighted = ({ label, query }) => {
    const range = labelMatch(label, query);
    if (!range) return label;
    return (
        <>
            {label.slice(0, range.start)}
            <mark className={styles.mark}>{label.slice(range.start, range.end)}</mark>
            {label.slice(range.end)}
        </>
    );
};

export default function CommandPalette({ open, onClose, perms = [] }) {
    const router = useRouter();
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [recents, setRecents] = useState([]);
    const inputRef = useRef(null);
    const listRef = useRef(null);
    const restoreFocusRef = useRef(null);

    const index = useMemo(() => searchableNav(perms), [perms]);

    /*
     * With nothing typed, the palette has to show SOMETHING useful or it reads
     * as broken. Recents first (what this device actually does), then the rest
     * of the primary rail to fill the space — never an empty box waiting to be
     * impressed.
     */
    const results = useMemo(() => {
        if (query.trim()) return searchNav(index, query);
        const byHref = new Map(index.map((e) => [e.href, e]));
        const recent = recents.map((h) => byHref.get(h)).filter(Boolean);
        const rest = index.filter((e) => e.nav === 'primary' && !recents.includes(e.href));
        return [...recent, ...rest].slice(0, 8);
    }, [query, index, recents]);

    const showingRecents = !query.trim() && recents.length > 0;

    // Reset per opening: a palette that reopens holding last time's search is
    // a palette you have to clear before you can use it.
    useEffect(() => {
        if (!open) return;
        restoreFocusRef.current = document.activeElement;
        setQuery('');
        setActive(0);
        setRecents(readRecents());
        // Focus after paint, or the browser hands focus back to the trigger.
        const id = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(id);
    }, [open]);

    // The page behind must not scroll under the overlay, and focus must come
    // back to where it was when this closes.
    useEffect(() => {
        if (!open) return;
        const { overflow } = document.body.style;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = overflow;
            const el = restoreFocusRef.current;
            if (el && typeof el.focus === 'function') el.focus();
        };
    }, [open]);

    useEffect(() => { setActive(0); }, [query]);

    const go = useCallback((entry) => {
        if (!entry) return;
        pushRecent(entry.href);
        onClose();
        if (entry.newTab) window.open(entry.href, '_blank', 'noopener');
        else router.push(entry.href);
    }, [onClose, router]);

    const onKeyDown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
        if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
            e.preventDefault();
            setActive((i) => (results.length ? (i + 1) % results.length : 0));
            return;
        }
        if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
            e.preventDefault();
            setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
            return;
        }
        if (e.key === 'Home') { e.preventDefault(); setActive(0); return; }
        if (e.key === 'End') { e.preventDefault(); setActive(Math.max(0, results.length - 1)); return; }
        if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    };

    // Keep the highlighted row on screen when arrowing past the fold.
    useEffect(() => {
        const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
        el?.scrollIntoView({ block: 'nearest' });
    }, [active, results]);

    if (!open) return null;

    // Group under section headings, but only once there is a query — with
    // recents showing, one flat list reads faster than two headings over
    // two rows each.
    const grouped = [];
    if (query.trim()) {
        let last = null;
        results.forEach((entry, i) => {
            if (entry.section !== last) { grouped.push({ heading: entry.section }); last = entry.section; }
            grouped.push({ entry, i });
        });
    } else {
        results.forEach((entry, i) => grouped.push({ entry, i }));
    }

    return (
        <div
            className={styles.overlay}
            role="presentation"
            /* Click-outside closes, but only a click that both starts and ends
               on the backdrop — dragging a selection out of the input should
               not dismiss the thing you are typing into. */
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div
                className={styles.panel}
                role="dialog"
                aria-modal="true"
                aria-label="Search screens"
                onKeyDown={onKeyDown}
            >
                <div className={styles.inputRow}>
                    <Search size={19} className={styles.inputIcon} aria-hidden="true" />
                    <input
                        ref={inputRef}
                        type="text"
                        className={styles.input}
                        placeholder="Search screens: try “z report”, “stock”, “tax”"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        role="combobox"
                        aria-expanded="true"
                        aria-controls="nav-search-results"
                        aria-activedescendant={results[active] ? `nav-opt-${active}` : undefined}
                        aria-autocomplete="list"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button
                        type="button"
                        className={styles.closeBtn}
                        onClick={onClose}
                        aria-label="Close search"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className={styles.results} id="nav-search-results" role="listbox" ref={listRef}>
                    {showingRecents && (
                        <p className={styles.heading}>
                            <Clock3 size={12} aria-hidden="true" /> Recent
                        </p>
                    )}

                    {grouped.map((row, k) => row.heading ? (
                        <p className={styles.heading} key={`h-${row.heading}-${k}`}>{row.heading}</p>
                    ) : (
                        <button
                            key={row.entry.href}
                            type="button"
                            id={`nav-opt-${row.i}`}
                            data-idx={row.i}
                            role="option"
                            aria-selected={row.i === active}
                            className={`${styles.row} ${row.i === active ? styles.rowActive : ''}`}
                            /* Pointer, not hover: on a touchscreen there is no
                               hover, and on a mouse this keeps the highlight
                               following the cursor without fighting the keys. */
                            onMouseMove={() => setActive(row.i)}
                            onClick={() => go(row.entry)}
                        >
                            {(() => { const Icon = navIcon(row.entry.icon); return <Icon size={18} className={styles.rowIcon} aria-hidden="true" />; })()}
                            <span className={styles.rowLabel}>
                                <Highlighted label={row.entry.label} query={query} />
                            </span>
                            <span className={styles.rowSection}>
                                {row.entry.newTab ? 'Opens in new tab' : row.entry.section}
                            </span>
                            {row.i === active && (
                                <CornerDownLeft size={15} className={styles.rowEnter} aria-hidden="true" />
                            )}
                        </button>
                    ))}

                    {results.length === 0 && (
                        <div className={styles.empty}>
                            <p className={styles.emptyTitle}>Nothing matches “{query.trim()}”</p>
                            <p className={styles.emptyHint}>
                                Try what you’d call it out loud. “best sellers”, “end of day”, “grn”.
                            </p>
                        </div>
                    )}
                </div>

                <div className={styles.footer}>
                    <span className={styles.hint}>
                        <kbd className={styles.kbd}><ArrowUp size={11} /></kbd>
                        <kbd className={styles.kbd}><ArrowDown size={11} /></kbd>
                        to move
                    </span>
                    <span className={styles.hint}>
                        <kbd className={styles.kbd}><CornerDownLeft size={11} /></kbd>
                        to open
                    </span>
                    <span className={styles.hint}>
                        <kbd className={styles.kbd}>esc</kbd>
                        to close
                    </span>
                </div>
            </div>
        </div>
    );
}

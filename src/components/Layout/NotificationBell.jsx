'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import styles from './NotificationBell.module.css';
import { markAllSeen } from '@/app/notifications/actions';

/*
 * The notice board, in the rail.
 *
 * What earns a line here is narrow on purpose: something is wrong that a
 * person can act on, and nobody is necessarily looking at the screen that
 * would show it. A receipt that did not print, a day left open overnight, an
 * FBR invoice the queue gave up on, a table unpaid for hours, an ingredient
 * under its reorder level. Not "an order was placed" — the till already shows
 * orders, and a bell that rings for normal work is a bell nobody reads.
 *
 * Polled slowly and deliberately: 45 seconds, against the orders channel's 4.
 * None of these are seconds-fresh facts, and the poll runs on every screen of
 * every terminal all evening.
 */
const POLL_MS = 45000;

const since = (iso) => {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
};

export default function NotificationBell({ collapsed = false }) {
    const [items, setItems] = useState([]);
    const [unseen, setUnseen] = useState(0);
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);

    useEffect(() => {
        let alive = true;
        /*
         * A poll that fails leaves the last board on screen and says nothing.
         * The offline banner already owns "this terminal cannot reach the
         * server"; an empty bell would say the opposite of what it means.
         */
        const tick = () => fetch('/api/notifications', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive || !data) return;
                setItems(data.items || []);
                setUnseen(Number(data.unseen) || 0);
            })
            .catch(() => {});

        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
    }, []);

    // Click-away and Escape, so the panel never strands itself over the rail.
    useEffect(() => {
        if (!open) return;
        const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const toggle = async () => {
        const next = !open;
        setOpen(next);
        if (!next || !unseen) return;
        // Opening the panel IS reading them. The badge clears immediately
        // rather than after the round trip — the list is already on screen,
        // and a number that lingers over what you are looking at reads as a
        // bug. The server catching up a moment later changes nothing.
        setUnseen(0);
        setItems((prev) => prev.map((n) => ({ ...n, seen_at: n.seen_at || new Date().toISOString() })));
        await markAllSeen();
    };

    return (
        <div className={`${styles.wrap} ${collapsed ? styles.collapsed : ''}`} ref={wrapRef}>
            <button
                type="button"
                className={styles.bell}
                onClick={toggle}
                title={collapsed ? `Alerts${unseen ? ` (${unseen} new)` : ''}` : undefined}
                aria-label={`Alerts${unseen ? `, ${unseen} unread` : ''}`}
                aria-expanded={open}
                aria-haspopup="menu"
            >
                <Bell size={collapsed ? 24 : 16} aria-hidden="true" />
                {!collapsed && <span className={styles.label}>Alerts</span>}
                {unseen > 0 && <span className={styles.count}>{unseen > 99 ? '99+' : unseen}</span>}
            </button>

            {open && (
                <div className={styles.panel} role="menu">
                    <div className={styles.head}>
                        <span>{items.length ? `${items.length} open` : 'Alerts'}</span>
                    </div>
                    {items.length === 0 ? (
                        <p className={styles.empty}>Nothing needs attention.</p>
                    ) : items.map((n) => (
                        <Link
                            key={n.id}
                            href={n.href || '#'}
                            className={`${styles.item} ${n.seen_at ? '' : styles.unseen}`}
                            onClick={() => setOpen(false)}
                            role="menuitem"
                        >
                            <span className={styles.title}>
                                <span className={`${styles.dot} ${styles[n.severity] || styles.info}`} aria-hidden="true" />
                                {n.title}
                                <span className={styles.when}>{since(n.created_at)}</span>
                            </span>
                            {n.body && <span className={styles.body}>{n.body}</span>}
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}

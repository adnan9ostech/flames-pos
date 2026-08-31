'use client';
import { useEffect, useRef } from 'react';
import { setChannelHealth, forgetChannel } from './connection';

/*
 * Watches a table for changes and — the part that must survive the move off
 * Supabase — refetches after a gap in coverage.
 *
 * There is no realtime socket any more. Instead each screen polls a tiny
 * version endpoint (an aggregate over orders that changes whenever any row
 * does) and refetches when the string differs from the last one it saw. Same
 * interface as the socket version so the call sites don't change; "healthy"
 * in the connection store now means "the last poll succeeded".
 *
 * The failure this guards against is unchanged: a terminal that silently
 * stops hearing about orders reads as a quiet service, not a broken screen.
 * So a poll that fails marks the channel unhealthy (the offline banner), and
 * the first poll that succeeds afterwards refetches unconditionally — the
 * version string alone can't say what was missed while blind.
 */

const POLL_MS = 4000;
// Jitter so a wall of terminals doesn't hit the server in lockstep.
const JITTER_MS = 500;

export function useRealtimeTable({ table, channel, onChange, enabled = true }) {
    // Held in a ref so a changing callback identity — which is normal, it
    // usually closes over filters — never tears down and rebuilds the poll.
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        if (!enabled) return;

        let stopped = false;
        let timer = null;
        let inFlight = false;
        // null until the first successful poll: the baseline never fires
        // onChange, because the caller has just loaded its own data.
        let lastVersion = null;
        let wasUnhealthy = false;

        const poll = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const res = await fetch('/api/orders/version', { cache: 'no-store' });
                if (stopped) return;
                if (!res.ok) {
                    // 401 lands here too: a dead session can't see new
                    // orders, which is exactly what the banner is for.
                    wasUnhealthy = true;
                    setChannelHealth(channel, false);
                    return;
                }
                const { version } = await res.json();
                if (stopped) return;
                const changed = lastVersion !== null && version !== lastVersion;
                const recovered = wasUnhealthy;
                lastVersion = version;
                wasUnhealthy = false;
                setChannelHealth(channel, true);
                // A recovery refetches even on a matching version — the fetch
                // that failed might have been the caller's own data load.
                if (changed || recovered) onChangeRef.current?.();
            } catch {
                if (stopped) return;
                wasUnhealthy = true;
                setChannelHealth(channel, false);
            } finally {
                inFlight = false;
            }
        };

        const schedule = () => {
            clearTimeout(timer);
            if (stopped || document.hidden) return;
            const jitter = (Math.random() * 2 - 1) * JITTER_MS;
            timer = setTimeout(tick, POLL_MS + jitter);
        };

        const tick = async () => {
            await poll();
            schedule();
        };

        tick();

        // A laptop lid closing kills the timers along with everything else,
        // so coming back online is its own trigger.
        const refetchOnOnline = () => onChangeRef.current?.();
        window.addEventListener('online', refetchOnOnline);

        // A hidden tab doesn't poll — nobody is looking, and a wedged
        // background timer would only burn requests. Coming back polls at
        // once, which refetches by itself if anything changed meanwhile.
        const onVisibility = () => {
            if (document.hidden) {
                clearTimeout(timer);
                timer = null;
            } else {
                tick();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            stopped = true;
            clearTimeout(timer);
            window.removeEventListener('online', refetchOnOnline);
            document.removeEventListener('visibilitychange', onVisibility);
            forgetChannel(channel);
        };
        // `table` stays a dependency for interface parity even though every
        // channel now polls the same orders version endpoint.
    }, [table, channel, enabled]);
}

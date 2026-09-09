'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
    DARK_QUERY,
    DEFAULT_THEME,
    STORAGE_KEY,
    THEME_COLORS,
    normalize,
    resolveTheme,
} from '@/lib/theme.mjs';

/*
 * Theme state, built on the same shape as the sidebar-collapse store in
 * AppLayout: a useSyncExternalStore over localStorage with a `storage`
 * listener, so two tabs on the same till stay in step and the server-rendered
 * markup matches the first client render.
 *
 * Two stores, not one. The PREFERENCE lives in localStorage; whether the OS
 * currently wants dark is a separate live signal from matchMedia. Keeping them
 * apart means picking Light or Dark stops re-rendering on OS changes entirely,
 * and only 'system' pays attention to the media query.
 */

const ThemeContext = createContext(null);

const prefListeners = new Set();

const prefStore = {
    subscribe(onChange) {
        prefListeners.add(onChange);
        // Fires for OTHER tabs/windows on this origin — same-tab writes notify
        // through the listener set below.
        window.addEventListener('storage', onChange);
        return () => {
            prefListeners.delete(onChange);
            window.removeEventListener('storage', onChange);
        };
    },
    getSnapshot() {
        try {
            return normalize(window.localStorage.getItem(STORAGE_KEY));
        } catch {
            // Private modes throw rather than returning null.
            return DEFAULT_THEME;
        }
    },
    getServerSnapshot: () => DEFAULT_THEME,
    set(pref) {
        try {
            window.localStorage.setItem(STORAGE_KEY, pref);
        } catch {
            /* Preference won't survive a reload, but the session still switches. */
        }
        prefListeners.forEach(onChange => onChange());
    },
};

const systemStore = {
    subscribe(onChange) {
        const mq = window.matchMedia(DARK_QUERY);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    },
    getSnapshot: () => window.matchMedia(DARK_QUERY).matches,
    // The server can't know the OS setting. Matching DEFAULT_THEME keeps the
    // first render consistent; the boot script has already painted the truth.
    getServerSnapshot: () => DEFAULT_THEME === 'dark',
};

export function ThemeProvider({ children }) {
    const pref = useSyncExternalStore(
        prefStore.subscribe,
        prefStore.getSnapshot,
        prefStore.getServerSnapshot,
    );
    const systemPrefersDark = useSyncExternalStore(
        systemStore.subscribe,
        systemStore.getSnapshot,
        systemStore.getServerSnapshot,
    );

    const resolved = resolveTheme(pref, systemPrefersDark);

    /*
     * The boot script is AUTHORITATIVE for the first paint, and this effect must
     * not fight it.
     *
     * During hydration useSyncExternalStore deliberately returns
     * getServerSnapshot before switching to the live store, so this effect can
     * run once holding the SERVER's value ('dark') while <html> already carries
     * the stored one ('light'). Writing on that pass produced a visible
     * light -> dark -> light flicker: exactly the flash the boot script exists
     * to prevent, reintroduced one frame later.
     *
     * So the first run adopts whatever the boot script painted and writes
     * nothing. Only genuine, post-mount changes write — plus the one case where
     * the boot script never ran (JS error, ancient browser), detected by the
     * attribute being absent, where this becomes the fallback that sets it.
     */
    const mounted = useRef(false);
    const timer = useRef(null);

    // Keep the browser-chrome meta in step with the painted theme. The boot
    // script set it before first paint; this owns it from mount on.
    const syncChrome = (theme) => {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', theme === 'dark' ? THEME_COLORS.dark : THEME_COLORS.light);
    };

    useEffect(() => {
        const root = document.documentElement;
        const current = root.getAttribute('data-theme');

        if (!mounted.current) {
            mounted.current = true;
            // Boot script did its job — leave it alone and wait for a real change.
            if (current) return;
            // It didn't run. Paint now, without a transition.
            root.setAttribute('data-theme', resolved);
            syncChrome(resolved);
            return;
        }

        if (current === resolved) return;
        syncChrome(resolved);

        root.setAttribute('data-theme-transition', '');
        clearTimeout(timer.current);
        // Must outlast the 220ms transition in globals.css, then come off —
        // leaving it on would put a transition on every hover in the app.
        timer.current = setTimeout(() => {
            root.removeAttribute('data-theme-transition');
        }, 260);

        root.setAttribute('data-theme', resolved);
    }, [resolved]);

    useEffect(() => () => clearTimeout(timer.current), []);

    const setPref = useCallback((next) => prefStore.set(normalize(next)), []);

    const value = useMemo(() => ({ pref, resolved, setPref }), [pref, resolved, setPref]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/*
 * { pref, resolved, setPref } — `pref` is what the person chose (may be
 * 'system'), `resolved` is what is actually on screen ('light' | 'dark').
 * A control needs both: to tick the right option AND to say what System
 * currently means.
 */
export function useTheme() {
    return useContext(ThemeContext) ?? {
        pref: DEFAULT_THEME,
        resolved: DEFAULT_THEME,
        setPref: () => {},
    };
}

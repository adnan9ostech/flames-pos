/*
 * Whether this terminal is actually connected — both to the network and to
 * the server it polls for order changes.
 *
 * These are separate failures and only one of them is obvious. A failing poll
 * on a working network is the dangerous case: the kitchen display keeps showing
 * the tickets it had when polling broke and nothing says otherwise, so staff
 * read a stale board as a quiet one. An offline banner is a much better failure
 * than that.
 *
 * A module-level store rather than context so any screen can report or read
 * status without threading providers through the tree.
 */

let state = {
    // Assume connected until told otherwise: on the server, and before the
    // first event fires, "offline" would be a false alarm.
    online: true,
    // channel name -> healthy?
    channels: {},
};

const listeners = new Set();

const emit = () => {
    // New object each time so useSyncExternalStore sees a changed snapshot.
    state = { ...state };
    listeners.forEach(fn => fn());
};

export const subscribeConnection = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};

export const getConnectionSnapshot = () => state;

// Constant identity: returning a fresh object here would make React loop.
const SERVER_SNAPSHOT = { online: true, channels: {} };
export const getConnectionServerSnapshot = () => SERVER_SNAPSHOT;

const setOnline = (online) => {
    if (state.online === online) return;
    state.online = online;
    emit();
};

export const setChannelHealth = (name, healthy) => {
    if (state.channels[name] === healthy) return;
    state.channels = { ...state.channels, [name]: healthy };
    emit();
};

export const forgetChannel = (name) => {
    if (!(name in state.channels)) return;
    const next = { ...state.channels };
    delete next[name];
    state.channels = next;
    emit();
};

// Degraded if anything that asked to be watched isn't currently healthy.
export const isDegraded = (snapshot) =>
    !snapshot.online || Object.values(snapshot.channels).some(healthy => healthy === false);

/*
 * Wire up the browser's own online/offline events. Called once from the layout;
 * safe to call again, since it tracks whether it already ran.
 */
let started = false;

export const startConnectionWatch = () => {
    if (started || typeof window === 'undefined') return () => {};
    started = true;

    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    setOnline(window.navigator.onLine !== false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
        window.removeEventListener('online', goOnline);
        window.removeEventListener('offline', goOffline);
        started = false;
    };
};

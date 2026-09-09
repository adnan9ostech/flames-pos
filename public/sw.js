/*
 * App-shell cache for the till.
 *
 * The problem this solves is narrow and worth being precise about: when the
 * connection drops, a reload used to give staff the browser's dinosaur. The
 * shell is now served from cache, so the app still paints and can say what's
 * wrong instead of vanishing.
 *
 * This caches the *shell*, never data. Nothing here queues writes or replays
 * anything — a cached order would be far more dangerous than a missing one.
 *
 * Deliberate exclusions:
 *   - anything but GET, so no write is ever intercepted
 *   - cross-origin requests
 *   - /api/*, the data path now that the API is same-origin: orders, auth and
 *     settings must always hit the network or the till would act on stale rows
 *   - /login, so a session is never decided from cache
 */

/* v3: the dual-theme release. offline.html is cached by NAME, not by content
   hash, so an installed till would keep serving the old always-dark copy until
   this bumps. */
const VERSION = 'v3';
const SHELL_CACHE = `flames-shell-${VERSION}`;
const ASSET_CACHE = `flames-assets-${VERSION}`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll([OFFLINE_URL]))
            // Take over immediately: a till left on a half-updated worker for a
            // whole service is worse than a single reload now.
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith('flames-') && !key.endsWith(VERSION))
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

const isCacheableAsset = (url) =>
    // Content-hashed by the build, so cache-first can never serve a stale
    // version of a file that has changed.
    url.pathname.startsWith('/_next/static/')
    // /menu-images/ files match here too, and they are NOT content-hashed:
    // cache-first means new bytes under an old filename keep serving the old
    // image until VERSION bumps. The rule, therefore: a changed menu image
    // gets a NEW filename, never a replacement under the old one.
    || /\.(?:png|jpg|jpeg|svg|webp|avif|ico|woff2?)$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Same-origin only — third-party requests are never ours to answer.
    if (url.origin !== self.location.origin) return;

    // The API is the data path, and it lives on this origin now: every order,
    // auth and settings call goes under /api/, and none of it may ever come
    // from cache.
    if (url.pathname.startsWith('/api/')) return;

    if (url.pathname === '/login') return;

    if (isCacheableAsset(url)) {
        event.respondWith(
            caches.match(request).then(hit => hit || fetch(request).then(response => {
                // Opaque or failed responses aren't worth keeping.
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(ASSET_CACHE).then(cache => cache.put(request, copy));
                }
                return response;
            }))
        );
        return;
    }

    /*
     * Navigations are network-first: the app is behind a login and reads live
     * data, so a cached page must never win over a reachable server. Cache is
     * only a fallback for when there's nothing to reach.
     */
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
                    return response;
                })
                .catch(async () => {
                    const cached = await caches.match(request);
                    return cached || caches.match(OFFLINE_URL);
                })
        );
    }
});

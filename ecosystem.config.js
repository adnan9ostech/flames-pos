/*
 * PM2 process definitions for the cPanel box (run as user ostech, never root).
 *
 * THE PORT LIVES IN EXACTLY TWO PLACES: the `-p 3017` below, and the two
 * ProxyPass lines in /etc/apache2/conf.d/userdata/ssl/2_4/ostech/
 * pos.flamesbytheindus.com/nodeproxy.conf. Change both together or Apache
 * serves 503s. 3017 was picked from a port inventory (`ss -ltnp`) on the box —
 * re-check before first start; ~150 tenants share this machine.
 *
 * Environment: there is no env_file key — PM2 does not read .env files.
 * Both processes rely on /home/ostech/apps/flames-pos/.env.production
 * (mode 600, outside every docroot): `next start` loads it natively, and
 * fbr-worker.mjs loads it itself the way scripts/db/migrate.mjs does.
 */
module.exports = {
    apps: [
        {
            name: 'flames-pos',
            cwd: '/home/ostech/apps/flames-pos',
            // Through the local binary, not `npm run start` — a reload must
            // restart Next itself, not an npm wrapper that orphans it.
            script: 'node_modules/.bin/next',
            args: 'start -H 127.0.0.1 -p 3017',
            // Bound to loopback: Apache is the only public face. The app must
            // never be reachable on a raw port of a shared box.
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
            },
        },
        {
            name: 'fbr-worker',
            cwd: '/home/ostech/apps/flames-pos',
            script: 'scripts/fbr-worker.mjs',
            // The worker retries queued FBR invoices; a crash loop must not
            // hammer the FBR endpoint.
            restart_delay: 5000,
            max_memory_restart: '256M',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};

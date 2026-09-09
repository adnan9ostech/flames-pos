/** @type {import('next').NextConfig} */
const nextConfig = {
  // Recipes moved under Menu Management (3 Sep 2026); the old address keeps
  // working for bookmarks and the inventory hub's muscle memory.
  async redirects() {
    return [{ source: '/inventory/recipes', destination: '/menu/recipes', permanent: false }];
  },
  experimental: {
    // Server Actions verify that the Origin header matches the Host header.
    // Behind Apache the primary defense is `ProxyPreserveHost On` in the
    // vhost include, which keeps Host as the public domain so the two match
    // naturally; this list is the backstop for a proxy hop that rewrites
    // Host, not a substitute for it (see docs/deploy-cpanel.md, Phase 4).
    //
    // Server Actions themselves are stable, but their config object never
    // left `experimental` — in Next 16 this is still its only valid location
    // (node_modules/next/dist/server/config-schema.js keeps `serverActions`
    // inside the experimental schema alone).
    serverActions: {
      allowedOrigins: ['pos.flamesbytheindus.com'],
    },
  },
};

export default nextConfig;

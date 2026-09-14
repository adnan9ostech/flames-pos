/*
 * The installed app's identity, from the database rather than a static file.
 *
 * This was `public/manifest.webmanifest`, and it named Flames by the Indus in
 * four places. That file is what a phone reads when somebody adds the till to
 * a home screen: on a white-labelled install, a different restaurant's staff
 * would have ended up with an icon captioned "Flames POS". The tab title had
 * already moved to the database; the home-screen name had not, and the
 * home-screen name is the one that outlives the tab.
 *
 * Served as a route so it answers per deployment with no build step. A
 * restaurant that changes its name in Settings changes what its staff install
 * the next time they install it.
 */
import { getBrand } from '@/lib/db/reads.mjs';

// Re-read per request rather than cached at build: the brand is editable, and
// a manifest frozen at deploy time is a brand that cannot be corrected without
// a redeploy. It is one small query on a file fetched approximately never.
export const dynamic = 'force-dynamic';

export async function GET() {
    const brand = await getBrand();

    /*
     * The icon follows the same rule as everywhere else: the restaurant's own
     * logo when it has uploaded one, and the built-in mark when it has not.
     * `purpose: maskable` is dropped for an uploaded logo — Android crops a
     * maskable icon to a circle, which is safe for a square app mark and eats
     * the edges of a wordmark.
     */
    const uploaded = brand.logoDark || brand.logoLight;
    const icons = uploaded
        ? [{ src: uploaded, sizes: 'any', type: uploaded.endsWith('.svg') ? 'image/svg+xml' : 'image/png', purpose: 'any' }]
        : [
            { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ];

    return Response.json({
        name: `${brand.name} POS`,
        short_name: brand.name,
        description: `Point of sale for ${brand.name}`,
        start_url: '/pos',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        // Black, matching the boot theme — NOT the brand colour. This paints
        // the splash behind the icon, and a mid-tone brand would show a flash
        // of the wrong colour before the app's own theme resolves.
        background_color: '#000000',
        theme_color: '#000000',
        icons,
    }, {
        headers: {
            'Content-Type': 'application/manifest+json',
            // Long enough that a phone is not refetching it, short enough that
            // a rebrand reaches an installed device the same day.
            'Cache-Control': 'public, max-age=3600',
        },
    });
}

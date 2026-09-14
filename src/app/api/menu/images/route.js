/*
 * Photo upload for the Menu screen. The browser has already scaled the image
 * down and re-encoded it as WebP (ImageField.jsx), so what arrives is small;
 * the server still trusts nothing about it — the bytes are sniffed for a
 * real image signature, the name is minted here, and the size is capped.
 *
 * Returns { url } — the path menu_items.image stores and <img src> uses.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requirePermission } from '@/lib/db/auth.mjs';
import { menuImageDir, MENU_IMAGE_URL_PREFIX, IMAGE_MAX_BYTES } from '@/lib/menu/kit.mjs';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/* The extension the bytes say they are, or null. */
const sniff = (buf) => {
    if (buf.length < 12) return null;
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    return null;
};

export async function POST(request) {
    try {
        /*
         * The Brand screen uploads a logo through this same route, and a
         * person who may change the brand holds `settings` rather than `menu`.
         * Either right opens it: what the route does is "store an image this
         * app will serve", and both screens are that.
         */
        /*
         * Three screens store a photo through here: the Menu (a dish), Brand
         * (a logo) and Expenses (the bill). Each is held by people with a
         * different right, and what the route does — "store an image this app
         * will serve" — is the same act in all three.
         */
        let allowed = false;
        for (const right of ['menu', 'settings', 'expenses']) {
            try {
                await requirePermission(right);
                allowed = true;
                break;
            } catch { /* try the next one */ }
        }
        if (!allowed) await requirePermission('menu');
    } catch (e) {
        return Response.json({ error: e.message }, { status: e.status ?? 401, headers: NO_STORE });
    }
    try {
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof Blob)) {
            return Response.json({ error: 'No photo was sent' }, { status: 400, headers: NO_STORE });
        }
        if (file.size > IMAGE_MAX_BYTES) {
            return Response.json({ error: 'That photo is too large (3 MB max)' }, { status: 413, headers: NO_STORE });
        }
        const buf = Buffer.from(await file.arrayBuffer());
        const ext = sniff(buf);
        if (!ext) {
            return Response.json({ error: 'That file is not a WebP, JPEG or PNG photo' }, { status: 415, headers: NO_STORE });
        }
        const name = `${randomUUID()}.${ext}`;
        const dir = menuImageDir();
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, name), buf);
        return Response.json({ url: `${MENU_IMAGE_URL_PREFIX}${name}` }, { headers: NO_STORE });
    } catch (e) {
        console.error('POST /api/menu/images failed:', e);
        return Response.json({ error: 'Could not save the photo' }, { status: 500, headers: NO_STORE });
    }
}

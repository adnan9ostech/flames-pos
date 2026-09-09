/*
 * Serves a photo uploaded from the Menu screen. Public, like /menu-images/
 * — the customer menu shows these with no session. The file name is a UUID
 * plus a known extension and nothing else, so there is no path to traverse;
 * and because a re-upload always mints a new name, the response can be
 * cached forever.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { menuImageDir, IMAGE_FILE_RE, IMAGE_TYPES } from '@/lib/menu/kit.mjs';

export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
    const { file } = await params;
    if (!IMAGE_FILE_RE.test(String(file ?? ''))) return new Response('Not found', { status: 404 });
    try {
        const buf = await readFile(path.join(menuImageDir(), file));
        const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
        return new Response(buf, {
            headers: {
                'Content-Type': IMAGE_TYPES[ext],
                'Content-Length': String(buf.length),
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        });
    } catch {
        return new Response('Not found', { status: 404 });
    }
}

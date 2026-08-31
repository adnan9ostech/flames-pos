/*
 * Step 2: pull every menu image out of the public Supabase Storage bucket
 * into public/menu-images/, preserving the path after the bucket name, and
 * record the URL -> root-relative-path rewrite in out/image-map.json for 04.
 *
 *   node scripts/migrate-to-mysql/02-download-images.mjs
 *
 * Exits nonzero listing every miss if anything fails to download — a partial
 * image set must not reach the load step silently, because the MySQL rows
 * would then point at files that do not exist.
 *
 * Re-runnable: a file already on disk with bytes in it is kept, not
 * re-fetched, so a re-run after a network blip only fetches the misses.
 */
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, outPath, readJson, writeJson } from './_lib.mjs';

const DEST_ROOT = path.join(ROOT, 'public', 'menu-images');
const CONCURRENCY = 6;

const exportFile = outPath('menu_items.json');
if (!existsSync(exportFile)) {
    console.error(`${exportFile} not found — run 01-export-supabase.mjs first.`);
    process.exit(1);
}
const rows = readJson(exportFile);

// The path after the bucket, so menu-v3/foo.webp stays menu-v3/foo.webp.
const bucketPath = (url) => {
    let pathname;
    try { pathname = new URL(url).pathname; } catch { return null; }
    const m = pathname.match(/\/object\/(?:public\/)?menu-images\/(.+)$/);
    if (!m) return null;
    const sub = decodeURIComponent(m[1]);
    // A crafted path must not write outside public/menu-images/.
    if (sub.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
    return sub;
};

const urls = [...new Set(rows.map((r) => r.image).filter(Boolean))];
const map = {};
const misses = [];
let downloaded = 0;
let kept = 0;

const handle = async (url) => {
    if (url.startsWith('/menu-images/')) {
        // Already rewritten (a previous run, or a hand-fixed row): keep it,
        // but only if the file it names is actually on disk.
        const local = path.join(ROOT, 'public', url.slice(1));
        if (existsSync(local) && statSync(local).size > 0) map[url] = url;
        else misses.push({ url, reason: 'already root-relative but the local file is missing or empty' });
        return;
    }
    const sub = bucketPath(url);
    if (!sub) {
        misses.push({ url, reason: 'not a menu-images bucket URL' });
        return;
    }
    const dest = path.join(DEST_ROOT, sub);
    if (existsSync(dest) && statSync(dest).size > 0) {
        kept += 1;
        map[url] = `/menu-images/${sub}`;
        return;
    }
    try {
        const res = await fetch(url);
        if (!res.ok) {
            misses.push({ url, reason: `HTTP ${res.status}` });
            return;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) {
            misses.push({ url, reason: 'empty body (0 bytes)' });
            return;
        }
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        downloaded += 1;
        map[url] = `/menu-images/${sub}`;
    } catch (e) {
        misses.push({ url, reason: e.message });
    }
};

for (let i = 0; i < urls.length; i += CONCURRENCY) {
    await Promise.all(urls.slice(i, i + CONCURRENCY).map(handle));
}

// The map of successes is written even on failure: 04 refuses unmapped
// images anyway, and a partial map makes the re-run cheaper to reason about.
writeJson(outPath('image-map.json'), map);

console.log(`${urls.length} distinct image URL(s): ${downloaded} downloaded, ${kept} already on disk, ${misses.length} missed.`);
console.log(`Map -> ${outPath('image-map.json')}`);

if (misses.length > 0) {
    console.error('\nMISSES:');
    for (const m of misses) console.error(`  ${m.url}\n    ${m.reason}`);
    process.exit(1);
}

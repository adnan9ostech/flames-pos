/*
 * Turns the receipt logo SVG into a 1-bit bitmap the thermal printer can print,
 * and writes it out as `src/lib/print/logo.mjs`.
 *
 *   node scripts/print/make-logo.mjs                 # both paper widths
 *   node scripts/print/make-logo.mjs --preview       # also draw it in the terminal
 *   node scripts/print/make-logo.mjs --threshold 0.7 # darker/lighter cut
 *
 * WHY IT IS A BUILD STEP AND NOT DONE AT RUNTIME
 *
 * A thermal printer takes a raster: one bit per dot, MSB leftmost, packed into
 * bytes across each row (ESC/POS `GS v 0`). Getting there from an SVG means
 * rasterising, and this project has no image library — deliberately, because a
 * till should not carry a native image toolchain just to print a header.
 *
 * So the conversion happens ONCE, here, on a developer machine, and the result
 * is committed as plain base64 in a .mjs file. The app then only has to spit
 * bytes at a printer, which it can already do. Re-run this only when the logo
 * artwork changes.
 *
 * HOW IT RASTERISES WITHOUT A LIBRARY
 *
 * Headless Chrome is the rasteriser — it is already on any machine that runs
 * this till, and it renders SVG exactly as the browser-printed receipt did. The
 * page below draws the SVG into a <canvas> at the target dot width, thresholds
 * each pixel to black or white, packs the bits, and leaves the base64 in the
 * DOM; `--dump-dom` hands it back. No native modules, no ImageMagick.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SVG = path.join(root, 'public', 'flames-by-the-indus-logo-for-receipt.svg');
const OUT = path.join(root, 'src', 'lib', 'print', 'logo.mjs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/*
 * The full printable width of the paper, in dots. Every bitmap is emitted at
 * exactly this width — see PAD TO THE PAPER below.
 */
/*
 * 512 for 80mm, NOT the 576 the spec sheets claim. 576 is the printable width
 * on paper, and a 576-dot solid bar does print — but the only full logo this
 * printer has ever rendered correctly was 512 dots wide (64 bytes per row), and
 * 576 came out as noise. Until the queue is rebuilt as a true raw queue, this
 * stays at the geometry that is known to work on the hardware in the room.
 */
const PAPER = { 80: 512, 58: 384 };

/*
 * How wide the artwork itself is drawn inside that. 80% of the 512/384 first
 * tried, which printed correctly but too large for the bill (reduced 10 Sep
 * 2026). Multiples of 32, so the inked area starts and ends on a byte.
 */
const LOGO = { 80: 416, 58: 320 };

/*
 * PAD TO THE PAPER, rather than emitting a narrow bitmap and asking the
 * printer to centre it.
 *
 * `ESC a 1` centres a raster by shifting it BYTE-wise. A 512-dot logo on
 * 576-dot paper offsets by (576-512)/2 = 32 dots — exactly 4 bytes — and
 * printed perfectly. Reducing it to 408 offset by 84 dots, which is 10.5
 * bytes: every row shifted half a byte, the rows smeared, and the leftovers
 * came out of the printer as random characters (seen on paper, 10 Sep 2026).
 *
 * So the bitmap is built at the FULL paper width with the artwork centred in
 * white inside it. The printer is then handed a row that starts at dot 0 and
 * needs no arithmetic at all, and the logo can be resized to anything without
 * the alignment mattering again. It costs a little more data and nothing else.
 */

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const THRESHOLD = Number(arg('threshold', '0.62'));
const PREVIEW = process.argv.includes('--preview');

// The SVG goes in as a data URI so the page has no file:// fetch to be blocked on.
const svg = readFileSync(SVG, 'utf8');
const svgDataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

const pageFor = (paperDots, logoDots) => `<!doctype html><meta charset="utf-8"><body><pre id="out"></pre><script>
const img = new Image();
img.onload = () => {
  const w = ${paperDots};                 // the bitmap is the whole paper wide
  const lw = ${logoDots};                 // the artwork inside it
  const h = Math.round(lw * (img.naturalHeight / img.naturalWidth));
  const x = Math.round((w - lw) / 2);     // centred here, not by the printer
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  // White ground first: the artwork is transparent, and an unpainted canvas
  // reads as black once alpha is flattened — a solid black slab of a logo.
  // This also supplies the white margin either side of the mark.
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, x, 0, lw, h);
  const px = g.getImageData(0, 0, w, h).data;
  const bytesPerRow = w / 8;
  const out = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Rec. 601 luma, then alpha-flattened onto white.
      const a = px[i + 3] / 255;
      const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
      const v = lum * a + (1 - a);
      if (v < ${THRESHOLD}) out[y * bytesPerRow + (x >> 3)] |= (0x80 >> (x & 7));
    }
  }
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  document.getElementById('out').textContent = JSON.stringify({ width: w, height: h, data: btoa(s) });
};
img.src = ${JSON.stringify(svgDataUri)};
</script>`;

const rasterise = (paperDots, logoDots) => {
    const dir = path.join(os.tmpdir(), `fbi-logo-${paperDots}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.html');
    writeFileSync(file, pageFor(paperDots, logoDots));
    try {
        const dom = execFileSync(CHROME, [
            '--headless', '--disable-gpu', '--no-sandbox',
            // The drawing happens in img.onload, after the load event that
            // --dump-dom waits for, so buy it some virtual time to finish.
            '--virtual-time-budget=8000',
            '--dump-dom', `file://${file}`,
        ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
        if (!m || !m[1].trim()) throw new Error('Chrome produced no bitmap — the SVG may not have rendered');
        // The DOM is HTML-escaped; base64 and digits survive, but quotes do not.
        const json = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        return JSON.parse(json);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

// A rough terminal render, two rows of dots per line, so the bitmap can be
// eyeballed before any paper is spent on it.
const preview = ({ width, height, data }) => {
    const bytes = Buffer.from(data, 'base64');
    const bpr = width / 8;
    const on = (x, y) => (bytes[y * bpr + (x >> 3)] >> (7 - (x & 7))) & 1;
    const step = Math.ceil(width / 96);
    for (let y = 0; y < height; y += step * 2) {
        let line = '';
        for (let x = 0; x < width; x += step) {
            const top = on(x, y), bot = y + step < height ? on(x, y + step) : 0;
            line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
        }
        console.log(line.replace(/\s+$/, ''));
    }
};

const out = {};
for (const [mm, paperDots] of Object.entries(PAPER)) {
    const bmp = rasterise(paperDots, LOGO[mm]);
    out[mm] = bmp;
    const ink = Buffer.from(bmp.data, 'base64').reduce((n, b) => n + (b.toString(2).match(/1/g)?.length || 0), 0);
    console.log(`${mm}mm -> ${bmp.width}x${bmp.height} dots, ${Buffer.from(bmp.data, 'base64').length} bytes, ${(100 * ink / (bmp.width * bmp.height)).toFixed(1)}% ink`);
    if (PREVIEW && String(mm) === '80') preview(bmp);
}

writeFileSync(OUT, `/*
 * The receipt logo as a 1-bit bitmap, one entry per paper width.
 *
 * GENERATED — do not edit by hand. Re-run when the artwork changes:
 *   node scripts/print/make-logo.mjs --preview
 *
 * \`data\` is base64 of packed rows: each row is width/8 bytes, most
 * significant bit leftmost, a set bit meaning a black dot. That is exactly the
 * payload ESC/POS \`GS v 0\` wants, so renderLogo() can hand it over untouched.
 */
export const RECEIPT_LOGO = ${JSON.stringify(out, null, 4)};
`);
console.log(`wrote ${path.relative(root, OUT)}`);

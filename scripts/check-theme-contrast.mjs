#!/usr/bin/env node
/*
 * Reads the two palettes straight out of src/app/globals.css and checks every
 * text token against every surface it can land on, in both themes.
 *
 * The point is that the theme's accessibility is a PROPERTY OF THE FILE, not of
 * a decision someone remembers making. Change a token, run this, and you find
 * out immediately whether you just put 3.9:1 body text on a card.
 *
 *   node scripts/check-theme-contrast.mjs          # summary, exits 1 on any fail
 *   node scripts/check-theme-contrast.mjs --all    # print every pair, passing too
 *
 * WCAG AA is 4.5:1 for body text and 3:1 for large text and UI boundaries.
 * Borders are checked against a 1.3 floor instead — they are not text, they
 * just have to be findable.
 */
import { readFileSync } from 'node:fs';

const CSS = new URL('../src/app/globals.css', import.meta.url);
const showAll = process.argv.includes('--all');

/* ---------- colour maths ---------- */
const hex = (h) => {
    h = h.replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const channel = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (h) => {
    const [r, g, b] = hex(h);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    const [hi, lo] = x > y ? [x, y] : [y, x];
    return (hi + 0.05) / (lo + 0.05);
};

/* ---------- pull the palettes out of the stylesheet ---------- */
const css = readFileSync(CSS, 'utf8');

function block(selector) {
    // Non-greedy to the first closing brace at column 0 — the token blocks are
    // flat, so this is enough and avoids pulling in a brace-matching parser.
    const at = css.indexOf(selector);
    if (at === -1) throw new Error(`missing block: ${selector}`);
    const body = css.slice(at, css.indexOf('\n}', at));
    const out = {};
    for (const [, name, value] of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        out[name] = value.trim();
    }
    return out;
}

const darkRaw = block(':root {');
const lightRaw = { ...darkRaw, ...block(':root[data-theme="light"] {') };

// Only solid hex is checkable — alpha tints composite against whatever is
// behind them, so their contrast is not a property of the token alone.
const solid = (t) => Object.fromEntries(
    Object.entries(t).filter(([, v]) => /^#[0-9a-fA-F]{3,8}$/.test(v)),
);

const THEMES = { dark: solid(darkRaw), light: solid(lightRaw) };

/* ---------- what has to be legible on what ---------- */
const SURFACES = ['background', 'card', 'card-elevated'];
const BODY_TEXT = [
    'foreground', 'card-foreground', 'muted-foreground', 'muted',
    'primary', 'accent', 'success', 'destructive', 'info',
    'success-text', 'danger-text', 'warning-text', 'info-text', 'neutral-text',
    'sidebar-muted', 'chart-axis', 'chart-label', 'trend-up', 'trend-down', 'trend-flat',
];
/*
 * Text on a coloured FILL. Third element is the minimum ratio: the primary
 * (brand-orange) buttons carry only large/bold LABELS and are white-on-orange
 * by owner decision, so they are held to the 3:1 large-text bar; every other
 * fill keeps the 4.5:1 small-text bar.
 */
const ON_FILL = [
    ['primary-foreground', 'primary', 3.0],
    ['primary-foreground', 'primary-hover', 3.0],
    ['accent-foreground', 'accent', 4.5],
    ['destructive-foreground', 'destructive', 4.5],
];
const STRUCTURE = [['border', 1.3], ['input', 1.3], ['disabled-border', 1.15]];

let failures = 0;
let checks = 0;

for (const [themeName, tok] of Object.entries(THEMES)) {
    const lines = [];

    for (const text of BODY_TEXT) {
        if (!tok[text]) continue;
        for (const surface of SURFACES) {
            if (!tok[surface]) continue;
            const r = ratio(tok[text], tok[surface]);
            checks++;
            const bad = r < 4.5;
            if (bad) failures++;
            if (bad || showAll) {
                lines.push(`  ${bad ? 'FAIL' : 'ok  '} ${r.toFixed(2).padStart(6)}  --${text} on --${surface}`);
            }
        }
    }

    for (const [ink, fill, min] of ON_FILL) {
        if (!tok[ink] || !tok[fill]) continue;
        const r = ratio(tok[ink], tok[fill]);
        checks++;
        const bad = r < min;
        if (bad) failures++;
        if (bad || showAll) {
            const tag = min < 4.5 ? ' (fill, large-text 3:1)' : ' (fill)';
            lines.push(`  ${bad ? 'FAIL' : 'ok  '} ${r.toFixed(2).padStart(6)}  --${ink} on --${fill}${tag}`);
        }
    }

    for (const [name, floor] of STRUCTURE) {
        if (!tok[name]) continue;
        for (const surface of ['card', 'background']) {
            const r = ratio(tok[name], tok[surface]);
            checks++;
            const bad = r < floor;
            if (bad) failures++;
            if (bad || showAll) {
                lines.push(`  ${bad ? 'FAIL' : 'ok  '} ${r.toFixed(2).padStart(6)}  --${name} vs --${surface} (needs ${floor})`);
            }
        }
    }

    console.log(`\n=== ${themeName.toUpperCase()} ===`);
    console.log(lines.length ? lines.join('\n') : '  all pairs pass');
}

/*
 * Status chips are an alpha TINT over a surface with the -text token on top.
 * The pairwise check above only sees solid tokens, so it structurally cannot
 * catch a chip whose text dips under AA once the tint darkens the ground —
 * which is exactly where three real failures hid. Composite, then check.
 */
const rgba = (v) => {
    const m = v.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/);
    if (!m) return null;
    return { rgb: [(+m[1]), (+m[2]), (+m[3])], a: m[4] === undefined ? 1 : +m[4] };
};
const compose = (tint, surfaceHex) => {
    const s = hex(surfaceHex);
    return '#' + tint.rgb.map((c, i) => Math.round(tint.a * c + (1 - tint.a) * s[i]).toString(16).padStart(2, '0')).join('');
};

const FAMILIES = ['success', 'danger', 'warning', 'info', 'neutral', 'primary'];
for (const [themeName, tokRaw] of [['dark', darkRaw], ['light', lightRaw]]) {
    const lines = [];
    for (const fam of FAMILIES) {
        const text = tokRaw[fam + '-text'] || tokRaw[fam];
        if (!text || !/^#/.test(text)) continue;
        // Strongest tint the family defines, over each surface it can sit on.
        const tintRaw = tokRaw[fam + '-soft-strong'] || tokRaw[fam + '-soft'];
        const tint = tintRaw && rgba(tintRaw);
        if (!tint) continue;
        for (const surf of ['card', 'background']) {
            if (!tokRaw[surf]) continue;
            const chip = compose(tint, tokRaw[surf]);
            const r = ratio(text, chip);
            checks++;
            const bad = r < 4.5;
            if (bad) failures++;
            if (bad || showAll) {
                lines.push(`  ${bad ? 'FAIL' : 'ok  '} ${r.toFixed(2).padStart(6)}  --${fam}-text on ${fam}-soft-strong over --${surf}`);
            }
        }
    }
    if (lines.length) {
        console.log(`\n=== ${themeName.toUpperCase()} — composited chips ===`);
        console.log(lines.join('\n'));
    }
}

console.log(`\n${checks} pairs checked, ${failures} failing.`);
process.exit(failures ? 1 : 0);

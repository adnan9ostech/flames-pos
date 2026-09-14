/*
 * One brand colour in, a readable palette out.
 *
 * WHY THE OWNER ONLY PICKS ONE. This theme's accents are used as text AND as
 * fills, in two themes, and the value that works in one place fails in
 * another: #F26513 measures 3.11:1 as text on white, which is illegible, while
 * a colour dark enough for white text is muddy on black. Asking somebody to
 * choose four hexes and hoping they contrast is how a white-labelled app ends
 * up unreadable at somebody else's counter.
 *
 * So the screen asks for the brand's colour, and this works out the rest:
 *
 *   dark theme   the colour, lightened if it is too dark to read on black
 *   light theme  the same hue, darkened until it clears AA as text on a card
 *   the label    white or near-black, whichever the fill can actually carry
 *
 * Plain functions, no imports: the server renders the palette into the page
 * and a test can check the ratios without a browser.
 */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const parseHex = (hex) => {
    const h = String(hex || '').trim().replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

export const toHex = ([r, g, b]) =>
    `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;

/* WCAG relative luminance, and the ratio between two colours. */
const lum = (rgb) => {
    const s = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};

export const contrast = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)];
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const WHITE = [255, 255, 255];
const NEAR_BLACK = [18, 16, 14];
// The two grounds the accent has to survive: the dark theme's page and the
// light theme's card.
const DARK_BG = [10, 10, 10];
const LIGHT_CARD = [255, 253, 249];

const mix = (rgb, towards, amount) => rgb.map((v, i) => v + (towards[i] - v) * amount);

/* Nudge a colour towards white or black until it clears `target` on `ground`. */
const until = (rgb, ground, target, towards) => {
    let out = rgb;
    for (let step = 0; step < 40; step += 1) {
        if (contrast(out, ground) >= target) return out;
        out = mix(out, towards, 0.05);
    }
    return out;
};

/*
 * The palette a brand colour implies.
 *
 * Targets, and why: 3:1 for the dark theme's accent because it carries button
 * and tab LABELS at semibold, which is the large-text bar; 4.5:1 for the light
 * theme because the same token is read as plain text on a card.
 */
export const paletteFor = (hex) => {
    const base = parseHex(hex);
    if (!base) return null;

    const dark = until(base, DARK_BG, 3, WHITE);
    const light = until(base, LIGHT_CARD, 4.5, NEAR_BLACK);

    /*
     * White first, and only near-black when white genuinely cannot be read.
     *
     * Picking whichever contrasts MORE would flip this restaurant's own
     * buttons from white-on-orange to black-on-orange: white measures 3.16:1
     * there and black 6.01, so the arithmetic prefers black while the owner
     * chose white on 3 Sep. 3:1 is the bar these labels actually have to clear
     * (semibold, button-sized, which is the large-text case), so white keeps
     * the job wherever it clears it and yields only on a pale fill.
     */
    const labelFor = (fill) => (contrast(WHITE, fill) >= 3 ? WHITE : NEAR_BLACK);

    return {
        dark: toHex(dark),
        // Hover is the same colour a shade further from the page, so it reads
        // as pressed rather than as a different colour.
        darkHover: toHex(mix(dark, NEAR_BLACK, 0.12)),
        darkForeground: toHex(labelFor(dark)),
        light: toHex(light),
        lightHover: toHex(mix(light, NEAR_BLACK, 0.15)),
        lightForeground: toHex(labelFor(light)),
        ratios: {
            darkOnBlack: Number(contrast(dark, DARK_BG).toFixed(2)),
            lightOnCard: Number(contrast(light, LIGHT_CARD).toFixed(2)),
            labelOnDark: Number(contrast(labelFor(dark), dark).toFixed(2)),
            labelOnLight: Number(contrast(labelFor(light), light).toFixed(2)),
        },
    };
};

/*
 * The palette as the handful of custom properties that actually differ, ready
 * to drop into a <style> tag. Everything else in globals.css is neutral and
 * stays as it is.
 */
export const brandCss = (hex) => {
    const p = paletteFor(hex);
    if (!p) return '';
    return `:root{--primary:${p.dark};--primary-hover:${p.darkHover};--primary-foreground:${p.darkForeground};`
        + `--accent:${p.dark};--accent-foreground:${p.darkForeground}}`
        + `:root[data-theme="light"]{--primary:${p.light};--primary-hover:${p.lightHover};`
        + `--primary-foreground:${p.lightForeground};--accent:${p.light};--accent-foreground:${p.lightForeground}}`;
};

/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./src/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    /*
     * Two hooks, because the app has two ways of being dark. `[data-theme="dark"]`
     * is the one the boot script writes — it always resolves "system" to a literal
     * light/dark before paint — and the bare `class` selector keeps `.dark` working
     * for anything that toggles a class instead. Neither is used by the pages below
     * any more (they read tokens that flip themselves), but a `dark:` variant now
     * means the same thing here as it does in globals.css.
     */
    darkMode: ['class', '[data-theme="dark"]'],
    theme: {
        extend: {
            colors: {
                /*
                 * Tailwind's stock `gray` is cool-toned — gray-900 is #111827,
                 * a visible blue against pure black. Remapped to the warm scale
                 * the public menu site uses.
                 *
                 * KEPT, BUT NO LONGER USED BY THE THREE TAILWIND PAGES. This ramp
                 * is dark-first and inverted from Tailwind convention — gray-900 is
                 * a BACKGROUND, gray-50/100 are TEXT — so every class built on it
                 * is a hardcoded dark theme that a light theme cannot reach. The
                 * semantic names below are what those pages read now; this stays
                 * only because it is a public scale and removing it is a different
                 * change. Do not reach for it in new work.
                 */
                gray: {
                    50: "#fffdf9",
                    100: "#f8f4ee",
                    200: "#e5ded6",
                    300: "#cfc7bf",
                    400: "#a39a92",
                    500: "#8a8179",   // AA on the near-black card; #756d65 was 3.86:1
                    600: "#6b635b",
                    700: "#332c27",
                    800: "#1a1613",
                    900: "#0d0b0a",
                    950: "#000000",
                },

                /*
                 * ===== Semantic tokens =====
                 *
                 * Every one of these is the SAME CSS variable the 45 CSS modules
                 * read, so the Tailwind pages and the module pages re-theme from
                 * one place — globals.css — rather than keeping two vocabularies
                 * that drift.
                 *
                 * No opacity modifiers on these. A `var(--x)` colour cannot be
                 * parsed into channels, so `bg-surface/70` silently loses its
                 * alpha in Tailwind 3. Where a wash is wanted, use the -soft /
                 * surface-raise / surface-sunken tokens, which carry their own
                 * alpha and are tuned per theme.
                 */

                /* Page ground. `page` is the readable name; `background` is kept
                   because it was already public. */
                page: "var(--background)",
                background: "var(--background)",

                /* Surfaces. DEFAULT is the card, and raise/sunken are the alpha
                   washes — they LIFT on dark and SINK on light, which is why a
                   copied rgba() literal is what makes a flipped theme look wrong. */
                surface: {
                    DEFAULT: "var(--card)",
                    elevated: "var(--card-elevated)",
                    translucent: "var(--surface-translucent)",
                    raise: "var(--surface-raise)",
                    "raise-strong": "var(--surface-raise-strong)",
                    sunken: "var(--surface-sunken)",
                    "sunken-strong": "var(--surface-sunken-strong)",
                    foreground: "var(--card-foreground)",
                },
                card: {
                    DEFAULT: "var(--card)",
                    elevated: "var(--card-elevated)",
                    foreground: "var(--card-foreground)",
                },

                /* Text. foreground is body copy, card-foreground the heading ink,
                   muted the tertiary tier and muted-foreground the secondary one —
                   matched across themes by contrast ratio, not by mirrored hex. */
                foreground: "var(--foreground)",
                muted: {
                    DEFAULT: "var(--muted)",
                    foreground: "var(--muted-foreground)",
                },

                border: "var(--border)",
                input: "var(--input)",
                overlay: "var(--overlay)",
                /* The app-wide focus treatment, for the pages that draw their own
                   ring instead of taking the :focus-visible outline. */
                focus: "var(--focus-ring)",

                // "You are here" — see --selected in globals.css: a solid slab
                // on dark, a brand wash on light.
                selected: {
                    DEFAULT: "var(--selected)",
                    foreground: "var(--selected-foreground)",
                    border: "var(--selected-border)",
                },
                primary: {
                    DEFAULT: "var(--primary)",
                    hover: "var(--primary-hover)",
                    /* Near-black on dark, white on light. White on the dark theme's
                       brand orange is 3.16:1 — this is why it is a token. */
                    foreground: "var(--primary-foreground)",
                    soft: "var(--primary-soft)",
                    "soft-strong": "var(--primary-soft-strong)",
                },
                accent: {
                    DEFAULT: "var(--accent)",
                    foreground: "var(--accent-foreground)",
                },

                /*
                 * Status families. -soft is the badge/banner fill, -border its
                 * edge, -text the label on it. The bare name is the solid colour
                 * (an icon, a swatch, a bar).
                 */
                success: {
                    DEFAULT: "var(--success)",
                    soft: "var(--success-soft)",
                    "soft-strong": "var(--success-soft-strong)",
                    border: "var(--success-border)",
                    text: "var(--success-text)",
                },
                destructive: {
                    DEFAULT: "var(--destructive)",
                    foreground: "var(--destructive-foreground)",
                },
                /* The red family's tints are named danger-* in globals.css, so
                   they keep that name here rather than inventing a synonym. */
                danger: {
                    DEFAULT: "var(--destructive)",
                    soft: "var(--danger-soft)",
                    "soft-strong": "var(--danger-soft-strong)",
                    border: "var(--danger-border)",
                    text: "var(--danger-text)",
                },
                warning: {
                    DEFAULT: "var(--accent)",
                    soft: "var(--warning-soft)",
                    "soft-strong": "var(--warning-soft-strong)",
                    border: "var(--warning-border)",
                    text: "var(--warning-text)",
                },
                info: {
                    DEFAULT: "var(--info)",
                    soft: "var(--info-soft)",
                    "soft-strong": "var(--info-soft-strong)",
                    border: "var(--info-border)",
                    text: "var(--info-text)",
                },
                neutral: {
                    soft: "var(--neutral-soft)",
                    text: "var(--neutral-text)",
                },

                /*
                 * Chart slots, for the few marks that are drawn as DOM rather than
                 * SVG — a legend swatch, a share bar. Same six validated slots the
                 * charts use, so a swatch and its series cannot disagree.
                 * `6-soft` is the wash under the violet slot's icon; it follows the
                 * --primary-soft pattern so it stays tied to the slot it tints.
                 */
                chart: {
                    1: "var(--chart-1)",
                    2: "var(--chart-2)",
                    3: "var(--chart-3)",
                    4: "var(--chart-4)",
                    5: "var(--chart-5)",
                    6: "var(--chart-6)",
                    "6-soft": "color-mix(in srgb, var(--chart-6) 15%, transparent)",
                    gain: "var(--chart-gain)",
                    loss: "var(--chart-loss)",
                    other: "var(--chart-other)",
                },
            },
        },
    },
    plugins: [],
};

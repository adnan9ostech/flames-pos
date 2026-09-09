/*
 * One chart palette for the whole reporting section.
 *
 * These were seven private copies of the same constants — SERIES, GRID, AXIS,
 * SURFACE, TOOLTIP_STYLE, SLOT, PALETTE — one per report page, each a literal
 * hex tied to the dark theme. A light theme cannot reach a hex compiled into a
 * JS bundle, so they move here and become var() references instead.
 *
 * WHY var() WORKS IN RECHARTS: these end up as SVG presentation attributes
 * (fill, stroke) or as React style objects, and both resolve CSS custom
 * properties. So the charts re-theme on the same repaint as everything else —
 * no subscription, no re-render, no flash.
 *
 * The six slots are validated, not chosen — see the note in globals.css. Assign
 * them in fixed order and never cycle: a 7th series folds into OTHER.
 */

/** Categorical series, in fixed order. */
export const SLOTS = [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
    'var(--chart-6)',
];

/*
 * The single-series colour. Slot 2 rather than brand orange, deliberately: when
 * data wears the brand colour it reads as chrome, and the eye stops treating it
 * as a measurement.
 */
export const SERIES = 'var(--chart-2)';

export const GRID = 'var(--chart-grid)';
export const AXIS_TEXT = 'var(--chart-axis)';
export const LABEL_TEXT = 'var(--chart-label)';
export const SURFACE = 'var(--chart-surface)';

/** Profit waterfall / variance. */
export const GAIN = 'var(--chart-gain)';
export const LOSS = 'var(--chart-loss)';

/** The "everything else" bucket beneath a top-10 cut. */
export const OTHER = 'var(--chart-other)';

/*
 * The band recharts paints under the hovered bar. A near-white wash reads as a
 * highlight on black and as nothing at all on white, so it is a token.
 */
export const CURSOR_FILL = { fill: 'var(--chart-cursor)' };

/* Recharts tooltip chrome. Objects, so they carry through as inline styles. */
export const TOOLTIP_STYLE = {
    background: 'var(--chart-tooltip-bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--chart-label)',
    boxShadow: 'var(--shadow-md)',
};

export const TOOLTIP_LABEL = { color: 'var(--chart-axis)' };
export const TOOLTIP_ITEM = { color: 'var(--chart-label)' };

/** Axis tick props — recharts spreads these onto its <text>. */
export const AXIS_TICK = { fill: 'var(--chart-axis)' };
export const LABEL_TICK = { fill: 'var(--chart-label)' };

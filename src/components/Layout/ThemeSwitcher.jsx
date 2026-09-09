'use client';
import { useCallback, useRef } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { THEMES, THEME_LABELS } from '@/lib/theme.mjs';
import styles from './ThemeSwitcher.module.css';

const ICONS = { light: Sun, dark: Moon, system: Monitor };

/*
 * The theme control, in two shapes off one implementation so the sidebar and
 * the Profile screen can never drift apart.
 *
 *   variant="full"    labelled segments + a line saying what System resolves to
 *   variant="compact" icon-only, for the sidebar rail
 *
 * A real radiogroup rather than three buttons: a segmented control IS a
 * single-choice control, and screen readers should announce it as "2 of 3"
 * rather than as three unrelated toggles. That brings roving tabindex with it —
 * one tab stop for the group, arrow keys to move within it, which is also just
 * faster on a touchscreen till.
 */
export default function ThemeSwitcher({ variant = 'full', collapsed = false }) {
    const { pref, resolved, setPref } = useTheme();
    const refs = useRef({});

    const onKeyDown = useCallback((event) => {
        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
        const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
        if (!forward && !back) return;
        event.preventDefault();
        const at = THEMES.indexOf(pref);
        // Wraps, so the group has no dead ends at either edge.
        const next = THEMES[(at + (forward ? 1 : THEMES.length - 1)) % THEMES.length];
        setPref(next);
        refs.current[next]?.focus();
    }, [pref, setPref]);

    /*
     * Collapsed rail: there is no room for three targets and no popup layer in
     * the sidebar, so it becomes one button that advances through the options.
     * The title carries both the current state and what a click will do —
     * without it this is an unlabelled icon that changes meaning.
     */
    if (variant === 'compact' && collapsed) {
        const at = THEMES.indexOf(pref);
        const next = THEMES[(at + 1) % THEMES.length];
        const Icon = ICONS[pref];
        return (
            <button
                type="button"
                className={styles.cycle}
                onClick={() => setPref(next)}
                title={`Theme: ${THEME_LABELS[pref]}${pref === 'system' ? ` (${THEME_LABELS[resolved]})` : ''} — switch to ${THEME_LABELS[next]}`}
                aria-label={`Theme: ${THEME_LABELS[pref]}. Switch to ${THEME_LABELS[next]}.`}
            >
                <Icon size={20} aria-hidden="true" />
            </button>
        );
    }

    const compact = variant === 'compact';

    return (
        <div className={compact ? styles.compactWrap : styles.wrap}>
            <div
                className={`${styles.group} ${compact ? styles.groupCompact : ''}`}
                role="radiogroup"
                aria-label="Colour theme"
                onKeyDown={onKeyDown}
            >
                {THEMES.map((option) => {
                    const Icon = ICONS[option];
                    const active = pref === option;
                    return (
                        <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            /* Roving tabindex: the group is one tab stop. */
                            tabIndex={active ? 0 : -1}
                            ref={(node) => { refs.current[option] = node; }}
                            className={`${styles.option} ${active ? styles.active : ''}`}
                            onClick={() => setPref(option)}
                            title={compact ? THEME_LABELS[option] : undefined}
                        >
                            <Icon size={compact ? 16 : 17} aria-hidden="true" />
                            {!compact && <span>{THEME_LABELS[option]}</span>}
                        </button>
                    );
                })}
            </div>

            {/*
              * Only meaningful under System, where the chosen option and what is
              * actually on screen are different facts. aria-live so a screen
              * reader hears the OS flip the theme underneath it.
              */}
            {!compact && pref === 'system' && (
                <p className={styles.hint} aria-live="polite">
                    Following your device, currently <strong>{THEME_LABELS[resolved].toLowerCase()}</strong>.
                </p>
            )}
        </div>
    );
}

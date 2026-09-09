/*
 * Theme resolution, and the two places its constants are DUPLICATED by
 * necessity.
 *
 * The resolve rules are trivial enough that testing them is nearly a formality.
 * The tests that earn their keep are the last two: the anti-flash boot script
 * and the offline page each carry their own inlined copy of the storage key,
 * because neither can import a module — one runs before the bundle exists, the
 * other is a static file served when the app cannot load at all. If either copy
 * drifts from src/lib/theme.mjs, nothing throws. A till just quietly forgets its
 * theme on every reload, or drops to a black screen at the exact moment the
 * network has already failed.
 *
 * No database: same reasoning as navsearch.test.mjs — pure logic lives here
 * because CLAUDE.md's one test command globs this directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    THEMES, STORAGE_KEY, DEFAULT_THEME, DARK_QUERY,
    isTheme, normalize, resolveTheme, THEME_BOOT_SCRIPT, THEME_LABELS,
} from '../../src/lib/theme.mjs';

test('1. the three options, and dark is the default', () => {
    assert.deepEqual(THEMES, ['light', 'dark', 'system']);
    // Every till in service is dark. Shipping a different default would change
    // the appliance under staff who never asked for it.
    assert.equal(DEFAULT_THEME, 'dark');
    for (const t of THEMES) assert.ok(THEME_LABELS[t], `${t} needs a label`);
});

test('2. an explicit choice ignores the OS; system follows it', () => {
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('light', false), 'light');
    assert.equal(resolveTheme('dark', true), 'dark');
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
});

test('3. resolution always yields a literal theme, never "system"', () => {
    // CSS has no [data-theme="system"] block on purpose, so anything that
    // reaches the DOM must already be light or dark.
    for (const pref of [...THEMES, 'nonsense', null, undefined]) {
        for (const os of [true, false]) {
            assert.ok(['light', 'dark'].includes(resolveTheme(pref, os)));
        }
    }
});

test('4. a tampered or missing preference falls back rather than breaking', () => {
    // localStorage is user-writable; a junk value must not leave the app unstyled.
    for (const junk of ['purple', '', null, undefined, '__proto__', 0, {}]) {
        assert.equal(normalize(junk), DEFAULT_THEME);
        assert.equal(isTheme(junk), false);
    }
    for (const t of THEMES) assert.equal(normalize(t), t);
});

test('5. the boot script agrees with the module it cannot import', () => {
    // It runs before the bundle exists, so it restates these by hand.
    assert.ok(THEME_BOOT_SCRIPT.includes(JSON.stringify(STORAGE_KEY)),
        'boot script must read the same localStorage key');
    assert.ok(THEME_BOOT_SCRIPT.includes(JSON.stringify(DARK_QUERY)),
        'boot script must use the same media query');
    assert.ok(THEME_BOOT_SCRIPT.includes(JSON.stringify(DEFAULT_THEME)),
        'boot script must fall back to the same default');
    assert.ok(THEME_BOOT_SCRIPT.includes('try'),
        'localStorage throws (not returns null) in some privacy modes');
    assert.ok(THEME_BOOT_SCRIPT.includes('data-theme'),
        'boot script must stamp the attribute the CSS keys off');
});

test('6. the offline page carries the same theme contract', () => {
    // public/offline.html is served by the service worker when the app cannot
    // load. It is a static file: it cannot import theme.mjs, so it inlines a
    // copy. This is the test that catches that copy going stale.
    const html = readFileSync(new URL('../../public/offline.html', import.meta.url), 'utf8');

    assert.ok(html.includes(STORAGE_KEY),
        `offline.html must read "${STORAGE_KEY}" — a drifted key means the offline screen ignores the theme`);
    assert.ok(html.includes(DARK_QUERY),
        'offline.html must honour the same prefers-color-scheme query');
    assert.ok(html.includes('data-theme="light"'),
        'offline.html needs a light palette, or a light-themed till goes black when it drops offline');
    assert.ok(html.indexOf('<script') < html.indexOf('<style'),
        'the theme must be stamped before the styles are parsed, or the page flashes');
});

test('7. globals.css defines a light block for every themed token', () => {
    // A token declared only in :root silently keeps its DARK value in light
    // mode — the single most likely way this system rots as screens get added.
    const css = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8');
    const names = (block) => new Set(
        [...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );

    const rootAt = css.indexOf(':root {');
    const lightAt = css.indexOf(':root[data-theme="light"] {');
    assert.ok(rootAt !== -1 && lightAt !== -1, 'both theme blocks must exist');

    const dark = names(css.slice(rootAt, css.indexOf('\n}', rootAt)));
    const light = names(css.slice(lightAt, css.indexOf('\n}', lightAt)));

    // Tokens that are deliberately theme-independent.
    const SHARED = new Set([
        'radius', 'header-height', 'sidebar-width',
        'focus-ring-width', 'focus-ring-offset',
        // Same hue in both themes on purpose: a series must keep its colour
        // when someone flips the theme. Only chart-4 (amber) is re-stepped.
        'chart-1', 'chart-2', 'chart-3', 'chart-5', 'chart-6',
        'chart-gain', 'chart-loss',
        // Derived with color-mix from a token that IS themed, so they follow
        // the theme without needing their own light value.
        'primary-soft', 'primary-soft-strong', 'surface-translucent',
        'disabled-opacity',
    ]);

    const missing = [...dark].filter((n) => !light.has(n) && !SHARED.has(n));
    assert.deepEqual(missing, [],
        `these tokens keep their dark value in light mode: ${missing.join(', ')}`);
});

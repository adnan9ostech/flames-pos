/*
 * Theme preference — the single source of truth for what the app is wearing.
 *
 * Three preferences, two outcomes: 'light' and 'dark' pin a theme, 'system'
 * defers to the OS. CSS only ever sees a RESOLVED value on <html data-theme>,
 * never the word "system" — so no stylesheet needs a prefers-color-scheme
 * query and the resolution rule lives in exactly one place.
 *
 * Plain .mjs with no imports so the boot script, the provider and any test can
 * all read the same constants. If the key or the default ever drifted between
 * the inline script and the React store, the app would flash on every load —
 * which is the whole bug this file exists to prevent.
 */

export const THEMES = ['light', 'dark', 'system'];

/* Matches the existing fbi.sidebarCollapsed convention in AppLayout. */
export const STORAGE_KEY = 'fbi.theme';

/*
 * Dark, not system. Every till in service today is dark, and shipping a
 * different default would change the appliance under staff mid-shift without
 * anyone asking for it. Opting in is a decision; opting out shouldn't be.
 */
export const DEFAULT_THEME = 'dark';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/*
 * Browser-chrome colour per RESOLVED theme — the address bar and the installed
 * PWA status bar. These MUST be driven by the resolved theme, not by a
 * prefers-color-scheme media query: the app paints from the stored preference,
 * so a 'light' pref on a dark-OS device would otherwise show a black chrome
 * band above a cream page. Values are each theme's --background.
 */
export const THEME_COLORS = { light: '#f6f2ec', dark: '#000000' };

export function isTheme(value) {
    return THEMES.includes(value);
}

/** A stored preference, or the default if it's missing or has been tampered with. */
export function normalize(value) {
    return isTheme(value) ? value : DEFAULT_THEME;
}

/** pref + what the OS currently says -> the literal theme to paint. */
export function resolveTheme(pref, systemPrefersDark) {
    if (pref === 'light') return 'light';
    if (pref === 'dark') return 'dark';
    return systemPrefersDark ? 'dark' : 'light';
}

export const THEME_LABELS = {
    light: 'Light',
    dark: 'Dark',
    system: 'System',
};

/*
 * Runs BEFORE first paint, injected into <body> by layout.js. Without it every
 * load paints the default theme and then corrects itself once React hydrates —
 * a white flash on a dark till, which on a kitchen screen at night is genuinely
 * unpleasant.
 *
 * Kept as a string next to the constants it uses so the two can't disagree.
 * Wrapped in try/catch because localStorage THROWS (not returns null) in some
 * privacy modes, and an exception here would leave the page unstyled.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var p=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
if(p!=="light"&&p!=="dark"&&p!=="system")p=${JSON.stringify(DEFAULT_THEME)};
var t=p==="system"?(window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light"):p;
document.documentElement.setAttribute("data-theme",t);
var m=document.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",t==="dark"?${JSON.stringify(THEME_COLORS.dark)}:${JSON.stringify(THEME_COLORS.light)});
}catch(e){document.documentElement.setAttribute("data-theme",${JSON.stringify(DEFAULT_THEME)});}})();`;

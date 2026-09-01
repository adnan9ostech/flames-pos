/*
 * Ranking for the nav search palette.
 *
 * The shape of the problem: a very small corpus (about thirty screens) that a
 * person types into while looking at it, on a touchscreen, mid-service. That
 * makes latency a non-issue and makes the ORDER of the first three results
 * everything — nobody scrolls a command palette. So this scores rather than
 * filters, and the scoring is deliberately blunt: an exact label beats a label
 * prefix beats a word start beats a keyword beats a scattered subsequence.
 *
 * Every token in the query must match something (AND, not OR), because "day
 * sales" meaning "anything with day OR sales" would bury Daily Food Sales under
 * Day Close and the four other reports with "sales" in them.
 */

const norm = (s) => (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents so "cafe" finds "café"
    .replace(/[^a-z0-9\s]/g, ' ')    // & - / punctuation are noise here
    .replace(/\s+/g, ' ')
    .trim();

/*
 * Is `q` spread through `text` in order? "gp" finds "Gross Profit", "ivrec"
 * finds "Inventory Receiving". Returns the span it used, so a tight match can
 * outrank a match scattered across the whole string.
 */
const subsequence = (text, q) => {
    let i = 0, start = -1;
    for (let j = 0; j < text.length && i < q.length; j += 1) {
        if (text[j] === q[i]) {
            if (i === 0) start = j;
            i += 1;
            if (i === q.length) return { start, end: j };
        }
    }
    return null;
};

/* Where a token sits in a string, and how good that position is. */
const scoreField = (field, token) => {
    if (!field) return 0;
    if (field === token) return 1000;
    if (field.startsWith(token)) return 880;
    // A word start: "sale" in "daily food sales"
    if (new RegExp(`(^| )${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(field)) return 760;
    if (field.includes(token)) return 620;
    const sub = subsequence(field, token);
    if (sub) {
        // Tighter spans are better: "grpr" over "Gross Profit" beats a match
        // that wandered the length of a keyword blob.
        const span = sub.end - sub.start + 1;
        return Math.max(180, 420 - (span - token.length) * 12);
    }
    return 0;
};

/*
 * Score one entry against one token. The label is what the person is looking
 * at, so it dominates; keywords are the vocabulary bridge and are worth less
 * than a real label hit; the section is a weak tiebreak so typing "report"
 * still surfaces the whole group.
 */
const scoreEntry = (entry, token) => {
    const label = scoreField(norm(entry.label), token);
    if (label) return label * 1.0;
    const keywords = scoreField(norm(entry.keywords), token);
    if (keywords) return keywords * 0.62;
    const section = scoreField(norm(entry.section), token);
    if (section) return section * 0.34;
    // The path itself, so someone who knows the URL can type it.
    const href = scoreField(norm(entry.href), token);
    if (href) return href * 0.30;
    return 0;
};

/*
 * The highlight range on the label, if the query hit the label at all. Only
 * contiguous matches are highlighted — underlining four scattered letters of
 * "Inventory Receiving" reads as damage, not as help.
 */
export const labelMatch = (label, query) => {
    const q = norm(query);
    if (!q) return null;
    const l = norm(label);
    // norm() can only collapse runs of punctuation/space, and labels here have
    // no accents, so indices line up with the original well enough to slice.
    const at = l.indexOf(q);
    if (at === -1 || l.length !== label.length) return null;
    return { start: at, end: at + q.length };
};

/*
 * Rank the index against a query. An empty query returns nothing — the palette
 * shows recents and defaults instead, which is a different job.
 */
export const searchNav = (entries, query, { limit = 12 } = {}) => {
    const q = norm(query);
    if (!q) return [];
    const tokens = q.split(' ').filter(Boolean);

    const scored = entries
        .map((entry) => {
            let total = 0;
            for (const token of tokens) {
                const s = scoreEntry(entry, token);
                if (s === 0) return null;   // every token must land somewhere
                total += s;
            }
            // Prefer the shorter of two otherwise-equal labels: "Reports"
            // should sit above "Inventory Reports" when someone types "report".
            return { entry, score: total - entry.label.length * 0.5 };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));

    if (scored.length === 0) return [];

    /*
     * Cut the weak tail. A short query like "grpr" subsequence-matches half the
     * app — Gross Profit genuinely, then Profile, Menu Analytics and Recipes by
     * coincidence. Showing those makes the real answer look like one guess
     * among eight. Anything scoring under 40% of the best match is noise, and a
     * palette that offers five results is more trustworthy than one that offers
     * every result it can technically justify.
     */
    const floor = scored[0].score * 0.4;
    return scored.filter((r) => r.score >= floor).slice(0, limit).map((r) => r.entry);
};

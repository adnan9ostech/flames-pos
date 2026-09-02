/*
 * Ranking for the nav search palette.
 *
 * The shape of the problem: a small corpus (fifty-odd screens) that a person
 * types into while looking at it, on a touchscreen, mid-service. Latency is a
 * non-issue; the ORDER of the first three results is everything, because
 * nobody scrolls a command palette. So this scores rather than filters, and
 * the scoring is deliberately blunt: an exact label beats a label prefix beats
 * a word start beats a keyword beats a scattered subsequence.
 *
 * Three rules that came out of watching it fail on a bigger index:
 *
 *  - A field's score is the BEST of the ways it matched, and an entry's score
 *    is the best across its fields. The first version returned the label's
 *    score whenever the label matched at all, so a weak three-letter
 *    subsequence in "Companies" beat the word "coa" sitting in Chart of
 *    Accounts' keywords.
 *  - Subsequence matching is for the LABEL only. Keyword blobs are long, so
 *    almost any short query threads through one somewhere; that is how
 *    "grpr" once offered eight results. Keywords are vocabulary — whole
 *    words — and match as words.
 *  - Initials are a first-class match. "tb", "coa", "gp", "kds": people who
 *    live in these screens abbreviate them, and an acronym hit outranks any
 *    fuzzy one.
 *
 * Every token in the query must match something (AND, not OR), because "day
 * sales" meaning "anything with day OR sales" would bury Daily Food Sales under
 * Day Close and the four other reports with "sales" in them.
 */

const norm = (s) => (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents so "cafe" finds "café"
    // "p&l" is one word, not the two single letters "p" and "l" that would
    // match half the app; "Waiters & Tables" keeps its space.
    .replace(/(?<=[a-z0-9])&(?=[a-z0-9])/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')    // remaining punctuation is noise here
    .replace(/\s+/g, ' ')
    .trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Initials of the label's words: "Chart of Accounts" -> "coa". */
const acronymOf = (label) => norm(label).split(' ').filter(Boolean).map((w) => w[0]).join('');

/*
 * Is `q` spread through `text` in order? "grpr" finds "Gross Profit". Returns
 * the span it used, so a tight match can outrank one scattered across the
 * whole string.
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

/* How well a token sits in a field, by whole-word placement only. */
const wordScore = (field, token) => {
    if (!field) return 0;
    if (field === token) return 1000;
    if (field.startsWith(token)) return 880;
    const t = escapeRe(token);
    if (new RegExp(`(^| )${t}( |$)`).test(field)) return 800;   // a whole word
    if (new RegExp(`(^| )${t}`).test(field)) return 700;        // starts a word
    // Buried mid-word ("pl" inside "suppliers"): weak, and weaker the shorter
    // the token, so two letters never outrank a curated keyword.
    if (field.includes(token)) return Math.min(600, 400 + token.length * 40);
    return 0;
};

/* The label also accepts a subsequence, scored by how tightly it landed. */
const labelScore = (label, token) => {
    const words = wordScore(label, token);
    if (words) return words;
    const sub = subsequence(label, token);
    if (!sub) return 0;
    const span = sub.end - sub.start + 1;
    return Math.max(120, 300 - (span - token.length) * 15);
};

const acronymScore = (acronym, token) => {
    if (!acronym || token.length < 2) return 0;
    if (acronym === token) return 900;
    if (acronym.startsWith(token)) return 720;
    return 0;
};

/*
 * One entry against one token: the best of its fields, each weighted by how
 * much a hit there says about intent. The label is what the person is looking
 * at, so it dominates; the acronym is the label in shorthand; keywords are the
 * vocabulary bridge; the section and the path are weak tiebreaks.
 */
const scoreEntry = (entry, token) => Math.max(
    labelScore(norm(entry.label), token),
    acronymScore(acronymOf(entry.label), token),
    wordScore(norm(entry.keywords), token) * 0.70,
    wordScore(norm(entry.section), token) * 0.34,
    wordScore(norm(entry.href), token) * 0.30,
);

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
     * Cut the weak tail. Anything scoring under 40% of the best match is
     * noise, and a palette that offers three results is more trustworthy than
     * one that offers everything it can technically justify.
     */
    const floor = scored[0].score * 0.4;
    return scored.filter((r) => r.score >= floor).slice(0, limit).map((r) => r.entry);
};

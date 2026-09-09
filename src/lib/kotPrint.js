/*
 * Kitchen Order Ticket printing — the round just sent, cut into slips and
 * pushed through the single thermal printer one at a time. A kitchen slip
 * never shows a price.
 *
 * TWO WAYS TO CUT A ROUND, chosen by store_settings.kot_mode:
 *
 *   'category'  groupRoundByCategory — one slip per SECTION present in the
 *               round (v1: station = category). Four sections means four cuts,
 *               each carrying that section's whole list.
 *   'item'      groupRoundByItem — one slip per LINE, so a ticket travels with
 *               the dish it names and can be spiked against it. This is the
 *               default: it is what the owner asked for. It is also far more
 *               paper — a 12-line order prints 12 tickets against maybe 4.
 *
 * Both produce the SAME slip shape, so KotSlips.jsx renders either without
 * knowing which mode is on. Call buildKotSlips(mode, …) rather than picking a
 * grouper by hand, so the till and the KDS reprint can never disagree about
 * what a mode means.
 *
 * ===== Integration contract (for src/app/pos/page.js) =====
 *
 * The page owns one piece of state and mounts one hidden component:
 *
 *   const [kotJob, setKotJob] = useState(null);
 *   ...
 *   <KotSlips job={kotJob} />        // src/components/POS/KotSlips.jsx
 *
 * After a round is ACCEPTED by the server (createOrder / appendRoundToOrder
 * resolved — never before, or the kitchen cooks food that was never stored),
 * and with the round's items captured BEFORE the cart is cleared:
 *
 *   const sentItems = cart;                       // snapshot; clearing the
 *                                                 // cart mid-queue is then safe
 *   const slips = buildKotSlips(kotMode, sentItems, menuData.items, menuData.categories);
 *   const meta = {
 *       orderNumber: getOrderNumber(saved),       // human order number
 *       table: saved.table_number,                // null off the floor
 *       waiter: saved.waiter_name,
 *       orderType: saved.order_type,              // 'dine-in' | 'takeaway' | 'delivery'
 *       roundNo,                                  // 1 for a new order
 *       at: new Date(),                           // fire time stamped on every slip
 *       reprint: false,                           // true only off the KDS
 *   };
 *   await runPrintQueue(slips, (slip) => {
 *       // flushSync, not a queued set: printKotSlip() reads the DOM on the
 *       // next line, and a queued render would print the previous slip.
 *       flushSync(() => setKotJob({ slip, meta }));
 *       printKotSlip();
 *   });
 *   flushSync(() => setKotJob(null));
 *   printIfEnabled();                             // customer receipt LAST
 *
 * The unmount (job = null) must happen before the receipt prints: while
 * #kot-print-root is in the DOM its print CSS owns the paper — deliberately,
 * so slips print clean even while the receipt modal is open (Send & Pay Now) —
 * and a receipt printed under it would come out blank. On a tab round
 * (handleSendRound) there is no receipt; the queue is the whole job.
 *
 * The seam is component-state + runPrintQueue rather than a renderSlip
 * callback so React keeps ownership of the DOM — this module only measures
 * and prints what the page has already rendered, exactly as printReceipt.js
 * does for the receipt.
 *
 * src/app/kds/page.js reuses the same three pieces (buildKotSlips →
 * runPrintQueue → printKotSlip) to reprint a stored order, with
 * meta.reprint = true so the paper says so and nothing is cooked twice.
 */

// Lines whose dish or category no longer resolves still have to reach the
// kitchen; they land on one catch-all slip under this name.
const FALLBACK_CATEGORY = 'Kitchen';

/*
 * The modes store_settings.kot_mode accepts. Anything else — an older row, a
 * hand-edited column, a database that has never heard of the setting — reads
 * as the default rather than printing nothing.
 */
export const KOT_MODES = ['category', 'item'];
export const DEFAULT_KOT_MODE = 'item';

export const normalizeKotMode = (mode) =>
    KOT_MODES.includes(mode) ? mode : DEFAULT_KOT_MODE;

// The one place a mode name turns into slips. Both callers (the till at send
// time, the KDS on a reprint) go through here.
export const buildKotSlips = (mode, roundItems, menuItems, categories) =>
    normalizeKotMode(mode) === 'category'
        ? groupRoundByCategory(roundItems, menuItems, categories)
        : groupRoundByItem(roundItems, menuItems, categories);

// Menu lookups both groupers need, built once per call rather than per line.
const indexMenu = (menuItems, categories) => ({
    dishById: new Map((menuItems || []).map((mi) => [String(mi.id), mi])),
    catById: new Map((categories || []).map((c) => [String(c.id), c])),
});

// The station a line belongs to, or null for the catch-all. Category resolves
// menu_item id → menu_items.category_id → categories; the direct category_id a
// cart line carries (the cart spreads the menu item) covers a dish deleted
// between ringing and printing.
const stationFor = (line, dishById, catById) => {
    const dish = dishById.get(String(line.id ?? line.menu_item_id ?? ''));
    const catId = dish?.category_id ?? line.category_id ?? null;
    return (catId != null ? catById.get(String(catId)) : null) || null;
};

// Infinity, so the catch-all always prints after the real stations regardless
// of how sort_order is numbered.
const sortOrderOf = (cat) => (cat ? (cat.sort_order ?? Number.MAX_SAFE_INTEGER) : Infinity);

/*
 * Station order, then name, then the order it was rung in. The identity guard
 * is not decoration: two catch-all slips both sort at Infinity, and
 * Infinity - Infinity is NaN — which sort() reads as "equal" only by accident,
 * and which would silently swallow the tie-breakers behind it.
 */
const byStation = (a, b) =>
    (a.sortOrder === b.sortOrder ? 0 : a.sortOrder - b.sortOrder)
    || a.categoryName.localeCompare(b.categoryName)
    || (a.seq - b.seq);

// Drops the sort keys, leaving the slip the renderer consumes.
const toSlip = ({ sortOrder, seq, ...slip }) => slip;

// One slip per category present in the round, ordered by the menu's category
// sort_order (fallback group last).
// Returns [{categoryId, categoryName, items: [{qty, name, variant, modifiers, notes}]}].
export const groupRoundByCategory = (roundItems, menuItems, categories) => {
    const { dishById, catById } = indexMenu(menuItems, categories);

    const groups = new Map();
    for (const [seq, line] of (roundItems || []).entries()) {
        const cat = stationFor(line, dishById, catById);
        const key = cat ? String(cat.id) : FALLBACK_CATEGORY;
        let group = groups.get(key);
        if (!group) {
            group = {
                categoryId: cat ? cat.id : null,
                categoryName: cat ? cat.name : FALLBACK_CATEGORY,
                sortOrder: sortOrderOf(cat),
                seq,
                items: [],
            };
            groups.set(key, group);
        }
        group.items.push(toSlipLine(line));
    }

    return [...groups.values()].sort(byStation).map(toSlip);
};

/*
 * One slip per LINE — the shape the owner asked for, so a ticket can travel
 * with its dish.
 *
 * A line of qty 3 is ONE ticket reading "3×", not three tickets. Three
 * identical karahis are one pan of work and one line on the bill, so three
 * identical scraps of paper would tell the section nothing the one ticket does
 * not, could not be told apart if two came back, and would treble the paper on
 * exactly the orders that are already the longest. If a kitchen ever needs a
 * ticket per plate, that is a third mode, not a reinterpretation of this one.
 *
 * Ordered by station, then by the order the lines were rung in, so the queue
 * hands the runner a contiguous stack per section rather than making them sort
 * a shuffled pile — the same ordering category mode prints in.
 * Returns the same slip shape as groupRoundByCategory, one item long.
 */
export const groupRoundByItem = (roundItems, menuItems, categories) => {
    const { dishById, catById } = indexMenu(menuItems, categories);

    return (roundItems || [])
        .map((line, seq) => {
            const cat = stationFor(line, dishById, catById);
            return {
                categoryId: cat ? cat.id : null,
                // Every ticket names its own station: with one dish per slip
                // this line is the only thing telling the runner where it goes.
                categoryName: cat ? cat.name : FALLBACK_CATEGORY,
                sortOrder: sortOrderOf(cat),
                seq,
                items: [toSlipLine(line)],
            };
        })
        .sort(byStation)
        .map(toSlip);
};

// Accepts both a till cart line ({selectedVariant, selectedModifiers}) and a
// stored order line ({variant, modifiers}) — the KDS reprint feeds it the
// stored snapshot, which carries selectedVariant as {name} and modifiers under
// selectedModifiers, and both spellings are read here.
const toSlipLine = (line) => {
    const variant = line.selectedVariant?.name ?? line.variant ?? null;

    // The cart bakes the variant into the display name — "Chicken Karahi
    // (Full)". The slip gives the variant its own line, so the suffix comes off
    // rather than printing twice.
    let name = String(line.name ?? '').trim();
    if (variant && name.endsWith(`(${variant})`)) {
        name = name.slice(0, name.length - variant.length - 2).trim();
    }

    return {
        qty: Number(line.qty) || 1,
        name,
        variant,
        modifiers: flattenModifiers(line.selectedModifiers ?? line.modifiers),
        notes: line.notes ? String(line.notes).trim() : null,
    };
};

// {modifierId: [{name, price}, ...]} → "Spicy, Raita". flat() tolerates a
// single-select modifier stored as a bare object rather than an array.
const flattenModifiers = (mods) => {
    if (!mods || typeof mods !== 'object') return null;
    const names = Object.values(mods)
        .flat()
        .map((m) => (typeof m === 'string' ? m : m?.name))
        .filter(Boolean);
    return names.length ? names.join(', ') : null;
};

/*
 * Prints the slip currently mounted at #kot-print-root. Same measured-@page
 * technique as printReceipt.js — see the comment there for why the height must
 * be computed rather than declared (`80mm auto` is invalid CSS and Chrome
 * silently paginates US Letter). The slip is hidden off-screen by position,
 * not display:none, precisely so scrollHeight here measures the real content.
 */

const STYLE_ID = 'kot-page-size';

// CSS reference pixels are 96 per inch by definition, regardless of the display.
const PX_PER_MM = 96 / 25.4;

const SLIP_WIDTH_MM = 80;

// Slack past the content so the auto-cut doesn't clip the last line, and a
// floor so an unmeasurable slip still prints something sane.
const TAIL_MM = 6;
const FALLBACK_HEIGHT_MM = 297;

export const printKotSlip = () => {
    if (typeof window === 'undefined') return;

    try {
        const root = document.getElementById('kot-print-root');

        const heightMm = root?.scrollHeight
            ? Math.ceil(root.scrollHeight / PX_PER_MM) + TAIL_MM
            : FALLBACK_HEIGHT_MM;

        let style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            document.head.appendChild(style);
        }
        style.textContent = `@page { size: ${SLIP_WIDTH_MM}mm ${heightMm}mm; margin: 0; }`;

        window.print();

        // Removed once the job is spooled, for the same reason printReceipt.js
        // removes its rule: a leftover @page would shape every later print in
        // the SPA, the Reports PDF included.
        style.remove();
    } catch (error) {
        // The round is already stored by the time this runs; a print failure
        // must never surface as a failed order.
        console.error('Could not print KOT slip', error);
    }
};

/*
 * Drives the jobs through the one printer, strictly one at a time:
 * render+print (printOne) → wait for afterprint → next. The timeout is a
 * fallback for a build that never fires the event — mid-service the queue must
 * keep moving, not hang on one slip.
 */

const AFTERPRINT_TIMEOUT_MS = 2000;

export const runPrintQueue = async (jobs, printOne) => {
    if (typeof window === 'undefined') return;

    for (const job of jobs || []) {
        await new Promise((resolve) => {
            // The listener goes on BEFORE the print fires: Chrome dispatches
            // afterprint while window.print() is still on the stack, so a
            // listener attached afterwards has already missed it and every
            // slip would sit out the full timeout.
            let timer;
            const done = () => {
                window.removeEventListener('afterprint', done);
                clearTimeout(timer);
                resolve();
            };
            timer = setTimeout(done, AFTERPRINT_TIMEOUT_MS);
            window.addEventListener('afterprint', done);

            Promise.resolve()
                .then(() => printOne(job))
                .catch((error) => {
                    // One slip failing must not strand the ones behind it.
                    console.error('KOT slip failed to print', error);
                    done();
                });
        });
    }
};

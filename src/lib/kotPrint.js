/*
 * Kitchen Order Ticket printing — one slip per category present in a round,
 * printed sequentially on the single thermal printer. v1 station = category:
 * four categories in a round means four cuts in a row, handed to sections by a
 * runner. A kitchen slip never shows a price.
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
 *   const slips = groupRoundByCategory(sentItems, menuData.items, menuData.categories);
 *   const meta = {
 *       orderNumber: getOrderNumber(saved),       // human order number
 *       table: saved.table_number,                // null off the floor
 *       waiter: saved.waiter_name,
 *       orderType: saved.order_type,              // 'dine-in' | 'takeaway' | 'delivery'
 *       roundNo,                                  // 1 for a new order
 *       at: new Date(),                           // fire time stamped on every slip
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
 */

// Lines whose dish or category no longer resolves still have to reach the
// kitchen; they land on one catch-all slip under this name.
const FALLBACK_CATEGORY = 'Kitchen';

// Groups a round's items into slips, one per category, ordered by the menu's
// category sort_order (fallback group last). Category resolves menu_item id →
// menu_items.category_id → categories; the direct category_id a cart line
// carries (the cart spreads the menu item) covers a dish deleted between
// ringing and printing.
// Returns [{categoryId, categoryName, items: [{qty, name, variant, modifiers, notes}]}].
export const groupRoundByCategory = (roundItems, menuItems, categories) => {
    const dishById = new Map((menuItems || []).map((mi) => [String(mi.id), mi]));
    const catById = new Map((categories || []).map((c) => [String(c.id), c]));

    const groups = new Map();
    for (const line of roundItems || []) {
        const dish = dishById.get(String(line.id ?? line.menu_item_id ?? ''));
        const catId = dish?.category_id ?? line.category_id ?? null;
        const cat = catId != null ? catById.get(String(catId)) : null;

        const key = cat ? String(cat.id) : FALLBACK_CATEGORY;
        let group = groups.get(key);
        if (!group) {
            group = {
                categoryId: cat ? cat.id : null,
                categoryName: cat ? cat.name : FALLBACK_CATEGORY,
                // Infinity, so the catch-all slip always prints after the real
                // stations regardless of how sort_order is numbered.
                sortOrder: cat ? (cat.sort_order ?? Number.MAX_SAFE_INTEGER) : Infinity,
                items: [],
            };
            groups.set(key, group);
        }
        group.items.push(toSlipLine(line));
    }

    return [...groups.values()]
        .sort((a, b) => (a.sortOrder - b.sortOrder) || a.categoryName.localeCompare(b.categoryName))
        .map(({ sortOrder, ...slip }) => slip);
};

// Accepts both a till cart line ({selectedVariant, selectedModifiers}) and a
// stored order line ({variant, modifiers}) so a reprint from an order row can
// reuse the same path later.
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

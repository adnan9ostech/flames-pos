/*
 * Sends the receipt currently on screen to the printer.
 *
 * The page height is computed and injected rather than declared, because the
 * obvious CSS for a receipt roll does not work:
 *
 *   @page { size: 80mm auto }   -> Chrome ignores the whole declaration and
 *                                  falls back to US Letter, then paginates
 *   @page { size: 80mm }        -> an 80mm *square* page, so a receipt breaks
 *                                  every 80mm
 *   @page { size: 80mm 297mm }  -> fine until a receipt runs past 297mm, then
 *                                  it splits across pages
 *
 * Mixing a length with `auto` isn't valid CSS, so `80mm auto` is dropped — it's
 * quietly wrong rather than obviously wrong, which is why it's worth stating
 * here. Measuring the rendered receipt and asking for exactly that height gives
 * one continuous strip with no pagination and no metre of blank roll.
 */

const STYLE_ID = 'receipt-page-size';

/*
 * The paper the till is actually printing on, in millimetres, published as a
 * CSS variable so the preview, the print rules and the KOT slip all lay out at
 * the same width. Everything downstream then MEASURES what was rendered rather
 * than being told a number twice — which is what keeps the measured height
 * honest when the width changes.
 *
 * 80mm is the counter printer and the default; 58mm is the pocket Bluetooth
 * kind. Anything outside that range is a typo, not a printer.
 */
export const applyPaperWidth = (mm) => {
    if (typeof document === 'undefined') return;
    const w = Number(mm);
    const clean = Number.isFinite(w) && w >= 40 && w <= 120 ? Math.round(w) : 80;
    document.documentElement.style.setProperty('--receipt-width', `${clean}mm`);
};

// CSS reference pixels are 96 per inch by definition, regardless of the display.
const PX_PER_MM = 96 / 25.4;

// The fallback when nothing has been rendered to measure.
const RECEIPT_WIDTH_MM = 80;

// A little slack past the content so the tear or auto-cut doesn't clip the last
// line, and a floor so an unmeasurable receipt still prints something sane.
const TAIL_MM = 6;
const FALLBACK_HEIGHT_MM = 297;

export const printReceipt = () => {
    if (typeof window === 'undefined') return;

    try {
        const root = document.getElementById('receipt-print-root');

        // scrollHeight, not the bounding box: the on-screen container may be
        // scrolled, and what matters is the full length of the content.
        const heightMm = root?.scrollHeight
            ? Math.ceil(root.scrollHeight / PX_PER_MM) + TAIL_MM
            : FALLBACK_HEIGHT_MM;

        /*
         * The width is MEASURED off the rendered receipt, not read from a
         * setting a second time. The preview already lays out at the paper's
         * width, so measuring it means the page can never disagree with what
         * was measured for the height — the failure that would clip a 58mm
         * bill on the right while the height looked correct.
         */
        const widthMm = root?.offsetWidth
            ? Math.round(root.offsetWidth / PX_PER_MM)
            : RECEIPT_WIDTH_MM;

        let style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            document.head.appendChild(style);
        }
        // The only @page in the app. It used to be a fallback over a global
        // 80mm rule, but @page can't be scoped to a selector — the global rule
        // was sizing the Reports PDF to a receipt roll too.
        style.textContent = `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`;

        window.print();

        /*
         * Remove the rule once the job is spooled. The style element outlives
         * navigation in an SPA, so leaving it meant every later print from any
         * screen — Reports' PDF export included — inherited an 80mm page.
         * window.print() blocks until the dialog closes (or returns after
         * spooling under --kiosk-printing), so the rule has served by now.
         */
        style.remove();
    } catch (error) {
        // The sale is already stored by the time this runs; a print failure must
        // never surface as a failed order.
        console.error('Could not print receipt', error);
    }
};

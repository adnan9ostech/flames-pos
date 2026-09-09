import styles from './kotSlips.module.css';

/*
 * One kitchen slip. What it holds depends on the mode the store is in — a
 * whole section's lines under 'category', a single dish under 'item' — but the
 * shape is identical either way, so this component never asks which.
 *
 * Mounted hidden (off-screen, never display:none — printKotSlip() measures its
 * scrollHeight to size the page) and driven by the page one slip at a time:
 *
 *   <KotSlips job={kotJob} />
 *
 * where job = { slip, meta } — `slip` is one element of buildKotSlips()'s
 * result, `meta` the round context shared by every slip in the pass. The full
 * sequencing contract lives atop src/lib/kotPrint.js.
 *
 * No prices anywhere on this document: it goes to the kitchen, not the
 * customer, and a priced ticket left on a pass ends up in the wrong hands.
 */

const ORDER_TYPE_LABEL = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };

// en-PK like timeFormat.js, but with the zone pinned to Asia/Karachi:
// formatClockTime follows the device zone, which is right for a receipt
// previewed on that device, while a slip's fire time gets compared against the
// kitchen clock — it must not drift with a till whose OS timezone is wrong.
const slipTime = (date) =>
    date
        .toLocaleTimeString('en-PK', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Karachi',
        })
        .replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase());

const KotSlips = ({ job }) => {
    if (!job?.slip) return null;

    const { slip, meta = {} } = job;
    /*
     * The fire time rides in on the job — both callers stamp it. A job that
     * somehow arrives without one prints no time rather than reading the clock
     * here: a render-phase Date.now() is impure, and would restamp the slip if
     * React happened to re-render it between measuring and printing.
     */
    const at = meta.at instanceof Date ? meta.at : meta.at ? new Date(meta.at) : null;
    const totalQty = slip.items.reduce((n, item) => n + item.qty, 0);

    /*
     * A reprint off the KDS carries every round on the order, not one round, so
     * the round cell says so rather than naming a single round it isn't. And it
     * has to be unmistakable at a glance: a reprint that looked like a fresh
     * ticket is food cooked twice.
     */
    const rounds = Number(meta.roundNo) || 1;
    const roundLabel = meta.reprint
        ? (rounds > 1 ? `Rounds 1-${rounds}` : 'Round 1')
        : `Round ${rounds}`;

    return (
        // Stable id, not a hashed module class: the print isolation in
        // kotSlips.module.css and the measurement in kotPrint.js both key off
        // it — the same arrangement the receipt has with #receipt-print-root.
        // aria-hidden because the slip is paper-only; off-screen it would
        // otherwise still be read out mid-service.
        <div id="kot-print-root" className={styles.slip} aria-hidden="true">
            {/* The runner sorts slips by this line alone, so it is the loudest
                thing on the paper */}
            <div className={styles.station}>{slip.categoryName}</div>
            <div className={styles.ticketType}>
                {meta.reprint ? 'Kitchen Order · Reprint' : 'Kitchen Order'}
            </div>

            {/* Shouted, boxed, above everything a cook reads: this food has
                already been fired once. */}
            {meta.reprint && <div className={styles.reprint}>Reprint — do not cook twice</div>}

            <div className={styles.meta}>
                <div className={styles.metaRow}>
                    <span>{meta.orderNumber ? `Order #${meta.orderNumber}` : 'Order'}</span>
                    <span>{roundLabel}</span>
                </div>
                <div className={styles.metaRow}>
                    <span>
                        {ORDER_TYPE_LABEL[meta.orderType] || meta.orderType || ''}
                        {meta.table ? ` · Table ${meta.table}` : ''}
                    </span>
                    <span>{at ? slipTime(at) : ''}</span>
                </div>
                {meta.waiter && (
                    <div className={styles.metaRow}>
                        <span>{meta.waiter}</span>
                    </div>
                )}
            </div>

            <div>
                {slip.items.map((item, idx) => (
                    <div key={idx} className={styles.line}>
                        <div className={styles.lineHead}>
                            <span className={styles.qty}>{item.qty}×</span>
                            <span className={styles.name}>{item.name}</span>
                        </div>
                        {item.variant && <div className={styles.detail}>{item.variant}</div>}
                        {item.modifiers && <div className={styles.detail}>{item.modifiers}</div>}
                        {/* Notes are the line a cook must not miss — boxed so
                            they can't read as just another modifier */}
                        {item.notes && <div className={styles.notes}>{item.notes}</div>}
                    </div>
                ))}
            </div>

            {/* Count on the tail so the section can spot a torn-off ticket */}
            <div className={styles.footer}>
                {totalQty} {totalQty === 1 ? 'item' : 'items'} · {slip.categoryName}
            </div>
        </div>
    );
};

export default KotSlips;

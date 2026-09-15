import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { generateEMVCoPayload } from '@/lib/emvco';
import { formatNumber as money } from '@/lib/money';
import { applyPaperWidth } from '@/lib/printReceipt';
import { getEffectiveSettings } from '@/app/settings/actions';
import { formatDateTime } from '@/lib/timeFormat';
import styles from './ReceiptPreview.module.css';

const ROLE_LABEL = { admin: 'Admin', staff: 'Staff' };

const ReceiptPreview = ({
    cart, totals, includeTax, invoiceNumber, meta, printLabel, role, busy, onClose, onPrint,
    /*
     * The rate this bill's tax was actually worked out at, as a fraction
     * (0.05 or 0.16). It has to be passed in, because it is a fact about the
     * BILL, not about the store: cash is taxed at 16% and card at 5% under
     * ICT, so a single store-wide number would misstate one of them. The till
     * passes the rate of the payment mode selected; a reprint passes the rate
     * stamped on the order at settle. Null when it genuinely isn't known —
     * a bill settled before that column existed — and the receipt then prints
     * the tax line with no percentage rather than asserting a wrong one.
     */
    taxRate = null,
    /*
     * The settled order row, when the caller has one. Only read for
     * fbr_invoice_number — the number FBR itself issued, backfilled after
     * settle (or later, by the retry worker). Callers without a row (a
     * pre-payment preview) simply get no FBR block, which is the truth:
     * that sale hasn't been reported yet.
     */
    order = null,
    /*
     * Reprint mode. `orderDate` is the original sale's timestamp and `reprint`
     * marks the paper as a copy. Without these a reprint stamped today's date
     * on last week's bill — two documents for one sale, each asserting a
     * different day, which is exactly what a tax inspection reads as fraud.
     */
    orderDate = null, reprint = false,
    /*
     * The cash tender, when this is a cash sale on a till that asks for one.
     * Held by the POS page rather than here because the number has to survive
     * this modal closing and reopening, and because the page is what sends it
     * to the server. `null` for card, city ledger, a reprint, or a counter
     * that has turned the prompt off — and then none of this renders.
     */
    cashReceived = null, onCashReceived = null,
    /*
     * The card slip's reference, on the same terms: the page holds it, and
     * these are null unless this is a card sale on a counter that asks.
     */
    cardRef = null, onCardRef = null, cardRefRequired = false
}) => {
    const [settings, setSettings] = useState(null);
    /*
     * The invoice number is the server's, minted at settle. It arrives as a
     * prop — possibly only after payment lands, flushed in just before
     * printing — so it is read live, never pinned. The old client-side
     * fallback generator is gone: paper either carries the issued number or
     * honestly says the sale hasn't been numbered yet.
     */
    const invoiceNo = invoiceNumber || null;

    /*
     * The tender arithmetic, and the only arithmetic this component does.
     *
     * `short` is what gates the print button: a cash sale that does not cover
     * the bill must not be settleable at all, because the server refuses it
     * and the cashier would meet the refusal only after the customer has been
     * told to go. The server refuses it anyway — this is the courtesy, not
     * the rule.
     *
     * The quick amounts are the notes people actually hand over: the exact
     * rupee, then the next hundred, five hundred, thousand and five thousand
     * above it, deduplicated (a Rs. 4,945 bill offers 4,945 and 5,000, not the
     * same 5,000 four times).
     */
    const due = Number(totals?.total || 0);
    const typed = cashReceived !== '' && cashReceived != null;
    const short = typed && Number(cashReceived) < due;
    const changeDue = typed ? Math.max(0, Number(cashReceived) - due) : 0;
    // A required reference that has not been typed blocks the close, for the
    // same reason a short tender does: the server refuses it either way, and
    // meeting that refusal after the customer has gone helps nobody.
    const cardRefMissing = Boolean(onCardRef && cardRefRequired && !String(cardRef || '').trim());
    const quickTenders = [...new Set(
        [Math.ceil(due), ...[100, 500, 1000, 5000].map((note) => Math.ceil(due / note) * note)],
    )].slice(0, 4);

    // Pinned on open for the same reason as the invoice number: read fresh on
    // every render, the printed time drifted between preview and print. A
    // reprint carries the original sale's date — the document is a copy of
    // that bill, not a new one.
    const [date] = useState(() => formatDateTime(orderDate ? new Date(orderDate) : new Date()));

    /*
     * `settingsLoaded` tracks the request finishing, not whether it returned
     * anything. The merchant details, tax label and payment QR all come from
     * here, so printing before it resolves puts out a receipt missing them —
     * and a settled bill can't be reprinted with the QR added afterwards.
     *
     * Keyed on the request completing rather than on `settings` being non-null
     * so a failed read still releases the button instead of disabling printing
     * for good.
     */
    const [settingsLoaded, setSettingsLoaded] = useState(false);

    useEffect(() => {
        getEffectiveSettings()
            .then((s) => {
                setSettings(s);
                // Before the paper is measured, not after: the preview lays out
                // at the paper's width, and printReceipt() measures the preview.
                applyPaperWidth(s?.receipt_width_mm);
            })
            .finally(() => setSettingsLoaded(true));
    }, []);

    // Two independent gates: the QR has to be switched on in Settings, and
    // there has to be an identifier to encode. `qr_enabled` is read as true
    // when absent so a database without the column behaves as it did before.
    const qrAllowed = settings?.qr_enabled !== false && Boolean(settings?.raast_id);

    /*
     * The header, from this deployment's own settings rather than from the
     * restaurant this app was first written for. Each piece is allowed to be
     * absent and the line it belongs to then disappears — a white-labelled
     * install that has not uploaded a logo draws its name as text, which is a
     * perfectly good wordmark, and one that has not entered a tax number
     * prints no tax line rather than somebody else's.
     */
    const receiptLogo = settings?.brand_logo_dark || settings?.brand_logo_light || '';
    const address = settings?.merchant_address || settings?.merchant_city || '';
    const registration = [
        settings?.merchant_ntn ? `NTN: ${settings.merchant_ntn}` : null,
        settings?.merchant_strn ? `STRN: ${settings.merchant_strn}` : null,
    ].filter(Boolean).join(' | ');

    // Settings may not have loaded on first paint, so both fall back rather than
    // rendering "undefined" on a document a customer keeps.
    const taxLabel = settings?.tax_label || 'GST';
    /*
     * `settings.tax_rate` has not existed since the rates were split into
     * tax_rate_cash / tax_rate_card, so this silently fell back to 16% and
     * every card bill printed "GST (16%)" over a 5% amount — on a document an
     * FBR inspection may read. The rate now arrives with the bill.
     */
    const rate = Number(taxRate);
    const taxPercent = Number.isFinite(rate) && rate > 0
        ? `${Number((rate * 100).toFixed(2))}%`
        : null;

    // Built inside a try because the encoder rejects values it cannot express in
    // a two-digit length rather than silently truncating an account id. This runs
    // during render, so an unguarded throw would take the whole receipt down —
    // and a receipt that won't open means a bill that can't be settled. A
    // missing QR is recoverable at the till; a blank screen is not.
    let qrPayload = null;
    if (qrAllowed && invoiceNo) {
        try {
            qrPayload = generateEMVCoPayload({
                raastId: settings.raast_id,
                amount: totals.total,
                merchantName: settings.merchant_name,
                merchantCity: settings.merchant_city,
                invoiceNo: invoiceNo
            });
        } catch (error) {
            console.error('Could not build payment QR payload', error);
        }
    }

    return (
        <div className={styles.overlay}>
            <div className={styles.modal}>
                {/* Stable id, not a hashed module class: the print rules in
                    globals.css key off it to show this subtree and nothing else. */}
                <div id="receipt-print-root" className={styles.receiptContainer}>
                    {/* Header */}
                    <div className={styles.header}>
                        {/* Sized and centred from CSS rather than inline, so the
                            print rules can reach it */}
                        {/* This restaurant's logo, not the one this app was
                            first built for. Drawn only when there is one — a
                            broken image is a worse wordmark than the name. */}
                        {receiptLogo && (
                            <img
                                src={receiptLogo}
                                alt={settings?.merchant_name || settings?.brand_name || ""}
                                className={styles.logoImg}
                            />
                        )}
                        <p>{settings?.merchant_name || settings?.brand_name}{address ? ` - ${address}` : ''}</p>
                        {/*
                          * The real registration or no line at all. This read
                          * "NTN: 1234567-8 | STRN: 1234567890123" as literal
                          * text: placeholder digits belonging to nobody, on a
                          * screen a cashier turns towards a customer. A tax
                          * number is either right or absent.
                          */}
                        {registration && <p>{registration}</p>}
                        {includeTax && (
                            <div className={styles.fbrHeader}>
                                <img src="/fbr-logo.png" alt="FBR" className={styles.fbrLogo} />
                                <span>FBR Invoice: {invoiceNo || 'issued at payment'}</span>
                            </div>
                        )}
                    </div>

                    {/* A copy must say it's a copy: two clean prints of one
                        sale is how a bill gets presented twice. */}
                    {reprint && <div className={styles.reprintBanner}>REPRINT: COPY OF ORIGINAL</div>}

                    {/* Meta */}
                    <div className={styles.meta}>
                        <span>Date: {date}</span>
                        <span>User: {ROLE_LABEL[role] || 'Staff'}</span>
                    </div>

                    {/* Table, server and — for a tab settled at the end — the
                        number of rounds that make up this one bill */}
                    {meta && (meta.orderNumber || meta.table || meta.waiter) && (
                        <div className={styles.meta}>
                            <span>
                                {meta.orderNumber && `Order #${meta.orderNumber}`}
                                {meta.table && `${meta.orderNumber ? ' · ' : ''}Table ${meta.table}`}
                            </span>
                            <span>
                                {meta.waiter && `Served by: ${meta.waiter}`}
                                {meta.rounds > 1 && ` · ${meta.rounds} rounds`}
                            </span>
                        </div>
                    )}

                    {/* Items */}
                    <div className={styles.items}>
                        <table>
                            <thead>
                                <tr>
                                    <th>Item</th>
                                    <th>Qty</th>
                                    <th className={styles.right}>Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {cart.map((item, idx) => (
                                    <tr key={idx}>
                                        <td>{item.name}</td>
                                        <td>{item.qty}</td>
                                        <td className={styles.right}>{money(item.price * item.qty)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Totals */}
                    <div className={styles.totals}>
                        <div className={styles.row}>
                            <span>Sub Total:</span>
                            <span>Rs. {money(totals.subtotal)}</span>
                        </div>
                        {totals.discount > 0 && (
                            <div className={styles.row}>
                                <span>Discount:</span>
                                <span>− Rs. {money(totals.discount)}</span>
                            </div>
                        )}
                        {/* Auto-applied charges (service charge, delivery fee),
                            each on its own line — a fee folded silently into the
                            total is how arguments at the counter start. */}
                        {(totals.charges || []).map((c) => (
                            <div className={styles.row} key={c.name}>
                                <span>{c.name}:</span>
                                <span>Rs. {money(c.amount)}</span>
                            </div>
                        ))}
                        {includeTax && (
                            <div className={styles.row}>
                                {/* Label and rate come from settings, so a rate change
                                    doesn't leave the receipt asserting the old one. */}
                                <span className="font-bold">
                                    {taxLabel}{taxPercent ? ` (${taxPercent})` : ''}:
                                </span>
                                <span>Rs. {money(totals.tax)}</span>
                            </div>
                        )}
                        {Number(totals.rounding) > 0 && (
                            <div className={styles.row}>
                                <span>Rounding:</span>
                                <span>-Rs. {money(totals.rounding)}</span>
                            </div>
                        )}
                        <div className={`${styles.row} ${styles.grandTotal}`}>
                            <span>Total:</span>
                            <span>Rs. {money(totals.total)}</span>
                        </div>

                        {/* On the document itself, because this is what the
                            customer checks against the notes in their hand.
                            Shown from the settled order on a reprint, and from
                            what the cashier has typed while the sale is still
                            being rung — the same two numbers either way. */}
                        {(order?.cash_received != null || (typed && !short)) && (
                            <>
                                <div className={styles.row}>
                                    <span>Cash:</span>
                                    <span>Rs. {money(order?.cash_received ?? Number(cashReceived))}</span>
                                </div>
                                <div className={`${styles.row} ${styles.grandTotal}`}>
                                    <span>Change:</span>
                                    <span>Rs. {money(order?.change_due ?? changeDue)}</span>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Payment QR Code */}
                    {qrPayload && (
                        <div className={styles.qrSection}>
                            {/* The dashed box and its padding cost ~15mm of roll and
                                earn nothing on paper, so both are gone. */}
                            <QRCodeSVG value={qrPayload} size={104} level="M" />
                            <p className={styles.qrCaption}>Scan to Pay with Raast / JazzCash</p>
                            <p>Amount: Rs. {money(totals.total)}</p>
                        </div>
                    )}

                    {/* FBR Digital Invoicing — only once FBR has actually issued
                        a number (the old placeholder QR encoded a constant, which
                        verifies nothing). The QR carries JUST the number: Tax
                        Asaan looks the invoice up by it, and wrapping it in a URL
                        breaks the app's scanner. Rendered inline rather than
                        fetched from an image host: a third-party request at print
                        time is simply missing on a till with a flaky connection,
                        and this has to reach paper. */}
                    {order?.fbr_invoice_number && (
                        <div className={styles.qrSection}>
                            <p className={styles.qrCaption}>FBR Invoice # {order.fbr_invoice_number}</p>
                            {/* ~1 inch at 80mm thermal — the size Tax Asaan scans
                                reliably at arm's length */}
                            <QRCodeSVG value={order.fbr_invoice_number} size={96} level="M" />
                            {/* Preflight makes img a block, so it needs auto margins
                                to centre — same reason .logoImg carries them. */}
                            <img
                                src="/fbr-logo.png"
                                alt="FBR Digital Invoicing"
                                className={styles.fbrLogo}
                                style={{ margin: '2.5mm auto 1mm' }}
                            />
                            <p>Verify this invoice via the FBR Tax Asaan app</p>
                        </div>
                    )}

                    <p className={styles.footer}>Thank you for dining with us!</p>
                </div>

                {/*
                  * The cash tender. Outside the receipt body on purpose: this
                  * is the cashier's working area, not part of the document —
                  * what reaches paper is the two settled lines the receipt
                  * prints once the sale is stored.
                  *
                  * The quick amounts are the notes a customer actually hands
                  * over. Most cash sales are settled with one of them, and a
                  * tap is faster and less wrong than typing four digits at
                  * eleven at night.
                  */}
                {onCashReceived && (
                    <div className={styles.cashPad}>
                        <div className={styles.cashRow}>
                            <label className={styles.cashLabel} htmlFor="cashReceived">Cash received</label>
                            <input
                                id="cashReceived"
                                className={styles.cashInput}
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="1"
                                placeholder={money(totals.total)}
                                value={cashReceived ?? ''}
                                onChange={(e) => onCashReceived(e.target.value)}
                                autoFocus
                            />
                        </div>
                        <div className={styles.quickCash}>
                            {quickTenders.map((amount) => (
                                <button
                                    key={amount}
                                    type="button"
                                    className={styles.quickBtn}
                                    onClick={() => onCashReceived(String(amount))}
                                >
                                    {amount === Math.ceil(Number(totals.total)) ? 'Exact' : money(amount)}
                                </button>
                            ))}
                            {cashReceived !== '' && cashReceived != null && (
                                <button type="button" className={styles.quickBtn} onClick={() => onCashReceived('')}>
                                    Clear
                                </button>
                            )}
                        </div>
                        {/* Silent until there is something to say: a blank box is
                            a cashier who has not typed yet, not an error. */}
                        {cashReceived !== '' && cashReceived != null && (
                            short ? (
                                <p className={`${styles.changeLine} ${styles.changeShort}`}>
                                    Rs. {money(Number(totals.total) - Number(cashReceived))} short of the bill
                                </p>
                            ) : (
                                <p className={styles.changeLine}>
                                    Change due <strong>Rs. {money(changeDue)}</strong>
                                </p>
                            )
                        )}
                    </div>
                )}

                {/*
                  * The card slip's number. Same working area as the cash pad
                  * and never both at once — a bill is settled one way.
                  */}
                {onCardRef && (
                    <div className={styles.cashPad}>
                        <div className={styles.cashRow}>
                            <label className={styles.cashLabel} htmlFor="cardRef">
                                Card ref{cardRefRequired ? '' : ' (optional)'}
                            </label>
                            <input
                                id="cardRef"
                                className={styles.cashInput}
                                type="text"
                                maxLength={32}
                                placeholder="Approval code or last 4"
                                value={cardRef ?? ''}
                                onChange={(e) => onCardRef(e.target.value)}
                                autoFocus
                            />
                        </div>
                        {cardRefRequired && !String(cardRef || '').trim() && (
                            <p className={`${styles.changeLine} ${styles.changeShort}`}>
                                Take this off the terminal slip before closing the sale
                            </p>
                        )}
                    </div>
                )}

                <div className={styles.actions}>
                    <button className={styles.cancelBtn} onClick={onClose} disabled={busy}>Back</button>
                    <button className={styles.printBtn} onClick={onPrint} disabled={busy || !settingsLoaded || short || cardRefMissing}>
                        {busy ? 'Saving…' : !settingsLoaded ? 'Loading…' : (printLabel || 'Print & Close')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ReceiptPreview;

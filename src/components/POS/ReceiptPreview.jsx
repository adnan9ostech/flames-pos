import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { generateEMVCoPayload } from '@/lib/emvco';
import { formatNumber as money } from '@/lib/money';
import { applyPaperWidth } from '@/lib/printReceipt';
import { getSettings } from '@/app/settings/actions';
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
    orderDate = null, reprint = false
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
        getSettings()
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
                        <img
                            src="/flames-by-the-indus-logo-for-receipt.svg"
                            alt="Flames by the Indus"
                            className={styles.logoImg}
                        />
                        <p>{settings?.merchant_name || 'Flames by the Indus'} - {settings?.merchant_address || settings?.merchant_city || 'Islamabad'}</p>
                        <p>NTN: 1234567-8 | STRN: 1234567890123</p>
                        {includeTax && (
                            <div className={styles.fbrHeader}>
                                <img src="/fbr-logo.png" alt="FBR" className={styles.fbrLogo} />
                                <span>FBR Invoice: {invoiceNo || 'issued at payment'}</span>
                            </div>
                        )}
                    </div>

                    {/* A copy must say it's a copy: two clean prints of one
                        sale is how a bill gets presented twice. */}
                    {reprint && <div className={styles.reprintBanner}>REPRINT — COPY OF ORIGINAL</div>}

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
                        <div className={`${styles.row} ${styles.grandTotal}`}>
                            <span>Total:</span>
                            <span>Rs. {money(totals.total)}</span>
                        </div>
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

                <div className={styles.actions}>
                    <button className={styles.cancelBtn} onClick={onClose} disabled={busy}>Back</button>
                    <button className={styles.printBtn} onClick={onPrint} disabled={busy || !settingsLoaded}>
                        {busy ? 'Saving…' : !settingsLoaded ? 'Loading…' : (printLabel || 'Print & Close')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ReceiptPreview;

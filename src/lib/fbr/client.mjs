/*
 * The one HTTP call to PRAL's Digital Invoicing API. Never throws — the
 * callers (a settle that must not fail, a worker loop that must not die)
 * both want a verdict, not an exception. 5s timeout: FBR being slow is
 * FBR's problem; the till's payment flow won't wait longer than that.
 */

const ENDPOINTS = {
    sandbox: 'https://esp.fbr.gov.pk:8244/DigitalInvoicing/v1/PostInvoiceData_v1',
    production: 'https://gw.fbr.gov.pk/pdi/v1/api/DigitalInvoicing/PostInvoiceData_v1',
};

/*
 * Returns {ok, fbrInvoiceNumber, error}. Success is the spec's definition —
 * statusCode 200/00 AND a non-empty result — not merely HTTP 200: the API
 * answers 200 with an errorMessage for a rejected invoice.
 */
export const postInvoice = async (payload) => {
    try {
        const mode = process.env.FBR_MODE === 'production' ? 'production' : 'sandbox';
        const res = await fetch(ENDPOINTS[mode], {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.FBR_TOKEN || ''}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });

        let body = null;
        try { body = await res.json(); } catch { /* gateway error pages aren't JSON */ }

        const code = String(body?.statusCode ?? '');
        const invoiceNumber = typeof body?.result === 'string' ? body.result.trim() : '';
        if ((code === '200' || code === '00') && invoiceNumber) {
            return { ok: true, fbrInvoiceNumber: invoiceNumber, error: null };
        }

        const error = body?.errorMessage
            || (Array.isArray(body?.errors) && body.errors.length > 0 ? JSON.stringify(body.errors) : '')
            || `FBR responded HTTP ${res.status}${code ? ` statusCode ${code}` : ''} without an invoice number`;
        return { ok: false, fbrInvoiceNumber: null, error: String(error).slice(0, 500) };
    } catch (e) {
        // Timeout, DNS, refused connection — all retryable, all worded for last_error.
        return { ok: false, fbrInvoiceNumber: null, error: String(e?.message || 'FBR request failed').slice(0, 500) };
    }
};

/*
 * Talks to the local print agent, when there is one.
 *
 * The till prints through the browser by default, which needs the printer to
 * exist as a print queue on the machine. Some thermal printers never become
 * one — a Bluetooth unit that advertises no printing service is invisible to
 * macOS's print system however well it is paired — so `scripts/print-agent.mjs`
 * can be run beside the app to write the bill to the device directly.
 *
 * The rule here: the agent is an OPTIONAL accelerator, never a dependency.
 * Every call fails soft. If the agent is absent, slow, or errors, the caller
 * falls back to browser printing exactly as before, and a sale is never held
 * up by a printer — the money is already taken by the time any of this runs.
 */

const AGENT = 'http://127.0.0.1:9110';

// Probed once per page load, not per print: a till prints all evening and a
// failed connection costs a round trip each time it is retried.
let probe = null;

const withTimeout = async (url, options = {}, ms = 1500) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: abort.signal });
    } finally {
        clearTimeout(timer);
    }
};

/* True when an agent is listening AND its printer is plugged in. */
export const thermalAgentReady = async () => {
    if (probe !== null) return probe;
    probe = (async () => {
        try {
            const res = await withTimeout(`${AGENT}/health`, {}, 1200);
            if (!res.ok) return false;
            const body = await res.json();
            return Boolean(body?.ok && body?.present);
        } catch {
            return false;
        }
    })();
    return probe;
};

/*
 * Prints one bill. Returns true only when the agent confirms paper was
 * written, so a caller can fall back on anything else — including the agent
 * being up but its printer switched off.
 *
 * The timeout is generous: a Bluetooth serial link is slow, and a receipt
 * half-written because the browser gave up is worse than a slow one.
 */
export const printReceiptViaAgent = async (orderId, { reprint = false } = {}) => {
    if (!orderId) return false;
    if (!(await thermalAgentReady())) return false;
    try {
        const res = await withTimeout(`${AGENT}/receipt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId, reprint }),
        }, 20000);
        if (!res.ok) return false;
        return Boolean((await res.json())?.printed);
    } catch (e) {
        // Logged, never surfaced: the bill is stored and the browser path is
        // about to be tried anyway.
        console.warn('Thermal agent did not print; falling back to the browser.', e?.message ?? e);
        return false;
    }
};

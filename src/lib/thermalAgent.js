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
export const thermalAgentReady = async ({ requirePrinter = true } = {}) => {
    /*
     * `requirePrinter: false` asks only whether the AGENT is up. The Settings
     * screen needs that: a counter whose printer is unplugged — or which has
     * never had one chosen — still has to be able to list what is available
     * and pick one, and the stricter answer would lock it out of the screen
     * that fixes it.
     */
    if (!requirePrinter) {
        try {
            const res = await withTimeout(`${AGENT}/health`, {}, 1200);
            return res.ok && Boolean((await res.json())?.ok);
        } catch {
            return false;
        }
    }
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

/*
 * Kitchen tickets through the agent. `round` prints just that round (one just
 * fired); omit it to print the whole order, which is what a KDS reprint wants.
 *
 * Same soft contract as the receipt: false means "not printed", and the caller
 * decides what to do about it. On a raw ESC/POS printer that decision must NOT
 * be "try the browser" — a browser job arrives as PostScript and prints as
 * source code — which is why the pages check print_transport first.
 */
export const printKotViaAgent = async (orderId, { round = null, reprint = false } = {}) => {
    if (!orderId) return false;
    if (!(await thermalAgentReady())) return false;
    try {
        const res = await withTimeout(`${AGENT}/kot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId, round, reprint }),
        }, 20000);
        if (!res.ok) return false;
        return Boolean((await res.json())?.printed);
    } catch (e) {
        console.warn('Thermal agent did not print the kitchen ticket.', e?.message ?? e);
        return false;
    }
};

/*
 * Opens the cash drawer for a completed sale.
 *
 * The agent decides whether it should open at all — it is the only thing that
 * knows the printer, the wiring and the setting — so the till just tells it a
 * sale is done. Returns true only when the drawer actually fired, so nothing
 * here can be mistaken for "the drawer is definitely open".
 *
 * Soft like the rest of this module: a shut drawer must never hold up a sale
 * whose money is already taken and stored. `force` is a person pressing a
 * button, and then the setting is not consulted.
 */
export const openCashDrawerViaAgent = async (orderId = null, { force = false } = {}) => {
    if (!(await thermalAgentReady())) return false;
    try {
        const res = await withTimeout(`${AGENT}/drawer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId, force }),
        }, 8000);
        if (!res.ok) return false;
        return Boolean((await res.json())?.opened);
    } catch (e) {
        console.warn('Cash drawer did not open.', e?.message ?? e);
        return false;
    }
};

/*
 * What this machine can print to, asked of the agent running on it.
 *
 * Only the agent knows: the queue list is a property of the MACHINE the
 * browser is sitting at, not of the server or the database. That is why the
 * Settings screen has to ask the local agent rather than the app.
 */
export const listAgentPrinters = async () => {
    if (!(await thermalAgentReady({ requirePrinter: false }))) return null;
    try {
        const res = await withTimeout(`${AGENT}/printers`, {}, 4000);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
};

/* A page of paper that proves the setup, without ringing a sale. */
export const testPrintViaAgent = async () => {
    try {
        const res = await withTimeout(`${AGENT}/test`, { method: 'POST' }, 20000);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: body?.error || 'The printer did not take the test page' };
        return { ok: true, printer: body.printer };
    } catch (e) {
        return { ok: false, error: 'The print agent is not running on this machine' };
    }
};

/*
 * Forget a cached probe. thermalAgentReady() caches for the life of the page
 * (a till prints all evening and a failed connection costs a round trip each
 * time), but an agent started AFTER the page loaded would then stay invisible
 * until someone reloaded — which is exactly the state a "print agent not
 * running" message leaves an operator in. The retry button calls this.
 */
export const resetAgentProbe = () => { probe = null; };

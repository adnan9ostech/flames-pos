/*
 * Stateless signed sessions — the whole of what Supabase Auth did for this
 * app, in one file with zero dependencies.
 *
 * Token: base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload)).
 * Payload: { sub, role, pv, iat, exp } — user id, role, pin_version (bumping
 * it on a PIN change strands every other device's cookie), issued-at,
 * expiry. Web Crypto (crypto.subtle) on purpose: it exists in Node AND in
 * the middleware runtime, and subtle.verify is constant-time.
 *
 * Verification is a pure cookie check — no network, no DB. The data layer's
 * requireUser() adds the pin_version DB check where it matters.
 */

const SECRET = () => {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 32) {
        throw new Error('SESSION_SECRET must be set (32+ random chars). Rotating it signs everyone out.');
    }
    return s;
};

export const COOKIE_NAME = 'fbi_session';
export const MAX_AGE_S = 30 * 24 * 60 * 60;     // a till stays signed in for a month
const RESIGN_AFTER_S = 24 * 60 * 60;            // sliding renewal cadence

const enc = new TextEncoder();

const b64url = (bytes) => {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const fromB64url = (s) => {
    const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hmacKey = (usage) => crypto.subtle.importKey(
    'raw', enc.encode(SECRET()), { name: 'HMAC', hash: 'SHA-256' }, false, [usage],
);

export const signSession = async ({ sub, role, pv }) => {
    const now = Math.floor(Date.now() / 1000);
    const body = b64url(enc.encode(JSON.stringify({ sub, role, pv, iat: now, exp: now + MAX_AGE_S })));
    const sig = await crypto.subtle.sign('HMAC', await hmacKey('sign'), enc.encode(body));
    return `${body}.${b64url(sig)}`;
};

/* Returns the payload, or null for anything invalid, expired, or tampered. */
export const verifySession = async (token) => {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    try {
        const ok = await crypto.subtle.verify(
            'HMAC', await hmacKey('verify'), fromB64url(token.slice(dot + 1)), enc.encode(body),
        );
        if (!ok) return null;
        const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
        if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
        if (payload.role !== 'admin' && payload.role !== 'staff') return null;
        return payload;
    } catch {
        return null;
    }
};

/* Sliding renewal: true when the cookie is valid but worth re-signing. */
export const shouldResign = (payload) =>
    payload && (Math.floor(Date.now() / 1000) - payload.iat) > RESIGN_AFTER_S;

export const cookieOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_S,
});

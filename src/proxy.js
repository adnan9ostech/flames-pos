/*
 * Route gate (Next 16 proxy, née middleware). Pure cookie check — verify the
 * signed session, then ask the permission map whether this account may open
 * this path. ZERO network or DB calls here: the per-action re-read of the
 * account's live rights lives in requireUser(), where a stale cookie
 * actually matters.
 */
import { NextResponse } from 'next/server'
import { COOKIE_NAME, verifySession, signSession, shouldResign, cookieOptions } from './lib/auth/session.mjs'
import { permissionForPath, landingPath } from './lib/auth/permissions.mjs'

// Reachable with any valid session, whatever the account may otherwise do:
// everyone can read and change their own profile.
const ALWAYS_ALLOWED = ['/profile', '/logout']

export async function proxy(request) {
    const pathname = request.nextUrl.pathname

    // API handlers own their 401s — a redirect-to-login would hand a fetch()
    // caller an HTML page where it expects JSON.
    if (pathname.startsWith('/api')) {
        return NextResponse.next()
    }

    const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value)
    const needed = permissionForPath(pathname)
    const guarded = needed !== null || ALWAYS_ALLOWED.some((p) => pathname.startsWith(p))

    if (!session && guarded) {
        const url = request.nextUrl.clone()
        url.pathname = '/login'
        return NextResponse.redirect(url)
    }

    let response
    if (session && needed && !session.perms.includes(needed)) {
        // Signed in, but this screen is not theirs. Send them somewhere they
        // can actually work rather than to /login, which would read as "your
        // password is wrong".
        const url = request.nextUrl.clone()
        url.pathname = landingPath(session.perms)
        response = NextResponse.redirect(url)
    } else {
        response = NextResponse.next()
    }

    // Sliding renewal: a till in daily use never hits the 30-day expiry.
    if (shouldResign(session)) {
        response.cookies.set(COOKIE_NAME, await signSession(session), cookieOptions())
    }

    return response
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * Feel free to modify this pattern to include more paths.
         */
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
}

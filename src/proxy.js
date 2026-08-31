/*
 * Route gate (Next 16 proxy, née middleware). Pure cookie check — verify the
 * signed session, route accordingly. ZERO network or DB calls here: the
 * per-action pin_version check lives in requireUser(), where a stale cookie
 * actually matters.
 */
import { NextResponse } from 'next/server'
import { COOKIE_NAME, verifySession, signSession, shouldResign, cookieOptions } from './lib/auth/session.mjs'

const protectedPaths = [
    '/pos', '/orders', '/kds', '/profile', '/reports', '/settings',
    // Back office (phases F–J). /drawer is deliberately staff-reachable —
    // the cashier owns their drawer; everything else below is admin-only.
    '/drawer', '/dayclose', '/expenses', '/companies', '/cityledger',
    '/charges', '/discounts', '/inventory',
]
const adminOnlyPaths = [
    '/reports', '/settings',
    '/dayclose', '/expenses', '/companies', '/cityledger',
    '/charges', '/discounts', '/inventory',
]

export async function proxy(request) {
    const pathname = request.nextUrl.pathname

    // API handlers own their 401s — a redirect-to-login would hand a fetch()
    // caller an HTML page where it expects JSON.
    if (pathname.startsWith('/api')) {
        return NextResponse.next()
    }

    const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value)

    if (!session && protectedPaths.some((path) => pathname.startsWith(path))) {
        const url = request.nextUrl.clone()
        url.pathname = '/login'
        return NextResponse.redirect(url)
    }

    // Signed in but wrong role: redirect to /pos, not /login — they ARE
    // authenticated, just not authorized for this route. The role claim is
    // inside the HMAC-signed payload, so it is the server's word, not the
    // client's.
    let response
    if (session && session.role !== 'admin' && adminOnlyPaths.some((path) => pathname.startsWith(path))) {
        const url = request.nextUrl.clone()
        url.pathname = '/pos'
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

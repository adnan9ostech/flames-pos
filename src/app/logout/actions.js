
'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { COOKIE_NAME } from '@/lib/auth/session.mjs'

export async function logout() {
    /*
     * Per-device by construction: deleting the cookie only signs out this
     * browser. That matters because admin/staff are shared accounts — one
     * person signing out of the back office must never drop the till and the
     * kitchen display mid-service, and here it can't: their cookies live on
     * their own devices, untouched.
     */
    const store = await cookies()
    store.delete(COOKIE_NAME)
    redirect('/login')
}

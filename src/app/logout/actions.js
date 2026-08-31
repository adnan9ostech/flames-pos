
'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { COOKIE_NAME } from '@/lib/auth/session.mjs'

export async function logout() {
    /*
     * Per-device by construction: deleting the cookie signs out this browser
     * and nothing else. Signing out of the back office on a laptop must
     * never drop the till or the kitchen board mid-service, and here it
     * can't — those cookies live on those devices, untouched.
     *
     * To end every session at once (a lost phone, a departing employee)
     * change the password or have an admin reset it: both bump
     * token_version, which strands every cookie the account holds.
     */
    const store = await cookies()
    store.delete(COOKIE_NAME)
    redirect('/login')
}

'use server'

import { query } from '@/lib/db/pool.mjs'
import { requirePermission } from '@/lib/db/auth.mjs'
import { paletteFor, parseHex } from '@/lib/brand/colour.mjs'

/*
 * The brand: what this deployment is called and what colour it wears.
 *
 * One vhost and one database per restaurant, so there is no tenant to scope
 * by. Handing the POS to another restaurant is a deployment plus this screen,
 * not a fork.
 */
export async function getBrandSettings() {
    try {
        await requirePermission('settings')
        const rows = await query(
            `SELECT brand_name, brand_logo_light, brand_logo_dark, brand_colour,
                    brand_tagline, merchant_name
               FROM store_settings LIMIT 1`,
        )
        return { data: rows[0] ?? {} }
    } catch (e) {
        return { error: e.message }
    }
}

export async function saveBrand({ name, colour, tagline, logoLight, logoDark } = {}) {
    try {
        await requirePermission('settings')
        const clean = String(name ?? '').trim().slice(0, 96)
        if (!clean) throw new Error('The brand needs a name — it is the tab title and the login screen')

        // Blank is legal and means "the built-in flame orange": no colour is
        // rendered into the page and globals.css stands as written.
        const hex = String(colour ?? '').trim()
        if (hex && !parseHex(hex)) throw new Error('That colour is not a hex like #a83f08')

        await query(
            `UPDATE store_settings SET
               brand_name = ?, brand_colour = ?, brand_tagline = ?,
               brand_logo_light = ?, brand_logo_dark = ?,
               updated_at = UTC_TIMESTAMP(3)`,
            [clean, hex, String(tagline ?? '').trim().slice(0, 96),
                String(logoLight ?? '').trim().slice(0, 255), String(logoDark ?? '').trim().slice(0, 255)],
        )
        return { success: 'Brand saved. Reload any open screen to see it.' }
    } catch (e) {
        return { error: e.message }
    }
}

/*
 * What a colour would become, worked out on the server so the screen can show
 * the real numbers rather than a swatch and a hope.
 */
export async function previewColour(hex) {
    try {
        await requirePermission('settings')
        return { data: paletteFor(hex) }
    } catch (e) {
        return { error: e.message }
    }
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import { Palette, Loader2, AlertTriangle, CheckCircle2, Upload, Save } from 'lucide-react'
import { getBrandSettings, saveBrand, previewColour } from './actions'
import SettingsTabs from '@/components/settings/SettingsTabs'

/*
 * The brand: the name on the tab and the login screen, the two logos, and the
 * one colour everything else is worked out from.
 *
 * ONE COLOUR, and that is the point. The accents here are read as text and
 * used as fills, in two themes, and a value that works in one place fails in
 * another. Asking for four hexes and hoping they contrast is how a
 * white-labelled app ends up unreadable at somebody else's counter. So the
 * screen takes the brand's colour and shows the measured result of it.
 */
const upload = (file) => new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file, file.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/menu/images')
    xhr.onload = () => {
        let body = {}
        try { body = JSON.parse(xhr.responseText) } catch { /* something else answered */ }
        if (xhr.status >= 200 && xhr.status < 300 && body.url) resolve(body.url)
        else reject(new Error(body.error || `The logo could not be saved (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('The logo could not reach the server. Check the connection'))
    xhr.send(form)
})

export default function BrandPage() {
    const [form, setForm] = useState(null)
    const [palette, setPalette] = useState(null)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState('')

    const load = useCallback(() => getBrandSettings().then((res) => {
        if (res.error) { setMessage({ type: 'error', text: res.error }); return }
        setForm({
            name: res.data.brand_name || res.data.merchant_name || '',
            colour: res.data.brand_colour || '',
            tagline: res.data.brand_tagline || '',
            logoLight: res.data.brand_logo_light || '',
            logoDark: res.data.brand_logo_dark || '',
        })
    }), [])

    useEffect(() => { load() }, [load])

    /*
     * The measured result of the chosen colour, from the same code that paints
     * the page. Cleared inside the fetch rather than before it, so the swatch
     * does not blink to nothing between keystrokes.
     */
    useEffect(() => {
        const hex = form?.colour
        let alive = true
        Promise.resolve(hex ? previewColour(hex) : { data: null })
            .then((res) => { if (alive) setPalette(res.data ?? null) })
        return () => { alive = false }
    }, [form?.colour])

    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 6000)
        return () => clearTimeout(t)
    }, [message])

    const pickLogo = async (which, file) => {
        if (!file) return
        setBusy(which)
        try {
            const url = await upload(file)
            setForm((f) => ({ ...f, [which]: url }))
            setMessage({ type: 'success', text: 'Logo uploaded. Save to use it.' })
        } catch (e) {
            setMessage({ type: 'error', text: e.message })
        }
        setBusy('')
    }

    const submit = async () => {
        setBusy('save')
        const res = await saveBrand(form)
        setBusy('')
        setMessage(res.error ? { type: 'error', text: res.error } : { type: 'success', text: res.success })
    }

    if (!form) {
        return <div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    }

    return (
        <div className="max-w-4xl mx-auto p-6">
            <div className="mb-6 flex items-start gap-3">
                <Palette className="h-7 w-7 text-muted-foreground mt-1" />
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Brand</h1>
                    <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                        The name on the tab and the login screen, the logo in the rail, and the colour the whole app
                        takes its accents from. This deployment is one restaurant, so changing these here is the
                        whole of handing the POS to another one.
                    </p>
                </div>
            </div>

            <SettingsTabs active="brand" />

            {message.type && (
                <div className={`flex items-start gap-3 p-4 mb-5 rounded-lg border text-sm ${message.type === 'error'
                    ? 'bg-danger-soft border-danger-border text-danger-text'
                    : 'bg-success-soft border-success-border text-success-text'}`}
                >
                    {message.type === 'error' ? <AlertTriangle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
                    {message.text}
                </div>
            )}

            <div className="bg-surface rounded-xl border border-border p-5 space-y-5">
                <div>
                    <label className="block text-sm font-medium text-foreground mb-1" htmlFor="brand_name">Name</label>
                    <input
                        id="brand_name"
                        className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                        value={form.name}
                        maxLength={96}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                        Shown on the browser tab, the login screen, the customer menu and the printed reports. The
                        name that goes on the BILL is the merchant name, under General.
                    </p>
                </div>

                <div>
                    <label className="block text-sm font-medium text-foreground mb-1" htmlFor="brand_tagline">Tagline</label>
                    <input
                        id="brand_tagline"
                        className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                        value={form.tagline}
                        maxLength={96}
                        placeholder="Authentic Pakistani Cuisine"
                        onChange={(e) => setForm((f) => ({ ...f, tagline: e.target.value }))}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                        The line under the logo on the customer menu. Left empty, no line is drawn — this was
                        fixed text in the code until now, which meant every restaurant&rsquo;s menu described this
                        one&rsquo;s food.
                    </p>
                </div>

                <div>
                    <label className="block text-sm font-medium text-foreground mb-1" htmlFor="brand_colour">Colour</label>
                    <div className="flex items-center gap-3">
                        <input
                            id="brand_colour"
                            type="color"
                            className="h-11 w-16 rounded-lg border border-border bg-background"
                            value={form.colour || '#f26513'}
                            onChange={(e) => setForm((f) => ({ ...f, colour: e.target.value }))}
                        />
                        <input
                            className="flex-1 min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground font-mono"
                            placeholder="#a83f08 — leave blank for the built-in orange"
                            value={form.colour}
                            onChange={(e) => setForm((f) => ({ ...f, colour: e.target.value }))}
                        />
                        {form.colour && (
                            <button
                                type="button"
                                className="px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground"
                                onClick={() => setForm((f) => ({ ...f, colour: '' }))}
                            >
                                Reset
                            </button>
                        )}
                    </div>

                    {palette && (
                        <div className="mt-3 rounded-lg border border-border overflow-hidden">
                            <div className="grid grid-cols-2">
                                <div className="p-4" style={{ background: '#0a0a0a' }}>
                                    <p className="text-xs uppercase tracking-wide mb-2" style={{ color: '#9ca3af' }}>Dark theme</p>
                                    <span
                                        className="inline-block px-3 py-2 rounded-lg text-sm font-semibold"
                                        style={{ background: palette.dark, color: palette.darkForeground }}
                                    >
                                        Send &amp; Pay Now
                                    </span>
                                    <p className="mt-2 text-xs" style={{ color: palette.dark }}>
                                        {palette.dark} · {palette.ratios.darkOnBlack}:1 on the page
                                    </p>
                                </div>
                                <div className="p-4" style={{ background: '#fffdf9' }}>
                                    <p className="text-xs uppercase tracking-wide mb-2" style={{ color: '#5d564f' }}>Light theme</p>
                                    <span
                                        className="inline-block px-3 py-2 rounded-lg text-sm font-semibold"
                                        style={{ background: palette.light, color: palette.lightForeground }}
                                    >
                                        Send &amp; Pay Now
                                    </span>
                                    <p className="mt-2 text-xs" style={{ color: palette.light }}>
                                        {palette.light} · {palette.ratios.lightOnCard}:1 on a card
                                    </p>
                                </div>
                            </div>
                            <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
                                Measured, not guessed. The light theme gets a darker version of your colour so it
                                stays readable as text on white, and the label is white or near-black depending on
                                which one your colour can actually carry.
                            </p>
                        </div>
                    )}
                </div>

                {[['logoLight', 'Logo for dark backgrounds', 'The rail and the kitchen display are dark, so this one usually has white or light artwork.'],
                  ['logoDark', 'Logo for light backgrounds', 'Used where the page is light — the customer menu, and the rail in light mode.']].map(([key, label, hint]) => (
                    <div key={key}>
                        <p className="text-sm font-medium text-foreground">{label}</p>
                        <p className="text-xs text-muted-foreground mb-2">{hint}</p>
                        <div className="flex items-center gap-3">
                            <div
                                className="h-14 w-40 rounded-lg border border-border flex items-center justify-center overflow-hidden"
                                style={{ background: key === 'logoLight' ? '#0a0a0a' : '#fffdf9' }}
                            >
                                {form[key]
                                    ? <Image src={form[key]} alt="" width={140} height={44} style={{ objectFit: 'contain', maxHeight: 44 }} unoptimized />
                                    : <span className="text-xs text-muted-foreground">the name, as text</span>}
                            </div>
                            <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm cursor-pointer text-muted-foreground hover:text-foreground">
                                <Upload className="h-4 w-4" />
                                {busy === key ? 'Uploading…' : 'Upload'}
                                <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => pickLogo(key, e.target.files?.[0])}
                                />
                            </label>
                            {form[key] && (
                                <button
                                    type="button"
                                    className="px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground"
                                    onClick={() => setForm((f) => ({ ...f, [key]: '' }))}
                                >
                                    Remove
                                </button>
                            )}
                        </div>
                    </div>
                ))}

                <div className="pt-4 border-t border-border flex justify-end">
                    <button
                        type="button"
                        onClick={submit}
                        disabled={busy === 'save'}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40"
                    >
                        <Save className="h-4 w-4" />{busy === 'save' ? 'Saving…' : 'Save brand'}
                    </button>
                </div>
            </div>
        </div>
    )
}

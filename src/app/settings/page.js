'use client'

import { useState, useEffect, useMemo } from 'react'
import { getSettings, updateSettings } from './actions'
import { Save, Loader2, CreditCard, Building, MapPin, CheckCircle2, AlertTriangle, QrCode } from 'lucide-react'

// EMVCo caps these fields, and emvco.js silently truncates the name at 25 —
// better to stop typing at the limit than to let a name look saved and then
// come out clipped on the customer's QR screen.
const MAX_NAME = 25
const MAX_CITY = 15

const EMPTY = {
    merchant_name: '',
    merchant_city: '',
    raast_id: '',
    qr_enabled: true,
    auto_print: true,
}

/*
 * A labelled on/off row. Extracted because there are two of them now and the
 * knob geometry is fiddly enough that stating it in one place is worth more than
 * spelling out each row.
 */
function SettingSwitch({ label, hint, checked, onToggle }) {
    return (
        <div className="mb-6 flex items-center gap-4 p-4 rounded-lg bg-gray-800/40 border border-gray-700/50">
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-200">{label}</p>
                <p className="mt-0.5 text-xs text-gray-400">{hint}</p>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={label}
                onClick={onToggle}
                className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-orange-500/40 ${checked ? 'bg-orange-600' : 'bg-gray-600'
                    }`}
            >
                {/* Geometry stated outright rather than left to the knob's static
                    position: inset 2px on both sides of a 44px track holding a
                    20px knob leaves exactly 20px of travel. */}
                <span
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'
                        }`}
                />
            </button>
        </div>
    )
}

export default function SettingsPage() {
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [settings, setSettings] = useState(EMPTY)
    const [saved, setSaved] = useState(EMPTY)

    useEffect(() => {
        getSettings().then(data => {
            const next = { ...EMPTY, ...(data || {}) }
            // Absent (migration not yet run) or null both mean "enabled", so the
            // toggle can't render as off against a database that has no opinion.
            next.qr_enabled = next.qr_enabled !== false
            next.auto_print = next.auto_print !== false
            setSettings(next)
            setSaved(next)
            setLoading(false)
        })
    }, [])

    // Clear a success note on its own; errors stay until the next attempt.
    useEffect(() => {
        if (message.type !== 'success') return
        const timer = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(timer)
    }, [message])

    const isDirty = useMemo(
        () => ['merchant_name', 'merchant_city', 'raast_id']
            .some(k => (settings[k] || '').trim() !== (saved[k] || '').trim())
            || settings.qr_enabled !== saved.qr_enabled
            || settings.auto_print !== saved.auto_print,
        [settings, saved]
    )

    // Two independent reasons a receipt might carry no QR: switched off, or no
    // identifier to encode. Both are worth saying outright rather than leaving
    // to be discovered at the till.
    const hasRaastId = Boolean((settings.raast_id || '').trim())
    const qrReady = settings.qr_enabled && hasRaastId

    const handleSubmit = async (formData) => {
        setSaving(true)
        setMessage({ type: '', text: '' })

        const result = await updateSettings(formData)

        if (result.error) {
            setMessage({ type: 'error', text: result.error })
        } else {
            setMessage({ type: 'success', text: result.success })
            setSaved(settings)
        }
        setSaving(false)
    }

    const handleChange = (e) => {
        setSettings(prev => ({ ...prev, [e.target.name]: e.target.value }))
    }

    if (loading) {
        return (
            <div className="max-w-4xl mx-auto p-6 space-y-6" aria-busy="true">
                <div className="skeleton" style={{ height: '2.25rem', width: '14rem' }} />
                <div className="skeleton" style={{ height: '22rem' }} />
            </div>
        )
    }

    const fieldClass =
        'w-full pl-10 pr-4 py-2.5 rounded-lg bg-gray-800/50 border border-gray-700/50 text-gray-100 placeholder-gray-500 outline-none transition-all focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20'

    return (
        <div className="max-w-4xl mx-auto p-6">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-bold text-white">Store Settings</h1>
                <p className="mt-1 text-sm text-gray-400">
                    Merchant details used for Raast QR payments on receipts.
                </p>
            </div>

            {/* Tax rates, service charge, and FBR live on their own tab. */}
            <div className="mb-6 flex gap-2">
                <span className="px-4 py-2 rounded-lg text-sm bg-orange-600 text-white font-semibold">General</span>
                <a href="/settings/tax" className="px-4 py-2 rounded-lg text-sm bg-gray-900/70 border border-gray-800 text-gray-300 hover:text-white">
                    Tax &amp; FBR
                </a>
            </div>

            <div className="bg-gray-900 rounded-xl shadow-sm border border-gray-800 p-6">
                <div className="flex items-start gap-4 mb-6">
                    <div className="h-12 w-12 bg-orange-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <CreditCard className="h-6 w-6 text-orange-500" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-xl font-semibold text-white">Payment &amp; Merchant Info</h2>
                        <p className="text-sm text-gray-400">Configure your payment details for QR codes</p>
                    </div>

                    <div
                        className={`ml-auto flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border whitespace-nowrap ${qrReady
                            ? 'bg-green-900/20 border-green-800/50 text-green-400'
                            : 'bg-amber-900/20 border-amber-800/50 text-amber-400'
                            }`}
                    >
                        <QrCode className="h-3.5 w-3.5" />
                        {qrReady ? 'QR active' : settings.qr_enabled ? 'QR needs an ID' : 'QR off'}
                    </div>
                </div>

                <SettingSwitch
                    label="Print payment QR on receipts"
                    hint="Turn off for card- or cash-only service. Your Raast ID is kept, so this can be switched back on without re-entering it."
                    checked={settings.qr_enabled}
                    onToggle={() => setSettings(prev => ({ ...prev, qr_enabled: !prev.qr_enabled }))}
                />

                <SettingSwitch
                    label="Print receipt automatically on payment"
                    hint="Paper comes out as the sale is saved, with no extra tap. Turn off if the printer is jammed or out of roll — you can still reprint any order from the Orders screen."
                    checked={settings.auto_print}
                    onToggle={() => setSettings(prev => ({ ...prev, auto_print: !prev.auto_print }))}
                />

                {settings.qr_enabled && !hasRaastId && (
                    <div className="mb-6 flex items-start gap-3 p-4 rounded-lg bg-amber-900/15 border border-amber-800/40">
                        <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-amber-200/90">
                            QR printing is on, but there&apos;s no Raast ID to encode — receipts will print without a
                            code until you add one below.
                        </p>
                    </div>
                )}

                <form action={handleSubmit} className="space-y-6">
                    {/* Explicit value: an unchecked checkbox submits nothing, which
                        the action can't tell apart from a missing field. */}
                    <input type="hidden" name="qr_enabled" value={settings.qr_enabled ? 'true' : 'false'} />
                    <input type="hidden" name="auto_print" value={settings.auto_print ? 'true' : 'false'} />
                    <div className="grid gap-6 md:grid-cols-2">
                        <div>
                            <div className="flex items-baseline justify-between mb-1.5">
                                <label htmlFor="merchant_name" className="block text-sm font-medium text-gray-300">
                                    Merchant Name
                                </label>
                                <span className="text-xs text-gray-500 tabular-nums">
                                    {(settings.merchant_name || '').length}/{MAX_NAME}
                                </span>
                            </div>
                            <div className="relative">
                                <Building className="absolute left-3 top-3 h-5 w-5 text-gray-500 pointer-events-none" />
                                <input
                                    id="merchant_name"
                                    type="text"
                                    name="merchant_name"
                                    value={settings.merchant_name || ''}
                                    onChange={handleChange}
                                    maxLength={MAX_NAME}
                                    autoComplete="off"
                                    className={fieldClass}
                                    placeholder="Flames by the Indus"
                                />
                            </div>
                            <p className="mt-1.5 text-xs text-gray-500">Displayed on the QR code scan screen.</p>
                        </div>

                        <div>
                            <div className="flex items-baseline justify-between mb-1.5">
                                <label htmlFor="merchant_city" className="block text-sm font-medium text-gray-300">
                                    City
                                </label>
                                <span className="text-xs text-gray-500 tabular-nums">
                                    {(settings.merchant_city || '').length}/{MAX_CITY}
                                </span>
                            </div>
                            <div className="relative">
                                <MapPin className="absolute left-3 top-3 h-5 w-5 text-gray-500 pointer-events-none" />
                                <input
                                    id="merchant_city"
                                    type="text"
                                    name="merchant_city"
                                    value={settings.merchant_city || ''}
                                    onChange={handleChange}
                                    maxLength={MAX_CITY}
                                    autoComplete="off"
                                    className={fieldClass}
                                    placeholder="Islamabad"
                                />
                            </div>
                            <p className="mt-1.5 text-xs text-gray-500">Defaults to Islamabad if left empty.</p>
                        </div>

                        <div className="md:col-span-2">
                            <label htmlFor="raast_id" className="block text-sm font-medium text-gray-300 mb-1.5">
                                Raast ID / IBAN / Merchant ID
                            </label>
                            <div className="relative">
                                <div className="absolute left-3 top-3 h-5 w-5 flex items-center justify-center font-bold text-gray-500 text-xs border border-gray-600 rounded-sm pointer-events-none">
                                    R
                                </div>
                                <input
                                    id="raast_id"
                                    type="text"
                                    name="raast_id"
                                    value={settings.raast_id || ''}
                                    onChange={handleChange}
                                    autoComplete="off"
                                    spellCheck={false}
                                    // Comfortably past the 24 of a Pakistani IBAN, and far
                                    // short of the length the QR encoder has to reject.
                                    maxLength={50}
                                    className={`${fieldClass} font-mono tracking-wide`}
                                    placeholder="03475369008"
                                />
                            </div>
                            <p className="mt-1.5 text-xs text-gray-500">
                                The unique identifier (Phone, IBAN, or Merchant ID) linked to your Raast account.
                            </p>
                        </div>
                    </div>

                    {message.type && (
                        <div
                            role="status"
                            aria-live="polite"
                            className={`flex items-start gap-3 p-4 rounded-lg border text-sm ${message.type === 'error'
                                ? 'bg-red-900/20 border-red-800/50 text-red-300'
                                : 'bg-green-900/20 border-green-800/50 text-green-300'
                                }`}
                        >
                            {message.type === 'error'
                                ? <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-px" />
                                : <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-px" />}
                            {message.text}
                        </div>
                    )}

                    <div className="flex items-center justify-end gap-4 pt-5 border-t border-gray-800">
                        <span className="text-xs text-gray-500 mr-auto">
                            {isDirty ? 'Unsaved changes' : 'All changes saved'}
                        </span>
                        <button
                            type="submit"
                            disabled={saving || !isDirty}
                            className="flex items-center gap-2 px-6 py-2.5 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-lg transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {saving ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Save className="h-4 w-4" />
                                    Save Settings
                                </>
                            )}
                        </button>
                    </div>
                </form>
            </div>

        </div>
    )
}

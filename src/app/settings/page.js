'use client'

import { useState, useEffect, useMemo } from 'react'
import { getSettings, updateSettings } from './actions'
import { Save, Loader2, CreditCard, Building, MapPin, CheckCircle2, AlertTriangle, QrCode, Banknote, Scale, Phone } from 'lucide-react'
import SettingsTabs from '@/components/settings/SettingsTabs'
import { SettingSwitch } from '@/components/settings/controls'

// EMVCo caps these fields, and emvco.js silently truncates the name at 25 —
// better to stop typing at the limit than to let a name look saved and then
// come out clipped on the customer's QR screen.
const MAX_NAME = 25
const MAX_CITY = 15

const EMPTY = {
    merchant_name: '',
    merchant_city: '',
    merchant_address: '',
    merchant_phone: '',
    raast_id: '',
    qr_enabled: true,
    void_requires_pin: false,
    cash_change: true,
    default_opening_float: 0,
    cash_variance_tolerance: 0,
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
            next.cash_change = next.cash_change !== false
            next.void_requires_pin = next.void_requires_pin === true
            // Cash policy: a row from before the columns existed reads as zero,
            // which is exactly today's behaviour — propose no float, explain
            // every difference.
            next.default_opening_float = Number(next.default_opening_float) || 0
            next.cash_variance_tolerance = Number(next.cash_variance_tolerance) || 0
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
        () => ['merchant_name', 'merchant_city', 'merchant_address', 'merchant_phone', 'raast_id']
            .some(k => (settings[k] || '').trim() !== (saved[k] || '').trim())
            || settings.qr_enabled !== saved.qr_enabled
            || settings.cash_change !== saved.cash_change
            || settings.void_requires_pin !== saved.void_requires_pin
            || Number(settings.default_opening_float || 0) !== Number(saved.default_opening_float || 0)
            || Number(settings.cash_variance_tolerance || 0) !== Number(saved.cash_variance_tolerance || 0),
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
        'w-full pl-10 pr-4 py-2.5 rounded-lg bg-surface-raise border border-input text-foreground placeholder-muted outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary-soft-strong'

    return (
        <div className="max-w-4xl mx-auto p-6">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Store Settings</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    Merchant details, cash policy, and who may void a line.
                </p>
            </div>

            <SettingsTabs active="general" />

            <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
                <div className="flex items-start gap-4 mb-6">
                    <div className="h-12 w-12 bg-primary-soft rounded-full flex items-center justify-center flex-shrink-0">
                        <CreditCard className="h-6 w-6 text-primary" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-xl font-semibold text-card-foreground">Payment &amp; Merchant Info</h2>
                        <p className="text-sm text-muted-foreground">Configure your payment details for QR codes</p>
                    </div>

                    <div
                        className={`ml-auto flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border whitespace-nowrap ${qrReady
                            ? 'bg-success-soft border-success-border text-success-text'
                            : 'bg-warning-soft border-warning-border text-warning-text'
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
                    label="Ask for cash received, and work out the change"
                    hint="The checkout asks what the customer handed over and shows the change due — and both go on the receipt and into the sale, so a short drawer at close can be explained. Turn off for a counter that only takes exact or card payments."
                    checked={settings.cash_change}
                    onToggle={() => setSettings(prev => ({ ...prev, cash_change: !prev.cash_change }))}
                />

                <SettingSwitch
                    label="Ask for a manager PIN to remove an item"
                    hint="Taking a line off a bill then needs someone who can void (a manager or admin) to enter their PIN. Stops items being quietly dropped off a cart — the person removing the line needs the PIN even if they are signed in themselves."
                    checked={settings.void_requires_pin}
                    onToggle={() => setSettings(prev => ({ ...prev, void_requires_pin: !prev.void_requires_pin }))}
                />

                {settings.qr_enabled && !hasRaastId && (
                    <div className="mb-6 flex items-start gap-3 p-4 rounded-lg bg-warning-soft border border-warning-border">
                        <AlertTriangle className="h-5 w-5 text-warning-text flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-warning-text">
                            QR printing is on, but there&apos;s no Raast ID to encode — receipts will print without a
                            code until you add one below.
                        </p>
                    </div>
                )}

                <form action={handleSubmit} className="space-y-6">
                    {/* Explicit value: an unchecked checkbox submits nothing, which
                        the action can't tell apart from a missing field. */}
                    <input type="hidden" name="qr_enabled" value={settings.qr_enabled ? 'true' : 'false'} />
                    <input type="hidden" name="void_requires_pin" value={settings.void_requires_pin ? 'true' : 'false'} />
                    <input type="hidden" name="cash_change" value={settings.cash_change ? 'true' : 'false'} />

                    {/* Cash policy. Two numbers that shape every drawer close:
                        what it proposes to leave in the till overnight, and how
                        far a count may miss before it asks why. */}
                    <div className="grid gap-6 md:grid-cols-2">
                        <div>
                            <label htmlFor="default_opening_float" className="block text-sm font-medium text-foreground mb-1.5">
                                Standing cash float
                            </label>
                            <div className="relative">
                                <Banknote className="absolute left-3 top-3 h-5 w-5 text-muted pointer-events-none" />
                                <input
                                    id="default_opening_float"
                                    type="number"
                                    min="0"
                                    step="any"
                                    inputMode="decimal"
                                    name="default_opening_float"
                                    value={settings.default_opening_float ?? 0}
                                    onChange={handleChange}
                                    className={fieldClass}
                                    placeholder="0"
                                />
                            </div>
                            <p className="mt-1.5 text-xs text-muted">
                                The change money that normally stays in the till overnight. A drawer
                                close proposes this figure, and the next morning opens on it — so the
                                opening balance is carried forward, not retyped from memory.
                            </p>
                        </div>

                        <div>
                            <label htmlFor="cash_variance_tolerance" className="block text-sm font-medium text-foreground mb-1.5">
                                Explain a difference over
                            </label>
                            <div className="relative">
                                <Scale className="absolute left-3 top-3 h-5 w-5 text-muted pointer-events-none" />
                                <input
                                    id="cash_variance_tolerance"
                                    type="number"
                                    min="0"
                                    step="any"
                                    inputMode="decimal"
                                    name="cash_variance_tolerance"
                                    value={settings.cash_variance_tolerance ?? 0}
                                    onChange={handleChange}
                                    className={fieldClass}
                                    placeholder="0"
                                />
                            </div>
                            <p className="mt-1.5 text-xs text-muted">
                                A count that misses by more than this cannot close without a written
                                reason. Zero means every difference is explained. The difference is
                                recorded and posted to Cash Over &amp; Short whatever this is set to —
                                this only decides when someone has to type why.
                            </p>
                        </div>
                    </div>

                    <div className="grid gap-6 md:grid-cols-2">
                        <div>
                            <div className="flex items-baseline justify-between mb-1.5">
                                <label htmlFor="merchant_name" className="block text-sm font-medium text-foreground">
                                    Merchant Name
                                </label>
                                <span className="text-xs text-muted tabular-nums">
                                    {(settings.merchant_name || '').length}/{MAX_NAME}
                                </span>
                            </div>
                            <div className="relative">
                                <Building className="absolute left-3 top-3 h-5 w-5 text-muted pointer-events-none" />
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
                            <p className="mt-1.5 text-xs text-muted">Displayed on the QR code scan screen.</p>
                        </div>

                        <div>
                            <div className="flex items-baseline justify-between mb-1.5">
                                <label htmlFor="merchant_city" className="block text-sm font-medium text-foreground">
                                    City
                                </label>
                                <span className="text-xs text-muted tabular-nums">
                                    {(settings.merchant_city || '').length}/{MAX_CITY}
                                </span>
                            </div>
                            <div className="relative">
                                <MapPin className="absolute left-3 top-3 h-5 w-5 text-muted pointer-events-none" />
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
                            <p className="mt-1.5 text-xs text-muted">
                                Kept short on purpose: this is the city on the Raast QR, which
                                allows only 15 characters. The full address goes below.
                            </p>
                        </div>

                        <div className="md:col-span-2">
                            <label htmlFor="merchant_address" className="block text-sm font-medium text-foreground mb-1.5">
                                Address on the receipt
                            </label>
                            <div className="relative">
                                <MapPin className="absolute left-3 top-3 h-5 w-5 text-muted pointer-events-none" />
                                <input
                                    id="merchant_address"
                                    type="text"
                                    name="merchant_address"
                                    value={settings.merchant_address || ''}
                                    onChange={handleChange}
                                    maxLength={96}
                                    autoComplete="off"
                                    className={fieldClass}
                                    placeholder="Gulberg Arena Mall, Islamabad"
                                />
                            </div>
                            <p className="mt-1.5 text-xs text-muted">
                                Printed under the logo on every bill, in place of the city. Left
                                empty, the receipt falls back to the city above.
                            </p>
                        </div>

                        <div>
                            <label htmlFor="merchant_phone" className="block text-sm font-medium text-foreground mb-1.5">
                                Phone
                            </label>
                            <div className="relative">
                                <Phone className="absolute left-3 top-3 h-5 w-5 text-muted pointer-events-none" />
                                <input
                                    id="merchant_phone"
                                    type="tel"
                                    name="merchant_phone"
                                    value={settings.merchant_phone || ''}
                                    onChange={handleChange}
                                    maxLength={32}
                                    autoComplete="off"
                                    className={fieldClass}
                                    placeholder="0304 5666516"
                                />
                            </div>
                            <p className="mt-1.5 text-xs text-muted">
                                Printed on every receipt, so a customer can ring about a delivery
                                or a missing item. Leave empty to keep it off the bill.
                            </p>
                        </div>

                        <div className="md:col-span-2">
                            <label htmlFor="raast_id" className="block text-sm font-medium text-foreground mb-1.5">
                                Raast ID / IBAN / Merchant ID
                            </label>
                            <div className="relative">
                                <div className="absolute left-3 top-3 h-5 w-5 flex items-center justify-center font-bold text-muted text-xs border border-muted rounded-sm pointer-events-none">
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
                            <p className="mt-1.5 text-xs text-muted">
                                The unique identifier (Phone, IBAN, or Merchant ID) linked to your Raast account.
                            </p>
                        </div>
                    </div>

                    {message.type && (
                        <div
                            role="status"
                            aria-live="polite"
                            className={`flex items-start gap-3 p-4 rounded-lg border text-sm ${message.type === 'error'
                                ? 'bg-danger-soft border-danger-border text-danger-text'
                                : 'bg-success-soft border-success-border text-success-text'
                                }`}
                        >
                            {message.type === 'error'
                                ? <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-px" />
                                : <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-px" />}
                            {message.text}
                        </div>
                    )}

                    <div className="flex items-center justify-end gap-4 pt-5 border-t border-border">
                        <span className="text-xs text-muted mr-auto">
                            {isDirty ? 'Unsaved changes' : 'All changes saved'}
                        </span>
                        <button
                            type="submit"
                            disabled={saving || !isDirty}
                            className="flex items-center gap-2 px-6 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
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

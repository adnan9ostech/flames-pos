'use client'

import { useState, useEffect, useMemo } from 'react'
import { getSettings, updateSettings } from './actions'
import { adminSetPin } from '@/app/profile/actions'
import { Save, Loader2, CreditCard, Building, MapPin, CheckCircle2, AlertTriangle, QrCode, KeyRound } from 'lucide-react'

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
    // Stored as fractions; the fields below are edited as percentages. Two
    // rates because ICT taxes cash and card sales differently — which one a
    // bill pays is resolved at settle.
    tax_rate_cash: 0.16,
    tax_rate_card: 0.16,
    tax_label: 'GST',
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
    // The tax fields are edited as percentages but stored as fractions, so the
    // operator's raw text lives here while they type.
    const [taxCashInput, setTaxCashInput] = useState('')
    const [taxCardInput, setTaxCardInput] = useState('')
    // Already a percentage end to end, unlike the tax fractions above.
    const [serviceChargeInput, setServiceChargeInput] = useState('')
    const [saved, setSaved] = useState(EMPTY)

    useEffect(() => {
        getSettings().then(data => {
            const next = { ...EMPTY, ...(data || {}) }
            // Absent (migration not yet run) or null both mean "enabled", so the
            // toggle can't render as off against a database that has no opinion.
            next.qr_enabled = next.qr_enabled !== false
            next.auto_print = next.auto_print !== false
            next.tax_rate_cash = Number(next.tax_rate_cash ?? EMPTY.tax_rate_cash)
            next.tax_rate_card = Number(next.tax_rate_card ?? EMPTY.tax_rate_card)
            next.service_charge_percent = Number(next.service_charge_percent ?? 0)
            setSettings(next)
            setSaved(next)
            // Seeded here rather than in an effect: the percentage fields keep
            // the operator's raw text while typing, so a half-entered "1" on the
            // way to "16" isn't normalised under the cursor.
            setTaxCashInput(String(Number((next.tax_rate_cash * 100).toFixed(2))))
            setTaxCardInput(String(Number((next.tax_rate_card * 100).toFixed(2))))
            setServiceChargeInput(String(next.service_charge_percent))
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
        () => ['merchant_name', 'merchant_city', 'raast_id', 'tax_label']
            .some(k => (settings[k] || '').trim() !== (saved[k] || '').trim())
            || settings.qr_enabled !== saved.qr_enabled
            || settings.auto_print !== saved.auto_print
            || Number(settings.tax_rate_cash) !== Number(saved.tax_rate_cash)
            || Number(settings.tax_rate_card) !== Number(saved.tax_rate_card)
            || Number(settings.service_charge_percent) !== Number(saved.service_charge_percent),
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

    /*
     * Edited as a percentage, stored as a fraction. Kept as a separate string in
     * state while typing so a half-entered "1" on the way to "16" doesn't get
     * normalised to 0.01 under the operator's cursor. One factory, two fields.
     */

    const handleTaxRateChange = (field, setInput) => (e) => {
        const raw = e.target.value
        setInput(raw)
        const percent = Math.min(Math.max(Number(raw) || 0, 0), 100)
        setSettings(prev => ({ ...prev, [field]: percent / 100 }))
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
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-bold text-white">Store Settings</h1>
                <p className="mt-1 text-sm text-gray-400">
                    Merchant details used for Raast QR payments on receipts.
                </p>
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
                    {/* The visible fields are percentages; the stored values are the fractions. */}
                    <input type="hidden" name="tax_rate_cash" value={settings.tax_rate_cash ?? 0.16} />
                    <input type="hidden" name="tax_rate_card" value={settings.tax_rate_card ?? 0.16} />
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

                        <div>
                            <label htmlFor="tax_rate_cash_percent" className="block text-sm font-medium text-gray-300 mb-1.5">
                                GST — cash
                            </label>
                            <input
                                id="tax_rate_cash_percent"
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                inputMode="decimal"
                                value={taxCashInput}
                                onChange={handleTaxRateChange('tax_rate_cash', setTaxCashInput)}
                                autoComplete="off"
                                className={fieldClass.replace('pl-10', 'pl-4')}
                                placeholder="16"
                            />
                            <p className="mt-1.5 text-xs text-gray-500">
                                Percent charged on cash bills. Applies to new orders only — past bills keep the tax they were charged.
                            </p>
                        </div>

                        <div>
                            <label htmlFor="tax_rate_card_percent" className="block text-sm font-medium text-gray-300 mb-1.5">
                                GST — card/digital
                            </label>
                            <input
                                id="tax_rate_card_percent"
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                inputMode="decimal"
                                value={taxCardInput}
                                onChange={handleTaxRateChange('tax_rate_card', setTaxCardInput)}
                                autoComplete="off"
                                className={fieldClass.replace('pl-10', 'pl-4')}
                                placeholder="5"
                            />
                            <p className="mt-1.5 text-xs text-gray-500">
                                The ICT differential rate for card and digital payments — resolved when the bill settles.
                            </p>
                        </div>

                        <div>
                            <label htmlFor="service_charge_percent" className="block text-sm font-medium text-gray-300 mb-1.5">
                                Service charge
                            </label>
                            <input
                                id="service_charge_percent"
                                type="number"
                                name="service_charge_percent"
                                min="0"
                                max="100"
                                step="0.5"
                                inputMode="decimal"
                                value={serviceChargeInput}
                                onChange={(e) => {
                                    setServiceChargeInput(e.target.value)
                                    setSettings(s => ({ ...s, service_charge_percent: Number(e.target.value) || 0 }))
                                }}
                                autoComplete="off"
                                className={fieldClass.replace('pl-10', 'pl-4')}
                                placeholder="5"
                            />
                            <p className="mt-1.5 text-xs text-gray-500">
                                Percent added automatically to dine-in bills, taxed like the food. 0 switches it off; scope and more charges live under Charges.
                            </p>
                        </div>

                        <div>
                            <label htmlFor="tax_label" className="block text-sm font-medium text-gray-300 mb-1.5">
                                Tax name
                            </label>
                            <input
                                id="tax_label"
                                type="text"
                                name="tax_label"
                                value={settings.tax_label || ''}
                                onChange={handleChange}
                                maxLength={16}
                                autoComplete="off"
                                className={fieldClass.replace('pl-10', 'pl-4')}
                                placeholder="GST"
                            />
                            <p className="mt-1.5 text-xs text-gray-500">Shown on the receipt tax line.</p>
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

            <StaffPinCard />
        </div>
    )
}

/*
 * PINs are set here by an admin for both shared accounts — there is no
 * "current PIN" prompt, because the admin gate on the action is the authority
 * and a forgotten staff PIN is exactly what this card exists to fix. Setting
 * one bumps that account's pin_version, so every other device signed in as
 * that role is logged out at its next action.
 */
function StaffPinCard() {
    const [role, setRole] = useState('staff')
    const [pin, setPin] = useState('')
    const [confirm, setConfirm] = useState('')
    const [busy, setBusy] = useState(false)
    const [note, setNote] = useState({ type: '', text: '' })

    // The login pad accepts exactly six digits, so nothing else may be stored.
    const digitsOnly = (value) => value.replace(/\D/g, '').slice(0, 6)

    const fieldClass =
        'w-full px-4 py-2.5 rounded-lg bg-gray-800/50 border border-gray-700/50 text-gray-100 placeholder-gray-500 outline-none transition-all focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 font-mono tracking-widest'

    const handleSubmit = async (e) => {
        e.preventDefault()
        setNote({ type: '', text: '' })

        if (!/^\d{6}$/.test(pin)) {
            setNote({ type: 'error', text: 'PIN must be exactly 6 digits' })
            return
        }
        if (pin !== confirm) {
            setNote({ type: 'error', text: 'PINs do not match' })
            return
        }

        setBusy(true)
        const res = await adminSetPin(role, pin)
        if (res?.error) {
            setNote({ type: 'error', text: res.error })
        } else {
            setNote({
                type: 'success',
                text: `${role === 'admin' ? 'Admin' : 'Staff'} PIN updated — other devices on that account will need to sign in again.`,
            })
            setPin('')
            setConfirm('')
        }
        setBusy(false)
    }

    return (
        <div className="bg-gray-900 rounded-xl shadow-sm border border-gray-800 p-6 mt-6">
            <div className="flex items-start gap-4 mb-6">
                <div className="h-12 w-12 bg-orange-900/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <KeyRound className="h-6 w-6 text-orange-500" />
                </div>
                <div className="min-w-0">
                    <h2 className="text-xl font-semibold text-white">Staff PIN</h2>
                    <p className="text-sm text-gray-400">
                        Set the sign-in PIN for either shared account. Changing one signs that
                        account out everywhere else.
                    </p>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                    <span className="block text-sm font-medium text-gray-300 mb-1.5">Account</span>
                    <div className="flex gap-2">
                        {[['admin', 'Admin'], ['staff', 'Staff']].map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={role === value}
                                onClick={() => setRole(value)}
                                className={`px-5 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${role === value
                                    ? 'bg-orange-600 border-orange-500 text-white'
                                    : 'bg-gray-800/50 border-gray-700/50 text-gray-300 hover:bg-gray-800'
                                    }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid gap-6 md:grid-cols-2">
                    <div>
                        <label htmlFor="pin_new" className="block text-sm font-medium text-gray-300 mb-1.5">
                            New PIN
                        </label>
                        <input
                            id="pin_new"
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={6}
                            value={pin}
                            onChange={(e) => setPin(digitsOnly(e.target.value))}
                            className={fieldClass}
                            placeholder="••••••"
                        />
                        <p className="mt-1.5 text-xs text-gray-500">Exactly 6 digits — the login pad accepts nothing else.</p>
                    </div>

                    <div>
                        <label htmlFor="pin_confirm" className="block text-sm font-medium text-gray-300 mb-1.5">
                            Confirm PIN
                        </label>
                        <input
                            id="pin_confirm"
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={6}
                            value={confirm}
                            onChange={(e) => setConfirm(digitsOnly(e.target.value))}
                            className={fieldClass}
                            placeholder="••••••"
                        />
                    </div>
                </div>

                {note.type && (
                    <div
                        role="status"
                        aria-live="polite"
                        className={`flex items-start gap-3 p-4 rounded-lg border text-sm ${note.type === 'error'
                            ? 'bg-red-900/20 border-red-800/50 text-red-300'
                            : 'bg-green-900/20 border-green-800/50 text-green-300'
                            }`}
                    >
                        {note.type === 'error'
                            ? <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-px" />
                            : <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-px" />}
                        {note.text}
                    </div>
                )}

                <div className="flex items-center justify-end pt-5 border-t border-gray-800">
                    <button
                        type="submit"
                        disabled={busy || !pin || !confirm}
                        className="flex items-center gap-2 px-6 py-2.5 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-lg transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {busy ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Setting...
                            </>
                        ) : (
                            <>
                                <KeyRound className="h-4 w-4" />
                                Set PIN
                            </>
                        )}
                    </button>
                </div>
            </form>
        </div>
    )
}

'use client'

import { useState, useEffect, useMemo } from 'react'
import { getSettings, updateSettings } from './actions'
import { KOT_MODES, DEFAULT_KOT_MODE } from '@/lib/kotPrint'
import { Save, Loader2, CreditCard, Building, MapPin, CheckCircle2, AlertTriangle, QrCode, Banknote, Scale } from 'lucide-react'

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
    receipt_width_mm: 80,
    kot_mode: DEFAULT_KOT_MODE,
    default_opening_float: 0,
    cash_variance_tolerance: 0,
}

/*
 * The two paper widths thermal printers are actually sold in. The receipt
 * lays out at whichever is chosen — the preview, the print rule and the page
 * handed to the printer all read one value — so picking the wrong one is
 * visible on screen before any paper is wasted.
 */
const PAPER_WIDTHS = [
    { value: 80, label: '80 mm', hint: 'The usual counter printer' },
    { value: 58, label: '58 mm', hint: 'Pocket and Bluetooth printers' },
]

/*
 * How a round is cut into kitchen tickets. Both are ordinary kitchen practice
 * and neither is a subset of the other, so the hints state the real cost
 * rather than nudging: the difference on a big table is 12 pieces of paper
 * against 4, and that is felt at the printer, not in this screen.
 */
const KOT_MODE_OPTIONS = [
    {
        value: 'item',
        label: 'Per item',
        hint: 'One ticket per line, so a ticket travels with each dish. A 12-line order prints 12 tickets — much more paper.',
    },
    {
        value: 'category',
        label: 'Per station',
        hint: 'One ticket per section in the round; each section gets its whole list at once. That same 12-line order prints about 4.',
    },
]

/*
 * A labelled on/off row. Extracted because there are two of them now and the
 * knob geometry is fiddly enough that stating it in one place is worth more than
 * spelling out each row.
 */
function SettingSwitch({ label, hint, checked, onToggle }) {
    return (
        <div className="mb-6 flex items-center gap-4 p-4 rounded-lg bg-surface-raise border border-input">
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={label}
                onClick={onToggle}
                className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-focus ${checked ? 'bg-primary' : 'bg-muted'
                    }`}
            >
                {/* Geometry stated outright rather than left to the knob's static
                    position: inset 2px on both sides of a 44px track holding a
                    20px knob leaves exactly 20px of travel.

                    The knob is deliberately a literal white, not a surface token:
                    it rides on a coloured track in both themes (--primary when on,
                    --muted when off), so a knob that flipped with the theme would
                    vanish into the light-mode track. */}
                <span
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'
                        }`}
                />
            </button>
        </div>
    )
}

/*
 * A row of mutually exclusive choices — the shape both paper width and ticket
 * mode want. Buttons rather than radios because each option carries a line of
 * explanation and the whole card has to be a 44px target on a till; aria-pressed
 * on a button group says the same thing to a screen reader that a radio would.
 */
function ChoiceGroup({ label, hint, options, value, onSelect }) {
    return (
        <div className="rounded-lg bg-surface-raise border border-input p-4">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {options.map(option => {
                    const on = value === option.value
                    return (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => onSelect(option.value)}
                            aria-pressed={on}
                            className={`min-h-[44px] rounded-lg border px-4 py-2.5 text-left transition-colors ${on
                                ? 'border-primary bg-primary-soft text-primary'
                                : 'border-input bg-surface text-foreground hover:border-primary'
                                }`}
                        >
                            <span className="block text-sm font-semibold">{option.label}</span>
                            <span className={`block text-xs ${on ? 'text-foreground' : 'text-muted-foreground'}`}>
                                {option.hint}
                            </span>
                        </button>
                    )
                })}
            </div>
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
            // A database with no opinion (or an older row) means the counter
            // printer, which is what the restaurant had first.
            next.receipt_width_mm = Number(next.receipt_width_mm) === 58 ? 58 : 80
            // Same posture: a row from before the column existed reads as the
            // default rather than rendering neither option as chosen.
            next.kot_mode = KOT_MODES.includes(next.kot_mode) ? next.kot_mode : DEFAULT_KOT_MODE
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
        () => ['merchant_name', 'merchant_city', 'raast_id']
            .some(k => (settings[k] || '').trim() !== (saved[k] || '').trim())
            || settings.qr_enabled !== saved.qr_enabled
            || settings.auto_print !== saved.auto_print
            || Number(settings.receipt_width_mm) !== Number(saved.receipt_width_mm)
            || settings.kot_mode !== saved.kot_mode
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
                    Merchant details used for Raast QR payments on receipts.
                </p>
            </div>

            {/* Tax rates, service charge, and FBR live on their own tab. */}
            <div className="mb-6 flex gap-2">
                <span className="px-4 py-2 rounded-lg text-sm bg-primary text-primary-foreground font-semibold">General</span>
                <a href="/settings/tax" className="px-4 py-2 rounded-lg text-sm bg-surface border border-border text-foreground hover:text-card-foreground">
                    Tax &amp; FBR
                </a>
            </div>

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
                    label="Print receipt automatically on payment"
                    hint="Paper comes out as the sale is saved, with no extra tap. Turn off if the printer is jammed or out of roll — you can still reprint any order from the Orders screen."
                    checked={settings.auto_print}
                    onToggle={() => setSettings(prev => ({ ...prev, auto_print: !prev.auto_print }))}
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
                    <input type="hidden" name="auto_print" value={settings.auto_print ? 'true' : 'false'} />
                    <input type="hidden" name="receipt_width_mm" value={settings.receipt_width_mm} />
                    <input type="hidden" name="kot_mode" value={settings.kot_mode} />

                    {/* Paper width. A choice, not a number field: there are two
                        sizes on the market and typing 57 would quietly produce
                        a receipt that never fits anything. */}
                    <ChoiceGroup
                        label="Receipt paper width"
                        hint="Measure the roll, not the printer. The bill is laid out at this width, so the preview on screen is exactly what comes out of the machine."
                        options={PAPER_WIDTHS}
                        value={Number(settings.receipt_width_mm)}
                        onSelect={mm => setSettings(prev => ({ ...prev, receipt_width_mm: mm }))}
                    />

                    <ChoiceGroup
                        label="Kitchen ticket printing"
                        hint="How a round is cut into slips when it is sent to the kitchen. Per item is on because it is what the kitchen asked for; switch back any time — the till picks the change up on its next load, and reprints from the Kitchen Display follow whatever is set here."
                        options={KOT_MODE_OPTIONS}
                        value={settings.kot_mode}
                        onSelect={mode => setSettings(prev => ({ ...prev, kot_mode: mode }))}
                    />

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
                            <p className="mt-1.5 text-xs text-muted">Defaults to Islamabad if left empty.</p>
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

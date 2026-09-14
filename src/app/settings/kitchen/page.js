'use client'

import { useState, useEffect, useMemo } from 'react'
import { Save, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { getSettings } from '../actions'
import { updateKitchenSettings } from './actions'
import { KOT_MODES, DEFAULT_KOT_MODE } from '@/lib/kotPrint'
import SettingsTabs from '@/components/settings/SettingsTabs'
import PrinterPanel from '@/components/settings/PrinterPanel'
import { SettingSwitch, ChoiceGroup } from '@/components/settings/controls'

const PAPER_WIDTHS = [
    { value: 80, label: '80 mm', hint: 'The usual counter printer' },
    { value: 58, label: '58 mm', hint: 'Pocket and Bluetooth printers' },
]

const KOT_ROUTE_OPTIONS = [
    {
        value: 'kds',
        label: 'Kitchen display',
        hint: 'The till prints only the customer receipt; the Kitchen Display prints each order on its own printer. Needs a screen (or a second device) in the kitchen.',
    },
    {
        value: 'till',
        label: 'The till itself',
        hint: 'One counter, one printer: the till prints the kitchen slips and the receipt on the same machine. Use this only when there is no kitchen screen.',
    },
]

const KOT_MODE_OPTIONS = [
    {
        value: 'item',
        label: 'Per item',
        hint: 'One ticket per line, so a ticket travels with each dish. A 12-line order prints 12 tickets — much more paper.',
    },
    {
        value: 'category',
        label: 'Per station',
        hint: 'One ticket per section; each section gets its whole list at once. That same 12-line order prints about 4.',
    },
]

/*
 * How a terminal reaches paper. The counter printer is a raw ESC/POS device:
 * it understands the agent's bytes and does NOT understand a browser's page,
 * which arrives as PostScript and prints as source code. So this is not a
 * preference between two working paths — on thermal hardware only one works.
 */
const TRANSPORT_OPTIONS = [
    {
        value: 'agent',
        label: 'Thermal print agent',
        hint: 'Raw ESC/POS to a thermal printer via the local agent — the correct setting for the counter printer. If the agent is not running, the till says so rather than printing rubbish.',
    },
    {
        value: 'browser',
        label: 'Browser',
        hint: 'window.print() through the operating system. Only for an ordinary page printer — on a thermal printer this prints pages of PostScript source.',
    },
]

/*
 * When the cash drawer opens on its own. The drawer is wired to the printer,
 * not to the till, so this is a per-restaurant rule the agent enforces — see
 * migration 023.
 */
const DRAWER_OPTIONS = [
    {
        value: 'cash',
        label: 'On cash sales',
        hint: 'The drawer opens when the bill is paid in cash — the moment there is money to put in or change to take out. Card and city-ledger bills leave it shut.',
    },
    {
        value: 'always',
        label: 'On every sale',
        hint: 'Opens on every completed order whatever the payment mode. For a counter that keeps one drawer for everything.',
    },
    {
        value: 'never',
        label: 'Never',
        hint: 'No drawer attached, or the counter opens it by hand. Nothing is ever sent to the printer.',
    },
]

const DRAWER_PIN_OPTIONS = [
    { value: 2, label: 'Pin 2', hint: 'Standard wiring — try this first. Almost every drawer sold uses it.' },
    { value: 5, label: 'Pin 5', hint: 'Epson-style twin-drawer wiring. Use only if the printer clicks and the drawer stays shut on Pin 2.' },
]

const COPY_OPTIONS = [
    { value: 2, label: 'Two copies', hint: 'Customer copy and restaurant copy, each cut off separately. The house practice.' },
    { value: 1, label: 'One copy', hint: 'Just the customer copy — less paper, but nothing to keep at the counter.' },
]

const EMPTY = {
    auto_print: true,
    receipt_width_mm: 80,
    kot_mode: DEFAULT_KOT_MODE,
    kot_route: 'kds',
    kds_auto_print: true,
    print_transport: 'agent',
    receipt_copies: 2,
    drawer_kick: 'cash',
    drawer_pin: 2,
    kot_qr: false,
}

export default function KitchenSettingsPage() {
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })
    const [settings, setSettings] = useState(EMPTY)
    const [saved, setSaved] = useState(EMPTY)

    useEffect(() => {
        getSettings().then(data => {
            const next = { ...EMPTY, ...(data || {}) }
            next.auto_print = next.auto_print !== false
            next.receipt_width_mm = Number(next.receipt_width_mm) === 58 ? 58 : 80
            next.kot_mode = KOT_MODES.includes(next.kot_mode) ? next.kot_mode : DEFAULT_KOT_MODE
            next.kot_route = next.kot_route === 'till' ? 'till' : 'kds'
            next.kds_auto_print = next.kds_auto_print !== false
            next.print_transport = next.print_transport === 'browser' ? 'browser' : 'agent'
            next.receipt_copies = Number(next.receipt_copies) === 1 ? 1 : 2
            next.drawer_kick = ['always', 'never'].includes(next.drawer_kick) ? next.drawer_kick : 'cash'
            next.drawer_pin = Number(next.drawer_pin) === 5 ? 5 : 2
            next.kot_qr = next.kot_qr === true || next.kot_qr === 1
            setSettings(next)
            setSaved(next)
            setLoading(false)
        })
    }, [])

    useEffect(() => {
        if (message.type !== 'success') return
        const timer = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(timer)
    }, [message])

    const isDirty = useMemo(
        () => settings.auto_print !== saved.auto_print
            || Number(settings.receipt_width_mm) !== Number(saved.receipt_width_mm)
            || settings.kot_mode !== saved.kot_mode
            || settings.kot_route !== saved.kot_route
            || settings.kds_auto_print !== saved.kds_auto_print
            || settings.print_transport !== saved.print_transport
            || Number(settings.receipt_copies) !== Number(saved.receipt_copies)
            || settings.drawer_kick !== saved.drawer_kick
            || Number(settings.drawer_pin) !== Number(saved.drawer_pin)
            || settings.kot_qr !== saved.kot_qr,
        [settings, saved]
    )

    const handleSubmit = async (formData) => {
        setSaving(true)
        setMessage({ type: '', text: '' })
        const result = await updateKitchenSettings(formData)
        if (result.error) {
            setMessage({ type: 'error', text: result.error })
        } else {
            setMessage({ type: 'success', text: result.success })
            setSaved(settings)
        }
        setSaving(false)
    }

    if (loading) {
        return (
            <div className="max-w-4xl mx-auto p-6 space-y-6" aria-busy="true">
                <div className="skeleton" style={{ height: '2.25rem', width: '14rem' }} />
                <div className="skeleton" style={{ height: '22rem' }} />
            </div>
        )
    }

    return (
        <div className="max-w-4xl mx-auto p-6">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Kitchen &amp; Printer</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    How receipts and kitchen tickets print, and where the kitchen gets its order.
                </p>
            </div>

            <SettingsTabs active="kitchen" />

            <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
                {/*
                  * WHICH printer, before HOW it prints. Everything under this
                  * is a preference; this is the thing that decides whether
                  * paper comes out at all, and it used to live in a plist.
                  */}
                <PrinterPanel />

                <SettingSwitch
                    label="Print receipt automatically on payment"
                    hint="Paper comes out as the sale is saved, with no extra tap. Turn off if the printer is jammed or out of roll — you can still reprint any order from the Orders screen."
                    checked={settings.auto_print}
                    onToggle={() => setSettings(prev => ({ ...prev, auto_print: !prev.auto_print }))}
                />

                <form action={handleSubmit} className="space-y-6">
                    <input type="hidden" name="auto_print" value={settings.auto_print ? 'true' : 'false'} />
                    <input type="hidden" name="receipt_width_mm" value={settings.receipt_width_mm} />
                    <input type="hidden" name="kot_mode" value={settings.kot_mode} />
                    <input type="hidden" name="kot_route" value={settings.kot_route} />
                    <input type="hidden" name="kds_auto_print" value={settings.kds_auto_print ? 'true' : 'false'} />
                    <input type="hidden" name="print_transport" value={settings.print_transport} />
                    <input type="hidden" name="receipt_copies" value={settings.receipt_copies} />
                    <input type="hidden" name="drawer_kick" value={settings.drawer_kick} />
                    <input type="hidden" name="drawer_pin" value={settings.drawer_pin} />
                    <input type="hidden" name="kot_qr" value={settings.kot_qr ? 'true' : 'false'} />

                    <ChoiceGroup
                        label="How this terminal prints"
                        hint="The counter printer is a thermal ESC/POS unit, so it needs the agent. Browser printing reaches it as PostScript and prints page after page of code."
                        options={TRANSPORT_OPTIONS}
                        value={settings.print_transport}
                        onSelect={t => setSettings(prev => ({ ...prev, print_transport: t }))}
                    />

                    <ChoiceGroup
                        label="When the cash drawer opens"
                        hint="The drawer plugs into this terminal's printer, not into the computer, so it opens only on a terminal that prints through the agent."
                        options={DRAWER_OPTIONS}
                        value={settings.drawer_kick}
                        onSelect={k => setSettings(prev => ({ ...prev, drawer_kick: k }))}
                    />

                    {settings.drawer_kick !== 'never' && (
                        <ChoiceGroup
                            label="Cash drawer cable pin"
                            hint="The fallback, for a terminal whose printer has not been set up above — the pin belongs to the printer the drawer is plugged into, so each printer carries its own."
                            options={DRAWER_PIN_OPTIONS}
                            value={Number(settings.drawer_pin)}
                            onSelect={pin => setSettings(prev => ({ ...prev, drawer_pin: pin }))}
                        />
                    )}

                    <ChoiceGroup
                        label="Copies of each bill"
                        hint="Each copy is a complete bill ending in its own cut, so the two come off the roll already separated."
                        options={COPY_OPTIONS}
                        value={Number(settings.receipt_copies)}
                        onSelect={n => setSettings(prev => ({ ...prev, receipt_copies: n }))}
                    />

                    <ChoiceGroup
                        label="Receipt paper width"
                        hint="The fallback, for a terminal whose printer has not been set up above — each printer now carries its own width, because paper is a fact about the machine rather than about the shop."
                        options={PAPER_WIDTHS}
                        value={Number(settings.receipt_width_mm)}
                        onSelect={mm => setSettings(prev => ({ ...prev, receipt_width_mm: mm }))}
                    />

                    <ChoiceGroup
                        label="Where kitchen tickets print"
                        hint="Two devices keep the receipt printer and the kitchen printer from ever fighting over one spool — the recommended setup."
                        options={KOT_ROUTE_OPTIONS}
                        value={settings.kot_route}
                        onSelect={route => setSettings(prev => ({ ...prev, kot_route: route }))}
                    />

                    {settings.kot_route === 'kds' && (
                        <SettingSwitch
                            label="Kitchen display prints new tickets automatically"
                            hint="Each order prints on the kitchen's printer the moment it lands there. Turn off during a jam or a roll change — the Kitchen Display's own reprint button still works either way."
                            checked={settings.kds_auto_print}
                            onToggle={() => setSettings(prev => ({ ...prev, kds_auto_print: !prev.kds_auto_print }))}
                        />
                    )}

                    <SettingSwitch
                        label="Print a QR code on kitchen tickets"
                        hint="Scanning a slip pulls that order up on a phone instead of typing its number. Costs about a centimetre of roll per ticket, so leave it off unless somebody is actually scanning them."
                        checked={settings.kot_qr}
                        onToggle={() => setSettings(prev => ({ ...prev, kot_qr: !prev.kot_qr }))}
                    />

                    <ChoiceGroup
                        label="How a round is cut into slips"
                        hint="Whichever device prints, this decides the shape. Reprints from the Kitchen Display follow it too; the change is picked up on the next order with no restart."
                        options={KOT_MODE_OPTIONS}
                        value={settings.kot_mode}
                        onSelect={mode => setSettings(prev => ({ ...prev, kot_mode: mode }))}
                    />

                    {message.type && (
                        <div
                            role="status"
                            aria-live="polite"
                            className={`flex items-start gap-3 p-4 rounded-lg border text-sm ${message.type === 'error'
                                ? 'bg-danger-soft border-danger-border text-danger-text'
                                : 'bg-success-soft border-success-border text-success-text'}`}
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
                            {saving ? (<><Loader2 className="h-4 w-4 animate-spin" />Saving...</>) : (<><Save className="h-4 w-4" />Save Settings</>)}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}

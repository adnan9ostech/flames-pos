'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Percent, Landmark, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { getSettings } from '../actions'
import { listActiveCharges } from '@/app/charges/actions'
import { updateTaxSettings, getFbrStatus } from './actions'

/*
 * The tax side of Settings, on its own tab: GST by payment method, the tax
 * label, the standing service charge, and the FBR Digital Invoicing panel.
 * Rates are edited as percentages but stored as fractions; the operator's
 * raw text lives in state while they type so "1" on the way to "16" isn't
 * normalised under the cursor.
 */
export default function TaxSettingsPage() {
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState({ type: '', text: '' })

    const [taxCash, setTaxCash] = useState('16')
    const [taxCard, setTaxCard] = useState('5')
    const [taxLabel, setTaxLabel] = useState('GST')
    const [charges, setCharges] = useState([])
    const [fbr, setFbr] = useState(null)

    useEffect(() => {
        Promise.all([getSettings(), getFbrStatus(), listActiveCharges()])
            .then(([settings, fbrRes, chargesRes]) => {
                if (settings) {
                    setTaxCash(String(Number(((settings.tax_rate_cash ?? 0.16) * 100).toFixed(2))))
                    setTaxCard(String(Number(((settings.tax_rate_card ?? 0.05) * 100).toFixed(2))))
                    setTaxLabel(settings.tax_label || 'GST')
                }
                if (fbrRes?.data) setFbr(fbrRes.data)
                if (chargesRes?.data) setCharges(chargesRes.data)
                setLoading(false)
            })
    }, [])

    useEffect(() => {
        if (message.type !== 'success') return
        const timer = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(timer)
    }, [message])

    const handleSubmit = async (formData) => {
        setSaving(true)
        setMessage({ type: '', text: '' })
        const result = await updateTaxSettings(formData)
        setMessage(result.error
            ? { type: 'error', text: result.error }
            : { type: 'success', text: result.success })
        setSaving(false)
    }

    const fieldClass =
        'w-full rounded-lg bg-gray-900/70 border border-gray-700/70 px-4 py-2.5 text-gray-100 ' +
        'placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-600/60'

    if (loading) {
        return (
            <div className="max-w-4xl mx-auto p-6 space-y-6" aria-busy="true">
                <div className="skeleton" style={{ height: '2.25rem', width: '14rem' }} />
                <div className="skeleton" style={{ height: '22rem' }} />
            </div>
        )
    }

    const pct = (v) => `${Number(v) || 0}%`
    const ok = (flag) => flag
        ? <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
        : <XCircle className="h-4 w-4 text-gray-500" aria-hidden="true" />

    return (
        <div className="max-w-4xl mx-auto p-6 space-y-6 text-gray-100">
            <div>
                <h1 className="text-2xl sm:text-3xl font-bold text-white">Settings</h1>
                <p className="text-gray-400 mt-1">Tax rates and FBR Digital Invoicing.</p>
            </div>

            {/* Tabs */}
            <div className="flex gap-2">
                <Link href="/settings" className="px-4 py-2 rounded-lg text-sm bg-gray-900/70 border border-gray-800 text-gray-300 hover:text-white">
                    General
                </Link>
                <span className="px-4 py-2 rounded-lg text-sm bg-orange-600 text-white font-semibold">
                    Tax &amp; FBR
                </span>
            </div>

            {message.text && (
                <div className={`rounded-lg px-4 py-3 text-sm border ${message.type === 'error'
                    ? 'bg-red-950/60 border-red-800 text-red-300'
                    : 'bg-emerald-950/60 border-emerald-800 text-emerald-300'}`}>
                    {message.text}
                </div>
            )}

            <form action={handleSubmit} className="rounded-2xl bg-gray-900/60 border border-gray-800/70 p-6 space-y-6">
                <div className="flex items-center gap-2 text-white font-semibold">
                    <Percent className="h-5 w-5 text-orange-500" aria-hidden="true" />
                    Rates
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label htmlFor="tax_rate_cash_percent" className="block text-sm font-medium text-gray-300 mb-1.5">
                            GST — cash
                        </label>
                        <input
                            id="tax_rate_cash_percent"
                            type="number" min="0" max="100" step="0.01" inputMode="decimal"
                            value={taxCash}
                            onChange={(e) => setTaxCash(e.target.value)}
                            className={fieldClass}
                            placeholder="16"
                        />
                        <input type="hidden" name="tax_rate_cash" value={(Math.min(Math.max(Number(taxCash) || 0, 0), 100)) / 100} />
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
                            type="number" min="0" max="100" step="0.01" inputMode="decimal"
                            value={taxCard}
                            onChange={(e) => setTaxCard(e.target.value)}
                            className={fieldClass}
                            placeholder="5"
                        />
                        <input type="hidden" name="tax_rate_card" value={(Math.min(Math.max(Number(taxCard) || 0, 0), 100)) / 100} />
                        <p className="mt-1.5 text-xs text-gray-500">
                            The ICT differential rate for card and digital payments — resolved when the bill settles.
                        </p>
                    </div>

                    <div>
                        <label htmlFor="tax_label" className="block text-sm font-medium text-gray-300 mb-1.5">
                            Tax name
                        </label>
                        <input
                            id="tax_label"
                            type="text" name="tax_label" maxLength={16}
                            value={taxLabel}
                            onChange={(e) => setTaxLabel(e.target.value)}
                            className={fieldClass}
                            placeholder="GST"
                        />
                        <p className="mt-1.5 text-xs text-gray-500">Shown on the receipt tax line.</p>
                    </div>
                </div>

                <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 px-5 py-2.5 font-semibold text-white"
                >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    Save tax settings
                </button>
            </form>

            {/* Charges are shown, not edited, here: the Charges screen owns
                them, and one row with two editors is how the two screens
                start disagreeing. */}
            <div className="rounded-2xl bg-gray-900/60 border border-gray-800/70 p-6 space-y-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 text-white font-semibold">
                        <Percent className="h-5 w-5 text-orange-500" aria-hidden="true" />
                        Charges on a bill
                    </div>
                    <Link href="/charges" className="text-sm text-orange-400 hover:text-orange-300">
                        Manage charges →
                    </Link>
                </div>

                {charges.length > 0 ? (
                    <ul className="divide-y divide-gray-800/70">
                        {charges.map((c) => (
                            <li key={c.name} className="py-2.5 flex items-center justify-between gap-4 text-sm">
                                <span className="text-gray-200">{c.name}</span>
                                <span className="text-gray-400">
                                    {c.value_type === 'percent' ? `${Number(c.value)}%` : `Rs. ${Number(c.value).toLocaleString('en-PK')}`}
                                    {' · '}
                                    {(Array.isArray(c.order_types) && c.order_types.length > 0)
                                        ? c.order_types.join(', ')
                                        : 'all order types'}
                                    {' · '}
                                    {c.before_tax ? 'taxed' : 'after tax'}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-gray-400">No charges are applied automatically.</p>
                )}
            </div>

            {/* FBR Digital Invoicing — status only. The token can file
                invoices with the tax authority, so it lives in the server
                environment, never in a form. */}
            <div className="rounded-2xl bg-gray-900/60 border border-gray-800/70 p-6 space-y-4">
                <div className="flex items-center gap-2 text-white font-semibold">
                    <Landmark className="h-5 w-5 text-orange-500" aria-hidden="true" />
                    FBR Digital Invoicing
                </div>

                {fbr ? (
                    <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                            <div className="flex items-center gap-2">
                                {ok(fbr.enabled)}
                                <span>{fbr.enabled ? `Enabled — ${fbr.mode}` : 'Disabled'}</span>
                            </div>
                            <div className="flex items-center gap-2">{ok(fbr.bposid_set)}<span>POS ID</span></div>
                            <div className="flex items-center gap-2">{ok(fbr.token_set)}<span>Token</span></div>
                            <div className="flex items-center gap-2">{ok(fbr.seller_ntn_set)}<span>Seller NTN</span></div>
                        </div>

                        <div className="grid grid-cols-3 gap-4 text-center">
                            {[['Pending', fbr.queue.pending], ['Sent', fbr.queue.sent], ['Failed', fbr.queue.failed]].map(([label, n]) => (
                                <div key={label} className="rounded-xl bg-gray-950/60 border border-gray-800/60 py-3">
                                    <div className="text-xl font-bold text-white">{n}</div>
                                    <div className="text-xs text-gray-400">{label}</div>
                                </div>
                            ))}
                        </div>

                        <p className="text-xs text-gray-500">
                            {fbr.last_sent
                                ? `Last accepted invoice: ${fbr.last_sent.number}`
                                : 'No invoices accepted by FBR yet.'}
                            {' '}Credentials are configured in the server environment
                            (FBR_ENABLED, FBR_MODE, FBR_BPOSID, FBR_TOKEN, FBR_SELLER_NTN) — see docs/deploy-cpanel.md.
                        </p>
                    </>
                ) : (
                    <p className="text-sm text-gray-400">FBR status unavailable.</p>
                )}
            </div>
        </div>
    )
}

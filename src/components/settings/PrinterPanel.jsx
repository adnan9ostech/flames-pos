'use client'

import { useCallback, useEffect, useState } from 'react'
import { Printer, Loader2, AlertTriangle, CheckCircle2, RefreshCw, FileText } from 'lucide-react'
import { listAgentPrinters, testPrintViaAgent, resetAgentProbe } from '@/lib/thermalAgent'
import { listPrinters, savePrinter, forgetPrinter } from '@/app/settings/kitchen/printerActions'

/*
 * Choosing a printer, on a screen.
 *
 * Until now the printer was named in the launchd plist that starts the agent,
 * so every machine was set up at a shell prompt and a replaced printer stopped
 * the till until somebody edited a file. Two halves fixed that: the agent is
 * started with a ROLE and looks the printer up in the database, and this panel
 * is what writes that row.
 *
 * IT ASKS THE LOCAL AGENT what printers exist, and it has to: the queue list
 * is a property of the machine the browser is sitting at, not of the server.
 * So this panel is about "this terminal", and says so — a manager opening it
 * on the office laptop is choosing that laptop's printer, which is exactly
 * what the roles are for.
 */
const ROLES = [
    { key: 'receipt', label: 'Receipt printer', hint: 'The counter: bills, and the drawer that hangs off it.' },
    { key: 'kitchen', label: 'Kitchen printer', hint: 'Where the kitchen tickets come out, on the machine running the Kitchen Display.' },
]

const CUTS = [
    ['full', 'Cuts right through'],
    ['partial', 'Leaves a small tab'],
    ['none', 'No cutter — feed to tear'],
]

const blank = (role) => ({
    role,
    label: '',
    transport: 'cups',
    target: '',
    widthMm: 80,
    cutMode: 'full',
    feedLines: 6,
    codepage: 0,
    drawerPin: 2,
})

export default function PrinterPanel() {
    const [agent, setAgent] = useState(undefined)   // undefined = asking, null = not running
    const [saved, setSaved] = useState([])
    const [drafts, setDrafts] = useState({})
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState('')

    const load = useCallback(() => {
        resetAgentProbe()
        Promise.all([listAgentPrinters(), listPrinters()]).then(([seen, rows]) => {
            setAgent(seen)
            const list = rows.error ? [] : rows.data
            setSaved(list)
            setDrafts(Object.fromEntries(ROLES.map(({ key }) => {
                const row = list.find((r) => r.role === key)
                return [key, row ? {
                    role: key,
                    label: row.label,
                    transport: row.transport,
                    target: row.target,
                    widthMm: Number(row.width_mm),
                    cutMode: row.cut_mode,
                    feedLines: Number(row.feed_lines),
                    codepage: Number(row.codepage),
                    drawerPin: Number(row.drawer_pin),
                } : blank(key)]
            })))
        })
    }, [])

    useEffect(() => { load() }, [load])
    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 5000)
        return () => clearTimeout(t)
    }, [message])

    const setField = (role, patch) => setDrafts((d) => ({ ...d, [role]: { ...d[role], ...patch } }))

    const save = async (role) => {
        setBusy(role)
        const res = await savePrinter(drafts[role])
        setBusy('')
        setMessage(res.error ? { type: 'error', text: res.error } : { type: 'success', text: res.success })
        if (!res.error) load()
    }

    const test = async () => {
        setBusy('test')
        const res = await testPrintViaAgent()
        setBusy('')
        setMessage(res.ok
            ? { type: 'success', text: `Test page sent to ${res.printer}. If nothing came out, the printer is not the one selected.` }
            : { type: 'error', text: res.error })
    }

    const forget = async (role) => {
        setBusy(role)
        const res = await forgetPrinter(role)
        setBusy('')
        setMessage(res.error ? { type: 'error', text: res.error } : { type: 'success', text: res.success })
        load()
    }

    const available = agent?.available ?? []

    return (
        <div className="mb-6 rounded-lg border border-input bg-surface-raise p-4">
            <div className="flex items-start justify-between gap-3 mb-1">
                <div>
                    <p className="text-sm font-medium text-foreground flex items-center gap-2">
                        <Printer className="h-4 w-4" />Printers on this terminal
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground max-w-2xl">
                        Picked here, not typed into a file — change the printer and the next bill goes to it, with
                        nothing restarted. The list comes from the machine you are sitting at, which is why the
                        kitchen&rsquo;s printer is chosen on the kitchen&rsquo;s machine.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={load}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground"
                >
                    <RefreshCw className="h-4 w-4" />Rescan
                </button>
            </div>

            {message.type && (
                <div className={`flex items-start gap-2 p-3 my-3 rounded-lg border text-sm ${message.type === 'error'
                    ? 'bg-danger-soft border-danger-border text-danger-text'
                    : 'bg-success-soft border-success-border text-success-text'}`}
                >
                    {message.type === 'error' ? <AlertTriangle className="h-4 w-4 flex-shrink-0" /> : <CheckCircle2 className="h-4 w-4 flex-shrink-0" />}
                    {message.text}
                </div>
            )}

            {agent === undefined ? (
                <div className="p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : agent === null ? (
                <div className="flex items-start gap-2 p-3 rounded-lg border bg-warning-soft border-warning-border text-warning-text text-sm">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    <span>
                        The print agent is not running on this machine, so there is nothing to list. Start it —{' '}
                        <code>bash scripts/print/install-agent-service.sh</code> — then press Rescan. Whatever is
                        already saved below still applies to the terminals that do have it running.
                    </span>
                </div>
            ) : (
                <p className="text-xs text-muted-foreground mb-3">
                    This machine can see {available.length} printer{available.length === 1 ? '' : 's'}
                    {agent.current
                        ? ` · currently printing to ${agent.current.label} (${agent.current.source})`
                        : ' · nothing chosen yet'}
                </p>
            )}

            {ROLES.map(({ key, label, hint }) => {
                const d = drafts[key] ?? blank(key)
                const row = saved.find((r) => r.role === key)
                return (
                    <div key={key} className="mt-4 pt-4 border-t border-border first:border-t-0 first:pt-0 first:mt-2">
                        <p className="text-sm font-semibold text-card-foreground">{label}</p>
                        <p className="text-xs text-muted-foreground mb-2">{hint}</p>

                        <div className="grid gap-2 sm:grid-cols-2 mb-2">
                            <select
                                className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                                value={d.target}
                                onChange={(e) => {
                                    const pick = available.find((a) => a.target === e.target.value)
                                    setField(key, {
                                        target: e.target.value,
                                        transport: pick?.transport ?? d.transport,
                                        label: d.label || pick?.label || e.target.value,
                                    })
                                }}
                            >
                                <option value="">Pick a printer…</option>
                                {available.map((a) => (
                                    <option key={`${a.transport}:${a.target}`} value={a.target}>
                                        {a.label}{a.likelyThermal ? ' — looks thermal' : ''}{a.present ? '' : ' (offline)'}
                                    </option>
                                ))}
                                {/* A printer this machine cannot see, saved from another terminal, must
                                    still show as the current choice rather than reading as blank. */}
                                {d.target && !available.some((a) => a.target === d.target) && (
                                    <option value={d.target}>{d.target} — saved, not visible here</option>
                                )}
                            </select>
                            <input
                                className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                                placeholder="Call it something — Counter printer"
                                value={d.label}
                                onChange={(e) => setField(key, { label: e.target.value })}
                            />
                        </div>

                        <div className="grid gap-2 sm:grid-cols-4">
                            <label className="text-xs text-muted-foreground">
                                Paper width
                                <select
                                    className="mt-1 w-full min-h-[40px] px-2 rounded-lg border border-border bg-background text-foreground text-sm"
                                    value={d.widthMm}
                                    onChange={(e) => setField(key, { widthMm: Number(e.target.value) })}
                                >
                                    <option value={80}>80 mm</option>
                                    <option value={58}>58 mm</option>
                                </select>
                            </label>
                            <label className="text-xs text-muted-foreground">
                                Cutter
                                <select
                                    className="mt-1 w-full min-h-[40px] px-2 rounded-lg border border-border bg-background text-foreground text-sm"
                                    value={d.cutMode}
                                    onChange={(e) => setField(key, { cutMode: e.target.value })}
                                >
                                    {CUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </select>
                            </label>
                            <label className="text-xs text-muted-foreground" title="Paper fed before the cut — raise it if the last line stays inside the printer">
                                Feed before cut
                                <input
                                    className="mt-1 w-full min-h-[40px] px-2 rounded-lg border border-border bg-background text-foreground text-sm text-right"
                                    type="number" min="0" max="30"
                                    value={d.feedLines}
                                    onChange={(e) => setField(key, { feedLines: e.target.value })}
                                />
                            </label>
                            <label className="text-xs text-muted-foreground" title="Which RJ11 pin opens the drawer plugged into this printer">
                                Drawer pin
                                <select
                                    className="mt-1 w-full min-h-[40px] px-2 rounded-lg border border-border bg-background text-foreground text-sm"
                                    value={d.drawerPin}
                                    onChange={(e) => setField(key, { drawerPin: Number(e.target.value) })}
                                >
                                    <option value={2}>Pin 2</option>
                                    <option value={5}>Pin 5</option>
                                </select>
                            </label>
                        </div>

                        <div className="flex items-center gap-2 mt-3">
                            <button
                                type="button"
                                onClick={() => save(key)}
                                disabled={busy === key || !d.target}
                                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40"
                            >
                                {busy === key ? 'Saving…' : row ? 'Update' : 'Use this printer'}
                            </button>
                            {key === 'receipt' && (
                                <button
                                    type="button"
                                    onClick={test}
                                    disabled={busy === 'test'}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-primary disabled:opacity-40"
                                >
                                    <FileText className="h-4 w-4" />
                                    {busy === 'test' ? 'Printing…' : 'Test print'}
                                </button>
                            )}
                            {row && (
                                <button
                                    type="button"
                                    onClick={() => forget(key)}
                                    className="px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-danger-text"
                                >
                                    Forget
                                </button>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

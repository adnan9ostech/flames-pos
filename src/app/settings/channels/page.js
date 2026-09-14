'use client'

import { useCallback, useEffect, useState } from 'react'
import { Share2, Plus, Loader2, AlertTriangle, CheckCircle2, Star, Power, Trash2 } from 'lucide-react'
import { listChannels, saveChannel, removeChannel } from './actions'
import SettingsTabs from '@/components/settings/SettingsTabs'

/*
 * Where orders come from. Until the restaurant lists itself somewhere there is
 * one row here and the till hides its picker entirely — a choice with one
 * option is furniture.
 */
export default function ChannelsPage() {
    const [rows, setRows] = useState(null)
    const [name, setName] = useState('')
    const [message, setMessage] = useState({ type: '', text: '' })
    const [busy, setBusy] = useState(false)

    const load = useCallback(() => listChannels().then((res) => {
        if (res.error) setMessage({ type: 'error', text: res.error })
        else setRows(res.data)
    }), [])

    useEffect(() => { load() }, [load])
    useEffect(() => {
        if (message.type !== 'success') return undefined
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 4000)
        return () => clearTimeout(t)
    }, [message])

    const act = async (fn) => {
        setBusy(true)
        const res = await fn()
        setBusy(false)
        if (res.error) setMessage({ type: 'error', text: res.error })
        else { setMessage({ type: 'success', text: res.success }); load() }
    }

    return (
        <div className="max-w-4xl mx-auto p-6">
            <div className="mb-6 flex items-start gap-3">
                <Share2 className="h-7 w-7 text-muted-foreground mt-1" />
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-card-foreground">Sales Channels</h1>
                    <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                        Where an order came from. The counter, or an app that sent it. The till only shows the
                        picker once there is more than one. What it does <em>not</em> do yet is money: an
                        aggregator&rsquo;s commission and the days it holds your cash are a receivable, and that is
                        its own piece of work.
                    </p>
                </div>
            </div>

            <SettingsTabs active="channels" />

            {message.type && (
                <div className={`flex items-start gap-3 p-4 mb-5 rounded-lg border text-sm ${message.type === 'error'
                    ? 'bg-danger-soft border-danger-border text-danger-text'
                    : 'bg-success-soft border-success-border text-success-text'}`}
                >
                    {message.type === 'error' ? <AlertTriangle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
                    {message.text}
                </div>
            )}

            <div className="bg-surface rounded-xl border border-border p-5 mb-6 flex gap-3">
                <input
                    className="flex-1 min-h-[44px] px-3 rounded-lg border border-border bg-background text-foreground"
                    placeholder="Foodpanda, Careem, our own website…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <button
                    type="button"
                    disabled={busy || !name.trim()}
                    onClick={() => act(() => saveChannel({ name })).then(() => setName(''))}
                    className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-lg disabled:opacity-40"
                >
                    <Plus className="h-4 w-4" />Add
                </button>
            </div>

            {!rows ? (
                <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
                <div className="bg-surface rounded-xl border border-border overflow-hidden">
                    {rows.map((c) => (
                        <div key={c.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
                            <span className="font-semibold text-card-foreground flex-1">
                                {c.name}
                                {Boolean(c.is_default) && (
                                    <span className="ml-2 text-xs font-normal text-muted-foreground">default</span>
                                )}
                                {!c.is_active && (
                                    <span className="ml-2 text-xs font-normal text-muted-foreground">off</span>
                                )}
                            </span>
                            <span className="text-sm text-muted-foreground">
                                {Number(c.orders)} order{Number(c.orders) === 1 ? '' : 's'}
                            </span>
                            {!c.is_default && (
                                <button
                                    type="button"
                                    title="Make this the default"
                                    onClick={() => act(() => saveChannel({ id: c.id, name: c.name, isActive: true, isDefault: true }))}
                                    className="p-2 rounded-lg border border-border text-muted-foreground hover:text-primary"
                                >
                                    <Star className="h-4 w-4" />
                                </button>
                            )}
                            <button
                                type="button"
                                title={c.is_active ? 'Switch off' : 'Switch on'}
                                onClick={() => act(() => saveChannel({ id: c.id, name: c.name, isActive: !c.is_active }))}
                                className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground"
                            >
                                <Power className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                title="Remove"
                                onClick={() => act(() => removeChannel(c.id))}
                                className="p-2 rounded-lg border border-border text-muted-foreground hover:text-danger-text"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

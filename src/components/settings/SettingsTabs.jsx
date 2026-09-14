import Link from 'next/link'

/*
 * The one tab strip every settings screen shares, so General, Kitchen &
 * Printer, Charges and Tax & FBR all read as tabs of the same thing rather
 * than four pages that happen to link to each other. `active` is the key of
 * the current tab; it renders as a plain highlighted label, the rest as links.
 *
 * Charges lives at its own route (/charges) — it is a full CRUD screen, not a
 * settings form — but it belongs to this group in the owner's mind, so it sits
 * on the strip like the others.
 */
const TABS = [
    { key: 'general', label: 'General', href: '/settings' },
    { key: 'brand', label: 'Brand', href: '/settings/brand' },
    { key: 'kitchen', label: 'Kitchen & Printer', href: '/settings/kitchen' },
    { key: 'charges', label: 'Charges', href: '/charges' },
    { key: 'channels', label: 'Sales Channels', href: '/settings/channels' },
    { key: 'tax', label: 'Tax & FBR', href: '/settings/tax' },
    { key: 'branches', label: 'Branches', href: '/settings/branches' },
]

export default function SettingsTabs({ active }) {
    return (
        <div className="mb-6 flex flex-wrap gap-2">
            {TABS.map(t => (t.key === active ? (
                <span key={t.key} className="px-4 py-2 rounded-lg text-sm bg-selected text-selected-foreground border border-selected-border font-semibold">
                    {t.label}
                </span>
            ) : (
                <Link
                    key={t.key}
                    href={t.href}
                    className="px-4 py-2 rounded-lg text-sm bg-surface border border-border text-foreground hover:text-card-foreground"
                >
                    {t.label}
                </Link>
            )))}
        </div>
    )
}

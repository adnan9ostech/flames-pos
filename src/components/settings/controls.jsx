'use client'

/*
 * The two form controls the settings tabs share. Lifted out of the General
 * page when Kitchen & Printer became its own tab and wanted the same switch
 * and choice-card geometry — one copy, so the knob travel and the 44px targets
 * are stated once.
 */

// A labelled on/off row.
export function SettingSwitch({ label, hint, checked, onToggle }) {
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
                className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-focus ${checked ? 'bg-primary' : 'bg-muted'}`}
            >
                {/* inset 2px on both sides of a 44px track holding a 20px knob
                    leaves exactly 20px of travel. The knob is a literal white,
                    not a surface token: it rides on a coloured track in both
                    themes, so a theme-flipping knob would vanish in light mode. */}
                <span
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`}
                />
            </button>
        </div>
    )
}

// A row of mutually exclusive choices, each carrying a line of explanation.
export function ChoiceGroup({ label, hint, options, value, onSelect }) {
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
                                : 'border-input bg-surface text-foreground hover:border-primary'}`}
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

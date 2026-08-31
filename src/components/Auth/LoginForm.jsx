'use client'

import { useState } from 'react'
import { login } from '@/app/login/actions'
import CookingLoader from '@/components/Layout/CookingLoader'
import { Utensils, Loader2, ShieldCheck, UserRound } from 'lucide-react'

const ROLES = [
    { key: 'admin', label: 'Admin', Icon: ShieldCheck },
    { key: 'staff', label: 'Staff', Icon: UserRound },
]

export default function LoginForm() {
    const [role, setRole] = useState('admin')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    // `loading` deliberately stays true through a successful sign-in: the action
    // resolves well before /pos finishes rendering, and dropping the pending
    // state in that gap is what made the button look like it did nothing.
    const handleSubmit = async (formData) => {
        setLoading(true)
        setError('')

        const result = await login(formData)

        if (result?.error) {
            setError(result.error)
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-900 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-gray-800 via-gray-900 to-black p-4">
            {/* Signing in crosses two waits — the auth round-trip, then the
                render of /pos — and the form's own pending state only covers
                the first. This stays up for both so the click never looks lost. */}
            {loading && (
                <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950/85 backdrop-blur-sm">
                    <CookingLoader
                        size={112}
                        label={`Signing in as ${role === 'admin' ? 'Admin' : 'Staff'}...`}
                    />
                </div>
            )}

            <div className="max-w-md w-full space-y-8 p-8 bg-gray-800/50 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-700/50">
                <div className="text-center">
                    <div className="mx-auto h-16 w-16 bg-gradient-to-br from-orange-500 to-orange-600 rounded-full flex items-center justify-center shadow-lg transform mb-6">
                        <Utensils className="h-8 w-8 text-white" />
                    </div>
                    <h2 className="text-3xl font-bold text-white tracking-tight">
                        Flames by the Indus
                    </h2>
                    <p className="mt-2 text-sm text-gray-400">
                        Staff Sign In
                    </p>
                </div>

                <form className="mt-8 space-y-6" action={handleSubmit}>
                    <input type="hidden" name="role" value={role} />

                    <div className="grid grid-cols-2 gap-3">
                        {ROLES.map(({ key, label, Icon }) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setRole(key)}
                                disabled={loading}
                                aria-pressed={role === key}
                                className={`flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-semibold border transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${role === key
                                        ? 'bg-orange-600 border-orange-500 text-white shadow-lg shadow-orange-500/20'
                                        : 'bg-gray-900/50 border-gray-600 text-gray-300 hover:border-gray-500'
                                    }`}
                            >
                                <Icon className="h-4 w-4" />
                                {label}
                            </button>
                        ))}
                    </div>

                    <div>
                        <label htmlFor="pin" className="block text-sm font-medium text-gray-300 mb-1">
                            {role === 'admin' ? 'Admin PIN' : 'Staff PIN'}
                        </label>
                        <input
                            id="pin"
                            name="pin"
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={6}
                            autoComplete="off"
                            required
                            autoFocus
                            disabled={loading}
                            className="appearance-none block w-full px-4 py-3 border border-gray-600 rounded-lg bg-gray-900/50 text-white placeholder-gray-500 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition duration-200 disabled:opacity-60"
                            placeholder="••••••"
                        />
                    </div>

                    {error && (
                        <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-3">
                            <p className="text-red-400 text-sm text-center font-medium">
                                {error}
                            </p>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="group relative w-full flex justify-center py-3 px-4 border border-transparent text-sm font-semibold rounded-lg text-white bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-orange-500/20"
                    >
                        {loading ? (
                            <span className="flex items-center">
                                <Loader2 className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" />
                                Signing in...
                            </span>
                        ) : (
                            'Sign In'
                        )}
                    </button>

                    {/* Forgot-PIN lives with the admin now: Settings > reset
                        either role's PIN at the counter. No emailed links. */}
                </form>
            </div>
        </div>
    )
}

'use client'

import { useState } from 'react'
import { login } from '@/app/login/actions'
import CookingLoader from '@/components/Layout/CookingLoader'
import { Utensils, Loader2, Eye, EyeOff, AlertTriangle } from 'lucide-react'
import styles from './login.module.css'

/*
 * One field for who you are, one for your password.
 *
 * The identifier is deliberately not split into "email" and "username" tabs:
 * an account carries both, people remember whichever they were told, and
 * login() accepts either — so asking which kind it is only adds a wrong answer
 * to give.
 */
export default function LoginForm() {
    const [identifier, setIdentifier] = useState('')
    const [password, setPassword] = useState('')
    const [revealed, setRevealed] = useState(false)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    // Both fields are controlled so a rejected attempt keeps what was typed:
    // React resets an uncontrolled form once its action settles, and re-typing
    // an email after a mistyped password is the kind of friction that ends in
    // the password being written on the till.
    //
    // `loading` deliberately stays true through a successful sign-in — login()
    // navigates, and the action settles well before the destination screen has
    // rendered. Dropping the pending state in that gap is what made the button
    // look like it did nothing. No try/catch around the call either: a Next
    // redirect travels as a thrown signal, and catching it here would swallow
    // the navigation.
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
        <div className={styles.page}>
            {/* Signing in crosses two waits — the auth round-trip, then the
                render of whichever screen this account lands on — and the
                form's own pending state only covers the first. This stays up
                for both so the tap never looks lost. */}
            {loading && (
                <div className={styles.overlay}>
                    <CookingLoader size={112} label="Signing you in…" />
                </div>
            )}

            <div className={styles.card}>
                <div className={styles.brand}>
                    <div className={styles.mark}>
                        <Utensils size={30} aria-hidden="true" />
                    </div>
                    <h1 className={styles.title}>Flames by the Indus</h1>
                    <p className={styles.subtitle}>Sign in to your account</p>
                </div>

                <form className={styles.form} action={handleSubmit}>
                    <div className={styles.field}>
                        <label className={styles.label} htmlFor="identifier">
                            Email or username
                        </label>
                        <input
                            id="identifier"
                            name="identifier"
                            type="text"
                            className={styles.input}
                            value={identifier}
                            onChange={(e) => setIdentifier(e.target.value)}
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            autoFocus
                            disabled={loading}
                            placeholder="you@flames.pk or ahmed"
                        />
                    </div>

                    <div className={styles.field}>
                        <label className={styles.label} htmlFor="password">
                            Password
                        </label>
                        <div className={styles.passwordField}>
                            <input
                                id="password"
                                name="password"
                                type={revealed ? 'text' : 'password'}
                                className={styles.input}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="current-password"
                                disabled={loading}
                                placeholder="••••••••"
                            />
                            {/* Typing a password blind on a touchscreen keyboard is
                                how a correct password gets reported as wrong. */}
                            <button
                                type="button"
                                className={styles.reveal}
                                onClick={() => setRevealed((v) => !v)}
                                disabled={loading}
                                aria-pressed={revealed}
                                aria-label={revealed ? 'Hide password' : 'Show password'}
                            >
                                {revealed
                                    ? <EyeOff size={20} aria-hidden="true" />
                                    : <Eye size={20} aria-hidden="true" />}
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div className={styles.error} role="alert">
                            <AlertTriangle size={18} className={styles.errorIcon} aria-hidden="true" />
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className={styles.submit}
                        disabled={loading || !identifier.trim() || !password}
                    >
                        {loading
                            ? <Loader2 size={18} className={styles.spinner} aria-hidden="true" />
                            : null}
                        {loading ? 'Signing in…' : 'Sign In'}
                    </button>
                </form>

                {/* No emailed reset links: the person who can prove who you are
                    is standing in the same building. */}
                <p className={styles.hint}>
                    Forgotten your password? An admin can set a new one for you at the counter.
                </p>
            </div>
        </div>
    )
}

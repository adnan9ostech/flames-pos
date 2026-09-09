'use client'

import { useState, useEffect, useRef } from 'react'
import styles from './profile.module.css'
import { getUser, updateProfile, changePassword } from './actions'
import {
    UserRound, KeyRound, ShieldCheck, Save, Loader2,
    AlertTriangle, CheckCircle2, Eye, EyeOff, Palette,
} from 'lucide-react'
import ThemeSwitcher from '@/components/Layout/ThemeSwitcher'

const EMPTY_PW = { current_password: '', new_password: '', confirm_password: '' }

/* The column stores UTC; the restaurant reads Karachi time. */
const signedInAt = (iso) => new Date(iso).toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'medium',
    timeStyle: 'short',
})

/*
 * Your own account: the two things you may correct yourself, the password only
 * you should know, and a plain statement of what this login can open. Anything
 * that decides what you are ALLOWED to do — role, username, permissions — is
 * shown here but changed on the users screen, by someone else.
 */
export default function ProfilePage() {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')

    // Handed-over password, per the ?first=1 the login redirect adds.
    const [handover, setHandover] = useState(false)

    const [account, setAccount] = useState({ full_name: '', email: '' })
    const [savedAccount, setSavedAccount] = useState({ full_name: '', email: '' })
    const [savingAccount, setSavingAccount] = useState(false)
    const [accountNote, setAccountNote] = useState(null)

    const [pw, setPw] = useState(EMPTY_PW)
    const [shown, setShown] = useState({})
    const [savingPw, setSavingPw] = useState(false)
    const [pwNote, setPwNote] = useState(null)

    const passwordCard = useRef(null)
    const currentPasswordInput = useRef(null)

    useEffect(() => {
        getUser().then((res) => {
            if (res.error) {
                setLoadError(res.error)
            } else {
                const next = { full_name: res.data.full_name || '', email: res.data.email || '' }
                setUser(res.data)
                setAccount(next)
                setSavedAccount(next)
            }
            // The flag is read off the URL rather than through useSearchParams:
            // this page is a client component with no Suspense boundary above
            // it, and the hook would opt the whole route out of prerendering to
            // buy nothing. Read here so the banner arrives with the data behind
            // it rather than flashing on ahead of it.
            setHandover(new URLSearchParams(window.location.search).get('first') === '1')
            setLoading(false)
        })
    }, [])

    const nudge = handover || Boolean(user?.must_change_password)

    useEffect(() => {
        if (!nudge || loading) return
        // `nearest` scrolls the minimum needed, so on a screen where the
        // password card is already visible the banner explaining why stays put.
        passwordCard.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        currentPasswordInput.current?.focus({ preventScroll: true })
    }, [nudge, loading])

    const accountDirty =
        account.full_name.trim() !== savedAccount.full_name.trim()
        || account.email.trim() !== savedAccount.email.trim()

    const saveAccount = async (formData) => {
        setSavingAccount(true)
        setAccountNote(null)

        const res = await updateProfile(formData)

        if (res.error) {
            setAccountNote({ type: 'error', text: res.error })
        } else {
            const next = { full_name: account.full_name.trim(), email: account.email.trim() }
            setAccount(next)
            setSavedAccount(next)
            setUser((u) => ({ ...u, ...next, email: next.email || null }))
            setAccountNote({ type: 'ok', text: 'Saved.' })
        }
        setSavingAccount(false)
    }

    const savePassword = async (formData) => {
        setSavingPw(true)
        setPwNote(null)

        const res = await changePassword(formData)

        if (res.error) {
            setPwNote({ type: 'error', text: res.error })
        } else {
            setPw(EMPTY_PW)
            setShown({})
            // The handover is over the moment the password is the holder's own.
            setHandover(false)
            setUser((u) => ({ ...u, must_change_password: false }))
            setPwNote({ type: 'ok', text: `${res.data} — your other devices have been signed out.` })
        }
        setSavingPw(false)
    }

    if (loading) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} aria-hidden="true" />
                    <p>Loading your account…</p>
                </div>
            </div>
        )
    }

    if (loadError) {
        return (
            <div className={styles.container}>
                <div className={`${styles.message} ${styles.messageError}`} role="alert">
                    <AlertTriangle size={18} className={styles.messageIcon} aria-hidden="true" />
                    {loadError}
                </div>
            </div>
        )
    }

    const pwFilled = pw.current_password && pw.new_password && pw.confirm_password

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Your profile</h1>
                <p className={styles.subtitle}>
                    Your name, your password, and what this login can open.
                </p>
            </div>

            {nudge && (
                <div className={styles.banner} role="alert">
                    <AlertTriangle size={22} className={styles.bannerIcon} aria-hidden="true" />
                    <div>
                        <p className={styles.bannerTitle}>Set your own password</p>
                        <p className={styles.bannerBody}>
                            The one you were given is known to whoever gave it to you. Choose a
                            password only you know before you carry on — everything you ring up
                            is recorded under this account.
                        </p>
                    </div>
                </div>
            )}

            <div className={styles.cards}>
                <section className={styles.card}>
                    <div className={styles.cardHead}>
                        <div className={styles.cardIcon}>
                            <UserRound size={20} aria-hidden="true" />
                        </div>
                        <div>
                            <h2 className={styles.cardTitle}>Your account</h2>
                            <p className={styles.cardHint}>
                                Your name and email are yours to correct. Your username and role
                                are set by an admin.
                            </p>
                        </div>
                    </div>

                    <form action={saveAccount}>
                        <div className={styles.grid}>
                            <div className={styles.field}>
                                <label className={styles.label} htmlFor="full_name">Full name</label>
                                <input
                                    id="full_name"
                                    name="full_name"
                                    type="text"
                                    className={styles.input}
                                    value={account.full_name}
                                    onChange={(e) => setAccount((a) => ({ ...a, full_name: e.target.value }))}
                                    maxLength={191}
                                    autoComplete="name"
                                    disabled={savingAccount}
                                />
                                <span className={styles.fieldHint}>
                                    Shown on the bills and voids you put through.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label} htmlFor="email">Email</label>
                                <input
                                    id="email"
                                    name="email"
                                    type="email"
                                    className={styles.input}
                                    value={account.email}
                                    onChange={(e) => setAccount((a) => ({ ...a, email: e.target.value }))}
                                    maxLength={191}
                                    autoComplete="email"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    disabled={savingAccount}
                                    placeholder="you@flames.pk"
                                />
                                <span className={styles.fieldHint}>
                                    You can sign in with this. Leave it empty if you use your username.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <span className={styles.label}>Username</span>
                                <div className={styles.readonly}>{user.username || 'Not set'}</div>
                                <span className={styles.fieldHint}>Only an admin can change this.</span>
                            </div>

                            <div className={styles.field}>
                                <span className={styles.label}>Role</span>
                                <div className={styles.readonly}>
                                    <span className={styles.roleChip}>{user.role_label}</span>
                                </div>
                                <span className={styles.fieldHint}>
                                    Your role decides what you can open. Only an admin can change it.
                                </span>
                            </div>
                        </div>

                        {accountNote && (
                            <div
                                role="status"
                                aria-live="polite"
                                className={`${styles.message} ${accountNote.type === 'error' ? styles.messageError : styles.messageOk}`}
                            >
                                {accountNote.type === 'error'
                                    ? <AlertTriangle size={18} className={styles.messageIcon} aria-hidden="true" />
                                    : <CheckCircle2 size={18} className={styles.messageIcon} aria-hidden="true" />}
                                {accountNote.text}
                            </div>
                        )}

                        <div className={styles.formFoot}>
                            <span className={styles.footMeta}>
                                {user.last_login_at
                                    ? `Last sign-in ${signedInAt(user.last_login_at)}`
                                    : 'This is your first sign-in'}
                            </span>
                            <button
                                type="submit"
                                className={styles.saveBtn}
                                disabled={savingAccount || !accountDirty}
                            >
                                {savingAccount
                                    ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                                    : <Save size={16} aria-hidden="true" />}
                                Save changes
                            </button>
                        </div>
                    </form>
                </section>

                <section className={styles.card} ref={passwordCard}>
                    <div className={styles.cardHead}>
                        <div className={styles.cardIcon}>
                            <KeyRound size={20} aria-hidden="true" />
                        </div>
                        <div>
                            <h2 className={styles.cardTitle}>Password</h2>
                            <p className={styles.cardHint}>
                                Use at least 8 characters. Your current password is asked for even
                                though you are signed in — an unattended till is exactly where
                                someone would otherwise lock you out of your own account.
                            </p>
                        </div>
                    </div>

                    <form action={savePassword}>
                        <div className={styles.grid}>
                            <PasswordField
                                id="current_password"
                                label="Current password"
                                autoComplete="current-password"
                                value={pw.current_password}
                                onChange={(v) => setPw((p) => ({ ...p, current_password: v }))}
                                shown={Boolean(shown.current_password)}
                                onToggle={() => setShown((s) => ({ ...s, current_password: !s.current_password }))}
                                disabled={savingPw}
                                inputRef={currentPasswordInput}
                                wide
                            />

                            <PasswordField
                                id="new_password"
                                label="New password"
                                autoComplete="new-password"
                                value={pw.new_password}
                                onChange={(v) => setPw((p) => ({ ...p, new_password: v }))}
                                shown={Boolean(shown.new_password)}
                                onToggle={() => setShown((s) => ({ ...s, new_password: !s.new_password }))}
                                disabled={savingPw}
                                hint="At least 8 characters."
                            />

                            <PasswordField
                                id="confirm_password"
                                label="Confirm new password"
                                autoComplete="new-password"
                                value={pw.confirm_password}
                                onChange={(v) => setPw((p) => ({ ...p, confirm_password: v }))}
                                shown={Boolean(shown.confirm_password)}
                                onToggle={() => setShown((s) => ({ ...s, confirm_password: !s.confirm_password }))}
                                disabled={savingPw}
                            />
                        </div>

                        <p className={styles.note}>
                            Changing your password signs you out on every other device. This one
                            stays signed in.
                        </p>

                        {pwNote && (
                            <div
                                role="status"
                                aria-live="polite"
                                className={`${styles.message} ${pwNote.type === 'error' ? styles.messageError : styles.messageOk}`}
                            >
                                {pwNote.type === 'error'
                                    ? <AlertTriangle size={18} className={styles.messageIcon} aria-hidden="true" />
                                    : <CheckCircle2 size={18} className={styles.messageIcon} aria-hidden="true" />}
                                {pwNote.text}
                            </div>
                        )}

                        <div className={styles.formFoot}>
                            <button
                                type="submit"
                                className={styles.saveBtn}
                                disabled={savingPw || !pwFilled}
                            >
                                {savingPw
                                    ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                                    : <KeyRound size={16} aria-hidden="true" />}
                                Change password
                            </button>
                        </div>
                    </form>
                </section>

                <section className={styles.card}>
                    <div className={styles.cardHead}>
                        <div className={styles.cardIcon}>
                            <Palette size={20} aria-hidden="true" />
                        </div>
                        <div>
                            <h2 className={styles.cardTitle}>Appearance</h2>
                            <p className={styles.cardHint}>
                                Light or dark, or follow whatever this device is set to.
                                The choice is saved on this device, so a shared till keeps
                                the same look whoever signs in.
                            </p>
                        </div>
                    </div>

                    <ThemeSwitcher />
                </section>

                <section className={styles.card}>
                    <div className={styles.cardHead}>
                        <div className={styles.cardIcon}>
                            <ShieldCheck size={20} aria-hidden="true" />
                        </div>
                        <div>
                            <h2 className={styles.cardTitle}>What you can access</h2>
                            <p className={styles.cardHint}>
                                The screens this login opens. An admin changes these — ask if
                                something you need for your shift is missing.
                            </p>
                        </div>
                    </div>

                    {user.permissions.length === 0 ? (
                        <p className={styles.empty}>
                            Nothing yet. Ask an admin to give this account the screens it needs.
                        </p>
                    ) : (
                        <div className={styles.chips}>
                            {user.permissions.map((p) => (
                                <span key={p.key} className={styles.chip}>{p.label}</span>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    )
}

/*
 * Controlled rather than left to the browser: React resets an uncontrolled form
 * once its action settles, which would wipe all three boxes on a mistyped
 * current password. Clearing them is this screen's decision to make, and it
 * makes it only on success.
 */
function PasswordField({ id, label, value, onChange, shown, onToggle, disabled, hint, autoComplete, inputRef, wide }) {
    return (
        <div className={`${styles.field} ${wide ? styles.spanAll : ''}`}>
            <label className={styles.label} htmlFor={id}>{label}</label>
            <div className={styles.passwordField}>
                <input
                    id={id}
                    name={id}
                    ref={inputRef}
                    type={shown ? 'text' : 'password'}
                    className={styles.input}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    autoComplete={autoComplete}
                    disabled={disabled}
                />
                <button
                    type="button"
                    className={styles.reveal}
                    onClick={onToggle}
                    disabled={disabled}
                    aria-pressed={shown}
                    aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
                >
                    {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
            </div>
            {hint && <span className={styles.fieldHint}>{hint}</span>}
        </div>
    )
}

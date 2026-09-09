'use client'

import { useState, useEffect } from 'react'
import styles from './CookingLoader.module.css'

/*
 * Branded waiting state for the login → POS handoff.
 *
 * That wait is a few seconds of auth round-trip plus page render, and a bare
 * spinner made it read as "nothing is happening". Flames are the restaurant's
 * own mark, so the wait carries some character instead of just elapsing.
 *
 * Everything is inline SVG and CSS — no runtime, no assets to fetch on the very
 * request the user is already waiting on.
 */
const DEFAULT_MESSAGES = [
    'Lighting the flames...',
    'Warming the tandoor...',
    'Sharpening the knives...',
    'Plating up...',
]

export default function CookingLoader({ label, messages = DEFAULT_MESSAGES, size = 96 }) {
    const [index, setIndex] = useState(0)

    useEffect(() => {
        if (messages.length < 2) return
        const timer = setInterval(() => setIndex(i => (i + 1) % messages.length), 1900)
        return () => clearInterval(timer)
    }, [messages])

    return (
        <div className={styles.root} role="status" aria-live="polite">
            <div className={styles.stage} style={{ width: size, height: size }}>
                <div className={styles.glow} aria-hidden="true" />

                <svg
                    className={styles.flameSvg}
                    viewBox="0 0 64 64"
                    width={size}
                    height={size}
                    aria-hidden="true"
                >
                    {/*
                      * These stay literal through the theme switch, deliberately.
                      * The flame is brand artwork, not chrome: every stop is read
                      * against the stop beside it inside the flame shape, never
                      * against the page, so a light background changes nothing
                      * about its legibility. A flame is the same colour in a lit
                      * room as in a dark one. (The bloom BEHIND it is a different
                      * matter and is themed — see CookingLoader.module.css.)
                      */}
                    <defs>
                        <linearGradient id="cl-outer" x1="32" y1="60" x2="32" y2="4" gradientUnits="userSpaceOnUse">
                            <stop offset="0%" stopColor="#b91c1c" />
                            <stop offset="45%" stopColor="#f26513" />
                            <stop offset="100%" stopColor="#fb923c" />
                        </linearGradient>
                        <linearGradient id="cl-mid" x1="32" y1="56" x2="32" y2="16" gradientUnits="userSpaceOnUse">
                            <stop offset="0%" stopColor="#f97316" />
                            <stop offset="100%" stopColor="#fbbf24" />
                        </linearGradient>
                        <linearGradient id="cl-core" x1="32" y1="54" x2="32" y2="28" gradientUnits="userSpaceOnUse">
                            <stop offset="0%" stopColor="#fde047" />
                            <stop offset="100%" stopColor="#fffbeb" />
                        </linearGradient>
                    </defs>

                    <path
                        className={`${styles.flame} ${styles.flameOuter}`}
                        fill="url(#cl-outer)"
                        d="M32 3 C 41 17 50 25 50 38 C 50 50 42 59 32 59 C 22 59 14 50 14 38 C 14 25 23 17 32 3 Z"
                    />
                    <path
                        className={`${styles.flame} ${styles.flameMid}`}
                        fill="url(#cl-mid)"
                        d="M32 16 C 38 26 44 31 44 40 C 44 49 39 55 32 55 C 25 55 20 49 20 40 C 20 31 26 26 32 16 Z"
                    />
                    <path
                        className={`${styles.flame} ${styles.flameCore}`}
                        fill="url(#cl-core)"
                        d="M32 30 C 35 36 38 39 38 44 C 38 50 35 53 32 53 C 29 53 26 50 26 44 C 26 39 29 36 32 30 Z"
                    />
                </svg>

                {/* Embers drifting up past the flame. */}
                <span className={`${styles.ember} ${styles.ember1}`} aria-hidden="true" />
                <span className={`${styles.ember} ${styles.ember2}`} aria-hidden="true" />
                <span className={`${styles.ember} ${styles.ember3}`} aria-hidden="true" />
                <span className={`${styles.ember} ${styles.ember4}`} aria-hidden="true" />
            </div>

            {label && <p className={styles.label}>{label}</p>}

            {messages.length > 0 && (
                /* key on the text so each swap replays the fade rather than
                   sliding characters around. */
                <p key={index} className={styles.message}>
                    {messages[index]}
                </p>
            )}
        </div>
    )
}

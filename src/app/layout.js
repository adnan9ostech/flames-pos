import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppLayout from "@/components/Layout/AppLayout";
import ConnectionStatus from "@/components/Layout/ConnectionStatus";
import ServiceWorkerRegistrar from "@/components/Layout/ServiceWorkerRegistrar";
import { readSession } from "@/lib/db/auth.mjs";
import { query } from "@/lib/db/pool.mjs";
import { THEME_BOOT_SCRIPT } from "@/lib/theme.mjs";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Flames by the Indus | POS",
  description: "Point of Sale System for Flames by the Indus",
  manifest: "/manifest.webmanifest",
};

/*
 * Browser chrome — the mobile address bar and the installed PWA's status bar.
 * A single default (dark) meta that the boot script overwrites to the RESOLVED
 * theme before paint, and ThemeProvider keeps in step. It is deliberately NOT a
 * prefers-color-scheme media array: the app paints from the stored preference,
 * so tying the chrome to the OS would mismatch the page whenever the two differ
 * (a 'light' pref on a dark-OS till, or the dark default on a light-OS one).
 */
export const viewport = {
  themeColor: "#000000",
};

export default async function RootLayout({ children }) {
  // Cookie-only read — the layout renders on every request, and the signed
  // session already carries the role and the granted rights, so deciding what
  // the sidebar draws costs no database round trip.
  const session = await readSession();

  // The one thing the cookie does not carry is the person's name, and the
  // sidebar names who is signed in. A primary-key lookup, skipped entirely
  // when nobody is; a database blip costs the footer a name, not the shell.
  let name = null;
  if (session) {
    try {
      const rows = await query(
        'SELECT full_name, username FROM users WHERE id = ?',
        [session.sub],
      );
      name = rows[0]?.full_name || rows[0]?.username || null;
    } catch {
      name = null;
    }
  }

  const viewer = {
    role: session?.role ?? null,
    perms: session?.perms ?? [],
    name,
  };

  return (
    /*
     * suppressHydrationWarning is REQUIRED, not cosmetic: the script below sets
     * data-theme on <html> before React hydrates, so the server markup and the
     * client DOM differ by exactly that attribute. Scoped to this element, so
     * it never hides a real mismatch anywhere inside the app.
     */
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {/*
          * Paints the stored theme before the first frame. Has to be inline and
          * synchronous — a deferred or bundled script runs after paint, which
          * is precisely the flash it exists to prevent.
          */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <AppLayout session={viewer}>
          {children}
        </AppLayout>
        {/* Global, so a dropped connection is visible on every screen — the KDS
            especially, where a stale board reads as a quiet service. */}
        <ConnectionStatus />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}

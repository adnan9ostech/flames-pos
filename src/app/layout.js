import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppLayout from "@/components/Layout/AppLayout";
import ConnectionStatus from "@/components/Layout/ConnectionStatus";
import ServiceWorkerRegistrar from "@/components/Layout/ServiceWorkerRegistrar";
import { readSession } from "@/lib/db/auth.mjs";
import { query } from "@/lib/db/pool.mjs";

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

// Matches the app background so an installed till has no light flash on launch
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
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
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

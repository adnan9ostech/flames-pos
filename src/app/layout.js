import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppLayout from "@/components/Layout/AppLayout";
import ConnectionStatus from "@/components/Layout/ConnectionStatus";
import ServiceWorkerRegistrar from "@/components/Layout/ServiceWorkerRegistrar";
import { readSession } from "@/lib/db/auth.mjs";

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
  // Cookie-only read — the layout renders on every request, so it gets the
  // role from the signed session without touching the DB.
  const session = await readSession();
  const role = session?.role ?? null;

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <AppLayout role={role}>
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

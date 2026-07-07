import type { Metadata } from "next";
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  weight: ["400", "500", "600"],
  subsets: ["latin"]
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  weight: ["400", "500"],
  subsets: ["latin"]
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"]
});

const SITE_URL = "https://mapos.app";
const OG_DESCRIPTION =
  "Build local-first maps with Markdown notes, location data, and AI that runs on your Mac.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "MapOS — Markdown maps for AI",
  description: "A plaintext map format your agents can actually read, write, and reason about.",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "MapOS",
    title: "MapOS — Maps, Meet Markdown",
    description: OG_DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "MapOS — Maps, Meet Markdown" }]
  },
  twitter: {
    card: "summary_large_image",
    title: "MapOS — Maps, Meet Markdown",
    description: OG_DESCRIPTION,
    images: ["/og.png"]
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`dark ${geistSans.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable}`}
    >
      <body className="min-h-screen bg-neutral-950 text-neutral-50 antialiased font-[family-name:var(--font-geist-sans)] overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}

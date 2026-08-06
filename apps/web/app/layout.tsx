import type { Metadata } from "next";
import { Geist, Handjet } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  weight: ["400", "500", "600"],
  subsets: ["latin"]
});

const serverMono = localFont({
  src: "./fonts/ServerMono-Regular.woff2",
  variable: "--font-server-mono",
  weight: "400"
});

const handjet = Handjet({
  variable: "--font-handjet",
  subsets: ["latin"]
});

const SITE_URL = "https://mapos.md";
const OG_DESCRIPTION =
  "Your places, notes, and AI on one map. Plain files on your Mac, no accounts, works offline.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "MapOS — The connected map for you and your agents",
  description: "A plaintext map format your agents can actually read, write, and reason about.",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "MapOS",
    title: "MapOS — The connected map for you and your agents",
    description: OG_DESCRIPTION,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "MapOS — The connected map for you and your agents"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "MapOS — The connected map for you and your agents",
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
      className={`dark ${geistSans.variable} ${serverMono.variable} ${handjet.variable}`}
    >
      <body className="min-h-screen bg-neutral-950 text-neutral-50 antialiased font-[family-name:var(--font-geist-sans)] overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}

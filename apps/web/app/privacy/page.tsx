import type { Metadata } from "next";
import { LegalPage } from "../_components/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy — MapOS",
  description: "How MapOS handles your data. The short version: it stays on your Mac."
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="July 6, 2026">
      <p>
        MapOS is a local-first Mac app. Your saved places and notes are ordinary files stored on
        your own computer, and by default they are never sent to us or to anyone else. This policy
        explains the few cases where data does leave your device, and what we do and don&apos;t
        collect.
      </p>

      <h2>What stays on your device</h2>
      <p>
        Everything you create in MapOS lives in a folder on your Mac (by default{" "}
        <code>~/MapOS/</code>). That includes your places, notes, map data, app configuration, and
        your chat history with the AI agent. These files are the source of truth. We have no servers
        that store them, no account system, and no way to see them. You can back them up, move them,
        or delete them like any other files.
      </p>

      <h2>When data leaves your device</h2>
      <p>Data leaves your device only in these cases:</p>
      <ul>
        <li>
          <strong>AI chat. </strong>When you use the AI agent, your messages — and the contents of
          any files the agent reads to answer you — are sent to the AI provider you have configured
          (for example, Anthropic). That data is handled under that provider&apos;s own privacy
          policy and terms. We don&apos;t keep a copy on any server; your conversation history is
          stored only in your local vault.
        </li>
        <li>
          <strong>Downloads and map tiles.</strong> Downloading MapOS, its updates, region packs,
          and map tiles involves normal network requests to our content delivery network
          (Cloudflare). Like any web request, these produce standard server logs, such as your IP
          address and the file requested.
        </li>
      </ul>

      <h2>No telemetry or analytics</h2>
      <p>
        MapOS does not collect usage analytics, does not track how you use the app, and does not
        send automatic crash reports or &ldquo;phone home&rdquo; in the background.
      </p>

      <h2>This website</h2>
      <p>
        This website is hosted on Cloudflare. Visiting it produces standard server logs, such as
        your IP address, browser type, and the pages you request. The site does not use analytics or
        advertising cookies and does not track you across other sites.
      </p>

      <h2>Your choices, changes, and contact</h2>
      <p>
        Because your data stays on your device, you remain in control of it. You can edit or delete
        your files at any time. We may update this policy from time to time; the &ldquo;last
        updated&rdquo; date at the top reflects the current version. If you have any questions,
        contact <a href="mailto:hello@mapos.md">hello@mapos.md</a>.
      </p>
    </LegalPage>
  );
}

import type { Metadata } from "next";
import { LegalPage } from "../_components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service — MapOS",
  description: "The terms for downloading and using MapOS."
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="July 6, 2026">
      <p>
        These terms are a plain-language agreement between you and Nicholas Haley (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;), the individual who makes MapOS (&ldquo;the app&rdquo;). By downloading or
        using MapOS, you agree to them.
      </p>

      <h2>License to use MapOS</h2>
      <p>
        MapOS is free to download and use. We grant you a personal, non-exclusive, non-transferable,
        revocable license to install and run the app on devices you own or control, for any lawful
        purpose. MapOS is proprietary software, and we retain all rights, title, and interest in it.
        You may not sell, redistribute, rent, or sublicense the app, or attempt to reverse engineer,
        decompile, or extract its source code, except where such a restriction is prohibited by law.
      </p>

      <h2>No fee, no guarantee of maintenance</h2>
      <p>
        MapOS is provided free of charge. We are not obligated to provide updates, maintenance, or
        support, and we may change or discontinue the app at any time.
      </p>

      <h2>Your files are yours</h2>
      <p>
        MapOS stores your data as ordinary files on your own device, and you own that content. You
        are responsible for your files, including keeping backups. Because the files are the source
        of truth, moving or deleting them changes what MapOS shows.
      </p>

      <h2>AI features</h2>
      <p>
        MapOS includes an AI agent that can read, create, modify, and delete files in your vault on
        your behalf. AI output can be inaccurate or unexpected, and the file changes it makes may
        not be what you intended. Use these features at your own risk, review changes, and keep
        backups. You are responsible for how you use the agent and for the content you create with
        it.
      </p>

      <h2>Third-party services</h2>
      <p>
        When you use cloud map services or the AI agent, your requests are handled by third-party
        providers (such as map data, routing, search, and AI model providers). Your use of those
        features is also subject to those providers&apos; terms and privacy policies, and we are not
        responsible for third-party services.
      </p>

      <h2>Disclaimer of warranties</h2>
      <p>
        MapOS is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranties of
        any kind, whether express or implied, including but not limited to warranties of
        merchantability, fitness for a particular purpose, and non-infringement. We do not warrant
        that the app will be error-free or uninterrupted, or that any data will be preserved.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        MapOS is provided free of charge. To the fullest extent permitted by law, we will not be
        liable for any damages of any kind arising out of or related to your use of MapOS. This
        includes direct, indirect, incidental, special, consequential, and punitive damages, and any
        loss of data, profits, or goodwill, whether caused by the AI agent, by the app itself, or
        otherwise, even if we have been advised of the possibility of such damages.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the Province of Québec and the federal laws of
        Canada applicable there, without regard to conflict-of-law rules. Any dispute will be
        subject to the exclusive jurisdiction of the courts located in that province.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update these terms from time to time; the &ldquo;last updated&rdquo; date at the top
        reflects the current version, and continuing to use MapOS means you accept the updated
        terms. If you have any questions, contact{" "}
        <a href="mailto:hello@nichaley.com">hello@nichaley.com</a>.
      </p>
    </LegalPage>
  );
}

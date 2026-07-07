import Link from "next/link";
import { MapOSLogo } from "./mapos-logo";

type LegalPageProps = {
  title: string;
  /** Human-readable date, e.g. "July 6, 2026". */
  lastUpdated: string;
  children: React.ReactNode;
};

const footerLink = "text-neutral-500 no-underline transition-colors hover:text-neutral-300";

export function LegalPage({ title, lastUpdated, children }: LegalPageProps) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 px-[clamp(20px,4vw,56px)] pt-6">
      <header className="mx-auto w-full max-w-[720px]">
        <Link className="inline-flex no-underline" href="/">
          <MapOSLogo />
        </Link>
      </header>

      <main className="mx-auto w-full max-w-[720px] flex-1 py-16">
        <h1 className="m-0 font-[family-name:var(--font-instrument-serif)] text-[clamp(32px,4.6vw,48px)] font-normal text-neutral-50">
          {title}
        </h1>
        <p className="mt-2 font-[family-name:var(--font-jetbrains-mono)] text-[11.5px] tracking-[0.01em] text-neutral-500">
          Last updated: {lastUpdated}
        </p>
        <article className="prose prose-invert prose-neutral mt-10 max-w-none prose-headings:font-normal prose-headings:text-neutral-50 prose-a:font-normal prose-a:text-neutral-50 prose-code:rounded prose-code:bg-neutral-800/60 prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none">
          {children}
        </article>
      </main>

      <footer className="mx-auto flex w-full max-w-[720px] items-center justify-center gap-4 py-10 font-[family-name:var(--font-jetbrains-mono)] text-xs tracking-[0.01em] text-neutral-500">
        <span>© 2026 MapOS</span>
        <Link className={footerLink} href="/privacy">
          Privacy
        </Link>
        <Link className={footerLink} href="/terms">
          Terms
        </Link>
        <Link className={footerLink} href="/">
          Home
        </Link>
      </footer>
    </div>
  );
}

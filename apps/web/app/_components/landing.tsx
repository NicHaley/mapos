"use client";

import { useMemo } from "react";
import { SiApple } from "react-icons/si";
import { AsciiStarfield } from "./ascii-starfield";
import { AsciiSun } from "./ascii-sun";
import { MapOSLogo } from "./mapos-logo";

type LandingProps = {
  /** Latest version string (e.g. "1.0.0-alpha.2"), or null if it couldn't be resolved. */
  version: string | null;
  /** Human-readable .dmg size (e.g. "44.0 MB"), or null if unavailable. */
  sizeLabel: string | null;
};

export function Landing({ version, sizeLabel }: LandingProps) {
  // "Apple Silicon · v1.0.0-alpha.2 · 44.0 MB", dropping any unknown parts.
  const caption = ["Apple Silicon", version && `v${version}`, sizeLabel]
    .filter(Boolean)
    .join(" · ");

  const sunScene = useMemo(
    () => ({
      disableStars: true,
      flareLength: 1.0,
      // Rim sits at ~30% from the top of the viewport on any aspect — the
      // engine derives arcCenterY from rimFraction + yScale, so mobile and
      // desktop land in the same place visually.
      rimFraction: 0.3
    }),
    []
  );

  return (
    <>
      <div className="fixed inset-0 z-0 pointer-events-none" aria-hidden="true">
        <AsciiStarfield />
      </div>
      <div className="fixed inset-0 z-[1] pointer-events-none overflow-hidden" aria-hidden="true">
        <AsciiSun scene={sunScene} />
      </div>
      <div
        className="fixed inset-0 z-[2] pointer-events-none"
        aria-hidden="true"
        style={{
          background:
            "linear-gradient(to bottom, transparent 0%, transparent 38%, #0a0a0a 68%, #0a0a0a 100%)"
        }}
      />
      <div className="relative z-[3] grid min-h-screen grid-rows-[auto_1fr_auto] gap-6 px-[clamp(20px,4vw,56px)] pt-6 pb-5 text-center">
        <header className="flex items-center justify-between">
          <MapOSLogo />
        </header>

        <main className="flex min-h-0 flex-col items-center justify-end gap-7 pb-[6vh]">
          <section className="mx-auto flex max-w-[640px] flex-col items-center gap-3.5">
            <div className="flex flex-col items-center">
              <h1 className="m-0 font-[family-name:var(--font-instrument-serif)] text-[38px] font-normal text-neutral-50 sm:text-[clamp(36px,5.2vw,56px)]">
                Maps, Meet Markdown
              </h1>
              <p className="m-0 max-w-96 text-center text-lg text-neutral-300">
                Build local-first maps with Markdown notes, location data, and AI that runs on your
                Mac.
              </p>
            </div>
            <div className="mt-1.5 flex flex-wrap flex-col items-center justify-center gap-3.5">
              <a
                className="inline-flex items-center gap-2 rounded-lg bg-neutral-50 px-4 py-2.5 text-sm font-medium tracking-[-0.005em] text-neutral-950 no-underline transition-[background-color,transform] duration-150 hover:bg-neutral-200 active:translate-y-px [&_svg]:-mt-px"
                href="/download"
              >
                <SiApple size={14} aria-hidden="true" />
                Download for macOS
              </a>
              <span className="font-[family-name:var(--font-jetbrains-mono)] text-[11.5px] tracking-[0.01em] text-neutral-500">
                {caption}
              </span>
            </div>
          </section>
        </main>

        <footer className="flex items-center justify-center gap-2.5 font-[family-name:var(--font-jetbrains-mono)] text-xs tracking-[0.01em] text-neutral-500">
          <span>
            © 2026 MapOS • Made by{" "}
            <a href="https://github.com/NicHaley" className="underline">
              Nic
            </a>{" "}
            in Montreal
          </span>
        </footer>
      </div>
    </>
  );
}

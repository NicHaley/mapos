"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SiApple } from "react-icons/si";
import { AsciiStarfield } from "./ascii-starfield";
import { AsciiSun } from "./ascii-sun";
import { MapOSLogo } from "./mapos-logo";

export function Landing() {
  const sunScene = useMemo(() => ({ disableStars: true, flareLength: 1.0 }), []);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [sceneBottom, setSceneBottom] = useState<number | null>(null);

  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const update = () => {
      setSceneBottom(el.getBoundingClientRect().bottom);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <>
      <div
        className="fixed inset-x-0 top-0 z-0 h-screen overflow-hidden pointer-events-none"
        aria-hidden="true"
        style={sceneBottom != null ? { height: `${sceneBottom}px` } : undefined}
      >
        <AsciiStarfield />
      </div>
      <div className="relative z-[1] grid min-h-screen grid-rows-[auto_1fr_auto] gap-6 px-[clamp(20px,4vw,56px)] pt-6 pb-5 text-center">
        <header className="flex items-center justify-between">
          <MapOSLogo />
        </header>

        <main className="flex min-h-0 flex-col items-center justify-center gap-7">
          <div
            className="relative mx-auto aspect-video w-full max-w-[800px] shrink-0 bg-[radial-gradient(ellipse_62.5%_100%_at_50%_160%,#0a0a0a_95%,transparent_100%)]"
            ref={sceneRef}
          >
            <AsciiSun scene={sunScene} />
          </div>
          <section className="mx-auto flex max-w-[640px] flex-col items-center gap-3.5">
            <h1 className="m-0 font-[family-name:var(--font-instrument-serif)] text-[38px] leading-[1.02] font-normal italic tracking-[-0.015em] text-neutral-50 sm:text-[clamp(36px,5.2vw,56px)]">
              Spatial Notes.
            </h1>
            <p className="m-0 max-w-[48ch] text-center text-[15px] leading-[1.55] text-neutral-300">
              A plaintext map format your agents can actually read, write, and reason about.
            </p>
            <div className="mt-1.5 flex flex-wrap flex-col items-center justify-center gap-3.5">
              <a
                className="inline-flex items-center gap-2 rounded-lg bg-neutral-50 px-4 py-2.5 text-sm font-medium tracking-[-0.005em] text-neutral-950 no-underline transition-[background-color,transform] duration-150 hover:bg-neutral-200 active:translate-y-px [&_svg]:-mt-px"
                href="#download"
              >
                <SiApple size={14} aria-hidden="true" />
                Download for macOS
              </a>
              <span className="font-[family-name:var(--font-jetbrains-mono)] text-[11.5px] tracking-[0.01em] text-neutral-500">
                v0.1.4 · Apple Silicon · 4.2 MB
              </span>
            </div>
          </section>
        </main>

        <footer className="flex items-center justify-center gap-2.5 font-[family-name:var(--font-jetbrains-mono)] text-xs tracking-[0.01em] text-neutral-500">
          <span>© 2026 MapOS</span>
          <span className="opacity-50">·</span>
          <span>made for cartographers and language models</span>
        </footer>
      </div>
    </>
  );
}

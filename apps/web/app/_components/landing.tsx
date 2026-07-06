"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from "@mapos/ui/components/accordion";
import { useEffect, useMemo, useState } from "react";
import { SiApple } from "react-icons/si";
import { AsciiStarfield } from "./ascii-starfield";
import { AsciiSun } from "./ascii-sun";
import { MapOSLogo } from "./mapos-logo";

const FAQ_ITEMS = [
  {
    question: "What is MapOS?",
    answer:
      "MapOS is a local-first map app for your Mac. Your saved places are plain Markdown files with location data in their frontmatter, and the map is the interface to them."
  },
  {
    question: "Where is my data stored?",
    answer:
      "Everything lives in a folder on your Mac. The files are the source of truth: no accounts, no sync servers, and you can read or edit them with any text editor."
  },
  {
    question: "Can I use it with Obsidian?",
    answer:
      "Yes. A MapOS vault is also a valid Obsidian vault, so you can open the same folder in both apps and your notes stay compatible."
  },
  {
    question: "Does it work offline?",
    answer:
      "Yes. Download region packs to get maps, search, and routing that run entirely on your machine, or switch to cloud services when you prefer."
  },
  {
    question: "What platforms are supported?",
    answer: "MapOS is currently available for Apple Silicon Macs."
  }
];

type LandingProps = {
  /** Latest version string (e.g. "1.0.0-alpha.2"), or null if it couldn't be resolved. */
  version: string | null;
  /** Human-readable .dmg size (e.g. "44.0 MB"), or null if unavailable. */
  sizeLabel: string | null;
};

// Parallax scroll factors, ordered by depth: the starfield stays fixed, the
// sun drifts slowest, the earth faster, and the title fastest (its factor is
// added on top of its natural 1x document scroll).
const SUN_PARALLAX = 0.15;
const EARTH_PARALLAX = 0.45;
const TITLE_PARALLAX = 0.22;

// Scroll progress (viewports) at which the sun/earth/stars scene is fully
// faded out.
const SCENE_FADE_END = 0.8;

export function Landing({ version, sizeLabel }: LandingProps) {
  // "Apple Silicon · v1.0.0-alpha.2 · 44.0 MB", dropping any unknown parts.
  const caption = ["Apple Silicon", version && `v${version}`, sizeLabel]
    .filter(Boolean)
    .join(" · ");

  const [scroll, setScroll] = useState({ y: 0, viewportH: 1 });

  useEffect(() => {
    const update = () =>
      setScroll({ y: window.scrollY, viewportH: Math.max(1, window.innerHeight) });
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  // Fraction of one viewport scrolled — the unit the engine's offsets use.
  const progress = scroll.y / scroll.viewportH;
  const sceneOpacity = Math.max(0, 1 - progress / SCENE_FADE_END);

  const sunScene = useMemo(
    () => ({
      disableStars: true,
      flareLength: 1.0,
      // Rim sits at ~30% from the top of the viewport on any aspect — the
      // engine derives arcCenterY from rimFraction + yScale, so mobile and
      // desktop land in the same place visually.
      rimFraction: 0.3,
      sunOffsetY: progress * SUN_PARALLAX,
      planetOffsetY: progress * EARTH_PARALLAX
    }),
    [progress]
  );

  return (
    <>
      <div
        className="fixed inset-0 z-0 pointer-events-none"
        aria-hidden="true"
        style={{ opacity: sceneOpacity }}
      >
        <AsciiStarfield />
      </div>
      <div
        className="fixed inset-0 z-[1] pointer-events-none overflow-hidden"
        aria-hidden="true"
        style={{ opacity: sceneOpacity }}
      >
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
      <div className="relative z-[3]">
        <div className="grid min-h-screen grid-rows-[auto_1fr] gap-6 px-[clamp(20px,4vw,56px)] pt-6 pb-5 text-center">
          <header className="flex items-center justify-between">
            <MapOSLogo />
          </header>

          <main
            className="flex min-h-0 flex-col items-center justify-end gap-7 pb-[6vh]"
            style={{ transform: `translateY(${-scroll.y * TITLE_PARALLAX}px)` }}
          >
            <section className="mx-auto flex max-w-[640px] flex-col items-center gap-3.5">
              <div className="flex flex-col items-center">
                <h1 className="m-0 font-[family-name:var(--font-instrument-serif)] text-[38px] font-normal text-neutral-50 sm:text-[clamp(36px,5.2vw,56px)]">
                  Maps, Meet Markdown
                </h1>
                <p className="m-0 max-w-96 text-center text-lg text-neutral-300">
                  Build local-first maps with Markdown notes, location data, and AI that runs on
                  your Mac.
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
        </div>

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pt-20 pb-24">
          <div className="mx-auto flex w-full max-w-[960px] flex-col items-center gap-7">
            <h2 className="m-0 font-[family-name:var(--font-instrument-serif)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
              See it in action
            </h2>
            <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-neutral-800 bg-neutral-900/50">
              <div className="flex flex-col items-center gap-3.5">
                <div className="flex size-14 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950/60">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="ml-0.5 text-neutral-300"
                    aria-hidden="true"
                  >
                    <path d="M4 2.5v11l9-5.5z" />
                  </svg>
                </div>
                <span className="font-[family-name:var(--font-jetbrains-mono)] text-xs tracking-[0.01em] text-neutral-500">
                  Demo video coming soon
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pb-24">
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-7">
            <h2 className="m-0 text-center font-[family-name:var(--font-instrument-serif)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
              Frequently asked questions
            </h2>
            <Accordion className="border-y border-neutral-800" multiple={false}>
              {FAQ_ITEMS.map((item) => (
                <AccordionItem
                  className="not-last:border-neutral-800"
                  key={item.question}
                  value={item.question}
                >
                  <AccordionTrigger className="items-center py-5 text-[15px] text-neutral-50 hover:no-underline">
                    {item.question}
                  </AccordionTrigger>
                  <AccordionContent className="pb-5 text-left text-sm leading-relaxed text-neutral-400">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        <footer className="flex items-center justify-center gap-2.5 bg-neutral-950 pb-5 font-[family-name:var(--font-jetbrains-mono)] text-xs tracking-[0.01em] text-neutral-500">
          <span>© 2026 MapOS</span>
        </footer>
      </div>
    </>
  );
}

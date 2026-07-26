"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from "@mapos/ui/components/accordion";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SiApple } from "react-icons/si";
import { AgentDemo } from "./agent-demo";
import { AsciiStarfield } from "./ascii-starfield";
import { AsciiSun } from "./ascii-sun";
import { InteractiveGrid } from "./interactive-grid";
import { MapOSLogo } from "./mapos-logo";
import { MeetupDemo } from "./meetup-demo";
import { PixelFileText, PixelPlay, PixelServer, PixelSignalOff } from "./pixel-icons";
import { SkillsSection } from "./skills-section";
import { ToolBelt } from "./tool-belt";

const FAQ_ITEMS = [
  {
    question: "What is MapOS?",
    answer:
      "MapOS is a local-first map client for your Mac. Your saved places are plain Markdown files with location data in their frontmatter, and the map is the interface to them."
  },
  {
    question: "How much does it cost?",
    answer: "MapOS is free. Download it and use it with no account, subscription, or usage limits."
  },
  {
    question: "Where is my data stored?",
    answer:
      "Everything lives in a folder on your Mac. The files are the source of truth: no accounts, no sync servers, and you can read or edit them with any text editor."
  },
  {
    question: "Does MapOS collect any data?",
    answer:
      "No. There's no telemetry, analytics, or crash reporting, and no account to sign in to. The app only touches the network to check for updates, download region packs, and reach services you choose — like cloud mode."
  },
  {
    question: "How does AI work in MapOS?",
    answer:
      "MapOS hosts a local MCP server, so you connect the AI app you already use — Claude Desktop, Claude Code, or any MCP-capable client — and it can search your places, draw routes, and edit your vault. The connection stays on your machine, and AI requests are handled by your client and its provider, never by a MapOS server."
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

const FEATURES = [
  {
    icon: PixelFileText,
    title: "places as markdown",
    body: "Every place is a Markdown file with its location in the frontmatter. Edit it in MapOS, in Obsidian, or in any text editor."
  },
  {
    icon: PixelServer,
    title: "an MCP server for your map",
    body: "Connect any MCP client, like Claude Code. Ask it to find places, draw routes, build overlays, and annotate your vault."
  },
  {
    icon: PixelSignalOff,
    title: "maps that work offline",
    body: "Download region packs for search, routing, and map tiles with no connection. Switch to cloud services whenever you want."
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
  // "[ Apple Silicon · v1.0.0-alpha.2 · 44.0 MB ]", dropping any unknown parts.
  const caption = `[ ${["Apple Silicon", version && `v${version}`, sizeLabel]
    .filter(Boolean)
    .join(" · ")} ]`;

  const [scroll, setScroll] = useState({ y: 0, viewportH: 1 });

  useEffect(() => {
    const update = () =>
      setScroll({
        y: window.scrollY,
        viewportH: Math.max(1, window.innerHeight)
      });
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
              <div className="flex flex-col items-center gap-5">
                <div className="flex flex-col items-center">
                  <span className="font-[family-name:var(--font-handjet)] text-[34px] leading-none text-neutral-50 sm:text-[44px]">
                    map anything
                  </span>
                  <h1 className="m-0 text-balance font-[family-name:var(--font-handjet)] text-[34px] font-normal leading-none text-neutral-400 sm:text-[44px] max-w-[340px]">
                    the connected map for you and your agents
                  </h1>
                </div>
                <p className="m-0 text-center text-lg text-neutral-300">
                  Your places, notes, and AI on one map.
                  <br className="hidden sm:block" />
                  Plain files on your Mac, no accounts, works offline.
                </p>
              </div>
              <div className="flex flex-wrap flex-col items-center justify-center gap-3.5">
                <a
                  className="my-2 inline-flex items-center gap-2 rounded-xs bg-[#2B5BFF] px-4 py-2.5 font-[family-name:var(--font-server-mono)] text-[13px] uppercase tracking-[0.04em] text-white no-underline transition-[background-color,transform] duration-150 hover:bg-[#2149E8] active:translate-y-px [&_svg]:-mt-px"
                  href="/download"
                >
                  <SiApple size={14} aria-hidden="true" />
                  Download for macOS
                </a>
                <span className="font-[family-name:var(--font-server-mono)] text-[11.5px] uppercase tracking-[0.04em] text-neutral-500">
                  {caption}
                </span>
              </div>
            </section>
          </main>
        </div>

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pt-16" id="demo">
          <div className="mx-auto w-full max-w-[960px]">
            <AgentDemo />
          </div>
        </section>

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pt-20">
          <div className="mx-auto flex w-full max-w-[960px] flex-col gap-14">
            <div className="flex flex-col items-center gap-3.5 text-center">
              <h2 className="m-0 font-[family-name:var(--font-handjet)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
                your places are just files
              </h2>
              <p className="m-0 max-w-[560px] text-lg text-neutral-400">
                Every place in MapOS is a plain Markdown file with its location in the frontmatter.
                MapOS reads that and puts it on the map. No database and no lock-in; your data is
                text you own.
              </p>
            </div>

            {/* Both card rows are one block: tight between them, and the
                section's gap-14 still separates them from the heading. */}
            <div className="flex flex-col gap-4">
              <div className="grid items-stretch gap-4 md:grid-cols-2">
                <div className="overflow-hidden rounded-xs border border-neutral-800 bg-neutral-900/50">
                  <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
                    <span className="size-3 rounded-full bg-neutral-700" />
                    <span className="size-3 rounded-full bg-neutral-700" />
                    <span className="size-3 rounded-full bg-neutral-700" />
                    <span className="ml-2 font-[family-name:var(--font-server-mono)] text-xs text-neutral-500">
                      Blue Bottle Coffee.md
                    </span>
                  </div>
                  <pre className="overflow-x-auto p-5 font-[family-name:var(--font-server-mono)] text-[13px] leading-relaxed">
                    <code>
                      <span className="text-neutral-600">---</span>
                      {"\n"}
                      <span className="text-neutral-500">geometry:</span>{" "}
                      <span className="text-neutral-200">&quot;POINT(-122.423 37.765)&quot;</span>
                      {"\n"}
                      <span className="text-neutral-500">color:</span>{" "}
                      <span className="text-[#7A97FF]">&quot;#2B5BFF&quot;</span>
                      {"\n"}
                      <span className="text-neutral-500">tags:</span>{" "}
                      <span className="text-neutral-200">[coffee, favorites]</span>
                      {"\n"}
                      <span className="text-neutral-600">---</span>
                      {"\n\n"}
                      <span className="text-neutral-400">Great cortado. Sit by the window.</span>
                    </code>
                  </pre>
                </div>

                <InteractiveGrid>
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2">
                      <span className="rounded-md bg-neutral-950/80 px-2 py-1 font-[family-name:var(--font-server-mono)] text-xs text-neutral-200 backdrop-blur">
                        Blue Bottle Coffee
                      </span>
                      <svg
                        aria-hidden="true"
                        fill="#2B5BFF"
                        height="30"
                        viewBox="0 0 24 24"
                        width="30"
                      >
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
                      </svg>
                    </div>
                  </div>
                </InteractiveGrid>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                {FEATURES.map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <div
                      className="flex flex-col gap-3 rounded-xs border border-neutral-800 bg-neutral-900/30 p-6"
                      key={feature.title}
                    >
                      <div className="flex size-10 items-center justify-center rounded-xs border border-neutral-800 bg-neutral-950 text-neutral-400">
                        <Icon aria-hidden="true" size={18} />
                      </div>
                      <h3 className="m-0 text-base font-medium text-neutral-50">{feature.title}</h3>
                      <p className="m-0 text-sm leading-relaxed text-neutral-400">{feature.body}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pt-20">
          <div className="mx-auto flex w-full max-w-[960px] flex-col gap-12">
            <div className="flex flex-col items-center gap-3.5 text-center">
              <h2 className="m-0 font-[family-name:var(--font-handjet)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
                it composes tools you'd have to chain by hand
              </h2>
              <p className="m-0 max-w-[600px] text-lg text-neutral-400">
                Two walk-time areas, the overlap, a search inside it, results on the map. Four
                tools, one sentence.
              </p>
            </div>
            <MeetupDemo />
          </div>
        </section>

        {/* Outside the section's padding so the belts run edge to edge and the
            demo's four tools land against the whole surface. */}
        <div className="bg-neutral-950 pt-14">
          <ToolBelt />
        </div>

        <SkillsSection />

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pt-20 pb-24">
          <div className="mx-auto flex w-full max-w-[960px] flex-col items-center gap-7">
            <h2 className="m-0 font-[family-name:var(--font-handjet)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
              see it in action
            </h2>
            {/* Placeholder for the recorded walkthrough (next-video asset once
                it exists — drop the MP4 in apps/web/videos and sync). */}
            <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xs border border-neutral-800 bg-neutral-900/50">
              <div className="flex flex-col items-center gap-3.5">
                <div className="flex size-14 items-center justify-center rounded-xs border border-neutral-700 bg-neutral-950/60">
                  <PixelPlay aria-hidden="true" className="text-neutral-300" size={22} />
                </div>
                <span className="font-[family-name:var(--font-server-mono)] text-xs tracking-[0.01em] text-neutral-500">
                  Demo video coming soon
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pb-24">
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-7">
            <h2 className="m-0 text-center font-[family-name:var(--font-handjet)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
              frequently asked questions
            </h2>
            <Accordion className="border-y border-neutral-800" multiple={false}>
              {FAQ_ITEMS.map((item) => (
                <AccordionItem
                  className="not-last:border-neutral-800"
                  key={item.question}
                  value={item.question}
                >
                  <AccordionTrigger className="items-center py-5 text-lg text-neutral-50 hover:no-underline">
                    {item.question}
                  </AccordionTrigger>
                  <AccordionContent className="pb-5 text-left text-base leading-relaxed text-neutral-400">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pb-28">
          <div className="mx-auto flex max-w-[640px] flex-col items-center gap-4 rounded-xs border border-neutral-800 bg-gradient-to-b from-neutral-900 to-neutral-950 px-8 py-14 text-center">
            <h2 className="m-0 font-[family-name:var(--font-handjet)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
              free. no account required.
            </h2>
            <div className="flex flex-col items-center gap-5">
              <a
                className="inline-flex items-center gap-2 rounded-xs bg-[#2B5BFF] px-4 py-2.5 font-[family-name:var(--font-server-mono)] text-[13px] uppercase tracking-[0.04em] text-white no-underline transition-[background-color,transform] duration-150 hover:bg-[#2149E8] active:translate-y-px [&_svg]:-mt-px"
                href="/download"
              >
                <SiApple size={14} aria-hidden="true" />
                Download for macOS
              </a>
              <span className="font-[family-name:var(--font-server-mono)] text-[11.5px] uppercase tracking-[0.04em] text-neutral-500">
                {caption}
              </span>
            </div>
          </div>
        </section>

        <footer className="flex items-center justify-center gap-4 bg-neutral-950 pb-5 font-[family-name:var(--font-server-mono)] text-xs tracking-[0.01em] text-neutral-500">
          <span>© 2026 MapOS</span>
          <Link
            className="text-neutral-500 no-underline transition-colors hover:text-neutral-300"
            href="/privacy"
          >
            Privacy
          </Link>
          <Link
            className="text-neutral-500 no-underline transition-colors hover:text-neutral-300"
            href="/terms"
          >
            Terms
          </Link>
          <a
            className="text-neutral-500 no-underline transition-colors hover:text-neutral-300"
            href="mailto:hello@mapos.md"
          >
            Contact
          </a>
        </footer>
      </div>
    </>
  );
}

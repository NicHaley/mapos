"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LuChevronDown, LuChevronRight, LuFile, LuFolder } from "react-icons/lu";
import dockClaude from "./dock-claude.png";
import dockFinder from "./dock-finder.png";
import dockGhostty from "./dock-ghostty.png";
import dockObsidian from "./dock-obsidian.png";
import maposDockIcon from "./mapos-dock-icon.png";
import windowShot from "./mapos-window.png";

// A scripted reconstruction of an MCP session: the real app window as a
// static capture, with the terminal, dropped pins, and sidebar files
// animated in DOM on top so the text stays crisp at any size.

const PROMPT = "Save the best pizza in New York to my map";

// Pin positions are percentages of the window capture, projected from each
// spot's real coordinates (georeferenced against the basemap labels).
const PLACES = [
  { name: "Joe's Pizza", x: 49.1, y: 67.6 },
  { name: "Una Pizza Napoletana", x: 56, y: 76.5 },
  { name: "L'Industrie", x: 62.4, y: 79.5 },
  { name: "Mama's Too", x: 61.5, y: 24.1 },
  { name: "Roberta's", x: 69.8, y: 83.3 },
];

type TermLine = {
  kind: "tool" | "result" | "done";
  text: string;
};

type Step = {
  /** ms after the previous step before this one fires. */
  delay: number;
  line: TermLine;
  /** Index into PLACES revealed on the map (and in the sidebar). */
  pin?: number;
};

const STEPS: Step[] = [
  {
    delay: 700,
    line: { kind: "tool", text: 'web_search "best pizza nyc"' },
  },
  { delay: 1300, line: { kind: "result", text: "Una Pizza Napoletana ranked #1" } },
  {
    delay: 800,
    line: { kind: "tool", text: 'geocode_search "pizza, new york"' },
  },
  { delay: 1000, line: { kind: "result", text: "28 results" } },
  {
    delay: 900,
    line: { kind: "tool", text: 'write_vault_file "Pizza/Joe\'s Pizza.md"' },
    pin: 0,
  },
  {
    delay: 750,
    line: {
      kind: "tool",
      text: 'write_vault_file "Pizza/Una Pizza Napoletana.md"',
    },
    pin: 1,
  },
  {
    delay: 750,
    line: { kind: "tool", text: 'write_vault_file "Pizza/L\'Industrie.md"' },
    pin: 2,
  },
  {
    delay: 750,
    line: { kind: "tool", text: 'write_vault_file "Pizza/Mama\'s Too.md"' },
    pin: 3,
  },
  {
    delay: 750,
    line: { kind: "tool", text: 'write_vault_file "Pizza/Roberta\'s.md"' },
    pin: 4,
  },
  { delay: 900, line: { kind: "done", text: "5 places saved to your map" } },
];

// Static rows drawn in the capture's empty sidebar so the vault doesn't
// look brand new; the Pizza folder appears below them as the agent writes.
const SIDEBAR_FOLDERS = ["attachments", "Collections", "Friends", "Trips"];

const DOCK_APPS = [
  { name: "Finder", icon: dockFinder, running: true },
  { name: "Ghostty", icon: dockGhostty, running: true },
  { name: "MapOS", icon: maposDockIcon, running: true },
  { name: "Claude", icon: dockClaude, running: false },
  { name: "Obsidian", icon: dockObsidian, running: false },
];

const TYPE_MS = 30;
const HOLD_MS = 5000;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function AgentDemo() {
  const [started, setStarted] = useState(false);
  const [typed, setTyped] = useState(0);
  const [step, setStep] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reduced motion renders the finished frame statically, no loop.
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || started) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setStarted(true);
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started || reduced || typed >= PROMPT.length) return;
    const t = setTimeout(() => setTyped((n) => n + 1), TYPE_MS);
    return () => clearTimeout(t);
  }, [started, reduced, typed]);

  useEffect(() => {
    if (!started || reduced || typed < PROMPT.length) return;
    const next = STEPS[step];
    if (next) {
      const t = setTimeout(() => setStep((s) => s + 1), next.delay);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setTyped(0);
      setStep(0);
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [started, reduced, typed, step]);

  const shownTyped = reduced ? PROMPT.length : typed;
  const shownStep = reduced ? STEPS.length : step;
  const shownPins = STEPS.slice(0, shownStep).flatMap((s) =>
    s.pin === undefined ? [] : [s.pin],
  );

  return (
    <div
      className="relative w-full"
      ref={containerRef}
      style={{ containerType: "inline-size" }}
    >
      <div className="relative overflow-hidden rounded-xl border border-neutral-800 shadow-2xl shadow-black/50">
        <Image
          alt="The MapOS app showing a map of New York while an agent saves new places to the vault"
          className="block h-auto w-full"
          placeholder="blur"
          sizes="(min-width: 1024px) 960px, 100vw"
          src={windowShot}
        />

        {/* Vault entries drawn in the (real) sidebar's empty space. */}
        <div
          className="pointer-events-none absolute hidden flex-col text-neutral-300 md:flex"
          style={{ left: "1.3%", top: "15.3%", fontSize: "0.87cqw" }}
        >
          {SIDEBAR_FOLDERS.map((folder) => (
            <div
              className="flex items-center"
              key={folder}
              style={{ gap: "0.55cqw", height: "2.1cqw" }}
            >
              <LuChevronRight
                aria-hidden="true"
                className="text-neutral-500"
                style={{ width: "0.9cqw", height: "0.9cqw" }}
              />
              <LuFolder
                aria-hidden="true"
                className="text-neutral-400"
                style={{ width: "0.95cqw", height: "0.95cqw" }}
              />
              {folder}
            </div>
          ))}
          {shownPins.length > 0 ? (
            <div
              className="flex items-center animate-[file-in_0.3s_ease-out]"
              style={{ gap: "0.55cqw", height: "2.1cqw" }}
            >
              <LuChevronDown
                aria-hidden="true"
                className="text-neutral-500"
                style={{ width: "0.9cqw", height: "0.9cqw" }}
              />
              <LuFolder
                aria-hidden="true"
                className="text-neutral-400"
                style={{ width: "0.95cqw", height: "0.95cqw" }}
              />
              Pizza
            </div>
          ) : null}
          {shownPins.map((i) => {
              const place = PLACES[i];
              if (!place) return null;
              return (
                <div
                  className="flex items-center animate-[file-in_0.3s_ease-out]"
                  key={place.name}
                  style={{
                    gap: "0.55cqw",
                    height: "2.1cqw",
                    paddingLeft: "1.45cqw",
                  }}
                >
                  <LuFile
                    aria-hidden="true"
                    className="text-neutral-400"
                    style={{ width: "0.95cqw", height: "0.95cqw" }}
                  />
                  {place.name}
                </div>
              );
          })}
        </div>

        {/* Pins dropped on the map as the agent writes each file. */}
        {shownPins.map((i) => {
          const place = PLACES[i];
          if (!place) return null;
          return (
            <div
              className="pointer-events-none absolute flex animate-[pin-drop_0.35s_ease-out] flex-col items-center gap-1"
              key={place.name}
              style={{
                left: `${place.x}%`,
                top: `${place.y}%`,
                // The dot (18px) is the anchor: its centre sits on the
                // coordinate, with the label stacked above.
                transform: "translate(-50%, calc(-100% + 9px))",
              }}
            >
              <span className="hidden rounded-md bg-neutral-950/80 px-2 py-1 font-[family-name:var(--font-server-mono)] text-xs text-neutral-200 backdrop-blur sm:block">
                {place.name}
              </span>
              <span className="size-[18px] rounded-full border-2 border-white bg-[#2B5BFF]" />
            </div>
          );
        })}

        {/* Mock dock. Real app icons (each 256px canvas with the standard
            macOS margin baked in); dots mark running apps, matching the
            story (Ghostty hosts the agent, MapOS is the window). */}
        <div className="pointer-events-none absolute bottom-[1.4%] left-1/2 flex -translate-x-1/2 items-end gap-[0.15cqw] rounded-[1cqw] border border-white/10 bg-neutral-400/15 px-[0.2cqw] pt-[0.1cqw] backdrop-blur-md">
          {DOCK_APPS.map((app) => (
            <div className="flex flex-col items-center" key={app.name}>
              <Image alt="" className="size-[4.5cqw]" src={app.icon} />
              <span
                className={`mb-[0.16cqw] size-[0.3cqw] rounded-full ${app.running ? "bg-white/60" : "bg-transparent"}`}
              />
            </div>
          ))}
        </div>
      </div>

      {/* The MCP client. Overlaid on the map on larger screens, stacked
          below the window on mobile so the text stays readable. */}
      <div className="mt-3 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/90 shadow-black/40 shadow-xl backdrop-blur sm:absolute sm:top-[6%] sm:left-[21%] sm:mt-0 sm:w-[36%] sm:max-w-[430px]">
        <div className="flex items-center gap-1.5 border-b border-neutral-800/80 px-3 py-2">
          <span className="size-2 rounded-full bg-neutral-700" />
          <span className="size-2 rounded-full bg-neutral-700" />
          <span className="size-2 rounded-full bg-neutral-700" />
          <span className="ml-1.5 font-[family-name:var(--font-server-mono)] text-[10px] text-neutral-500 uppercase tracking-[0.04em]">
            claude code · mapos
          </span>
        </div>
        <div className="flex flex-col gap-1 px-3.5 py-3 font-[family-name:var(--font-server-mono)] text-[11.5px] leading-relaxed">
          <div className="text-neutral-50">
            <span className="text-neutral-500">&gt; </span>
            {PROMPT.slice(0, shownTyped)}
            {shownTyped < PROMPT.length ? (
              <span className="animate-pulse text-neutral-400">▍</span>
            ) : null}
          </div>
          {STEPS.slice(0, shownStep).map(({ line }) => {
            if (line.kind === "tool") {
              return (
                <div className="text-neutral-300" key={line.text}>
                  <span className="text-[#7A97FF]">● </span>
                  {line.text}
                </div>
              );
            }
            if (line.kind === "result") {
              return (
                <div className="pl-4 text-neutral-500" key={line.text}>
                  ⎿ {line.text}
                </div>
              );
            }
            return (
              <div className="text-neutral-50" key={line.text}>
                ✓ {line.text}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

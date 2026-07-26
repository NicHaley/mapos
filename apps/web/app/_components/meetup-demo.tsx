"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LuChevronRight, LuFolder, LuGraduationCap, LuMapPin, LuPentagon } from "react-icons/lu";
import dockClaude from "./dock-claude.png";
import dockFinder from "./dock-finder.png";
import dockGhostty from "./dock-ghostty.png";
import dockObsidian from "./dock-obsidian.png";
import maposDockIcon from "./mapos-dock-icon.png";
import windowShot from "./mapos-window-plateau.png";
import { McpTranscript, type TermLine } from "./mcp-transcript";

// Second scripted MCP session, composing four tools: two walk isochrones, their
// intersection, a search inside it, results on the map. Same technique as
// agent-demo.tsx — the real app window as a static capture with the zone, pins
// and results panel animated in SVG/DOM on top so everything stays crisp at any
// size. Every overlay position below is measured off the capture this replaces
// the empty state of, so the drawn layers land where the app really put them.

const PROMPT = "Brunch with Sam. I'm at McGill, they're in Outremont, 20 min walk max.";

// The capture's aspect ratio, used as the overlay viewBox so strokes stay
// isotropic. 3024 × 1898 → x = percent × 15.93, y = percent × 10.
const VIEW_W = 1593;
const VIEW_H = 1000;

// The fair-meeting zone: the overlap of the two 20-minute walk isochrones,
// traced from the polygon the app drew.
const ZONE_POINTS = [
  [877.6, 596.2],
  [841.8, 597.2],
  [835.7, 591.7],
  [838.4, 582.7],
  [828.9, 551.6],
  [834.2, 513.7],
  [846.5, 498.2],
  [888.2, 480.2],
  [982.5, 459.7],
  [1046.2, 462.9],
  [1095.7, 451.3],
  [1108.9, 479.2],
  [1123.4, 477.9],
  [1137.1, 510.0],
  [1141.3, 530.0],
  [1116.8, 541.4],
  [971.4, 570.9],
  [953.5, 569.8],
  [929.3, 581.9],
  [917.1, 583.5],
  [897.6, 576.1]
]
  .map(([x, y]) => `${x},${y}`)
  .join(" ");

// Where the two of them start out, as percentages of the capture. The McGill
// dot sits on the basemap's own McGill marker; Sam's is placed in Outremont,
// clear of both the zone and the terminal panel overlaid above it.
const ORIGINS = [
  { label: "You · 22 min", x: 62.56, y: 71.04 },
  { label: "Sam · 22 min", x: 45.0, y: 57.0 }
];

// The result pins inside the zone, as percentages of the capture. Three of the
// cafés share a block, so the cluster is tight — that's the real spacing.
const ZONE_PINS: Array<[number, number]> = [
  [63.61, 49.32],
  [63.15, 50.95],
  [62.95, 52.85],
  [62.7, 52.27],
  [61.87, 51.61],
  [61.54, 55.03],
  [61.25, 52.4]
];

type ResultRow = {
  name: string;
  /** POI category shown beside the name; absent for the zone polygon. */
  category?: string;
  /** Second line; absent for the zone polygon. */
  address?: string;
  icon: typeof LuMapPin;
};

const RESULTS: ResultRow[] = [
  {
    name: "McGill University",
    category: "University",
    address: "845 Rue Sherbrooke Ouest, Ville-Marie, Montréal",
    icon: LuGraduationCap
  },
  {
    name: "Breizh Café",
    category: "Restaurant",
    address: "3991 Boulevard Saint-Laurent, Le Plateau-Mont-Royal",
    icon: LuMapPin
  },
  {
    name: "Chez José",
    category: "Cafe",
    address: "173 Avenue Duluth Est, Le Plateau-Mont-Royal",
    icon: LuMapPin
  },
  {
    name: "Dispatch",
    category: "Cafe",
    address: "4021 Boulevard Saint-Laurent, Le Plateau-Mont-Royal",
    icon: LuMapPin
  },
  {
    name: "Santropol",
    category: "Cafe",
    address: "3990 Rue Saint-Urbain, Le Plateau-Mont-Royal",
    icon: LuMapPin
  },
  {
    name: "Café Chat L'Heureux",
    category: "Cafe",
    address: "172 Avenue Duluth Est, Le Plateau-Mont-Royal",
    icon: LuMapPin
  },
  {
    name: "Imago Café",
    category: "Cafe",
    address: "4095 Boulevard Saint-Laurent, Le Plateau-Mont-Royal",
    icon: LuMapPin
  },
  {
    name: "Laurel Café",
    category: "Cafe",
    address: "80 Avenue Duluth Est, Le Plateau-Mont-Royal",
    icon: LuMapPin
  },
  { name: "Fair-meeting zone (22 min walk for both)", icon: LuPentagon }
];

// Static rows drawn in the capture's empty sidebar so the vault doesn't look
// brand new. Nothing here gets written — present_features is transient.
const SIDEBAR_FOLDERS = ["attachments", "Collections", "Friends", "Trips"];

const DOCK_APPS = [
  { name: "Finder", icon: dockFinder, running: true },
  { name: "Ghostty", icon: dockGhostty, running: true },
  { name: "MapOS", icon: maposDockIcon, running: true },
  { name: "Claude", icon: dockClaude, running: false },
  { name: "Obsidian", icon: dockObsidian, running: false }
];

// The results panel, measured off the capture (percent of the image; heights in
// cqw, which is 1% of the image width since the container is the image).
const PANEL_LEFT = 16.34;
const PANEL_TOP = 9.39;
const PANEL_ROW_H = "2.99cqw";
const PANEL_TEXT_W = "15.2cqw";
const PANEL_HEADER_TOP = 6.67;

type Step = {
  /** ms after the previous step before this one fires. */
  delay: number;
  line: TermLine;
  /** Overlay layer this step switches on. */
  reveal?: "origins" | "zone" | "pins" | "panel";
};

const STEPS: Step[] = [
  {
    delay: 700,
    line: { kind: "tool", text: "get_isochrone walk 20min · 2 origins" },
    reveal: "origins"
  },
  { delay: 1000, line: { kind: "tool", text: "geo_compute intersect" } },
  {
    delay: 1100,
    line: { kind: "result", text: "fair-meeting zone · 22 min each way" },
    reveal: "zone"
  },
  { delay: 900, line: { kind: "tool", text: 'geocode_search "café" in zone' } },
  {
    delay: 1000,
    line: { kind: "result", text: "7 of 9 results inside the zone" },
    reveal: "pins"
  },
  {
    delay: 800,
    line: { kind: "tool", text: 'present_features "search-results"' },
    reveal: "panel"
  },
  {
    delay: 900,
    line: { kind: "done", text: "7 spots, an even walk for both of you" }
  }
];

const LINES = STEPS.map((s) => s.line);
const TYPE_MS = 26;
const HOLD_MS = 5200;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function MeetupDemo() {
  const [started, setStarted] = useState(false);
  const [typed, setTyped] = useState(0);
  const [step, setStep] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || started) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setStarted(true);
      },
      { threshold: 0.35 }
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
  const shown = new Set(STEPS.slice(0, shownStep).flatMap((s) => (s.reveal ? [s.reveal] : [])));

  return (
    <div className="relative w-full" ref={containerRef} style={{ containerType: "inline-size" }}>
      <div className="relative overflow-hidden rounded-xs border border-neutral-800 shadow-2xl shadow-black/50">
        <Image
          alt="The MapOS app showing the walkable overlap between two starting points in Montréal, with brunch spots found inside it"
          className="block h-auto w-full"
          placeholder="blur"
          sizes="(min-width: 1024px) 960px, 100vw"
          src={windowShot}
        />

        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        >
          {shown.has("zone") ? (
            <polygon
              className="animate-[pin-fade_500ms_ease-out]"
              fill="#2B5BFF"
              fillOpacity={0.28}
              points={ZONE_POINTS}
              stroke="#7A97FF"
              strokeDasharray="9 7"
              strokeLinejoin="round"
              strokeWidth={3}
            />
          ) : null}
        </svg>

        {/* Where each of them starts. Bigger than the result pins, and labelled
            with the walk time that makes the zone "fair". */}
        {shown.has("origins")
          ? ORIGINS.map((origin) => (
              <div
                className="pointer-events-none absolute flex animate-[pin-drop_350ms_ease-out] flex-col items-center gap-1"
                key={origin.label}
                style={{
                  left: `${origin.x}%`,
                  top: `${origin.y}%`,
                  // The dot (18px) is the anchor: its centre sits on the
                  // coordinate, with the label stacked above.
                  transform: "translate(-50%, calc(-100% + 9px))"
                }}
              >
                <span className="hidden rounded-md bg-neutral-950/80 px-2 py-1 font-[family-name:var(--font-server-mono)] text-xs text-neutral-200 backdrop-blur sm:block">
                  {origin.label}
                </span>
                <span className="size-[18px] rounded-full border-2 border-white bg-[#2B5BFF]" />
              </div>
            ))
          : null}

        {shown.has("pins")
          ? ZONE_PINS.map(([x, y]) => (
              <span
                className="pointer-events-none absolute size-[15px] animate-[pin-pop_350ms_ease-out] rounded-full border-2 border-white bg-[#2B5BFF]"
                key={`${x}-${y}`}
                style={{ left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)" }}
              />
            ))
          : null}

        {/* Vault folders drawn in the capture's empty sidebar. */}
        <div
          className="pointer-events-none absolute hidden flex-col text-neutral-300 md:flex"
          style={{ left: "1.4%", top: "15.9%", fontSize: "0.87cqw" }}
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
        </div>

        {/* The search-results panel. Its chrome is in the capture; the count,
            Save all, and the rows are drawn once present_features runs. */}
        {shown.has("panel") ? (
          <>
            <span
              className="pointer-events-none absolute hidden animate-[pin-fade_300ms_ease-out] items-center justify-center rounded bg-neutral-800 text-neutral-400 md:flex"
              style={{
                left: "24.98%",
                top: `${PANEL_HEADER_TOP}%`,
                transform: "translateY(-50%)",
                width: "1.3cqw",
                height: "1.15cqw",
                fontSize: "0.72cqw"
              }}
            >
              {RESULTS.length}
            </span>
            <span
              className="pointer-events-none absolute hidden animate-[pin-fade_300ms_ease-out] items-center text-neutral-200 md:flex"
              style={{
                left: "30.27%",
                top: `${PANEL_HEADER_TOP}%`,
                transform: "translateY(-50%)",
                gap: "0.35cqw",
                fontSize: "0.9cqw"
              }}
            >
              <span style={{ fontSize: "1.05cqw", lineHeight: 1 }}>+</span>
              Save all
            </span>

            <div
              className="pointer-events-none absolute hidden flex-col md:flex"
              style={{ left: `${PANEL_LEFT}%`, top: `${PANEL_TOP}%` }}
            >
              {RESULTS.map((row, i) => {
                const Icon = row.icon;
                return (
                  <div
                    className="flex items-center animate-[file-in_300ms_ease-out_backwards]"
                    key={row.name}
                    style={{
                      height: PANEL_ROW_H,
                      gap: "0.56cqw",
                      animationDelay: `${i * 55}ms`
                    }}
                  >
                    <span
                      className="flex shrink-0 items-center justify-center rounded border border-neutral-700/70 bg-neutral-800/30"
                      style={{ width: "2.15cqw", height: "2.15cqw" }}
                    >
                      <Icon
                        aria-hidden="true"
                        className="text-neutral-400"
                        style={{ width: "1.1cqw", height: "1.1cqw" }}
                      />
                    </span>
                    <span className="flex min-w-0 flex-col" style={{ width: PANEL_TEXT_W }}>
                      <span
                        className="truncate text-neutral-50"
                        style={{ fontSize: "0.96cqw", lineHeight: 1.35 }}
                      >
                        {row.name}
                        {row.category ? (
                          <span className="text-neutral-500" style={{ fontSize: "0.7cqw" }}>
                            {" "}
                            {row.category}
                          </span>
                        ) : null}
                      </span>
                      {row.address ? (
                        <span
                          className="truncate text-neutral-400"
                          style={{ fontSize: "0.7cqw", lineHeight: 1.35 }}
                        >
                          {row.address}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        {/* Mock dock, matching agent-demo.tsx. Real app icons (each 256px
            canvas with the standard macOS margin baked in); dots mark running
            apps — Ghostty hosts the agent, MapOS is the window. */}
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

      {/* The MCP client. Overlaid on the empty north-east of the map once the
          window is wide enough that the transcript stays a fraction of it;
          below that it stacks under the window rather than burying the map. */}
      <McpTranscript
        className="mt-3 lg:absolute lg:top-[4%] lg:right-[2.5%] lg:mt-0 lg:w-[52%] lg:max-w-[500px]"
        floatAt="lg"
        lines={LINES}
        prompt={PROMPT}
        shown={shownStep}
        typed={shownTyped}
      />
    </div>
  );
}

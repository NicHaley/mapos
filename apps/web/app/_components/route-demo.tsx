"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LuChevronDown, LuFile, LuFolder } from "react-icons/lu";
import windowShot from "./mapos-window-quebec.png";

// Second scripted MCP session, composing four tools: route, buffer, filtered
// search, save. Same technique as agent-demo.tsx — the real app window as a
// static capture with the route, corridor, pins and sidebar animated in
// SVG/DOM on top so everything stays crisp at any size.

const PROMPT = "Bike route from Montréal to Gaspé. Find casse-croûtes within 2 km of it.";

// The capture's aspect ratio, used as the overlay viewBox so strokes stay
// isotropic. x = percent * 15.31, y = percent * 10.
const VIEW_W = 1531;
const VIEW_H = 1000;

// Route Verte down the St. Lawrence's south shore, georeferenced against the
// basemap's city labels.
const ROUTE_POINTS: Array<[number, number]> = [
  [531, 728], // Montréal
  [574, 675],
  [628, 614], // Trois-Rivières
  [689, 580],
  [756, 550], // Québec
  [819, 485],
  [914, 406], // Rivière-du-Loup
  [964, 355],
  [1010, 318], // Rimouski
  [1079, 275],
  [1187, 225], // Cap-Chat
  [1248, 208],
  [1324, 202],
  [1370, 225],
  [1396, 263] // Gaspé
];

/** Quadratic smoothing through midpoints so the route reads as a curve. */
function smoothPath(points: Array<[number, number]>) {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M ${first[0]} ${first[1]}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const current = rest[i];
    const next = rest[i + 1];
    if (!current || !next) continue;
    d += ` Q ${current[0]} ${current[1]} ${(current[0] + next[0]) / 2} ${
      (current[1] + next[1]) / 2
    }`;
  }
  const last = rest[rest.length - 1];
  if (last) d += ` L ${last[0]} ${last[1]}`;
  return d;
}

const ROUTE_D = smoothPath(ROUTE_POINTS);

// Percentages of the capture. `inside` pins fall in the corridor and get
// saved; the others are found but filtered out, and stay dim.
const PLACES = [
  { name: "Casse-croûte du Quai", x: 41.6, y: 60.6 },
  { name: "Cantine du Fleuve", x: 49.9, y: 54.2 },
  { name: "Chez Ti-Guy", x: 60.3, y: 39.8 },
  { name: "La Patate Heureuse", x: 66.5, y: 31.0 },
  { name: "Casse-croûte de la Baie", x: 78.1, y: 21.9 },
  { name: "Cantine Gaspésienne", x: 90.6, y: 25.5 }
];

const OUTSIDE = [
  { x: 44.0, y: 70.5 },
  { x: 52.5, y: 63.5 },
  { x: 67.5, y: 41.5 }
];

type TermLine = { kind: "tool" | "result" | "done"; text: string };

type Step = {
  /** ms after the previous step before this one fires. */
  delay: number;
  line: TermLine;
  /** Overlay layer this step switches on. */
  reveal?: "route" | "corridor" | "pins" | "files";
};

const STEPS: Step[] = [
  {
    delay: 700,
    line: { kind: "tool", text: 'get_directions "montréal → gaspé" bicycle' },
    reveal: "route"
  },
  { delay: 1600, line: { kind: "result", text: "941 km · 6 days" } },
  {
    delay: 800,
    line: { kind: "tool", text: "geo_compute buffer 2km" },
    reveal: "corridor"
  },
  {
    delay: 1000,
    line: { kind: "tool", text: 'find_near "casse-croûte"' },
    reveal: "pins"
  },
  { delay: 900, line: { kind: "result", text: "9 found · 6 inside corridor" } },
  {
    delay: 800,
    line: { kind: "tool", text: 'save_features_to_vault "Gaspésie/"' },
    reveal: "files"
  },
  {
    delay: 900,
    line: { kind: "done", text: "6 casse-croûtes saved along your route" }
  }
];

const TYPE_MS = 26;
const HOLD_MS = 5200;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function RouteDemo() {
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
      <div className="relative overflow-hidden rounded-xl border border-neutral-800 shadow-2xl shadow-black/50">
        <Image
          alt="The MapOS app showing a cycling route from Montréal to Gaspé with a 2 km search corridor along it"
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
          {shown.has("corridor") ? (
            <path
              className="animate-[corridor-in_700ms_ease-out_forwards]"
              d={ROUTE_D}
              fill="none"
              stroke="#2B5BFF"
              strokeLinecap="round"
              strokeOpacity={0.18}
            />
          ) : null}
          {shown.has("route") ? (
            <path
              className="animate-[route-draw_1500ms_ease-out_forwards]"
              d={ROUTE_D}
              fill="none"
              pathLength={1}
              stroke="#7A97FF"
              strokeDasharray={1}
              strokeLinecap="round"
              strokeWidth={5}
            />
          ) : null}
        </svg>

        {/* Found but outside the corridor — the beat that makes it read as a
            filter rather than decoration. */}
        {shown.has("pins")
          ? OUTSIDE.map((place) => (
              <span
                className="pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2 animate-[pin-fade_400ms_ease-out] rounded-full border border-neutral-600 bg-neutral-800"
                key={`${place.x}-${place.y}`}
                style={{ left: `${place.x}%`, top: `${place.y}%` }}
              />
            ))
          : null}

        {shown.has("pins")
          ? PLACES.map((place) => (
              <span
                className="pointer-events-none absolute size-[15px] animate-[pin-pop_350ms_ease-out] rounded-full border-2 border-white bg-[#2B5BFF]"
                key={place.name}
                style={{
                  left: `${place.x}%`,
                  top: `${place.y}%`,
                  transform: "translate(-50%, -50%)"
                }}
              />
            ))
          : null}

        {/* Vault entries drawn in the capture's empty sidebar. */}
        {shown.has("files") ? (
          <div
            className="pointer-events-none absolute hidden flex-col text-neutral-300 md:flex"
            style={{ left: "4.3%", top: "16.5%", fontSize: "0.82cqw" }}
          >
            <div
              className="flex items-center animate-[file-in_300ms_ease-out]"
              style={{ gap: "0.5cqw", height: "2cqw" }}
            >
              <LuChevronDown
                aria-hidden="true"
                className="text-neutral-500"
                style={{ width: "0.85cqw", height: "0.85cqw" }}
              />
              <LuFolder
                aria-hidden="true"
                className="text-neutral-400"
                style={{ width: "0.9cqw", height: "0.9cqw" }}
              />
              Gaspésie
            </div>
            {PLACES.map((place) => (
              <div
                className="flex items-center animate-[file-in_300ms_ease-out]"
                key={place.name}
                style={{
                  gap: "0.5cqw",
                  height: "2cqw",
                  paddingLeft: "1.4cqw"
                }}
              >
                <LuFile
                  aria-hidden="true"
                  className="text-neutral-400"
                  style={{ width: "0.9cqw", height: "0.9cqw" }}
                />
                {place.name}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* The MCP client. Overlaid on the empty north-Québec wilderness on
          larger screens, stacked below the window on mobile. */}
      <div className="mt-3 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/90 shadow-black/40 shadow-xl backdrop-blur sm:absolute sm:top-[6%] sm:left-[22%] sm:mt-0 sm:w-[37%] sm:max-w-[440px]">
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

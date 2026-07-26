"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type LogRow = {
  /** What the app did, in the terms a user would recognise. */
  request: string;
  /** The file or in-process engine that answered it. */
  source: string;
};

// One row per subsystem that would normally be a network call: tiles, search,
// routing, the spatial index, the vault itself. Every source is a real artifact
// name so a reader who goes looking finds the same thing on disk. Each replay
// draws a different batch, so the table reads as new work rather than a loop.
const BATCHES: LogRow[][] = [
  [
    { request: "pan → tiles 13/2534/3045", source: "quebec.pmtiles" },
    { request: 'search "café"', source: "geocode.sqlite" },
    { request: "route walk · 1.8 km", source: "valhalla · in-process" },
    { request: "isochrone walk · 20 min", source: "valhalla · in-process" },
    { request: "places within polygon", source: "index.db" },
    { request: "read Café Olimpico.md", source: "~/MapOS/places" }
  ],
  [
    { request: "zoom → tiles 15/9847/11912", source: "quebec.pmtiles" },
    { request: 'search "dépanneur"', source: "geocode.sqlite" },
    { request: "route bike · 4.2 km", source: "valhalla · in-process" },
    { request: "matrix 12 × 12", source: "valhalla · in-process" },
    { request: "places within 500 m", source: "index.db" },
    { request: "read Mont Royal.md", source: "~/MapOS/places" }
  ],
  [
    { request: "pan → tiles 12/1267/1522", source: "quebec.pmtiles" },
    { request: "reverse geocode 45.52, -73.58", source: "geocode.sqlite" },
    { request: "route drive · 26 km", source: "valhalla · in-process" },
    { request: "isochrone bike · 15 min", source: "valhalla · in-process" },
    { request: "nearest 20 places", source: "index.db" },
    { request: "read Parc Jarry.md", source: "~/MapOS/places" }
  ]
];

const ROW_COUNT = BATCHES[0].length;

const ROW_STAGGER_MS = 110;
const ROW_DURATION_MS = 380;
// Long enough to read the whole table before it replays.
const HOLD_MS = 7000;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function OfflineLog() {
  const [started, setStarted] = useState(false);
  // Bumped to replay the stagger; keying the rows on it restarts the animation.
  const [run, setRun] = useState(0);
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
    if (!started || reduced) return;
    // The period is constant, so one interval beats re-arming a timeout per run.
    const total = ROW_COUNT * ROW_STAGGER_MS + ROW_DURATION_MS + HOLD_MS;
    const id = setInterval(() => setRun((n) => n + 1), total);
    return () => clearInterval(id);
  }, [started, reduced]);

  const animate = started && !reduced;
  const rows = BATCHES[run % BATCHES.length];

  return (
    <div className="w-full" ref={containerRef}>
      <div className="overflow-hidden rounded-xs border border-neutral-800 bg-neutral-900/30">
        <div className="flex items-center gap-4 border-b border-neutral-800 bg-neutral-900/60 px-5 py-2.5 font-[family-name:var(--font-server-mono)] text-[10px] uppercase tracking-[0.2em] text-neutral-600">
          {/* Stacked rows below sm, so one combined label instead of lanes. */}
          <span className="w-full sm:hidden">Request · served from</span>
          <span className="hidden w-[40%] shrink-0 sm:block">Request</span>
          <span className="hidden w-[40%] shrink-0 sm:block">Served from</span>
          <span className="hidden min-w-0 flex-1 text-right sm:block">Origin</span>
        </div>

        {rows.map((row, i) => (
          <div
            // Below sm the three lanes can't hold the filenames without
            // truncating them, and the filenames are the whole point — so the
            // row stacks instead.
            className="flex flex-col gap-1 border-neutral-800/60 px-5 py-3 font-[family-name:var(--font-server-mono)] text-[11.5px] not-last:border-b sm:flex-row sm:items-center sm:gap-4 sm:text-[13px]"
            // Re-keying on `run` remounts the rows, which is what restarts the
            // CSS stagger without tracking per-row state.
            key={`${run}-${row.request}`}
            style={
              animate
                ? {
                    animation: `file-in ${ROW_DURATION_MS}ms ease-out both`,
                    animationDelay: `${i * ROW_STAGGER_MS}ms`
                  }
                : undefined
            }
          >
            <span className="flex w-full items-center gap-2.5 sm:w-[40%] sm:shrink-0">
              <span aria-hidden="true" className="size-1.5 shrink-0 bg-neutral-700" />
              <span className="min-w-0 text-neutral-100 sm:truncate">{row.request}</span>
            </span>
            {/* pl-4 lines the stacked source up under the request text, past the dot. */}
            <span className="w-full pl-4 text-[#7A97FF] sm:w-[40%] sm:shrink-0 sm:truncate sm:pl-0">
              {row.source}
            </span>
            <span className="hidden min-w-0 flex-1 text-right text-neutral-500 sm:block">
              local
            </span>
          </div>
        ))}

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-neutral-800 bg-neutral-950 px-5 py-5">
          <div className="flex items-baseline gap-4">
            <span className="font-[family-name:var(--font-server-mono)] text-[34px] leading-none text-neutral-50 sm:text-[44px]">
              0
            </span>
            <span className="font-[family-name:var(--font-server-mono)] text-[10px] uppercase tracking-[0.28em] text-neutral-500 sm:text-[11px]">
              network requests
            </span>
          </div>
          <span className="font-[family-name:var(--font-server-mono)] text-xs text-neutral-600">
            services: local
          </span>
        </div>
      </div>
    </div>
  );
}

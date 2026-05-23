"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AsciiRamp, type CellKind, type SceneOptions, renderFrame } from "./ascii-engine";

interface AsciiSunProps {
  speed?: number;
  ramp?: AsciiRamp;
  scene?: SceneOptions;
}

const RISE_DURATION_MS = 14000;

function shapeT(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function useTimeChannels(speed: number): { riseT: number; ambientT: number } {
  const [time, setTime] = useState({ riseT: 0, ambientT: 0 });
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    startRef.current = null;
    let raf = 0;
    const tick = (now: number) => {
      if (startRef.current == null) startRef.current = now;
      const elapsed = (now - startRef.current) * speed;
      const raw = Math.min(elapsed / RISE_DURATION_MS, 1);
      setTime({ riseT: shapeT(raw), ambientT: elapsed / 1000 });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed]);

  return time;
}

const FG: Record<CellKind, string> = {
  sky: "transparent",
  star: "#a3a3a3",
  planet: "#171717",
  surface: "#3a3a3a",
  rim: "#d4d4d4",
  flare: "#a3a3a3",
  "flare-hot": "#e5e5e5",
  "sun-body": "#fafafa",
  "sun-core": "#ffffff"
};

// Cells that should occlude the underlying starfield render with a solid bg.
// Sky and flare/sun cells stay transparent so stars peek through ambient glow.
const BG: Record<CellKind, string | undefined> = {
  sky: undefined,
  star: undefined,
  planet: "#0a0a0a",
  surface: "#0a0a0a",
  rim: "#0a0a0a",
  flare: undefined,
  "flare-hot": undefined,
  "sun-body": "#0a0a0a",
  "sun-core": "#0a0a0a"
};

export function AsciiSun({ speed = 1, ramp = "classic", scene }: AsciiSunProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState({ cols: 80, rows: 32, aspect: 1.75 });
  // SSR/hydration renders the default grid briefly before the client measures.
  // Stay invisible until the first measurement lands, then fade in.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const probe = document.createElement("span");
      probe.textContent = "M";
      probe.style.cssText = "position:absolute;visibility:hidden;font:inherit;white-space:pre;";
      el.appendChild(probe);
      const cw = probe.getBoundingClientRect().width || 8;
      const ch = probe.getBoundingClientRect().height || 16;
      el.removeChild(probe);
      const cols = Math.max(40, Math.min(360, Math.floor(rect.width / cw)));
      const rows = Math.max(18, Math.min(200, Math.floor(rect.height / ch)));
      const aspect = ch / cw;
      setGrid({ cols, rows, aspect });
    };
    measure();
    setReady(true);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { riseT, ambientT } = useTimeChannels(speed);

  const frame = useMemo(
    () =>
      renderFrame({
        cols: grid.cols,
        rows: grid.rows,
        t: riseT,
        ambientT,
        cellAspect: grid.aspect,
        ramp,
        opts: scene
      }),
    [grid.cols, grid.rows, grid.aspect, riseT, ambientT, ramp, scene]
  );

  const colored = useMemo(() => {
    const out: { kind: CellKind; text: string }[][] = [];
    for (let r = 0; r < frame.lines.length; r++) {
      const line = frame.lines[r];
      const meta = frame.meta[r];
      const runs: { kind: CellKind; text: string }[] = [];
      let curKind = meta[0];
      let buf = line[0];
      for (let c = 1; c < line.length; c++) {
        if (meta[c] === curKind) {
          buf += line[c];
        } else {
          runs.push({ kind: curKind, text: buf });
          curKind = meta[c];
          buf = line[c];
        }
      }
      runs.push({ kind: curKind, text: buf });
      out.push(runs);
    }
    return out;
  }, [frame]);

  return (
    <div
      className={`relative flex h-full w-full items-start justify-center overflow-hidden font-[family-name:var(--font-jetbrains-mono)] text-[9px] leading-[1.05] transition-opacity duration-[14000ms] ease-out sm:text-[11px] ${ready ? "opacity-100" : "opacity-0"}`}
      ref={wrapRef}
    >
      <pre
        className="m-0 p-0 whitespace-pre font-[family-name:var(--font-jetbrains-mono)] text-[9px] leading-[1.05] tracking-normal pointer-events-none select-none sm:text-[11px]"
        aria-hidden="true"
      >
        {colored.map((runs, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: row index is the natural stable key for the ascii grid
          <div key={i} className="whitespace-pre">
            {runs.map((run, j) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: run order within a row is stable per frame
                key={j}
                style={{
                  color: FG[run.kind],
                  backgroundColor: BG[run.kind]
                }}
              >
                {run.text}
              </span>
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AsciiRamp,
  type CellKind,
  renderFrame,
  type SceneOptions,
} from "./ascii-engine";

interface AsciiSunProps {
  dark: boolean;
  loop?: boolean;
  speed?: number;
  ramp?: AsciiRamp;
  scene?: SceneOptions;
}

function shapeT(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function useAnimationProgress(loop: boolean, speed: number): number {
  const [t, setT] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    finishedRef.current = false;
    startRef.current = null;
    const DURATION = 14000 / speed;

    const tick = (now: number) => {
      if (startRef.current == null) startRef.current = now;
      const elapsed = now - startRef.current;
      let progress = elapsed / DURATION;

      if (loop) {
        progress = progress % 1;
      } else if (progress >= 1) {
        progress = 1;
        finishedRef.current = true;
      }
      setT(progress);
      if (!finishedRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [loop, speed]);

  return t;
}

const DARK_PALETTE: Record<CellKind, string> = {
  sky: "#404040",
  star: "#a3a3a3",
  planet: "#171717",
  rim: "#d4d4d4",
  flare: "#a3a3a3",
  "flare-hot": "#e5e5e5",
  "sun-body": "#fafafa",
  "sun-core": "#ffffff",
};

const LIGHT_PALETTE: Record<CellKind, string> = {
  sky: "#d4d4d4",
  star: "#525252",
  planet: "#e5e5e5",
  rim: "#262626",
  flare: "#525252",
  "flare-hot": "#171717",
  "sun-body": "#0a0a0a",
  "sun-core": "#000000",
};

export function AsciiSun({
  dark,
  loop = true,
  speed = 1,
  ramp = "classic",
  scene,
}: AsciiSunProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState({ cols: 80, rows: 32 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const probe = document.createElement("span");
      probe.textContent = "M";
      probe.style.cssText =
        "position:absolute;visibility:hidden;font:inherit;white-space:pre;";
      el.appendChild(probe);
      const cw = probe.getBoundingClientRect().width || 8;
      const ch = probe.getBoundingClientRect().height || 16;
      el.removeChild(probe);
      const cols = Math.max(40, Math.min(180, Math.floor(rect.width / cw)));
      const rows = Math.max(18, Math.min(80, Math.floor(rect.height / ch)));
      setGrid({ cols, rows });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rawT = useAnimationProgress(loop, speed);
  const t = shapeT(rawT);

  const frame = useMemo(
    () => renderFrame({ cols: grid.cols, rows: grid.rows, t, ramp, opts: scene }),
    [grid.cols, grid.rows, t, ramp, scene],
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

  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;

  return (
    <div className="ascii-wrap" ref={wrapRef}>
      <pre className="ascii-pre" aria-hidden="true">
        {colored.map((runs, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: row index is the natural stable key for the ascii grid
          <div key={i} className="ascii-line">
            {runs.map((run, j) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: run order within a row is stable per frame
                key={j}
                style={{ color: palette[run.kind] }}
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

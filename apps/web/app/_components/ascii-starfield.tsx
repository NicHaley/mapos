"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface AsciiStarfieldProps {
  density?: number;
}

interface Star {
  col: number;
  row: number;
  phase: number;
  rate: number;
  glyphSet: string;
}

const FAINT = " . ·.·· ";
const MEDIUM = ".·.·:·.";
const BRIGHT = ":*+:";

function pickGlyphSet(h: number): string {
  if (h > 0.9985) return BRIGHT;
  if (h > 0.993) return MEDIUM;
  return FAINT;
}

export function AsciiStarfield({
  density = 0.009,
}: AsciiStarfieldProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState({ cols: 120, rows: 60 });
  const [ambientT, setAmbientT] = useState(0);

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
      const cols = Math.max(40, Math.floor(rect.width / cw));
      const rows = Math.max(20, Math.floor(rect.height / ch));
      setGrid({ cols, rows });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      if (start == null) start = now;
      setAmbientT((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const stars = useMemo<Star[]>(() => {
    const list: Star[] = [];
    const threshold = 1 - density;
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const h = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
        const hf = h - Math.floor(h);
        if (hf > threshold) {
          const bucket = (hf - threshold) / density;
          const h2 = (Math.sin(c * 7.31 + r * 3.17) * 9999) % 1;
          list.push({
            col: c,
            row: r,
            phase: hf * 17.3 + bucket * 9.1,
            rate: 0.6 + bucket * 1.6 + Math.abs(h2) * 0.5,
            glyphSet: pickGlyphSet(hf),
          });
        }
      }
    }
    return list;
  }, [grid.cols, grid.rows, density]);

  const text = useMemo(() => {
    if (grid.cols < 1 || grid.rows < 1) return "";
    const lines: string[][] = [];
    for (let r = 0; r < grid.rows; r++) {
      lines.push(new Array(grid.cols).fill(" "));
    }
    for (const s of stars) {
      const tw = 0.5 + 0.5 * Math.sin(ambientT * s.rate + s.phase);
      const set = s.glyphSet;
      const idx = Math.min(set.length - 1, Math.floor(tw * set.length));
      lines[s.row][s.col] = set[idx];
    }
    return lines.map((arr) => arr.join("")).join("\n");
  }, [stars, ambientT, grid.cols, grid.rows]);

  return (
    <div className="ascii-starfield" ref={wrapRef} aria-hidden="true">
      <pre className="ascii-pre" style={{ color: "#525252", padding: 0 }}>
        {text}
      </pre>
    </div>
  );
}

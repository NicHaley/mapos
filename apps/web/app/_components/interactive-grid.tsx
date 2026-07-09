"use client";

import { type ReactNode, useEffect, useRef } from "react";

const TILE = 36; // px; must match the base grid backgroundSize below.

/**
 * A faux-map grid panel that illuminates the cells under the cursor. The base
 * grid stays dim; a brighter copy is revealed through a radial mask centred on
 * the pointer, so the hovered cell is brightest and neighbours fall off. Pointer
 * coordinates are written straight to CSS vars (--x/--y) to avoid re-rendering
 * on every mousemove; the fade in/out is pure CSS via group-hover.
 */
export function InteractiveGrid({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const raf = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, []);

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const node = ref.current;
      if (!node) return;
      node.style.setProperty("--x", `${pos.current.x}px`);
      node.style.setProperty("--y", `${pos.current.y}px`);
    });
  };

  return (
    <div
      className="group relative min-h-[220px] overflow-hidden rounded-xl border border-neutral-800"
      onMouseMove={handleMove}
      ref={ref}
      style={{
        backgroundColor: "#0d0d0f",
        backgroundImage:
          "linear-gradient(#ffffff0a 1px, transparent 1px), linear-gradient(90deg, #ffffff0a 1px, transparent 1px)",
        backgroundSize: `${TILE}px ${TILE}px`
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          backgroundImage:
            "radial-gradient(circle 150px at var(--x, 50%) var(--y, 50%), rgba(59,130,246,0.18), transparent 72%)," +
            "linear-gradient(#ffffff3d 1px, transparent 1px)," +
            "linear-gradient(90deg, #ffffff3d 1px, transparent 1px)",
          backgroundSize: `100% 100%, ${TILE}px ${TILE}px, ${TILE}px ${TILE}px`,
          maskImage:
            "radial-gradient(circle 150px at var(--x, 50%) var(--y, 50%), #000 0%, rgba(0,0,0,0.45) 38%, transparent 74%)",
          WebkitMaskImage:
            "radial-gradient(circle 150px at var(--x, 50%) var(--y, 50%), #000 0%, rgba(0,0,0,0.45) 38%, transparent 74%)"
        }}
      />
      {children}
    </div>
  );
}

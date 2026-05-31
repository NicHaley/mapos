import createGlobe, { type Marker } from "cobe";
import { useEffect, useRef } from "react";
import { useDarkMode } from "../../hooks/use-dark-mode";

export type GlobeMarker = Marker & { id: string };

const DEG = Math.PI / 180;
/** Idle auto-spin, radians/frame. Slow enough to read as ambient, not busy. */
const SPIN_SPEED = 0.0015;
/** Tilt clamp so high-latitude regions still center without flipping over a pole. */
const MAX_THETA = Math.PI / 3;

/**
 * A small spinning cobe globe with one marker per available region. Render is
 * imperative (cobe 2.x has no built-in loop — we drive `globe.update()` each
 * frame), so phi/theta and the latest props live in refs: this is the sanctioned
 * "third-party library / animation frame" use of refs, not state we could derive.
 *
 * When `focus` ([lng, lat]) is set the globe eases to face that point; otherwise
 * it auto-spins slowly. The list, not the globe, is the authoritative selector.
 */
export function RegionGlobe({
  markers,
  focus,
  size = 220
}: {
  markers: GlobeMarker[];
  focus?: [number, number] | null;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dark = useDarkMode();

  // Latest props the render loop reads, so prop changes don't tear down the
  // WebGL context (which createGlobe sets up once per mount).
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const focusRef = useRef<[number, number] | null>(focus ?? null);
  focusRef.current = focus ?? null;
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let phi = 0;
    let theta = 0.2;
    let raf = 0;

    // Pointer-drag to rotate. While dragging we suppress auto-spin/focus and steer
    // phi/theta from pointer deltas; on release the globe resumes spinning from
    // wherever it was left (no snap-back). Radians per pixel — matches cobe's feel.
    const DRAG_SPEED = 0.006;
    const drag = { active: false, lastX: 0, lastY: 0 };

    const theme = (isDark: boolean) => ({
      dark: isDark ? 1 : 0,
      mapBrightness: isDark ? 3 : 6,
      baseColor: (isDark ? [0.3, 0.3, 0.35] : [0.92, 0.92, 0.95]) as [number, number, number],
      glowColor: (isDark ? [0.12, 0.12, 0.18] : [0.9, 0.9, 0.96]) as [number, number, number]
    });

    const globe = createGlobe(canvas, {
      devicePixelRatio: 2,
      width: size * 2,
      height: size * 2,
      phi,
      theta,
      diffuse: 1.2,
      mapSamples: 12000,
      markerColor: [0.4, 0.7, 1],
      markers: markersRef.current,
      ...theme(darkRef.current)
    });

    const render = (): void => {
      const f = focusRef.current;
      if (drag.active) {
        // Hand-steered: phi/theta are set by the pointer handlers below.
      } else if (f) {
        // cobe's canonical focus mapping (focus is [lng, lat]): bring the location
        // to face the camera. phi targets the longitude with cobe's 1.5π front-
        // meridian offset; theta tilts toward the latitude, clamped near the poles.
        const targetPhi = 1.5 * Math.PI - f[0] * DEG;
        const targetTheta = Math.max(-MAX_THETA, Math.min(MAX_THETA, f[1] * DEG));
        // Ease along the shortest arc, normalized to (-π, π].
        const dPhi = (((targetPhi - phi) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
        phi += dPhi * 0.08;
        theta += (targetTheta - theta) * 0.08;
      } else {
        phi += SPIN_SPEED;
      }
      globe.update({ phi, theta, markers: markersRef.current, ...theme(darkRef.current) });
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    const onPointerDown = (e: PointerEvent): void => {
      drag.active = true;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      canvas.style.cursor = "grabbing";
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (!drag.active) return;
      phi += (e.clientX - drag.lastX) * DRAG_SPEED;
      theta = Math.max(-MAX_THETA, Math.min(MAX_THETA, theta + (e.clientY - drag.lastY) * DRAG_SPEED));
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
    };
    const onPointerUp = (): void => {
      if (!drag.active) return;
      drag.active = false;
      canvas.style.cursor = "grab";
    };
    // pointerdown on the canvas, but move/up on window so a drag keeps tracking even
    // when the pointer leaves the globe.
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      globe.destroy();
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      width={size * 2}
      height={size * 2}
      // Block + margin-inline:auto centers it in any full-width parent, independent
      // of flex quirks (a <canvas> is display:inline by default).
      style={{
        display: "block",
        marginInline: "auto",
        width: size,
        height: size,
        aspectRatio: "1",
        contain: "layout paint size",
        cursor: "grab",
        // Stop touch-drags on the globe from scrolling the list behind it.
        touchAction: "none"
      }}
    />
  );
}

import createGlobe, { type Marker } from "cobe";
import { useEffect, useRef } from "react";
import { useDarkMode } from "../../hooks/use-dark-mode";

export type GlobeMarker = Marker & { id: string };

const DEG = Math.PI / 180;

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
      if (f) {
        // Face longitude f[0]; tilt toward latitude f[1] (clamped so poles stay sane).
        const targetPhi = -f[0] * DEG;
        const targetTheta = Math.max(-0.6, Math.min(0.6, f[1] * DEG));
        let dPhi = ((targetPhi - phi + Math.PI) % (2 * Math.PI)) - Math.PI;
        if (dPhi < -Math.PI) dPhi += 2 * Math.PI;
        phi += dPhi * 0.08;
        theta += (targetTheta - theta) * 0.08;
      } else {
        phi += 0.0025;
      }
      globe.update({ phi, theta, markers: markersRef.current, ...theme(darkRef.current) });
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      globe.destroy();
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      width={size * 2}
      height={size * 2}
      style={{ width: size, height: size, aspectRatio: "1", contain: "layout paint size" }}
    />
  );
}

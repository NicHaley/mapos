// ASCII renderer — lens flare sun cresting a planetary limb.
//
// Composition:
//   - Mostly black sky.
//   - A thin curved arc across the lower-mid frame: the limb of a huge sphere whose
//     center is far below. Only the rim is lit (where light grazes).
//   - A brilliant point-of-light sun sitting ON that arc, peaking the brightest section.
//   - Horizontal lens-flare streaks extending left/right from the sun.
//   - Vertical/diagonal "starburst" rays radiating from the sun.
//   - Faint stars.
//
// All sampled per character cell into a brightness 0..1, then mapped to a glyph.

export type AsciiRamp = "classic" | "sparse" | "dense" | "blocks" | "dots";

export type CellKind =
  | "sun-core"
  | "sun-body"
  | "flare-hot"
  | "flare"
  | "rim"
  | "planet"
  | "star"
  | "sky";

export interface SceneOptions {
  sunSize?: number;
  arcCenterY?: number;
  arcRadius?: number;
  sunArcSpan?: number;
  flareLength?: number;
  starburst?: number;
}

export interface RenderArgs {
  cols: number;
  rows: number;
  t: number;
  ramp?: AsciiRamp;
  opts?: SceneOptions;
}

export interface RenderedFrame {
  lines: string[];
  meta: CellKind[][];
}

const ASCII_RAMPS: Record<AsciiRamp, string> = {
  classic: " .:-=+*#%@",
  sparse: "  .  .:-+*#",
  dense:
    " .'`,^:\";~-_+<>i!lI?/\\|()1{}[]rcvunxzjftLCJUYXZO0Qoahkbdpqwm*WMB8&%$#@",
  blocks: " ░▒▓█",
  dots: " ·∙•●◉",
};

function brightnessToGlyph(b: number, ramp: AsciiRamp): string {
  const r = ASCII_RAMPS[ramp] || ASCII_RAMPS.classic;
  const idx = Math.max(0, Math.min(r.length - 1, Math.floor(b * r.length)));
  return r[idx];
}

function sampleScene(
  x: number,
  y: number,
  t: number,
  opts: SceneOptions,
): { b: number; kind: CellKind } {
  const {
    sunSize = 0.05,
    arcCenterY = -1.6,
    arcRadius = 1.75,
    sunArcSpan = 0.55,
    flareLength = 1.6,
    starburst = 1.0,
  } = opts;

  // Sun position: vertical rise, centered horizontally.
  const sx = 0;
  const phi = 0;
  const rimTopY = arcCenterY + arcRadius * Math.cos(phi);
  const startY = rimTopY - sunArcSpan * 0.4;
  const endY = rimTopY + sunArcSpan * 0.6;
  const sy = startY + (endY - startY) * t;

  const dxS = x - sx;
  const dyS = y - sy;
  const dyAdj = dyS * 2.0;
  const distSun = Math.sqrt(dxS * dxS + dyAdj * dyAdj);

  // Brightness envelope: dark → very bright → subside.
  let intensity: number;
  if (t < 0.45) {
    intensity = (t / 0.45) ** 1.4;
  } else {
    const k = (t - 0.45) / 0.55;
    intensity = 1 - k ** 1.5 * 0.45;
  }

  // One-shot starburst pulse around peak.
  let flarePulse = 0;
  if (t > 0.2 && t < 0.7) {
    const u = (t - 0.45) / 0.25;
    flarePulse = Math.exp(-u * u * 1.6);
  }
  const flareBoost = Math.min(1.4, flarePulse * 1.4);

  const postRise = t < 0.45 ? intensity : Math.max(0.85, intensity);
  let b = 0;
  if (distSun < sunSize * 0.5) {
    return { b: Math.min(1, 0.85 + 0.15 * postRise), kind: "sun-core" };
  }

  const corona = Math.exp(-((distSun / (sunSize * 2.8)) ** 2));
  b = Math.max(b, corona * 0.98 * postRise);
  const halo = Math.exp(-((distSun / (sunSize * 7)) ** 2)) * 0.55 * postRise;
  b = Math.max(b, halo);

  // Horizontal lens-flare streak (one-shot, gated by flarePulse).
  const streakX = Math.exp(-((dxS / flareLength) ** 2));
  const streakY = Math.exp(-((dyAdj / 0.05) ** 2));
  const streak = streakX * streakY * 1.0 * flareBoost;
  b = Math.max(b, streak);

  const streakY2 = Math.exp(-((dyAdj / 0.16) ** 2));
  const streak2 =
    Math.exp(-((dxS / (flareLength * 0.8)) ** 2)) *
    streakY2 *
    0.6 *
    flareBoost;
  b = Math.max(b, streak2);

  // Starburst rays.
  const angle = Math.atan2(dyAdj, dxS);
  const spokes = [
    0,
    Math.PI / 2,
    Math.PI / 4,
    -Math.PI / 4,
    Math.PI,
    -Math.PI / 2,
    (-3 * Math.PI) / 4,
    (3 * Math.PI) / 4,
  ];
  const spokeWeights = [1.0, 0.9, 0.55, 0.55, 1.0, 0.9, 0.5, 0.5];
  let ray = 0;
  for (let i = 0; i < spokes.length; i++) {
    let da = angle - spokes[i];
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const angularFalloff = Math.exp(-((da / 0.1) ** 2));
    const radial =
      Math.exp(-((distSun / 1.0) ** 2)) * (1 - Math.exp(-distSun / 0.04));
    ray = Math.max(ray, angularFalloff * radial * spokeWeights[i]);
  }
  b = Math.max(b, ray * 1.05 * starburst * flareBoost);

  // Planet limb arc.
  const dxA = x - 0;
  const dyA = y - arcCenterY;
  const distArc = Math.sqrt(dxA * dxA + dyA * dyA);
  const arcDelta = distArc - arcRadius;
  let arcBrightness = 0;
  if (Math.abs(arcDelta) < 0.1) {
    const rimBand = Math.exp(-((arcDelta / 0.025) ** 2));
    const pointPhi = Math.atan2(x, y - arcCenterY);
    let dPhi = pointPhi - 0;
    while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
    while (dPhi < -Math.PI) dPhi += 2 * Math.PI;
    const arcGlow = Math.exp(-((dPhi / 0.7) ** 2));
    arcBrightness =
      rimBand * (0.45 + 0.55 * arcGlow) * (0.55 + 0.45 * intensity);
  }

  // Inside planet body — crush to near-black, but allow rim glow through.
  const insidePlanet = distArc < arcRadius - 0.005;
  if (insidePlanet) {
    b = Math.min(b, 0.02);
    b = Math.max(b, arcBrightness);
    return { b, kind: b > 0.1 ? "rim" : "planet" };
  }
  b = Math.max(b, arcBrightness);

  // Faint stars.
  if (b < 0.05) {
    const cellX = Math.floor(x * 80);
    const cellY = Math.floor(y * 80);
    const h = Math.sin(cellX * 12.9898 + cellY * 78.233) * 43758.5453;
    const hf = h - Math.floor(h);
    if (hf > 0.995) {
      const tw = 0.5 + 0.5 * Math.sin(t * 8 + cellX * 0.7 + cellY * 1.3);
      const starB = 0.15 + 0.3 * tw;
      if (starB > b) return { b: starB, kind: "star" };
    }
  }

  let kind: CellKind = "sky";
  if (distSun < sunSize * 1.2) kind = "sun-body";
  else if (b > 0.6) kind = "flare-hot";
  else if (b > 0.25) kind = "flare";
  else if (arcBrightness > 0.05 && Math.abs(arcDelta) < 0.1) kind = "rim";

  return { b: Math.min(b, 1), kind };
}

export function renderFrame({
  cols,
  rows,
  t,
  ramp = "classic",
  opts = {},
}: RenderArgs): RenderedFrame {
  const lines: string[] = [];
  const meta: CellKind[][] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    const metaRow: CellKind[] = [];
    for (let c = 0; c < cols; c++) {
      const x = (c / (cols - 1)) * 2.8 - 1.4;
      const y = 0.85 - (r / (rows - 1)) * 1.4;
      const s = sampleScene(x, y, t, opts);
      line += brightnessToGlyph(s.b, ramp);
      metaRow.push(s.kind);
    }
    lines.push(line);
    meta.push(metaRow);
  }
  return { lines, meta };
}

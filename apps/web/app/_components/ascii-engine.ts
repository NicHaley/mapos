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
// Two time channels:
//   - t (rise progress 0..1): drives sun position and the one-shot rise envelope.
//     Clamped to 1 once the sun has risen so it hangs in place.
//   - ambientT (continuous seconds): drives star twinkle and subtle ambient flicker
//     so the ASCII keeps moving even after the rise is complete.
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
  disableStars?: boolean;
}

export interface RenderArgs {
  cols: number;
  rows: number;
  t: number;
  ambientT?: number;
  cellAspect?: number;
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

// Normalized viewport extents — must match the mapping in renderFrame.
// Y range extends well above the sun's end position so the halo never clips
// at the canvas top regardless of canvas aspect.
const VIEW_W = 2.8;
const VIEW_H = 1.75;
const VIEW_TOP = 1.2;

function brightnessToGlyph(b: number, ramp: AsciiRamp): string {
  const r = ASCII_RAMPS[ramp] || ASCII_RAMPS.classic;
  const idx = Math.max(0, Math.min(r.length - 1, Math.floor(b * r.length)));
  return r[idx];
}

function sampleScene(
  x: number,
  y: number,
  t: number,
  ambientT: number,
  yScale: number,
  opts: SceneOptions,
): { b: number; kind: CellKind } {
  const {
    sunSize = 0.1,
    arcCenterY = -1.6,
    arcRadius = 1.75,
    sunArcSpan = 0.55,
    flareLength = 1.6,
    starburst = 1.0,
    disableStars = false,
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
  // yScale compensates for the normalized viewport's aspect and the character
  // cell's height/width ratio so circular brightness contours render as visual
  // circles rather than horizontally-stretched ovals.
  const dyAdj = dyS * yScale;
  const distSun = Math.sqrt(dxS * dxS + dyAdj * dyAdj);

  // Brightness envelope: dark → bright → settle. After rise (t=1) the sun
  // holds full intensity so it hangs in place.
  let intensity: number;
  if (t < 0.45) {
    intensity = (t / 0.45) ** 1.4;
  } else {
    intensity = 1.0;
  }

  // Starburst pulse: builds during rise, peaks, decays to a low ambient floor
  // so the post-rise sun is dominated by its (round) corona/halo rather than
  // the wide horizontal streak — the streak still fires during the rise climax.
  let flarePulse: number;
  if (t < 0.45) {
    flarePulse = (t / 0.45) ** 2;
  } else {
    const k = (t - 0.45) / 0.55;
    flarePulse = 1 - k ** 1.2 * 0.85;
  }
  const flareBoost = Math.min(1.4, flarePulse * 1.4);

  // Continuous ambient shimmer perturbs non-core brightness so glyphs near
  // brightness boundaries swap each frame even when the rise is complete.
  const shimmer =
    1 +
    0.05 *
      Math.sin(ambientT * 1.7 + dxS * 4.1 + dyS * 2.7) *
      Math.sin(ambientT * 0.9 + dxS * 1.3);

  let b = 0;
  if (distSun < sunSize * 0.45) {
    return { b: Math.min(1, 0.9 + 0.1 * intensity), kind: "sun-core" };
  }

  const corona = Math.exp(-((distSun / (sunSize * 2.6)) ** 2));
  b = Math.max(b, corona * 0.98 * intensity);
  // Halo sized to fully fade out before the canvas top so the glow reads as a
  // soft round dome, not a horizontal cap clipped at the edge.
  const halo = Math.exp(-((distSun / (sunSize * 4.5)) ** 2)) * 0.6 * intensity;
  b = Math.max(b, halo);

  // Horizontal lens-flare streaks (gated by flarePulse).
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

  // Apply ambient shimmer to corona/halo/flare/ray cells (not the core).
  b *= shimmer;

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

  // Faint stars — twinkle driven by ambientT so they keep moving after rise.
  if (!disableStars && b < 0.05) {
    const cellX = Math.floor(x * 80);
    const cellY = Math.floor(y * 80);
    const h = Math.sin(cellX * 12.9898 + cellY * 78.233) * 43758.5453;
    const hf = h - Math.floor(h);
    if (hf > 0.985) {
      const tw =
        0.5 + 0.5 * Math.sin(ambientT * 2.4 + cellX * 0.7 + cellY * 1.3);
      // Brighter rare stars, dimmer common ones — gives a sense of depth.
      const baseB = hf > 0.997 ? 0.35 : hf > 0.992 ? 0.22 : 0.15;
      const starB = baseB + 0.3 * tw;
      if (starB > b) return { b: starB, kind: "star" };
    }
  }

  let kind: CellKind = "sky";
  if (distSun < sunSize * 1.1) kind = "sun-body";
  else if (b > 0.6) kind = "flare-hot";
  else if (b > 0.25) kind = "flare";
  else if (arcBrightness > 0.05 && Math.abs(arcDelta) < 0.1) kind = "rim";

  return { b: Math.min(b, 1), kind };
}

export function renderFrame({
  cols,
  rows,
  t,
  ambientT,
  cellAspect = 1.75,
  ramp = "classic",
  opts = {},
}: RenderArgs): RenderedFrame {
  // yScale makes a brightness contour `dx² + (yScale*dy)² = R²` render as a
  // visual circle on screen given the normalized viewport (VIEW_W × VIEW_H)
  // and the actual character cell aspect (height/width).
  // Derivation: equate horizontal and vertical pixel extents of the contour.
  const yScale =
    rows > 1 && cols > 1
      ? (cellAspect * (rows - 1) * VIEW_W) / ((cols - 1) * VIEW_H)
      : 1;
  const at = ambientT ?? t;

  const lines: string[] = [];
  const meta: CellKind[][] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    const metaRow: CellKind[] = [];
    for (let c = 0; c < cols; c++) {
      const x = (c / (cols - 1)) * VIEW_W - VIEW_W / 2;
      const y = VIEW_TOP - (r / (rows - 1)) * VIEW_H;
      const s = sampleScene(x, y, t, at, yScale, opts);
      line += brightnessToGlyph(s.b, ramp);
      metaRow.push(s.kind);
    }
    lines.push(line);
    meta.push(metaRow);
  }
  return { lines, meta };
}

import type {
  CircleLayerSpecification,
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification
} from "maplibre-gl";

/**
 * Shared paint/layout for map features so the vault sources (folder / linked / presented /
 * opened-geojson), the selected source, and the ephemeral overlays stay visually consistent
 * instead of drifting across copy-pasted inline paint.
 *
 * The visual language: **solid = persisted in the vault, dashed = ephemeral** (agent overlays,
 * list tabs, search results). Ephemeral points can't dash a circle stroke, so they use the
 * dashed-rim "poker chip" icon instead. Directions routes are the one exempt ephemeral line —
 * see `routeLinePaint`.
 *
 * Every feature is drawn in the accent hue by default (grey when monochrome); a per-feature
 * `color` frontmatter key overrides it. Selection keeps that colour and adds a soft accent
 * "glow" that reads the same on points, lines, and polygons.
 */

/** Feature colour: the per-feature `color` if present, else the passed default (accent/grey). */
function withColor(defaultColor: string): DataDrivenPropertyValueSpecification<string> {
  return ["coalesce", ["get", "color"], defaultColor] as ExpressionSpecification;
}

// Matches the user-location dot: radius 5 + a 2px stroke = a 14px circle, the same
// outer size as that HTML marker (size-3.5 + border-2).
export const FEATURE_CIRCLE_RADIUS = 5;

/** Round caps/joins for line + fill-outline layers so paths and corners read cleanly. */
export const ROUND_LINE_LAYOUT: LineLayerSpecification["layout"] = {
  "line-cap": "round",
  "line-join": "round"
};

const FEATURE_LINE_WIDTH = 3;
/** A clicked line is drawn inside its white casing, so it gives up a little width to it. */
const CLICKED_LINE_WIDTH = 2.5;

/**
 * Feature property marking the one selected feature the user actually *clicked*, as opposed to
 * a file that is merely open (which renders from the same source). Only the clicked feature
 * takes the white casing — opening a line file leaves it looking like any other line.
 */
export const CLICKED_PROPERTY = "clicked";

/** Matches only the clicked feature — the filter for the casing layer, and the condition the
 *  selected line's width branches on. Compared to `true` because a bare `["get"]` returns null
 *  on the other features, which `case` rejects. */
export const CLICKED_FILTER: ExpressionSpecification = ["==", ["get", CLICKED_PROPERTY], true];

// --- Unselected (vault) feature paint -------------------------------------------------------

export function featureCirclePaint(defaultColor: string): CircleLayerSpecification["paint"] {
  return {
    "circle-radius": FEATURE_CIRCLE_RADIUS,
    "circle-color": withColor(defaultColor),
    "circle-stroke-width": 2,
    "circle-stroke-color": "#ffffff"
  };
}

export function featureLinePaint(defaultColor: string): LineLayerSpecification["paint"] {
  return { "line-color": withColor(defaultColor), "line-width": FEATURE_LINE_WIDTH };
}

export function featureFillPaint(defaultColor: string): FillLayerSpecification["paint"] {
  return { "fill-color": withColor(defaultColor), "fill-opacity": 0.25 };
}

export function featureFillOutlinePaint(defaultColor: string): LineLayerSpecification["paint"] {
  return { "line-color": withColor(defaultColor), "line-width": 2 };
}

// --- Selected feature paint (white outline highlight) ---------------------------------------
//
// Selection reads as a white highlight on every geometry: points get a thicker white stroke,
// polygons get a white outline drawn beneath a slightly-thinner boundary, and a *clicked* line
// gets the same casing (see CLICKED_PROPERTY). The feature's own colour is kept (same
// `defaultColor` as unselected) — selection never changes the hue, so monochrome greys stay
// grey and accents stay accent.

/** White outline drawn beneath a clicked line / a selected polygon's boundary — the highlight,
 * matching the white stroke on selected point circles. Wider than the centre so white shows on
 * each side. */
export const SELECTED_OUTLINE_PAINT: LineLayerSpecification["paint"] = {
  "line-color": "#ffffff",
  "line-width": 5.5
};

export function selectedCirclePaint(defaultColor: string): CircleLayerSpecification["paint"] {
  return {
    "circle-radius": FEATURE_CIRCLE_RADIUS + 1,
    "circle-color": withColor(defaultColor),
    "circle-stroke-width": 4,
    "circle-stroke-color": "#ffffff"
  };
}

export function selectedLinePaint(defaultColor: string): LineLayerSpecification["paint"] {
  return {
    "line-color": withColor(defaultColor),
    // Only the clicked line has a casing to make room for; an open (or peeked) file keeps the
    // plain feature width, so opening a line note doesn't restyle it.
    "line-width": ["case", CLICKED_FILTER, CLICKED_LINE_WIDTH, FEATURE_LINE_WIDTH]
  };
}

export function selectedFillPaint(defaultColor: string): FillLayerSpecification["paint"] {
  return { "fill-color": withColor(defaultColor), "fill-opacity": 0.35 };
}

export function selectedFillOutlinePaint(defaultColor: string): LineLayerSpecification["paint"] {
  return { "line-color": withColor(defaultColor), "line-width": 2.5 };
}

// --- Ephemeral (overlay) feature paint -------------------------------------------------------
//
// Overlay geometry has no per-feature `color`; everything draws in the accent (foreground when
// monochrome), dashed to read as not-yet-saved.

const OVERLAY_LINE_DASH = [2, 1];

type OverlayOpacity = DataDrivenPropertyValueSpecification<number>;

export function overlayLinePaint(
  color: string,
  opacity: OverlayOpacity
): LineLayerSpecification["paint"] {
  return {
    "line-color": color,
    "line-width": 2,
    "line-opacity": opacity,
    "line-dasharray": OVERLAY_LINE_DASH
  };
}

export function overlayFillPaint(
  color: string,
  opacity: OverlayOpacity
): FillLayerSpecification["paint"] {
  return { "fill-color": color, "fill-opacity": opacity };
}

/** Directions routes are ephemeral but exempt from the dash rule: nav convention draws the
 * active route solid, and dashed route segments read as walking mode. */
export function routeLinePaint(
  color: string,
  opacity: OverlayOpacity
): LineLayerSpecification["paint"] {
  return { "line-color": color, "line-width": 4, "line-opacity": opacity };
}

/** The stops of a *saved* route, drawn along its selected line so it reads as a trip rather
 * than a hand-drawn squiggle. Deliberately smaller than a place marker — these are part of
 * one feature, not places in their own right, and they aren't clickable. */
export function routeStopPaint(color: string): CircleLayerSpecification["paint"] {
  return {
    "circle-radius": 4,
    "circle-color": "#ffffff",
    "circle-stroke-color": color,
    "circle-stroke-width": 2.5
  };
}

// --- Ephemeral point: the "poker chip" icon --------------------------------------------------
//
// The WebGL twin of the HTML SelectionMarker chip (accent disk, dashed white rim). Rasterized
// to a map icon so overlay points stay a single symbol layer (thousands of points cheap) —
// MapLibre circle strokes can't dash.

export const OVERLAY_CHIP_IMAGE_ID = "overlay-chip";
export const OVERLAY_CHIP_PIXEL_RATIO = 2;
// Same 14px footprint as persisted points (FEATURE_CIRCLE_RADIUS + 2px stroke); the 18px
// selection chip stays a touch bigger.
const OVERLAY_CHIP_SIZE = FEATURE_CIRCLE_RADIUS * 2 + 4;
const OVERLAY_CHIP_BORDER = 2;
// Long dashes, few breaks: the rim reads as a chip, not a dotted circle.
const OVERLAY_CHIP_DASH_UNIT = 8;
const OVERLAY_CHIP_DASH_FRACTION = 0.68;

export function drawOverlayChip(fill: string, border: string): ImageData {
  const size = OVERLAY_CHIP_SIZE * OVERLAY_CHIP_PIXEL_RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new ImageData(size, size);
  const center = size / 2;
  ctx.beginPath();
  ctx.arc(center, center, center, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  const lineWidth = OVERLAY_CHIP_BORDER * OVERLAY_CHIP_PIXEL_RATIO;
  const radius = center - lineWidth / 2;
  // Snap the dash unit to a whole number of repeats around the rim so the pattern
  // closes without a seam.
  const circumference = 2 * Math.PI * radius;
  const unit =
    circumference / Math.round(circumference / (OVERLAY_CHIP_DASH_UNIT * OVERLAY_CHIP_PIXEL_RATIO));
  ctx.setLineDash([unit * OVERLAY_CHIP_DASH_FRACTION, unit * (1 - OVERLAY_CHIP_DASH_FRACTION)]);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

import type {
  CircleLayerSpecification,
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification
} from "maplibre-gl";

/**
 * Shared paint/layout for map features so the vault sources (folder / linked / presented /
 * opened-geojson), the selected source, and the ephemeral overlays stay visually consistent
 * instead of drifting across copy-pasted inline paint.
 *
 * The visual language: **solid = persisted in the vault, dashed = ephemeral** (agent overlays,
 * list tabs, search results). Ephemeral points can't dash a circle stroke, so they use the
 * dashed-rim "poker chip" icon instead. Directions routes are the one exemption — line *and*
 * stops draw solid, see `routeLinePaint` / `routeStopPaint`.
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

/** Wider than a vault line — a route is the thing being followed, and the direction arrows
 *  drawn on it (see `drawRouteArrow`) need the stroke to sit in. */
export const ROUTE_LINE_WIDTH = 4;

/** Directions routes are ephemeral but exempt from the dash rule: nav convention draws the
 * active route solid, and dashed route segments read as walking mode. */
export function routeLinePaint(
  color: string,
  opacity: OverlayOpacity
): LineLayerSpecification["paint"] {
  return { "line-color": color, "line-width": ROUTE_LINE_WIDTH, "line-opacity": opacity };
}

// --- Route direction arrows ------------------------------------------------------------------
//
// Repeating arrowheads along a route line, so a route reads as a journey with a direction
// rather than a drawn shape. Nav convention: small marks in the contrast colour *on* the line,
// not beside it.

export const ROUTE_ARROW_IMAGE_ID = "route-arrow";
export const ROUTE_ARROW_PIXEL_RATIO = 2;
/** Screen-space gap between arrowheads. Sparse enough to read as punctuation on the line
 *  rather than a dashed texture — which is the one thing a route line must not look like. */
export const ROUTE_ARROW_SPACING = 70;
// Sized against the route line, a hair proud of it (5 vs 4): an arrowhead confined to the
// stroke width reads as a dot once you zoom out, and the ½px overhang is invisible against a
// round-capped line.
const ROUTE_ARROW_LENGTH = 6;
const ROUTE_ARROW_HEIGHT = ROUTE_LINE_WIDTH + 1;

/** Layout for the arrow symbol layer. Placed along the line, and deliberately exempt from
 *  collision: the arrows are the route's own annotation, so basemap labels shouldn't punch
 *  holes in the sequence. */
export const ROUTE_ARROW_LAYOUT = {
  "symbol-placement": "line",
  "symbol-spacing": ROUTE_ARROW_SPACING,
  "icon-image": ROUTE_ARROW_IMAGE_ID,
  "icon-rotation-alignment": "map",
  "icon-allow-overlap": true,
  "icon-ignore-placement": true
} as const;

export function routeArrowPaint(opacity: OverlayOpacity): SymbolLayerSpecification["paint"] {
  return { "icon-opacity": opacity };
}

/**
 * The arrowhead icon, rasterized like the overlay chip (see `drawOverlayChip`).
 *
 * Drawn pointing **right**: with `symbol-placement: "line"` MapLibre maps the image's +x axis
 * onto the direction the line runs, the same convention one-way street arrows use. Since route
 * coordinates run origin → destination, that points the way the user travels.
 */
export function drawRouteArrow(color: string): ImageData {
  const width = Math.round(ROUTE_ARROW_LENGTH * ROUTE_ARROW_PIXEL_RATIO);
  const height = Math.round(ROUTE_ARROW_HEIGHT * ROUTE_ARROW_PIXEL_RATIO);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new ImageData(width, height);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, height / 2);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  return ctx.getImageData(0, 0, width, height);
}

/** The stops of a route, drawn along its line so it reads as a trip rather than a hand-drawn
 * squiggle. Deliberately smaller than a place marker — these are part of one feature, not
 * places in their own right. Used for a saved route's stops and for a live directions route's,
 * so both read the same; solid on the same exemption as `routeLinePaint`, since a dashed rim
 * beside a solid line looks like two different features.
 *
 * `fill` is the dot's centre — white against an accent or dark rim, near-black when the rim
 * itself is the near-white monochrome foreground. */
export const ROUTE_STOP_RADIUS = 4;
export const ROUTE_STOP_STROKE = 2.5;
/** Outer diameter of a stop dot, so the HTML selection marker can match it exactly. */
export const ROUTE_STOP_SIZE = (ROUTE_STOP_RADIUS + ROUTE_STOP_STROKE) * 2;

export function routeStopPaint(
  color: string,
  { fill = "#ffffff", opacity = 1 }: { fill?: string; opacity?: OverlayOpacity } = {}
): CircleLayerSpecification["paint"] {
  return {
    "circle-radius": ROUTE_STOP_RADIUS,
    "circle-color": fill,
    "circle-stroke-color": color,
    "circle-stroke-width": ROUTE_STOP_STROKE,
    "circle-opacity": opacity,
    "circle-stroke-opacity": opacity
  };
}

// --- Route destination: the chequered-flag stop ----------------------------------------------
//
// The last stop is the one the eye looks for, so it gets the finish-line pattern instead of
// another identical dot. Rasterized like the other icons because MapLibre circles can't carry
// a fill pattern. Bigger than an intermediate stop — a chequer inside a 13px dot is noise.

export const ROUTE_DESTINATION_IMAGE_ID = "route-destination";
export const ROUTE_DESTINATION_PIXEL_RATIO = 2;
const ROUTE_DESTINATION_SIZE = 18;
const ROUTE_DESTINATION_BORDER = 2.5;
/** Chequer cells across the inner disk. Four reads as a finish flag; fewer reads as a pie
 *  chart, more turns to grey mush at this diameter. */
const ROUTE_DESTINATION_CELLS = 4;

/** `flag` is the chequer's dark squares and the rim; `ground` is the light squares. */
export function drawRouteDestination(flag: string, ground: string): ImageData {
  const size = ROUTE_DESTINATION_SIZE * ROUTE_DESTINATION_PIXEL_RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new ImageData(size, size);
  const center = size / 2;
  const lineWidth = ROUTE_DESTINATION_BORDER * ROUTE_DESTINATION_PIXEL_RATIO;
  const innerRadius = center - lineWidth;

  // Light ground first, then dark squares over it, both clipped to the inner disk so the
  // chequer never bleeds into the rim.
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, innerRadius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, size, size);
  const cell = (innerRadius * 2) / ROUTE_DESTINATION_CELLS;
  const origin = center - innerRadius;
  ctx.fillStyle = flag;
  for (let row = 0; row < ROUTE_DESTINATION_CELLS; row++) {
    for (let col = 0; col < ROUTE_DESTINATION_CELLS; col++) {
      if ((row + col) % 2 === 1) continue;
      ctx.fillRect(origin + col * cell, origin + row * cell, cell, cell);
    }
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(center, center, center - lineWidth / 2, 0, Math.PI * 2);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = flag;
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

/** Layout for the destination symbol. Never collides away — the finish of the route is the
 *  one mark that must always be on screen. */
export const ROUTE_DESTINATION_LAYOUT = {
  "icon-image": ROUTE_DESTINATION_IMAGE_ID,
  "icon-allow-overlap": true,
  "icon-ignore-placement": true
} as const;

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

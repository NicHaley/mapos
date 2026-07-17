import type {
  CircleLayerSpecification,
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification
} from "maplibre-gl";

/**
 * Shared paint/layout for map features so the vault sources (folder / linked / presented /
 * opened-geojson) and the selected source stay visually identical instead of drifting across
 * copy-pasted inline paint. Chat/AI overlays are intentionally NOT covered here — their dashed
 * "unsaved" look lives inline in map-view.tsx.
 *
 * Every feature is drawn in the accent hue by default (grey when monochrome); a per-feature
 * `color` frontmatter key overrides it. Selection keeps that colour and adds a soft accent
 * "glow" that reads the same on points, lines, and polygons.
 */

/** Feature colour: the per-feature `color` if present, else the passed default (accent/grey). */
function withColor(defaultColor: string): DataDrivenPropertyValueSpecification<string> {
  return ["coalesce", ["get", "color"], defaultColor] as ExpressionSpecification;
}

export const FEATURE_CIRCLE_RADIUS = 5;

/** Round caps/joins for line + fill-outline layers so paths and corners read cleanly. */
export const ROUND_LINE_LAYOUT: LineLayerSpecification["layout"] = {
  "line-cap": "round",
  "line-join": "round"
};

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
  return { "line-color": withColor(defaultColor), "line-width": 3 };
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
// lines/polygons get a white outline drawn beneath a slightly-thinner centre. The feature's own
// colour is kept (same `defaultColor` as unselected) — selection never changes the hue, so
// monochrome greys stay grey and accents stay accent.

/** White outline drawn beneath a selected line / polygon boundary — the highlight, matching the
 * white stroke on selected point circles. Wider than the centre so white shows on each side. */
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
  return { "line-color": withColor(defaultColor), "line-width": 2.5 };
}

export function selectedFillPaint(defaultColor: string): FillLayerSpecification["paint"] {
  return { "fill-color": withColor(defaultColor), "fill-opacity": 0.35 };
}

export function selectedFillOutlinePaint(defaultColor: string): LineLayerSpecification["paint"] {
  return { "line-color": withColor(defaultColor), "line-width": 2.5 };
}

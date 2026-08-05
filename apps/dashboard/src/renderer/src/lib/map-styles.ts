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

/** Feature colour: the per-feature `color` if present, else the passed default (accent/grey).
 *  Shared with `emojiPinLayout`, which bakes the resolved colour into its image id — so a pin
 *  and the circle it replaces resolve their colour through the same expression by construction. */
function colorExpression(defaultColor: string): ExpressionSpecification {
  return ["coalesce", ["get", "color"], defaultColor];
}

function withColor(defaultColor: string): DataDrivenPropertyValueSpecification<string> {
  return colorExpression(defaultColor);
}

// Matches the user-location dot: radius 5 + a 2px stroke = a 14px circle, the same
// outer size as that HTML marker (size-3.5 + border-2).
export const FEATURE_CIRCLE_RADIUS = 5;

/** Outer diameter of a persisted point: the radius plus its 2px stroke on each side. The size
 *  every other point mark is measured against, so the family can't drift. */
const FEATURE_POINT_SIZE = FEATURE_CIRCLE_RADIUS * 2 + 4;

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
// Same 14px footprint as persisted points; the 18px selection chip stays a touch bigger.
const OVERLAY_CHIP_SIZE = FEATURE_POINT_SIZE;
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

// --- Emoji place pins ------------------------------------------------------------------------
//
// A place whose `icon` frontmatter holds an emoji draws as the feature circle's disk with the
// glyph on it, rasterized to a map icon rather than a DOM marker — a folder can hold thousands
// of points and they have to stay one WebGL draw.
//
// The disk colour is baked into the raster, so the *resolved* colour (per-feature `color`, else
// the accent default) is part of the image id. The id is built by an expression at layout time
// (`emojiPinLayout`) rather than baked into the feature, so changing the accent recolours every
// pin without re-uploading a single source. Nothing pre-registers the images: `styleimagemissing`
// fires for an id the first time a tile needs it and the handler rasterizes it there and then
// (see `EmojiPinImages` in map-view.tsx).

export const EMOJI_PIN_PIXEL_RATIO = 2;

/** Outer diameter, CSS px. One step up from the 14px circle it replaces: a glyph inside a 14px
 *  disk is ~10px of ink, which is mush at any zoom. 22px leaves an 18px disk for the emoji and
 *  lands on the same step as the 18px selection chip rather than inventing a third scale. */
export const EMOJI_PIN_SIZE = FEATURE_POINT_SIZE + 8;

/** The selected variant's outer diameter, exported so the HTML SelectionMarker matches the
 *  raster instead of guessing at it. */
export const SELECTED_EMOJI_PIN_SIZE = EMOJI_PIN_SIZE + 4;

const EMOJI_PIN_BORDER = 2;
/**
 * How far out the corners of the glyph's ink box are allowed to reach, as a fraction of the inner
 * disk's radius.
 *
 * The constraint is a circle, not a square. Fitting the ink box inside a square of the disk's
 * diameter — the obvious reading — puts the corners at 1.41× the radius, so a glyph that really
 * does fill its box (🟥, ⬛, a flag) spills out over the white rim while a round one looks right.
 * Fitting the box's half-diagonal to the radius instead is correct for every shape, and is *more*
 * generous to flat glyphs than a square fit: a wide, short ink box can span nearly the full
 * diameter, because a thin strip through the centre of a circle can.
 */
const EMOJI_INK_FRACTION = 0.98;
/** Measurement-only font size; the drawn size is derived from the measured ink box. */
const EMOJI_MEASURE_SIZE = 64;
const EMOJI_FONT_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", sans-serif';

/**
 * An emoji place pin: the feature circle's disk and white rim with the glyph on top.
 *
 * The glyph is fitted from its measured ink box rather than drawn at a fixed font size. Emoji
 * differ wildly in how much of the em box they fill (a flag is wide, a bowl of ramen is tall) and
 * the emoji fonts' ascent sits high, so a fixed size plus `textBaseline: "middle"` leaves them
 * visibly off-centre and unevenly sized. Fitting here is also why the symbol layer needs no
 * `icon-size` or `icon-offset` fudge, and why the raster is 22px rather than the ~100px a fixed
 * 48px font would need — the icon atlas is rebuilt per tile, so wasted raster is wasted texture.
 *
 * Ink-fitting is also the reason the DOM surfaces render this raster (via `emojiPinDataUrl`)
 * instead of an emoji in a styled `<span>`: CSS can only centre a glyph's *line box*, and an
 * emoji's ink sits high and off-centre inside it, so a text-based pin never lines up with the row
 * beside it. Centring here is measured, so it holds for every glyph.
 */
function paintEmojiPin(emoji: string, color: string, size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const center = size / 2;
  // Everything scales off the raster's own size, so a bigger canvas is the same pin at a higher
  // resolution rather than a differently proportioned one.
  const lineWidth = EMOJI_PIN_BORDER * (size / EMOJI_PIN_SIZE);

  ctx.beginPath();
  ctx.arc(center, center, center, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(center, center, center - lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  const target = (center - lineWidth) * EMOJI_INK_FRACTION;
  ctx.font = `${EMOJI_MEASURE_SIZE}px ${EMOJI_FONT_STACK}`;
  const measured = ctx.measureText(emoji);
  const inkWidth = measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight;
  const inkHeight = measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent;
  // A glyph with no ink (an unsupported sequence) leaves the plain disk rather than a NaN font.
  if (!(inkWidth > 0) || !(inkHeight > 0)) return canvas;
  // The ink box is centred on the disk's centre, so its corners are the constraint: keep their
  // distance from the centre — half the box's diagonal — inside the disk.
  const fitted = (EMOJI_MEASURE_SIZE * target) / (Math.hypot(inkWidth, inkHeight) / 2);
  ctx.font = `${fitted}px ${EMOJI_FONT_STACK}`;
  // Centre the ink box, not the advance width or the baseline. Default `textAlign: "left"` puts
  // ink at [x - left, x + right]; default `textBaseline: "alphabetic"` at [y - ascent, y + descent].
  const ink = ctx.measureText(emoji);
  ctx.fillText(
    emoji,
    center + (ink.actualBoundingBoxLeft - ink.actualBoundingBoxRight) / 2,
    center + (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2
  );
  return canvas;
}

/** The pin as `ImageData`, for `map.addImage`. Synchronous, which is what lets the
 *  `styleimagemissing` handler satisfy the very request that fired it. */
export function drawEmojiPin(emoji: string, color: string): ImageData {
  const canvas = paintEmojiPin(emoji, color, EMOJI_PIN_SIZE * EMOJI_PIN_PIXEL_RATIO);
  const ctx = canvas.getContext("2d");
  return ctx
    ? ctx.getImageData(0, 0, canvas.width, canvas.height)
    : new ImageData(canvas.width, canvas.height);
}

const EMOJI_PIN_PREFIX = "emoji-pin:";
/**
 * Colour first, then `|`, then the glyph. `|` can't appear in any CSS colour syntax, and the
 * glyph is the whole remainder — so ZWJ sequences, variation selectors, skin-tone modifiers and
 * regional-indicator pairs survive byte-for-byte without the codec knowing anything about them.
 * Only the fixed-shape field can safely be the delimited one.
 */
const EMOJI_PIN_SEPARATOR = "|";

export function emojiPinImageId(emoji: string, color: string): string {
  return `${EMOJI_PIN_PREFIX}${color}${EMOJI_PIN_SEPARATOR}${emoji}`;
}

/** The inverse, for the `styleimagemissing` handler. Null for any other image id. */
export function parseEmojiPinImageId(id: string): { emoji: string; color: string } | null {
  if (!id.startsWith(EMOJI_PIN_PREFIX)) return null;
  const rest = id.slice(EMOJI_PIN_PREFIX.length);
  const cut = rest.indexOf(EMOJI_PIN_SEPARATOR);
  if (cut <= 0) return null;
  const emoji = rest.slice(cut + EMOJI_PIN_SEPARATOR.length);
  return emoji ? { emoji, color: rest.slice(0, cut) } : null;
}

/**
 * The same pin the map draws, as a data URL, so sidebar rows / tabs / result rows / the card
 * header show a place's icon as the marker it is on the map rather than a bare glyph.
 *
 * Keyed by the map's own image id, so a colour that produces one pin on the map produces one
 * entry here. Never evicted: the cache is bounded by the distinct emoji×colour pairs the vault
 * actually uses.
 *
 * Painted once at `DOM_EMOJI_PIN_PIXELS` and scaled *down* by CSS at every surface, rather than at
 * the map's own 44px raster. The card header shows it at 28 CSS px, which is 56 device px on a 2×
 * display and 84 on a 3× one — an upscaled 44px square there is visibly soft. One oversized entry
 * per pair beats one per display size: sharp everywhere, and still a single cache key.
 */
const emojiPinUrls = new Map<string, string>();

/** Raster size for the DOM copy. Covers the largest surface (28 CSS px) at 3× with headroom;
 *  minification down to a 16px row icon is what browsers are good at. */
const DOM_EMOJI_PIN_PIXELS = 96;

export function emojiPinDataUrl(emoji: string, color: string): string {
  const key = emojiPinImageId(emoji, color);
  const cached = emojiPinUrls.get(key);
  if (cached) return cached;
  const url = paintEmojiPin(emoji, color, DOM_EMOJI_PIN_PIXELS).toDataURL();
  emojiPinUrls.set(key, url);
  return url;
}

/**
 * Feature property carrying a place's single-emoji `icon`. Set only when it really is an emoji
 * (see `emojiIcon`): the circle and symbol filters are exact complements, so a value the
 * rasterizer would refuse to draw must never reach the symbol layer — the point would vanish
 * rather than fall back to a circle.
 */
export const EMOJI_PROPERTY = "icon";
export const HAS_EMOJI_FILTER: ExpressionSpecification = ["has", EMOJI_PROPERTY];
export const NO_EMOJI_FILTER: ExpressionSpecification = ["!", ["has", EMOJI_PROPERTY]];

/**
 * The emoji pin's `icon-image`, built from the glyph and the *resolved* colour so the id carries
 * everything the raster bakes in. `icon-size` stays 1 and there is no `icon-offset`: the raster
 * is already display-sized and ink-centred.
 *
 * Deliberately a plain `concat` (a string coerced to resolvedImage) and *not* `["image", …]` —
 * `image` checks the style's available-images list and would resolve to nothing for an id that
 * hasn't been registered yet, which is every id on first sight.
 */
export function emojiPinLayout(defaultColor: string): SymbolLayerSpecification["layout"] {
  return {
    "icon-image": [
      "concat",
      EMOJI_PIN_PREFIX,
      colorExpression(defaultColor),
      EMOJI_PIN_SEPARATOR,
      ["get", EMOJI_PROPERTY]
    ] as ExpressionSpecification,
    // Same exemption as the route marks: a place is not a label. Collision would also drop the
    // pin from the collision index, and with it from queryRenderedFeatures — i.e. from clicks.
    "icon-allow-overlap": true,
    "icon-ignore-placement": true
  };
}

/** A symbol icon can't take a circle stroke, so the selected pin's white highlight is a plain
 *  white disk drawn *under* it: 2px proud of the pin's own 2px rim, which comes to the same 4px
 *  of white as `selectedCirclePaint`'s stroke. */
export function selectedEmojiPinHaloPaint(): CircleLayerSpecification["paint"] {
  return { "circle-radius": SELECTED_EMOJI_PIN_SIZE / 2, "circle-color": "#ffffff" };
}

/**
 * A place's `icon` frontmatter as something the pin rasterizer can draw, or undefined.
 *
 * The gate for the whole feature: `icon: home` must never become an `icon` feature property,
 * because the circle layer's filter is the exact complement of the symbol layer's — a value that
 * reaches the symbol layer and rasterizes to nothing leaves an invisible point rather than a
 * plain circle. One grapheme cluster (so a ZWJ family or a flag counts as one) and pictographic
 * (or a keycap, whose base character is a digit).
 */
export function emojiIcon(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const icon = value.trim();
  if (!icon) return undefined;
  const graphemes = new Intl.Segmenter().segment(icon)[Symbol.iterator]();
  if (graphemes.next().done || !graphemes.next().done) return undefined;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(icon) ? icon : undefined;
}

/**
 * A `color` frontmatter value normalized so equivalent spellings collapse to one registered pin
 * image instead of three. Hex is lowercased and shorthand expanded; anything else is passed
 * through untouched (the layout expression is a bare `coalesce` and can't normalize).
 */
export function normalizeFeatureColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const color = value.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : color;
}

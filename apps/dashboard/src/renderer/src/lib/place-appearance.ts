/**
 * The validators for a place's own look — the reserved `icon` and `color` frontmatter keys.
 *
 * These are frontmatter concerns, not map-style ones: the sidebar tree, tabs, result rows and the
 * card header all need them and none of them draw a map. They live apart from `map-styles.ts` so
 * those surfaces don't have to import the maplibre layer specs to ask whether a string is an emoji.
 */

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

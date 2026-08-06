import { cn } from "@mapos/ui/lib/utils";
import { featureDefaultColor, useAccent } from "@renderer/lib/accent";
import { iconForFilename } from "@renderer/lib/file-icons";
import { type FileGlyphKind, glyphKindOf } from "@renderer/lib/geometry-wkt";
import { emojiPinDataUrl } from "@renderer/lib/map-styles";
import { emojiIcon, normalizeFeatureColor } from "@renderer/lib/place-appearance";
import type { PlaceRecord } from "@shared/types";

/**
 * A named size rather than a class per call site. The emoji pin is a filled disk and the lucide
 * glyph is line art, so a pin has to sit one step up from the glyph it replaces to read at the
 * same weight — which had every caller writing the same `icon ? bigger : smaller` ternary. The
 * component already owns the emoji-vs-glyph decision, so it owns the step that decision forces.
 */
export type VaultFileIconSize = "sm" | "md";

const SIZES: Record<VaultFileIconSize, { glyph: string; pin: string }> = {
  /** Sidebar rows and tabs. */
  sm: { glyph: "size-3.5", pin: "size-4" },
  /** Result rows, feature lists, and directions stops. */
  md: { glyph: "size-4", pin: "size-[18px]" }
};

/** The frontmatter a glyph is drawn from. A `PlaceRecord` satisfies it, which is the point: the
 *  four values always come off one record, so they travel as the record. */
type PlaceGlyphSource = Pick<PlaceRecord, "filePath" | "geometry" | "route" | "icon" | "color">;

type VaultFileIconProps = {
  size?: VaultFileIconSize;
  /** Classes for whichever branch renders. */
  className?: string;
  /**
   * Classes for the lucide branch only — the muted tint most rows give their glyph. A pin carries
   * the file's own colour, so it must never take it.
   */
  glyphClassName?: string;
} & (
  | { place: PlaceGlyphSource }
  | { name: string; geometryKind?: FileGlyphKind | null; icon?: string; color?: string }
);

/**
 * A vault file's icon, everywhere one is shown: sidebar rows, tabs, result rows, and directions
 * stops. The single place that decides between a file's own `icon` emoji and the file-type lucide
 * glyph, so the surfaces can't drift. Not the place card — that shows one place, so it carries no
 * identity glyph of its own.
 *
 * An emoji renders as the *map pin* — the identical raster the symbol layer uses — not as text.
 * Two reasons, and the first is the load-bearing one:
 *
 * 1. **Centring.** CSS centres a glyph's line box; an emoji's ink sits high and off-centre inside
 *    that box, and by a different amount per glyph. So a `<span>` emoji never lines up with the
 *    label next to it, at any font-size. `drawEmojiPin` fits and centres the measured ink box, so
 *    the image is centred by construction.
 * 2. **One identity.** A place looks the same in the tree as it does on the map.
 *
 * When there's no emoji, `color` tints the lucide glyph instead. That's what makes a place's
 * `color` visible off the map at all.
 *
 * `iconForFilename` stays the source of truth for the fallback glyph (extension + geometry); this
 * only adds the emoji branch on top, since an emoji is a string and that returns a component.
 */
export function VaultFileIcon(props: VaultFileIconProps): React.JSX.Element {
  const { size = "md", className, glyphClassName } = props;
  const source =
    "place" in props
      ? {
          name: props.place.filePath,
          geometryKind: glyphKindOf(props.place.geometry, Boolean(props.place.route)),
          icon: props.place.icon,
          color: props.place.color
        }
      : props;

  const accent = useAccent();
  const emoji = emojiIcon(source.icon);
  const tint = normalizeFeatureColor(source.color);
  if (emoji) {
    return (
      <img
        // The pin's disk takes the file's own colour, falling back to the same accent-derived
        // default the map uses — so an uncoloured pin matches its map counterpart exactly.
        src={emojiPinDataUrl(emoji, tint ?? featureDefaultColor(accent))}
        alt=""
        draggable={false}
        // `object-contain` so a caller overriding the width can't stretch the square.
        className={cn("shrink-0 object-contain", SIZES[size].pin, className)}
      />
    );
  }
  const Icon = iconForFilename(source.name, source.geometryKind);
  return (
    <Icon
      className={cn("shrink-0", SIZES[size].glyph, className, glyphClassName)}
      style={tint ? { color: tint } : undefined}
    />
  );
}

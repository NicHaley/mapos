import { cn } from "@mapos/ui/lib/utils";
import { featureDefaultColor, useAccent } from "@renderer/lib/accent";
import { iconForFilename } from "@renderer/lib/file-icons";
import type { GeometryKind } from "@renderer/lib/geometry-wkt";
import { emojiIcon, emojiPinDataUrl, normalizeFeatureColor } from "@renderer/lib/map-styles";

/**
 * A vault file's icon, everywhere one is shown: sidebar rows, tabs, result rows, and the card
 * header. The single place that decides between a file's own `icon` emoji and the file-type
 * lucide glyph, so the surfaces can't drift.
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
export function VaultFileIcon({
  name,
  geometryKind,
  icon,
  color,
  className
}: {
  name: string;
  geometryKind?: GeometryKind | null;
  icon?: string;
  color?: string;
  className?: string;
}): React.JSX.Element {
  const accent = useAccent();
  const emoji = emojiIcon(icon);
  const tint = normalizeFeatureColor(color);
  if (emoji) {
    return (
      <img
        // The pin's disk takes the file's own colour, falling back to the same accent-derived
        // default the map uses — so an uncoloured pin matches its map counterpart exactly.
        src={emojiPinDataUrl(emoji, tint ?? featureDefaultColor(accent))}
        alt=""
        draggable={false}
        // `object-contain` so a caller sizing by width (`size-3.5`) can't stretch the square.
        className={cn("shrink-0 object-contain", className)}
      />
    );
  }
  const Icon = iconForFilename(name, geometryKind);
  return <Icon className={className} style={tint ? { color: tint } : undefined} />;
}

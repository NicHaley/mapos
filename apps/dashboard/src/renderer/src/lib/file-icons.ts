import {
  FileIcon,
  FileTextIcon,
  ImageIcon,
  Layers2Icon,
  MapPinIcon,
  PentagonIcon,
  RouteIcon,
  SplineIcon
} from "lucide-react";
import type { FileGlyphKind } from "./geometry-wkt";

const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".avif"
];

const LAYER_EXTENSIONS = [".geojson", ".gpx", ".kml", ".shp"];

/** Matches the draw menu's shapes (`DRAW_OPTIONS`), so the glyph a file ends up with is the one on
 *  the tool that drew it. A saved route is the exception: it's a line, but it reopens as a trip. */
const GEOMETRY_ICONS: Record<FileGlyphKind, React.ElementType> = {
  point: MapPinIcon,
  line: SplineIcon,
  area: PentagonIcon,
  route: RouteIcon
};

/** The glyph for a shape on its own, for surfaces that aren't showing a file (the card's location
 *  row). File rows go through `iconForFilename` so the extension still gets a say. */
export function iconForGeometry(kind: FileGlyphKind): React.ElementType {
  return GEOMETRY_ICONS[kind];
}

/**
 * Icon for a vault file. `geometryKind` is the indexed geometry of a place file, and when
 * present it wins over the extension: a note that is on the map should not look like a note
 * that isn't. Matches the row icons in the features list panel.
 */
export function iconForFilename(
  name: string,
  geometryKind?: FileGlyphKind | null
): React.ElementType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) {
    return geometryKind ? GEOMETRY_ICONS[geometryKind] : FileTextIcon;
  }
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return ImageIcon;
  if (LAYER_EXTENSIONS.some((ext) => lower.endsWith(ext))) return Layers2Icon;
  return FileIcon;
}

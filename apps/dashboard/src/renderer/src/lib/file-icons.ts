import {
  FileIcon,
  FileTextIcon,
  ImageIcon,
  Layers2Icon,
  MapPinIcon,
  PentagonIcon,
  RouteIcon
} from "lucide-react";
import type { GeometryKind } from "./geometry-wkt";

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

const GEOMETRY_ICONS: Record<GeometryKind, React.ElementType> = {
  point: MapPinIcon,
  line: RouteIcon,
  area: PentagonIcon
};

/**
 * Icon for a vault file. `geometryKind` is the indexed geometry of a place file, and when
 * present it wins over the extension: a note that is on the map should not look like a note
 * that isn't. Matches the row icons in the features list panel.
 */
export function iconForFilename(
  name: string,
  geometryKind?: GeometryKind | null
): React.ElementType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) {
    return geometryKind ? GEOMETRY_ICONS[geometryKind] : FileTextIcon;
  }
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return ImageIcon;
  if (LAYER_EXTENSIONS.some((ext) => lower.endsWith(ext))) return Layers2Icon;
  return FileIcon;
}

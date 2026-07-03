import { FileIcon, FileTextIcon, ImageIcon, Layers2Icon } from "lucide-react";

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

export function iconForFilename(name: string): React.ElementType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return FileTextIcon;
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return ImageIcon;
  if (LAYER_EXTENSIONS.some((ext) => lower.endsWith(ext))) return Layers2Icon;
  return FileIcon;
}

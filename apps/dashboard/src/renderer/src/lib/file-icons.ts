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

// Image formats the mapos-vault:// protocol will actually serve — must stay in
// sync with SERVABLE_IMAGE_EXTS in src/main/vault-protocol.ts.
const SERVABLE_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

export function isServableImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SERVABLE_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function iconForFilename(name: string): React.ElementType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return FileTextIcon;
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return ImageIcon;
  if (LAYER_EXTENSIONS.some((ext) => lower.endsWith(ext))) return Layers2Icon;
  return FileIcon;
}

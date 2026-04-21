import type { MapOverlayPayload } from "@shared/types";
import { bbox } from "@turf/bbox";
import { useCallback } from "react";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "../lib/place-utils";

/** BBox center in [lng, lat] order (same as split for createNoteFile). */
function lngLatFromOverlayGeometry(
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "Polygon"; coordinates: [number, number][][] }
): [number, number] | null {
  try {
    const [minLng, minLat, maxLng, maxLat] = bbox({
      type: "Feature",
      geometry,
      properties: {}
    });
    return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  } catch {
    return null;
  }
}

function overlayVaultFeatures(mapOverlay: MapOverlayPayload) {
  const { points, lines, polygons } = mapOverlay;
  return [
    ...points.map((p) => ({
      lngLat: [p.lng, p.lat] as [number, number],
      title: p.title,
      preview_markdown: p.preview_markdown
    })),
    ...lines.flatMap((l) => {
      const lngLat = lngLatFromOverlayGeometry({
        type: "LineString",
        coordinates: l.coordinates
      });
      return lngLat
        ? [{ lngLat, title: l.title ?? "Route", preview_markdown: l.preview_markdown }]
        : [];
    }),
    ...polygons.flatMap((poly) => {
      const lngLat = lngLatFromOverlayGeometry({
        type: "Polygon",
        coordinates: poly.coordinates
      });
      return lngLat
        ? [{ lngLat, title: poly.title ?? "Area", preview_markdown: poly.preview_markdown }]
        : [];
    })
  ];
}

export function useOverlayVaultSync({
  mapOverlay,
  parentFolderForNewFiles,
  setAddAllOverlayBusy
}: {
  mapOverlay: MapOverlayPayload;
  parentFolderForNewFiles: string | null;
  setAddAllOverlayBusy: (busy: boolean) => void;
}): { handleAddAllOverlayToVault: () => Promise<void> } {
  const handleAddAllOverlayToVault = useCallback(async () => {
    const features = overlayVaultFeatures(mapOverlay);
    if (features.length === 0) return;
    setAddAllOverlayBusy(true);
    try {
      await Promise.all(
        features.map(async (f) => {
          const [lng, lat] = f.lngLat;
          const create = await window.api.fs.createNoteFile({
            parentFolderPath: parentFolderForNewFiles,
            lat,
            lng
          });
          if (!create.success) {
            console.error("[add all overlay]", create.error);
            return;
          }
          const baseName = filenameBaseFromPlaceTitle(f.title);
          const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
          if (!renamed.ok) {
            console.error("[add all overlay]", renamed.error);
            return;
          }
          if (f.preview_markdown?.trim()) {
            const w = await window.api.fs.writePlaceBody(renamed.filePath, f.preview_markdown);
            if (!w.success) console.error("[add all overlay] write body", w.error);
          }
        })
      );
    } finally {
      setAddAllOverlayBusy(false);
    }
  }, [mapOverlay, parentFolderForNewFiles, setAddAllOverlayBusy]);

  return { handleAddAllOverlayToVault };
}

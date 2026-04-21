import type { MapOverlayPayload, OverlayLine, OverlayPolygon } from "@shared/types";
import { bbox } from "@turf/bbox";
import { useCallback } from "react";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "../lib/place-utils";

function lngLatFromOverlayLine(line: OverlayLine): [number, number] | null {
  try {
    const [minLng, minLat, maxLng, maxLat] = bbox({
      type: "Feature",
      geometry: { type: "LineString", coordinates: line.coordinates },
      properties: {}
    });
    return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  } catch {
    return null;
  }
}

function lngLatFromOverlayPolygon(poly: OverlayPolygon): [number, number] | null {
  try {
    const [minLng, minLat, maxLng, maxLat] = bbox({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: poly.coordinates },
      properties: {}
    });
    return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  } catch {
    return null;
  }
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
    const { points, lines, polygons } = mapOverlay;
    const n = points.length + lines.length + polygons.length;
    if (n === 0) return;
    setAddAllOverlayBusy(true);
    try {
      for (const p of points) {
        const create = await window.api.fs.createNoteFile({
          parentFolderPath: parentFolderForNewFiles,
          lat: p.lat,
          lng: p.lng
        });
        if (!create.success) {
          console.error("[add all overlay]", create.error);
          continue;
        }
        const baseName = filenameBaseFromPlaceTitle(p.title);
        const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
        if (!renamed.ok) {
          console.error("[add all overlay]", renamed.error);
          continue;
        }
        if (p.preview_markdown?.trim()) {
          const w = await window.api.fs.writePlaceBody(renamed.filePath, p.preview_markdown);
          if (!w.success) console.error("[add all overlay] write body", w.error);
        }
      }
      for (const l of lines) {
        const ll = lngLatFromOverlayLine(l);
        if (!ll) continue;
        const [lng, lat] = ll;
        const create = await window.api.fs.createNoteFile({
          parentFolderPath: parentFolderForNewFiles,
          lat,
          lng
        });
        if (!create.success) {
          console.error("[add all overlay]", create.error);
          continue;
        }
        const baseName = filenameBaseFromPlaceTitle(l.title ?? "Route");
        const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
        if (!renamed.ok) {
          console.error("[add all overlay]", renamed.error);
          continue;
        }
        if (l.preview_markdown?.trim()) {
          const w = await window.api.fs.writePlaceBody(renamed.filePath, l.preview_markdown);
          if (!w.success) console.error("[add all overlay] write body", w.error);
        }
      }
      for (const poly of polygons) {
        const ll = lngLatFromOverlayPolygon(poly);
        if (!ll) continue;
        const [lng, lat] = ll;
        const create = await window.api.fs.createNoteFile({
          parentFolderPath: parentFolderForNewFiles,
          lat,
          lng
        });
        if (!create.success) {
          console.error("[add all overlay]", create.error);
          continue;
        }
        const baseName = filenameBaseFromPlaceTitle(poly.title ?? "Area");
        const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
        if (!renamed.ok) {
          console.error("[add all overlay]", renamed.error);
          continue;
        }
        if (poly.preview_markdown?.trim()) {
          const w = await window.api.fs.writePlaceBody(renamed.filePath, poly.preview_markdown);
          if (!w.success) console.error("[add all overlay] write body", w.error);
        }
      }
    } finally {
      setAddAllOverlayBusy(false);
    }
  }, [mapOverlay, parentFolderForNewFiles, setAddAllOverlayBusy]);

  return { handleAddAllOverlayToVault };
}

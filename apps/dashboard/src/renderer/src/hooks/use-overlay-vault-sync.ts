import type { MapOverlayPayload } from "@shared/types";
import { orderDetailProperties } from "@shared/types";
import { useCallback } from "react";
import { type GeometryCreateArgs, lineStringWkt, polygonWkt } from "../lib/geometry-wkt";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "../lib/place-utils";

type OverlayFeature = {
  title: string;
  preview_markdown?: string;
  /** Structured details persisted as frontmatter (points only). */
  properties?: Record<string, string>;
  /** Args for createNoteFile that produce the right `geometry` frontmatter. */
  createArgs: GeometryCreateArgs;
};

function overlayVaultFeatures(mapOverlay: MapOverlayPayload): OverlayFeature[] {
  const { points, lines, polygons } = mapOverlay;
  return [
    ...points.map(
      (p): OverlayFeature => ({
        title: p.title,
        preview_markdown: p.preview_markdown,
        properties: p.properties,
        createArgs: { lat: p.lat, lng: p.lng }
      })
    ),
    ...lines.flatMap((l): OverlayFeature[] => {
      if (l.coordinates.length < 2) return [];
      return [
        {
          title: l.title ?? "Route",
          preview_markdown: l.preview_markdown,
          createArgs: { geometryWkt: lineStringWkt(l.coordinates) }
        }
      ];
    }),
    ...polygons.flatMap((poly): OverlayFeature[] => {
      const rings = poly.coordinates.filter((r) => r.length >= 4);
      if (rings.length === 0) return [];
      return [
        {
          title: poly.title ?? "Area",
          preview_markdown: poly.preview_markdown,
          createArgs: { geometryWkt: polygonWkt(rings) }
        }
      ];
    })
  ];
}

export function useOverlayVaultSync(): {
  addLayerToVault: (layer: MapOverlayPayload, parentFolderPath: string | null) => Promise<void>;
} {
  const addLayerToVault = useCallback(
    async (layer: MapOverlayPayload, parentFolderPath: string | null) => {
      const features = overlayVaultFeatures(layer);
      if (features.length === 0) return;
      await Promise.all(
        features.map(async (f) => {
          const create = await window.api.fs.createNoteFile({
            parentFolderPath,
            ...f.createArgs
          });
          if (!create.success) {
            console.error("[add layer to vault]", create.error);
            return;
          }
          const baseName = filenameBaseFromPlaceTitle(f.title);
          const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
          if (!renamed.ok) {
            console.error("[add layer to vault]", renamed.error);
            return;
          }
          // Write structured details as frontmatter (canonical order, empties dropped)
          // before the body, so the saved file matches the preview card exactly.
          const properties = orderDetailProperties(f.properties);
          if (Object.keys(properties).length > 0) {
            const wp = await window.api.fs.writeFrontmatterProperties(renamed.filePath, properties);
            if (!wp.success) console.error("[add layer to vault] write properties", wp.error);
          }
          if (f.preview_markdown?.trim()) {
            const w = await window.api.fs.writePlaceBody(renamed.filePath, f.preview_markdown);
            if (!w.success) console.error("[add layer to vault] write body", w.error);
          }
        })
      );
    },
    []
  );

  return { addLayerToVault };
}

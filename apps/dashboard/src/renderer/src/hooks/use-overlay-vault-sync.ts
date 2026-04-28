import type { MapOverlayPayload } from "@shared/types";
import { useCallback } from "react";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "../lib/place-utils";

type CreateNoteArgs = Parameters<typeof window.api.fs.createNoteFile>[0];

type OverlayFeature = {
  title: string;
  preview_markdown?: string;
  /** Args for createNoteFile that produce the right `geometry` frontmatter. */
  createArgs: Omit<CreateNoteArgs, "parentFolderPath">;
};

function fmtCoord(n: number): string {
  return Number.isFinite(n) ? String(n) : "0";
}

function lineStringWkt(coords: [number, number][]): string {
  return `LINESTRING(${coords.map(([lng, lat]) => `${fmtCoord(lng)} ${fmtCoord(lat)}`).join(", ")})`;
}

function polygonWkt(rings: [number, number][][]): string {
  const parts = rings.map(
    (ring) => `(${ring.map(([lng, lat]) => `${fmtCoord(lng)} ${fmtCoord(lat)}`).join(", ")})`
  );
  return `POLYGON(${parts.join(", ")})`;
}

function overlayVaultFeatures(mapOverlay: MapOverlayPayload): OverlayFeature[] {
  const { points, lines, polygons } = mapOverlay;
  return [
    ...points.map(
      (p): OverlayFeature => ({
        title: p.title,
        preview_markdown: p.preview_markdown,
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

export function useOverlayVaultSync({
  mapOverlay,
  setAddAllOverlayBusy
}: {
  mapOverlay: MapOverlayPayload;
  setAddAllOverlayBusy: (busy: boolean) => void;
}): { handleAddAllOverlayToVault: (parentFolderPath: string | null) => Promise<void> } {
  const handleAddAllOverlayToVault = useCallback(
    async (parentFolderPath: string | null) => {
      const features = overlayVaultFeatures(mapOverlay);
      if (features.length === 0) return;
      setAddAllOverlayBusy(true);
      try {
        await Promise.all(
          features.map(async (f) => {
            const create = await window.api.fs.createNoteFile({
              parentFolderPath,
              ...f.createArgs
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
    },
    [mapOverlay, setAddAllOverlayBusy]
  );

  return { handleAddAllOverlayToVault };
}

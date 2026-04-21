import type { MapOverlayPayload } from "@shared/types";
import { useEffect } from "react";
import type { PlaceRecord } from "../components/map-view";

const EMPTY_MAP_OVERLAY: MapOverlayPayload = {
  layerName: "",
  points: [],
  lines: [],
  polygons: []
};

export function useMapOverlaySync({
  selectedPlaceRef,
  clearPlace,
  setMapOverlay,
  setMapOverlayNonce
}: {
  selectedPlaceRef: React.RefObject<PlaceRecord | null>;
  clearPlace: () => void;
  setMapOverlay: (overlay: MapOverlayPayload) => void;
  setMapOverlayNonce: (updater: (n: number) => number) => void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedPlaceRef.current is intentionally read inside callback without being a dep
  useEffect(() => {
    window.api.map.onOverlay((data) => {
      const points = data.points ?? [];
      const lines = data.lines ?? [];
      const polygons = data.polygons ?? [];
      setMapOverlay({ layerName: data.layerName, points, lines, polygons });
      if (points.length + lines.length + polygons.length > 0) {
        setMapOverlayNonce((n) => n + 1);
      }
    });
    window.api.map.onOverlayClear(() => {
      setMapOverlay(EMPTY_MAP_OVERLAY);
      const fp = selectedPlaceRef.current?.filePath;
      if (fp?.startsWith("map-overlay:")) clearPlace();
    });
    return () => window.api.map.removeOverlayListeners();
  }, [clearPlace, setMapOverlay, setMapOverlayNonce]);
}

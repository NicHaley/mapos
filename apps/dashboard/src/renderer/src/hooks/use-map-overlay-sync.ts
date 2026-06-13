import type { MapOverlayLayer } from "@shared/types";
import { useEffect } from "react";
import type { PlaceRecord } from "../components/map-view";

export function useMapOverlaySync({
  selectedPlaceRef,
  clearPlace,
  addLayer,
  clearLayers
}: {
  selectedPlaceRef: React.RefObject<PlaceRecord | null>;
  clearPlace: () => void;
  addLayer: (layer: MapOverlayLayer) => void;
  clearLayers: () => void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedPlaceRef.current is intentionally read inside callback without being a dep
  useEffect(() => {
    window.api.map.onOverlayAdd((layer) => addLayer(layer));
    window.api.map.onOverlayClear(() => {
      clearLayers();
      const fp = selectedPlaceRef.current?.filePath;
      if (fp?.startsWith("map-overlay:")) clearPlace();
    });
    return () => window.api.map.removeOverlayListeners();
  }, [clearPlace, addLayer, clearLayers]);
}

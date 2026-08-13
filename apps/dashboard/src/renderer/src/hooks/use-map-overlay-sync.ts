import type { MapOverlayLayer } from "@shared/types";
import { useEffect } from "react";

/** Subscribe to `map:overlay-add` / `map:overlay-update` from the main process (the agent's
 *  present_features) and hand each layer to the caller. There is no overlay-clear channel: a
 *  shown feature set lives in its tab and clears when the tab closes. */
export function useMapOverlaySync({
  addLayer,
  updateLayer
}: {
  addLayer: (layer: MapOverlayLayer) => void;
  updateLayer: (layer: MapOverlayLayer) => void;
}): void {
  useEffect(() => {
    window.api.map.onOverlayAdd((layer) => addLayer(layer));
    window.api.map.onOverlayUpdate((layer) => updateLayer(layer));
    return () => window.api.map.removeOverlayListeners();
  }, [addLayer, updateLayer]);
}

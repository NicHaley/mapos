import type { MapOverlayLayer } from "@shared/types";
import { useEffect } from "react";

/** Subscribe to `map:overlay-add` from the main process (the agent's present_features) and
 *  hand each layer to `addLayer`, which opens it as a list tab. There is no overlay-clear
 *  channel: a shown feature set lives in its tab and clears when the tab closes. */
export function useMapOverlaySync({
  addLayer
}: {
  addLayer: (layer: MapOverlayLayer) => void;
}): void {
  useEffect(() => {
    window.api.map.onOverlayAdd((layer) => addLayer(layer));
    return () => window.api.map.removeOverlayListeners();
  }, [addLayer]);
}

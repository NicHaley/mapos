import { useEffect } from "react";
import type { PlaceRecord } from "../components/MapView";

export function usePlacesWatcher({
  selectedPlaceRef,
  clearPlace
}: {
  selectedPlaceRef: React.RefObject<PlaceRecord | null>;
  clearPlace: () => void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedPlaceRef.current is intentionally read inside callback without being a dep
  useEffect(() => {
    window.api.places.onUpdated((update) => {
      if (update.event === "unlink" && update.filePath === selectedPlaceRef.current?.filePath) {
        clearPlace();
      }
    });
  }, [clearPlace]);
}

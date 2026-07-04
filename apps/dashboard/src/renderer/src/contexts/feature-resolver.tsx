import { type ReactNode, createContext, useContext } from "react";
import type { MapOverlayLayer, PlaceRecord } from "../../../shared/types";

type FeatureResolverContextValue = {
  /** Synchronous lookup against the renderer's in-memory places mirror. */
  getPlace: (filePath: string) => PlaceRecord | undefined;
  /** All accumulated overlay layers; `overlay:` refs resolve by scanning these. */
  overlayLayers: MapOverlayLayer[];
  /** File path of the currently-selected place, used to highlight matching rows. */
  selectedFilePath: string | null;
  /** Open a feature (place card + map). */
  onOpenFeature: (place: PlaceRecord) => void;
  /** Emphasize one overlay feature on the map (the hovered row); null clears focus. */
  focusFeature: (featureId: string | null) => void;
};

const FeatureResolverContext = createContext<FeatureResolverContextValue | null>(null);

export function FeatureResolverProvider({
  value,
  children
}: {
  value: FeatureResolverContextValue;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <FeatureResolverContext.Provider value={value}>{children}</FeatureResolverContext.Provider>
  );
}

export function useFeatureResolver(): FeatureResolverContextValue {
  const ctx = useContext(FeatureResolverContext);
  if (!ctx) {
    throw new Error("useFeatureResolver must be used within a FeatureResolverProvider");
  }
  return ctx;
}

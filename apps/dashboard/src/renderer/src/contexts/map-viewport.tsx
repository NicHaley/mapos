import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import type { BBox } from "@mapos/contracts";

type MapViewportContextValue = {
  /** Latest map viewport bounds, or null before the map's first load/move. */
  getViewportBBox: () => BBox | null;
  /** Published by the map on viewport changes. */
  setViewportBBox: (bbox: BBox | null) => void;
};

// Default is a no-op: consumers rendered outside a provider (or before the map has
// reported) get an unbiased search rather than a crash. Viewport bias is a nicety,
// never a requirement.
const MapViewportContext = createContext<MapViewportContextValue>({
  getViewportBBox: () => null,
  setViewportBBox: () => {}
});

export function MapViewportProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // Imperative by design: the viewport changes on every pan/zoom, but consumers only
  // read it at the instant a search fires. Holding it in a ref (not state) means
  // panning never re-renders the tree, and the context value stays referentially stable.
  const bboxRef = useRef<BBox | null>(null);
  const value = useMemo<MapViewportContextValue>(
    () => ({
      getViewportBBox: () => bboxRef.current,
      setViewportBBox: (bbox) => {
        bboxRef.current = bbox;
      }
    }),
    []
  );
  return <MapViewportContext.Provider value={value}>{children}</MapViewportContext.Provider>;
}

export function useMapViewport(): MapViewportContextValue {
  return useContext(MapViewportContext);
}

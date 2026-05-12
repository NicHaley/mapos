import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { MapOverlayPayload, PlaceRecord } from "../../../shared/types";

type FeatureResolverContextValue = {
  /** Synchronous lookup against the renderer's in-memory places mirror. */
  getPlace: (filePath: string) => PlaceRecord | undefined;
  /** Currently-active map overlay. Resolves `overlay:` refs from messages with no snapshot. */
  liveOverlay: MapOverlayPayload | null;
  /** File path of the currently-selected place, used to highlight matching rows. */
  selectedFilePath: string | null;
  /**
   * Open a feature. When `restoreOverlay` is provided, the caller will first
   * replay the overlay snapshot (replacing the current overlay) before opening
   * the mini place card. Used when a row references a stale overlay id.
   */
  onOpenFeature: (place: PlaceRecord, restoreOverlay?: MapOverlayPayload) => void;
};

const FeatureResolverContext = createContext<FeatureResolverContextValue | null>(null);

type FeatureMessageContextValue = {
  /** Overlay captured at message-persist time, used to resolve `overlay:` refs that are no longer live. */
  overlaySnapshot: MapOverlayPayload | null;
};

const FeatureMessageContext = createContext<FeatureMessageContextValue>({
  overlaySnapshot: null
});

export function FeatureResolverProvider({
  value,
  children
}: {
  value: FeatureResolverContextValue;
  children: ReactNode;
}): React.JSX.Element {
  return <FeatureResolverContext.Provider value={value}>{children}</FeatureResolverContext.Provider>;
}

export function FeatureMessageProvider({
  overlaySnapshot,
  children
}: {
  overlaySnapshot: MapOverlayPayload | null;
  children: ReactNode;
}): React.JSX.Element {
  const value = useMemo(() => ({ overlaySnapshot }), [overlaySnapshot]);
  return <FeatureMessageContext.Provider value={value}>{children}</FeatureMessageContext.Provider>;
}

export function useFeatureResolver(): FeatureResolverContextValue & FeatureMessageContextValue {
  const app = useContext(FeatureResolverContext);
  const message = useContext(FeatureMessageContext);
  if (!app) {
    throw new Error("useFeatureResolver must be used within a FeatureResolverProvider");
  }
  return { ...app, ...message };
}

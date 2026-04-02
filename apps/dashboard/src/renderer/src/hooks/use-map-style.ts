import { useCallback, useEffect, useState } from "react";
import { useDarkMode } from "./use-dark-mode";

const PROTOMAPS_KEY = import.meta.env.RENDERER_VITE_PROTOMAPS_KEY as string;
const R2_PUBLIC_URL = (import.meta.env.RENDERER_VITE_R2_PUBLIC_URL as string | undefined)?.replace(
  /\/$/,
  ""
);

const STORAGE_KEY = "mapos:selectedRegionId";

export type ManifestRegion = {
  id: string;
  name: string;
  parent: string;
  bbox: [number, number, number, number];
  url: string;
  size_bytes: number;
};

type Manifest = {
  build: string;
  generated_at: string;
  regions: ManifestRegion[];
};

// Swap the first vector tile source in a Protomaps style to use the given pmtiles URL.
// Returns a new style object; the original is not mutated.
function applyPMTilesSource(
  style: Record<string, unknown>,
  pmtilesUrl: string
): Record<string, unknown> {
  const sources = style.sources as Record<
    string,
    { type: string; url?: string; attribution?: string }
  >;
  const vectorKey = Object.keys(sources).find((k) => sources[k].type === "vector");
  if (!vectorKey) return style;
  return {
    ...style,
    sources: {
      ...sources,
      [vectorKey]: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
        attribution: sources[vectorKey].attribution
      }
    }
  };
}

async function fetchStyle(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch style: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export function useMapStyle() {
  const isDark = useDarkMode();
  const protomapsStyleUrl = `https://api.protomaps.com/styles/v5/${isDark ? "black" : "light"}/en.json?key=${PROTOMAPS_KEY}`;

  const [regions, setRegions] = useState<ManifestRegion[]>([]);
  const [selectedRegionId, setSelectedRegionIdState] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY)
  );
  // null = Protomaps API fallback; string | object = resolved style
  const [mapStyle, setMapStyle] = useState<string | Record<string, unknown>>(protomapsStyleUrl);

  const setSelectedRegionId = useCallback((id: string | null) => {
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, id);
    }
    setSelectedRegionIdState(id);
  }, []);

  // Fetch manifest on mount if R2 is configured
  useEffect(() => {
    if (!R2_PUBLIC_URL) return;
    fetch(`${R2_PUBLIC_URL}/manifest.json`)
      .then((r) => r.json())
      .then((data: Manifest) => {
        // Filter out continent-level regions (parent is empty string)
        setRegions(data.regions.filter((r) => r.parent !== ""));
      })
      .catch(() => {
        // Manifest unavailable — silently fall back to Protomaps API
      });
  }, []);

  // Build map style whenever selected region or dark mode changes
  useEffect(() => {
    if (!selectedRegionId) {
      setMapStyle(protomapsStyleUrl);
      return;
    }
    const region = regions.find((r) => r.id === selectedRegionId);
    if (!region) {
      setMapStyle(protomapsStyleUrl);
      return;
    }
    let cancelled = false;
    fetchStyle(protomapsStyleUrl)
      .then((style) => {
        if (!cancelled) {
          setMapStyle(applyPMTilesSource(style, region.url));
        }
      })
      .catch(() => {
        if (!cancelled) setMapStyle(protomapsStyleUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRegionId, regions, protomapsStyleUrl]);

  return { mapStyle, regions, selectedRegionId, setSelectedRegionId };
}

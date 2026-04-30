import type { MapOverlayPayload } from "@shared/types";
import { bbox } from "@turf/bbox";
import { MessageCircleIcon, PanelLeftIcon } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatSidebar } from "./components/chat-sidebar";
import MapView, {
  type MapSelectPlaceMeta,
  type MapViewHandle,
  type PlaceRecord,
  type SelectionPulseAnchor
} from "./components/map-view";
import { NavTabs } from "./components/nav-tabs";
import { PhotonSearchPopover } from "./components/photon-search-popover";
import { PlaceCard } from "./components/place-card";
import { ProjectSidebar } from "./components/project-sidebar";
import { cn } from "@mapos/ui/lib/utils";
import { Button } from "@mapos/ui/components/button";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { type SidebarKeyboardShortcutConfig, SidebarProvider } from "@mapos/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { useFullscreen } from "./hooks/use-fullscreen";
import { useMapOverlaySync } from "./hooks/use-map-overlay-sync";
import { type NavEntry, folderLabel, useNavTabs } from "./hooks/use-nav-tabs";
import { useOverlayVaultSync } from "./hooks/use-overlay-vault-sync";
import { usePathSync } from "./hooks/use-path-sync";
import { usePlacesWatcher } from "./hooks/use-places-watcher";
import { modSymbol, useShortcuts } from "./hooks/use-shortcuts";
import type { PhotonSearchResult } from "./lib/photon";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "./lib/place-utils";
import { extractWikilinkTitles, flattenMdFiles } from "./lib/wikilinks";

const BASE_UNITS = 16;

const PROJECT_SIDEBAR_WIDTH = 14 * BASE_UNITS;
const PLACE_CARD_WIDTH = 22 * BASE_UNITS;
const CHAT_SIDEBAR_WIDTH = 22 * BASE_UNITS;
const TOP_BAR_HEIGHT = 2.5 * BASE_UNITS;
const FIT_BUFFER = 2.5 * BASE_UNITS;

const SIDEBAR_KB_PROJECT: SidebarKeyboardShortcutConfig = { shift: false };
const SIDEBAR_KB_CHAT: SidebarKeyboardShortcutConfig = { shift: true };

const EMPTY_MAP_OVERLAY: MapOverlayPayload = {
  layerName: "",
  points: [],
  lines: [],
  polygons: []
};

/** Lines, polygons, etc. — pulse should anchor at map click; Points use geometry coordinates. */
function geometryUsesMapClickPulseAnchor(geometryJson: string | undefined): boolean {
  if (!geometryJson) return false;
  try {
    const g = JSON.parse(geometryJson) as { type?: string };
    return Boolean(g.type && g.type !== "Point");
  } catch {
    return false;
  }
}

function representativeLngLatFromGeometryJson(geometryJson: string): [number, number] | null {
  try {
    const geo = JSON.parse(geometryJson) as {
      type: string;
      coordinates: unknown;
    };
    if (geo.type === "Point" && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      const c = geo.coordinates as number[];
      const lng = c[0];
      const lat = c[1];
      if (typeof lng !== "number" || typeof lat !== "number") return null;
      return [lng, lat];
    }
    if (geo.type === "LineString" && Array.isArray(geo.coordinates)) {
      const [minLng, minLat, maxLng, maxLat] = bbox({
        type: "Feature",
        geometry: { type: "LineString", coordinates: geo.coordinates as [number, number][] },
        properties: {}
      });
      return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    }
    if (geo.type === "Polygon" && Array.isArray(geo.coordinates)) {
      const [minLng, minLat, maxLng, maxLat] = bbox({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: geo.coordinates as [number, number][][] },
        properties: {}
      });
      return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    }
  } catch {
    return null;
  }
  return null;
}

function placeFromPhotonSearchResult(r: PhotonSearchResult): PlaceRecord {
  const geometry = JSON.stringify({
    type: "Point",
    coordinates: [r.lng, r.lat]
  });
  return {
    filePath: `photon-search:${r.id}`,
    title: r.primaryLabel,
    type: "Search",
    geometry,
    /** Present (may be empty) so PlaceCard stays in preview mode without reading a file. */
    previewMarkdown: ""
  };
}

/** Directory containing a vault file path (browser-safe; avoids Node `path` in the renderer bundle). */
function parentFolderOfVaultFile(filePath: string): string {
  const n = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (n === -1) return ".";
  if (n === 0) return filePath.slice(0, 1);
  return filePath.slice(0, n);
}

/** Path looks like a real vault file (rules out preview/overlay/synthetic identifiers). */
function isVaultFilePath(fp: string | undefined | null): fp is string {
  if (!fp) return false;
  if (fp.startsWith("photon-search:")) return false;
  if (fp.startsWith("map-overlay:")) return false;
  if (fp.startsWith("geojson-feature:")) return false;
  return true;
}

/** Open file is a real vault .md (not a photon search, map overlay, or GeoJSON layer). */
function isVaultPlaceFile(place: PlaceRecord | null | undefined): place is PlaceRecord {
  if (!place) return false;
  if (place.previewMarkdown !== undefined) return false;
  if (place.type === "GeoJsonLayer") return false;
  return isVaultFilePath(place.filePath);
}

/** Read the file body, parse [[wikilinks]], resolve each title to a PlaceRecord with geometry. */
async function resolveWikilinks(filePath: string): Promise<PlaceRecord[]> {
  const [readResult, nodes] = await Promise.all([
    window.api.fs.readFile(filePath),
    window.api.fs.listDir()
  ]);
  if ("error" in readResult) return [];
  const titles = extractWikilinkTitles(readResult.body);
  if (titles.length === 0) return [];
  const cache = flattenMdFiles(nodes);
  const paths = titles
    .map((t) => cache.find((f) => f.title === t)?.filePath)
    .filter((p): p is string => Boolean(p) && p !== filePath);
  const records = await Promise.all(paths.map((p) => window.api.places.getByPath(p)));
  return records.filter((r): r is PlaceRecord => r !== null && Boolean(r.geometry));
}

function mapPadding(projectSidebarOpen: boolean, chatSidebarOpen: boolean, placeCardOpen: boolean) {
  return {
    left:
      (projectSidebarOpen ? PROJECT_SIDEBAR_WIDTH : 0) +
      (placeCardOpen ? PLACE_CARD_WIDTH : 0) +
      FIT_BUFFER,
    right: (chatSidebarOpen ? CHAT_SIDEBAR_WIDTH : 0) + FIT_BUFFER,
    top: TOP_BAR_HEIGHT + FIT_BUFFER,
    bottom: FIT_BUFFER
  };
}

function App(): React.JSX.Element {
  const [selectedPlace, setSelectedPlace] = useState<PlaceRecord | null>(null);
  const [placeMode, setPlaceMode] = useState<"mini" | "full">("mini");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(true);
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false);
  const [featureScreenPos, setFeatureScreenPos] = useState<{ x: number; y: number } | null>(null);
  /** Map selection while full PlaceCard is open (floating mini card + highlight). */
  const [mapPeekPlace, setMapPeekPlace] = useState<PlaceRecord | null>(null);
  /** Last real vault file path (kept when switching to a Photon search preview). */
  const [lastVaultFilePath, setLastVaultFilePath] = useState<string | null>(null);
  const [mapOverlay, setMapOverlay] = useState<MapOverlayPayload>(EMPTY_MAP_OVERLAY);
  /** Bumps when a non-empty overlay is pushed so chat can re-show "Add all". */
  const [mapOverlayNonce, setMapOverlayNonce] = useState(0);
  const [addAllOverlayBusy, setAddAllOverlayBusy] = useState(false);
  const [selectionPulseAnchor, setSelectionPulseAnchor] = useState<SelectionPulseAnchor | null>(
    null
  );
  const [activeGeoJsonLayers, setActiveGeoJsonLayers] = useState<
    Array<{
      filePath: string;
      data: Record<string, unknown>;
      bbox: [number, number, number, number];
    }>
  >([]);
  /** Places linked from [[wikilinks]] in the currently-open file; rendered gray. */
  const [linkedPlaces, setLinkedPlaces] = useState<PlaceRecord[]>([]);
  const mapRef = useRef<MapViewHandle>(null);
  const selectedFolderRef = useRef(selectedFolder);
  selectedFolderRef.current = selectedFolder;
  const selectedPlaceRef = useRef(selectedPlace);
  selectedPlaceRef.current = selectedPlace;

  useEffect(() => {
    const p = selectedPlace?.filePath;
    if (!p) {
      setLastVaultFilePath(null);
      return;
    }
    if (!p.startsWith("photon-search:") && !p.startsWith("map-overlay:")) {
      setLastVaultFilePath(p);
    }
  }, [selectedPlace]);

  /** Open file: snapshot padding, resolve wikilinks, set markers, and fit-to-bounds.
   * Keyed on filePath only — toggling sidebars or switching mode after open shouldn't re-fit. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: padding is intentionally snapshotted at open time
  useEffect(() => {
    const filePath = selectedPlace?.filePath;
    if (!filePath || !isVaultPlaceFile(selectedPlace)) {
      setLinkedPlaces([]);
      return;
    }
    const padding = mapPadding(projectSidebarOpen, chatSidebarOpen, placeMode === "full");
    let cancelled = false;
    void (async () => {
      const linked = await resolveWikilinks(filePath);
      if (cancelled) return;
      setLinkedPlaces(linked);
      // Read the latest place from the existing ref so a metadata update mid-resolve
      // (e.g. geometry commit on the same file) feeds the freshest geometry to the fit.
      const currentPlace = selectedPlaceRef.current;
      if (linked.length > 0 && currentPlace?.filePath === filePath) {
        mapRef.current?.fitToPlaceAndLinks(currentPlace, linked, padding);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPlace?.filePath]);

  /** Live update: refresh markers (no fit) when the open file's body changes on disk.
   * Only the filePath shape is consulted — re-binds when the open file changes, not on metadata. */
  useEffect(() => {
    const filePath = selectedPlace?.filePath;
    if (!isVaultFilePath(filePath)) return;
    let cancelled = false;
    const off = window.api.fs.onFileContentChanged(({ filePath: changedPath }) => {
      if (changedPath !== filePath) return;
      void resolveWikilinks(filePath).then((linked) => {
        if (cancelled) return;
        setLinkedPlaces(linked);
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [selectedPlace?.filePath]);

  // MapView.emitFeaturePosition returns early when there is no geometry, otherwise the
  // floating PlaceCard would keep the last screen position after a clear.
  useEffect(() => {
    const placeForMap = mapPeekPlace ?? selectedPlace;
    if (!placeForMap?.geometry) {
      setFeatureScreenPos(null);
    }
  }, [selectedPlace, mapPeekPlace]);

  const placeForMapHighlight = useMemo(
    () => mapPeekPlace ?? selectedPlace,
    [mapPeekPlace, selectedPlace]
  );

  const parentFolderForNewFiles = useMemo(
    () => selectedFolder ?? (lastVaultFilePath ? parentFolderOfVaultFile(lastVaultFilePath) : null),
    [selectedFolder, lastVaultFilePath]
  );

  const clearPlace = useCallback(() => {
    setSelectedPlace(null);
    setPlaceMode("mini");
    setFeatureScreenPos(null);
    setMapPeekPlace(null);
    setSelectionPulseAnchor(null);
  }, []);

  // Open a nav entry without pushing to history (used by back/forward/tab switch)
  const openEntry = useCallback(
    (entry: NavEntry) => {
      if (entry.kind === "place") {
        setSelectedPlace(entry.place);
        setPlaceMode("full");
        setSelectedFolder(null);
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        mapRef.current?.fitToPlace(
          entry.place,
          mapPadding(projectSidebarOpen, chatSidebarOpen, true)
        );
      } else {
        setSelectedFolder(entry.folderPath);
        setSelectedPlace(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        mapRef.current?.fitToFolder(
          entry.folderPath,
          mapPadding(projectSidebarOpen, chatSidebarOpen, false)
        );
      }
    },
    [projectSidebarOpen, chatSidebarOpen]
  );

  const onNavEmpty = useCallback(() => {
    clearPlace();
    setSelectedFolder(null);
  }, [clearPlace]);

  const {
    nav,
    dispatchNav,
    navTabsData,
    activeTabIndex,
    canBack,
    canForward,
    handleNavTabActivate,
    handleNavTabClose,
    handleNavTabReorder,
    handleNavBack,
    handleNavForward
  } = useNavTabs({ openEntry, onEmpty: onNavEmpty });

  const isFullscreen = useFullscreen();

  usePlacesWatcher({ selectedPlaceRef, clearPlace });
  useMapOverlaySync({ selectedPlaceRef, clearPlace, setMapOverlay, setMapOverlayNonce });

  /** Keep file-based GeoJSON on the map in sync with selection (clears when navigating away). */
  const geoJsonLayerPlacePath =
    selectedPlace?.type === "GeoJsonLayer" ? selectedPlace.filePath : null;

  useEffect(() => {
    if (geoJsonLayerPlacePath) {
      let cancelled = false;
      setActiveGeoJsonLayers([]);
      void (async () => {
        const data = await window.api.fs.readGeoJson(geoJsonLayerPlacePath);
        if (cancelled || !data) return;
        const layerBbox = bbox(data as unknown as Parameters<typeof bbox>[0]) as [
          number,
          number,
          number,
          number
        ];
        setActiveGeoJsonLayers([{ filePath: geoJsonLayerPlacePath, data, bbox: layerBbox }]);
      })();
      return () => {
        cancelled = true;
      };
    }

    if (selectedFolder) {
      let cancelled = false;
      setActiveGeoJsonLayers([]);
      void window.api.fs.geoJsonFilesInFolder(selectedFolder).then(async (paths) => {
        if (cancelled) return;
        const results = await Promise.all(paths.map((p) => window.api.fs.readGeoJson(p)));
        if (cancelled) return;
        const layers = results.flatMap((data, i) =>
          data
            ? [
                {
                  filePath: paths[i],
                  data,
                  bbox: bbox(data as unknown as Parameters<typeof bbox>[0]) as [
                    number,
                    number,
                    number,
                    number
                  ]
                }
              ]
            : []
        );
        setActiveGeoJsonLayers(layers);
      });
      return () => {
        cancelled = true;
      };
    }

    setActiveGeoJsonLayers([]);
  }, [geoJsonLayerPlacePath, selectedFolder]);

  /** Live-refresh a .geojson on disk if it's currently rendered on the map (e.g. an
   * external editor or agent overwrote the file). Surgical: only re-reads the file
   * that changed, patches just that entry in the layer list. */
  useEffect(() => {
    const off = window.api.fs.onFileContentChanged(async ({ filePath }) => {
      if (!filePath.toLowerCase().endsWith(".geojson")) return;
      if (!activeGeoJsonLayers.some((l) => l.filePath === filePath)) return;
      const data = await window.api.fs.readGeoJson(filePath);
      if (!data) return;
      const layerBbox = bbox(data as unknown as Parameters<typeof bbox>[0]) as [
        number,
        number,
        number,
        number
      ];
      setActiveGeoJsonLayers((prev) =>
        prev.map((layer) =>
          layer.filePath === filePath ? { filePath, data, bbox: layerBbox } : layer
        )
      );
    });
    return off;
  }, [activeGeoJsonLayers]);

  const handlePlaceRename = useCallback(
    (oldPath: string, newPath: string) => {
      dispatchNav({ type: "relocate_path", oldPath, newPath, isDirectory: false });
      setActiveGeoJsonLayers((prev) =>
        prev.map((layer) => (layer.filePath === oldPath ? { ...layer, filePath: newPath } : layer))
      );
    },
    [dispatchNav]
  );

  useShortcuts([
    {
      def: { key: "w", meta: true, enabled: activeTabIndex >= 0 },
      handler: () => handleNavTabClose(activeTabIndex)
    },
    {
      def: { code: "BracketLeft", meta: true, shift: true, enabled: navTabsData.length > 1 },
      handler: () =>
        handleNavTabActivate((activeTabIndex - 1 + navTabsData.length) % navTabsData.length)
    },
    {
      def: { code: "BracketRight", meta: true, shift: true, enabled: navTabsData.length > 1 },
      handler: () => handleNavTabActivate((activeTabIndex + 1) % navTabsData.length)
    }
  ]);

  function handlePlaceCardClose() {
    setMapPeekPlace(null);
    // Full place cards should close exactly like the active top-bar tab.
    if (placeMode !== "full" || activeTabIndex < 0) {
      clearPlace();
      return;
    }
    handleNavTabClose(activeTabIndex);
  }

  // Map feature click — mini card, or peek mini while full panel stays open
  const handleSelectPlaceFromMap = useCallback(
    (place: PlaceRecord, meta?: MapSelectPlaceMeta) => {
      const useClickPulse =
        Boolean(meta?.mapClickLngLat) && geometryUsesMapClickPulseAnchor(place.geometry);
      if (useClickPulse && meta?.mapClickLngLat) {
        setSelectionPulseAnchor({
          filePath: place.filePath,
          lng: meta.mapClickLngLat.lng,
          lat: meta.mapClickLngLat.lat
        });
      } else {
        setSelectionPulseAnchor(null);
      }

      if (placeMode === "full") {
        setMapPeekPlace(place);
        setFeatureScreenPos(null);
        return;
      }
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      if (!selectedFolderRef.current) {
        setSelectedFolder(null);
        mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
      }
    },
    [placeMode, projectSidebarOpen, chatSidebarOpen]
  );

  // Sidebar file click — navigate within active tab (or background tab on cmd/ctrl+click)
  const handleSelectPlaceFromSidebar = useCallback(
    (place: PlaceRecord, newTab = false) => {
      // Cmd/ctrl-click → open in background tab (browser convention): add to nav,
      // but don't disturb the currently visible view, selection, or map fit.
      if (newTab) {
        dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: true });
        return;
      }
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      const alreadyOpen = placeMode === "full" && selectedPlace?.filePath === place.filePath;
      setSelectedPlace(place);
      setPlaceMode("full");
      setSelectedFolder(null);
      setFeatureScreenPos(null);
      dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: false });
      if (!alreadyOpen) {
        mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
      }
    },
    [placeMode, selectedPlace, projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  // Sidebar folder click — navigate within active tab
  const handleSelectFolder = useCallback(
    (folderPath: string) => {
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      setSelectedFolder(folderPath);
      setSelectedPlace(null);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      dispatchNav({
        type: "navigate",
        entry: { kind: "folder", folderPath, label: folderLabel(folderPath) },
        newTab: false
      });
      mapRef.current?.fitToFolder(
        folderPath,
        mapPadding(projectSidebarOpen, chatSidebarOpen, false)
      );
    },
    [projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  const handleSelectGeoJson = useCallback(
    async (filePath: string) => {
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      const data = await window.api.fs.readGeoJson(filePath);
      if (!data) return;

      const title = String(
        (data as Record<string, unknown>).name ??
          filePath
            .split("/")
            .pop()
            ?.replace(/\.geojson$/i, "") ??
          filePath
      );
      const place: PlaceRecord = { filePath, type: "GeoJsonLayer", title };
      setSelectedPlace(place);
      setPlaceMode("full");
      setSelectedFolder(null);
      setFeatureScreenPos(null);
      dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: false });

      // @ts-expect-error - data shape matches RawFeatureCollection
      mapRef.current?.fitToGeoJson(data, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
    },
    [projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  // New place file created from map context menu
  const handleCreatePlace = useCallback(
    (place: PlaceRecord) => {
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      if (selectedFolder) {
        setSelectedPlace(place);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
      } else {
        setSelectedPlace(place);
        setPlaceMode("full");
        setFeatureScreenPos(null);
        mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
      }
    },
    [selectedFolder, projectSidebarOpen, chatSidebarOpen]
  );

  const handlePhotonSearchResult = useCallback(
    (r: PhotonSearchResult) => {
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      const place = placeFromPhotonSearchResult(r);
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
    },
    [projectSidebarOpen, chatSidebarOpen]
  );

  const commitVaultPointLocation = useCallback(
    async (filePath: string, lat: number, lng: number): Promise<boolean> => {
      const wkt = `POINT(${lng} ${lat})`;
      const write = await window.api.fs.writeFrontmatterProperty(filePath, "geometry", wkt);
      if (!write.success) {
        console.error("[commit location]", write.error);
        return false;
      }
      // `places.getByPath` reads the in-memory index updated by the file watcher, which uses
      // awaitWriteFinish — so it is often still stale immediately after a write. Merge the
      // geometry we know we just persisted instead of trusting getByPath alone.
      const geometryJson = JSON.stringify({ type: "Point", coordinates: [lng, lat] });
      const fromIndex = (await window.api.places.getByPath(filePath)) ?? null;
      const updated: PlaceRecord = {
        ...(fromIndex ?? {
          filePath,
          title: (filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.md$/i, ""),
          type: "place"
        }),
        geometry: geometryJson
      };
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      setSelectedPlace(updated);
      dispatchNav({ type: "update-entry", filePath: updated.filePath, place: updated });
      mapRef.current?.fitToPlace(
        updated,
        mapPadding(projectSidebarOpen, chatSidebarOpen, placeMode === "full")
      );
      return true;
    },
    [projectSidebarOpen, chatSidebarOpen, placeMode, dispatchNav]
  );

  const clearVaultPointLocation = useCallback(
    async (filePath: string): Promise<boolean> => {
      const write = await window.api.fs.writeFrontmatterProperty(filePath, "geometry", null);
      if (!write.success) {
        console.error("[clear location]", write.error);
        return false;
      }
      const fromIndex = (await window.api.places.getByPath(filePath)) ?? null;
      const base: PlaceRecord =
        fromIndex ??
        ({
          filePath,
          title: (filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.md$/i, ""),
          type: "note"
        } satisfies PlaceRecord);
      const cleared = { ...base, geometry: undefined };
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      setSelectedPlace(cleared);
      dispatchNav({ type: "update-entry", filePath, place: cleared });
      mapRef.current?.invalidateFolderPlace(filePath);
      return true;
    },
    [dispatchNav]
  );

  const savePreviewPlaceToVault = useCallback(
    async (place: PlaceRecord | null) => {
      if (place?.previewMarkdown === undefined || !place.geometry) return;
      const lngLat = representativeLngLatFromGeometryJson(place.geometry);
      if (!lngLat) return;
      const [lng, lat] = lngLat;
      const create = await window.api.fs.createNoteFile({
        parentFolderPath: parentFolderForNewFiles,
        lat,
        lng,
        includePlaceFrontmatterDefaults: false
      });
      if (!create.success) {
        console.error("[save search]", create.error);
        return;
      }
      const baseName = filenameBaseFromPlaceTitle(place.title);
      const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
      if (!renamed.ok) {
        console.error("[save search]", renamed.error);
        return;
      }
      if (place.previewMarkdown.trim()) {
        const w = await window.api.fs.writePlaceBody(renamed.filePath, place.previewMarkdown);
        if (!w.success) console.error("[save search] write body", w.error);
      }
      const created =
        (await window.api.places.getByPath(renamed.filePath)) ??
        ({
          filePath: renamed.filePath,
          title: place.title,
          type: "place",
          geometry: place.geometry
        } satisfies PlaceRecord);
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      if (selectedFolder) {
        setSelectedPlace(created);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        mapRef.current?.fitToPlace(created, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
      } else {
        setSelectedPlace(created);
        setPlaceMode("full");
        setFeatureScreenPos(null);
        dispatchNav({
          type: "navigate",
          entry: { kind: "place", place: created },
          newTab: false
        });
        mapRef.current?.fitToPlace(created, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
      }
    },
    [parentFolderForNewFiles, selectedFolder, projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  const handleSaveSearchToVault = useCallback(async () => {
    await savePreviewPlaceToVault(selectedPlace);
  }, [selectedPlace, savePreviewPlaceToVault]);

  const handleOverlayRestore = useCallback((overlay: MapOverlayPayload | null) => {
    if (overlay) {
      setMapOverlay(overlay);
      setMapOverlayNonce((n) => n + 1);
    } else {
      setMapOverlay(EMPTY_MAP_OVERLAY);
    }
  }, []);

  const { handleAddAllOverlayToVault } = useOverlayVaultSync({
    mapOverlay,
    setAddAllOverlayBusy
  });

  const { handleRenamePath, handlePathRelocated, handleDeletedPath } = usePathSync({
    nav,
    dispatchNav,
    selectedPlace,
    selectedFolder,
    setSelectedFolder,
    setSelectedPlace,
    openEntry,
    clearPlace,
    onNavEmpty
  });

  const isMini = selectedPlace !== null && placeMode === "mini";
  const isFull = selectedPlace !== null && placeMode === "full";

  const handleMapClickEmpty = useCallback(() => {
    if (isMini) {
      clearPlace();
      return;
    }
    if (mapPeekPlace) {
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
    }
  }, [isMini, mapPeekPlace, clearPlace]);

  /** Sidebar tree highlight: follow the active tab's place, not `selectedPlace` (Photon replaces that in mini mode). */
  const selectedFilePathForSidebar = useMemo(() => {
    const tab = nav.tabs[nav.activeTab];
    const entry = tab?.history[tab.cursor];
    if (entry?.kind !== "place") return undefined;
    const fp = entry.place.filePath;
    // Sidebar matches real vault paths only; preview ids are not files on disk.
    if (fp.startsWith("photon-search:") || fp.startsWith("map-overlay:")) return undefined;
    return fp;
  }, [nav]);

  return (
    <>
      {/* Map: full viewport, goes under the top bar */}
      <div className="fixed inset-0 z-0">
        <MapView
          ref={mapRef}
          onSelectPlace={handleSelectPlaceFromMap}
          onCreatePlace={handleCreatePlace}
          onMapClickEmpty={isMini || mapPeekPlace ? handleMapClickEmpty : undefined}
          selectedPlace={placeForMapHighlight}
          selectedFolder={selectedFolder}
          parentFolderForNewFiles={parentFolderForNewFiles}
          onSelectedFeaturePosition={(x, y) => setFeatureScreenPos({ x, y })}
          mapOverlay={{
            points: mapOverlay.points,
            lines: mapOverlay.lines,
            polygons: mapOverlay.polygons
          }}
          showOverlay={chatSidebarOpen}
          // @ts-expect-error - activeGeoJsonLayers data shape matches RawFeatureCollection
          geoJsonLayers={activeGeoJsonLayers}
          selectionPulseAnchor={selectionPulseAnchor}
          linkedPlaces={linkedPlaces}
        />
      </div>

      {/* Top bar */}
      <motion.div
        layoutRoot
        className={cn(
          "fixed top-0 inset-x-0 z-30 flex items-center gap-1 pr-2 text-sidebar-foreground bg-sidebar/80 backdrop-blur-md border-b border-sidebar-border",
          isFullscreen ? "pl-2" : "pl-21"
        )}
        style={{ height: TOP_BAR_HEIGHT, WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setProjectSidebarOpen((o) => !o)}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="bottom">
            Project
            <KbdGroup>
              <Kbd>{modSymbol}</Kbd>
              <Kbd>{"\\"}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <PhotonSearchPopover onSelectResult={handlePhotonSearchResult} />
        </div>
        <div className="flex-1 min-w-0 flex items-center h-full min-h-0">
          <NavTabs
            tabs={navTabsData}
            activeTabIndex={activeTabIndex}
            canBack={canBack}
            canForward={canForward}
            onTabActivate={handleNavTabActivate}
            onTabClose={handleNavTabClose}
            onTabReorder={handleNavTabReorder}
            onBack={handleNavBack}
            onForward={handleNavForward}
          />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setChatSidebarOpen((o) => !o)}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <MessageCircleIcon className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="bottom">
            Chat
            <KbdGroup>
              <Kbd>{modSymbol}</Kbd>
              <Kbd>⇧</Kbd>
              <Kbd>{"\\"}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </motion.div>

      {/* Content wrapper: top offset + transform creates a new containing block
          so all fixed children are relative to this wrapper, not the viewport */}
      <div
        className="fixed inset-x-0 bottom-0 pointer-events-none"
        style={{ top: TOP_BAR_HEIGHT, transform: "translateZ(0)" }}
      >
        {/* Full-height place panel */}
        {isFull && selectedPlace && (
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-auto p-2"
            style={{
              left: projectSidebarOpen ? PROJECT_SIDEBAR_WIDTH : 0,
              width: PLACE_CARD_WIDTH
            }}
          >
            <PlaceCard
              key={selectedPlace.filePath}
              place={selectedPlace}
              mode="full"
              onClose={handlePlaceCardClose}
              onNavigate={handleSelectPlaceFromSidebar}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
            />
          </div>
        )}

        {/* Mini place card — floats above the selected map feature */}
        {isMini && featureScreenPos && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: featureScreenPos.x,
              top: featureScreenPos.y - TOP_BAR_HEIGHT,
              transform: "translate(-50%, calc(-100% - 16px))"
            }}
          >
            <PlaceCard
              key={selectedPlace.filePath}
              place={selectedPlace}
              mode="mini"
              onClose={handlePlaceCardClose}
              onNavigate={handleSelectPlaceFromSidebar}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
              onSaveSearchToVault={
                selectedPlace.previewMarkdown !== undefined ? handleSaveSearchToVault : undefined
              }
              onExpand={
                selectedPlace.previewMarkdown !== undefined
                  ? undefined
                  : () => {
                      setPlaceMode("full");
                      setSelectedFolder(null);
                      dispatchNav({
                        type: "navigate",
                        entry: { kind: "place", place: selectedPlace },
                        newTab: false
                      });
                      mapRef.current?.fitToPlace(
                        selectedPlace,
                        mapPadding(projectSidebarOpen, chatSidebarOpen, true)
                      );
                    }
              }
            />
          </div>
        )}

        {/* Peek mini card — map selection while full PlaceCard is open */}
        {isFull && mapPeekPlace && featureScreenPos && (
          <div
            className="absolute pointer-events-none z-30"
            style={{
              left: featureScreenPos.x,
              top: featureScreenPos.y - TOP_BAR_HEIGHT,
              transform: "translate(-50%, calc(-100% - 16px))"
            }}
          >
            <PlaceCard
              key={mapPeekPlace.filePath}
              place={mapPeekPlace}
              mode="mini"
              onClose={() => {
                setMapPeekPlace(null);
                setSelectionPulseAnchor(null);
              }}
              onNavigate={handleSelectPlaceFromSidebar}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
              onSaveSearchToVault={
                mapPeekPlace.previewMarkdown !== undefined
                  ? async () => {
                      await savePreviewPlaceToVault(mapPeekPlace);
                    }
                  : undefined
              }
              onExpand={
                mapPeekPlace.previewMarkdown !== undefined
                  ? undefined
                  : () => {
                      setMapPeekPlace(null);
                      handleSelectPlaceFromSidebar(mapPeekPlace, false);
                    }
              }
            />
          </div>
        )}

        {/* Left sidebar overlay */}
        <SidebarProvider
          name="sidebar-left"
          open={projectSidebarOpen}
          onOpenChange={setProjectSidebarOpen}
          keyboardShortcut={SIDEBAR_KB_PROJECT}
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
          style={{ "--sidebar-width": `${PROJECT_SIDEBAR_WIDTH}px` } as React.CSSProperties}
        >
          <ProjectSidebar
            selectedFilePath={selectedFilePathForSidebar}
            selectedFolderPath={selectedFolder ?? undefined}
            onSelectPlace={handleSelectPlaceFromSidebar}
            onSelectFolder={handleSelectFolder}
            onSelectGeoJson={(p) => void handleSelectGeoJson(p)}
            onDeletePath={handleDeletedPath}
            onRenamePath={handlePathRelocated}
            onMoved={handlePathRelocated}
          />
        </SidebarProvider>

        {/* Right sidebar overlay */}
        <SidebarProvider
          name="sidebar-right"
          open={chatSidebarOpen}
          onOpenChange={setChatSidebarOpen}
          keyboardShortcut={SIDEBAR_KB_CHAT}
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
          style={{ "--sidebar-width": `${CHAT_SIDEBAR_WIDTH}px` } as React.CSSProperties}
        >
          <ChatSidebar
            mapOverlay={mapOverlay}
            mapOverlayNonce={mapOverlayNonce}
            onAddAllOverlayToVault={handleAddAllOverlayToVault}
            addAllOverlayBusy={addAllOverlayBusy}
            defaultParentFolderPath={parentFolderForNewFiles}
            onOverlayRestore={handleOverlayRestore}
            onOpenFile={async (filePath) => {
              const place = await window.api.places.getByPath(filePath);
              if (place) handleSelectPlaceFromSidebar(place);
            }}
          />
        </SidebarProvider>
      </div>
    </>
  );
}

export default App;

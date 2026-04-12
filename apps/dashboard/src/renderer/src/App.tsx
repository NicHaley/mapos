import type { MapOverlayPayload, OverlayLine, OverlayPolygon } from "@shared/types";
import { bbox } from "@turf/bbox";
import { MessageCircleIcon, PanelLeftIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatSidebar } from "./components/ChatSidebar";
import MapView, { type MapViewHandle, type PlaceRecord } from "./components/MapView";
import { NavTabs } from "./components/NavTabs";
import { PhotonSearchPopover } from "./components/PhotonSearchPopover";
import { PlaceCard } from "./components/PlaceCard";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Button } from "./components/ui/button";
import { Kbd, KbdGroup } from "./components/ui/kbd";
import { type SidebarKeyboardShortcutConfig, SidebarProvider } from "./components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { type NavEntry, folderLabel, navReducer, useNavTabs } from "./hooks/useNavTabs";
import { modSymbol } from "./hooks/useShortcuts";
import type { PhotonSearchResult } from "./lib/photon";
import { uniqueNameCandidates } from "./lib/unique-name";

const PROJECT_SIDEBAR_WIDTH = 256;
const PLACE_CARD_WIDTH = 320;
const CHAT_SIDEBAR_WIDTH = 360;
const TOP_BAR_HEIGHT = 40;
const FIT_BUFFER = 40;

const SIDEBAR_KB_PROJECT: SidebarKeyboardShortcutConfig = { shift: false };
const SIDEBAR_KB_CHAT: SidebarKeyboardShortcutConfig = { shift: true };

/** File basename (no extension) from Photon/OSM place name — keeps casing and spacing; only strips illegal path chars. */
function filenameBaseFromPlaceTitle(title: string): string {
  const s = title
    .trim()
    .replace(/[/\\:*?"<>|]/g, "")
    .trim();
  return s || "place";
}

async function renameCreatedPlaceToSlug(
  initialPath: string,
  baseSlug: string
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  const current = initialPath;
  let n = 0;
  const maxCandidates = 31;
  for (const slug of uniqueNameCandidates(baseSlug, "hyphenNumbered")) {
    if (++n > maxCandidates) {
      return { ok: false, error: "Could not find an available filename" };
    }
    const r = await window.api.fs.renameFile(current, slug);
    if (r.success) return { ok: true, filePath: r.newPath };
    if (r.error !== "A file or folder with that name already exists") {
      return { ok: false, error: r.error };
    }
  }
  return { ok: false, error: "Could not find an available filename" };
}

const EMPTY_MAP_OVERLAY: MapOverlayPayload = {
  layerName: "",
  points: [],
  lines: [],
  polygons: []
};

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

function lngLatFromOverlayLine(line: OverlayLine): [number, number] | null {
  try {
    const [minLng, minLat, maxLng, maxLat] = bbox({
      type: "Feature",
      geometry: { type: "LineString", coordinates: line.coordinates },
      properties: {}
    });
    return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  } catch {
    return null;
  }
}

function lngLatFromOverlayPolygon(poly: OverlayPolygon): [number, number] | null {
  try {
    const [minLng, minLat, maxLng, maxLat] = bbox({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: poly.coordinates },
      properties: {}
    });
    return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  } catch {
    return null;
  }
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
  /** Last real vault file path (kept when switching to a Photon search preview). */
  const [lastVaultFilePath, setLastVaultFilePath] = useState<string | null>(null);
  const [mapOverlay, setMapOverlay] = useState<MapOverlayPayload>(EMPTY_MAP_OVERLAY);
  /** Bumps when a non-empty overlay is pushed so chat can re-show "Add all". */
  const [mapOverlayNonce, setMapOverlayNonce] = useState(0);
  const [addAllOverlayBusy, setAddAllOverlayBusy] = useState(false);
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

  const parentFolderForNewFiles = useMemo(
    () => selectedFolder ?? (lastVaultFilePath ? parentFolderOfVaultFile(lastVaultFilePath) : null),
    [selectedFolder, lastVaultFilePath]
  );

  const clearPlace = useCallback(() => {
    setSelectedPlace(null);
    setPlaceMode("mini");
    setFeatureScreenPos(null);
  }, []);

  // Close the place card if the currently open file is deleted externally (e.g. by undo)
  useEffect(() => {
    window.api.places.onUpdated((update) => {
      if (update.event === "unlink" && update.filePath === selectedPlaceRef.current?.filePath) {
        clearPlace();
      }
    });
  }, [clearPlace]);

  useEffect(() => {
    window.api.map.onOverlay((data) => {
      const points = data.points ?? [];
      const lines = data.lines ?? [];
      const polygons = data.polygons ?? [];
      setMapOverlay({
        layerName: data.layerName,
        points,
        lines,
        polygons
      });
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
  }, [clearPlace]);

  // Open a nav entry without pushing to history (used by back/forward/tab switch)
  const openEntry = useCallback(
    (entry: NavEntry) => {
      if (entry.kind === "place") {
        setSelectedPlace(entry.place);
        setPlaceMode("full");
        setSelectedFolder(null);
        setFeatureScreenPos(null);
        mapRef.current?.fitToPlace(
          entry.place,
          mapPadding(projectSidebarOpen, chatSidebarOpen, true)
        );
      } else {
        setSelectedFolder(entry.folderPath);
        setSelectedPlace(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
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
    handleNavBack,
    handleNavForward
  } = useNavTabs({ openEntry, onEmpty: onNavEmpty });

  // Map feature click — show mini card; no-op when full panel is active
  const handleSelectPlaceFromMap = useCallback(
    (place: PlaceRecord) => {
      if (placeMode === "full") return;
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

  // Sidebar file click — navigate within active tab (or new tab on cmd/ctrl+click)
  const handleSelectPlaceFromSidebar = useCallback(
    (place: PlaceRecord, newTab = false) => {
      const alreadyOpen = placeMode === "full" && selectedPlace?.filePath === place.filePath;
      setSelectedPlace(place);
      setPlaceMode("full");
      setSelectedFolder(null);
      setFeatureScreenPos(null);
      dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab });
      if (!alreadyOpen) {
        mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
      }
    },
    [placeMode, selectedPlace, projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  // Sidebar folder click — navigate within active tab
  const handleSelectFolder = useCallback(
    (folderPath: string) => {
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

  // New place file created from map context menu
  const handleCreatePlace = useCallback(
    (place: PlaceRecord) => {
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
      setSelectedPlace(updated);
      mapRef.current?.fitToPlace(
        updated,
        mapPadding(projectSidebarOpen, chatSidebarOpen, placeMode === "full")
      );
      return true;
    },
    [projectSidebarOpen, chatSidebarOpen, placeMode]
  );

  const clearVaultPointLocation = useCallback(async (filePath: string): Promise<boolean> => {
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
    setSelectedPlace({ ...base, geometry: undefined });
    return true;
  }, []);

  const handleSaveSearchToVault = useCallback(async () => {
    const place = selectedPlace;
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
  }, [
    parentFolderForNewFiles,
    selectedFolder,
    selectedPlace,
    projectSidebarOpen,
    chatSidebarOpen,
    dispatchNav
  ]);

  const handleOverlayRestore = useCallback((overlay: MapOverlayPayload | null) => {
    if (overlay) {
      setMapOverlay(overlay);
      setMapOverlayNonce((n) => n + 1);
    } else {
      setMapOverlay(EMPTY_MAP_OVERLAY);
    }
  }, []);

  const handleAddAllOverlayToVault = useCallback(async () => {
    const { points, lines, polygons } = mapOverlay;
    const n = points.length + lines.length + polygons.length;
    if (n === 0) return;
    setAddAllOverlayBusy(true);
    try {
      for (const p of points) {
        const create = await window.api.fs.createNoteFile({
          parentFolderPath: parentFolderForNewFiles,
          lat: p.lat,
          lng: p.lng
        });
        if (!create.success) {
          console.error("[add all overlay]", create.error);
          continue;
        }
        const baseName = filenameBaseFromPlaceTitle(p.title);
        const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
        if (!renamed.ok) {
          console.error("[add all overlay]", renamed.error);
          continue;
        }
        if (p.preview_markdown?.trim()) {
          const w = await window.api.fs.writePlaceBody(renamed.filePath, p.preview_markdown);
          if (!w.success) console.error("[add all overlay] write body", w.error);
        }
      }
      for (const l of lines) {
        const ll = lngLatFromOverlayLine(l);
        if (!ll) continue;
        const [lng, lat] = ll;
        const create = await window.api.fs.createNoteFile({
          parentFolderPath: parentFolderForNewFiles,
          lat,
          lng
        });
        if (!create.success) {
          console.error("[add all overlay]", create.error);
          continue;
        }
        const baseName = filenameBaseFromPlaceTitle(l.title ?? "Route");
        const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
        if (!renamed.ok) {
          console.error("[add all overlay]", renamed.error);
          continue;
        }
        if (l.preview_markdown?.trim()) {
          const w = await window.api.fs.writePlaceBody(renamed.filePath, l.preview_markdown);
          if (!w.success) console.error("[add all overlay] write body", w.error);
        }
      }
      for (const poly of polygons) {
        const ll = lngLatFromOverlayPolygon(poly);
        if (!ll) continue;
        const [lng, lat] = ll;
        const create = await window.api.fs.createNoteFile({
          parentFolderPath: parentFolderForNewFiles,
          lat,
          lng
        });
        if (!create.success) {
          console.error("[add all overlay]", create.error);
          continue;
        }
        const baseName = filenameBaseFromPlaceTitle(poly.title ?? "Area");
        const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
        if (!renamed.ok) {
          console.error("[add all overlay]", renamed.error);
          continue;
        }
        if (poly.preview_markdown?.trim()) {
          const w = await window.api.fs.writePlaceBody(renamed.filePath, poly.preview_markdown);
          if (!w.success) console.error("[add all overlay] write body", w.error);
        }
      }
    } finally {
      setAddAllOverlayBusy(false);
    }
  }, [mapOverlay, parentFolderForNewFiles]);

  const handleRenamePath = useCallback((oldPath: string, newPath: string) => {
    setSelectedFolder((prev) => {
      if (!prev) return prev;
      if (prev === oldPath) return newPath;
      if (prev.startsWith(`${oldPath}/`) || prev.startsWith(`${oldPath}\\`))
        return newPath + prev.slice(oldPath.length);
      return prev;
    });
  }, []);

  /** After drag-and-drop or cross-folder move: sync nav tabs, selection, and open place paths. */
  const handlePathRelocated = useCallback(
    (oldPath: string, newPath: string, isDirectory: boolean) => {
      dispatchNav({ type: "relocate_path", oldPath, newPath, isDirectory });

      setSelectedFolder((prev) => {
        if (!prev) return prev;
        if (prev === oldPath) return newPath;
        if (prev.startsWith(`${oldPath}/`) || prev.startsWith(`${oldPath}\\`))
          return newPath + prev.slice(oldPath.length);
        return prev;
      });

      setSelectedPlace((prev) => {
        if (
          !prev ||
          prev.filePath.startsWith("photon-search:") ||
          prev.filePath.startsWith("map-overlay:")
        )
          return prev;
        const fp = prev.filePath;
        if (!isDirectory) {
          if (fp !== oldPath) return prev;
          const base = newPath.split(/[/\\]/).pop() ?? newPath;
          return { ...prev, filePath: newPath, title: base.replace(/\.md$/i, "") };
        }
        if (fp === oldPath) {
          const base = newPath.split(/[/\\]/).pop() ?? newPath;
          return { ...prev, filePath: newPath, title: base.replace(/\.md$/i, "") };
        }
        if (fp.startsWith(`${oldPath}/`) || fp.startsWith(`${oldPath}\\`)) {
          const nextPath = newPath + fp.slice(oldPath.length);
          const base = nextPath.split(/[/\\]/).pop() ?? nextPath;
          return { ...prev, filePath: nextPath, title: base.replace(/\.md$/i, "") };
        }
        return prev;
      });
    },
    [dispatchNav]
  );

  const handleDeletedPath = useCallback(
    (deletedPath: string, type: "file" | "directory") => {
      const isSameOrChildPath = (currentPath: string, parentPath: string) =>
        currentPath === parentPath ||
        currentPath.startsWith(`${parentPath}/`) ||
        currentPath.startsWith(`${parentPath}\\`);

      const isFolder = type === "directory";
      const nextNavState = navReducer(nav, { type: "remove_path", path: deletedPath, isFolder });
      dispatchNav({ type: "remove_path", path: deletedPath, isFolder });

      if (isFolder) {
        const wasAffected =
          (selectedFolder && isSameOrChildPath(selectedFolder, deletedPath)) ||
          (selectedPlace && isSameOrChildPath(selectedPlace.filePath, deletedPath));
        setSelectedFolder((prev) => (prev && isSameOrChildPath(prev, deletedPath) ? null : prev));
        setSelectedPlace((prev) =>
          prev && isSameOrChildPath(prev.filePath, deletedPath) ? null : prev
        );
        if (wasAffected) {
          const nextTab = nextNavState.tabs[nextNavState.activeTab];
          const nextEntry = nextTab?.history[nextTab.cursor];
          if (nextEntry) openEntry(nextEntry);
          else onNavEmpty();
        }
      } else {
        if (selectedPlace?.filePath === deletedPath) {
          const nextTab = nextNavState.tabs[nextNavState.activeTab];
          const nextEntry = nextTab?.history[nextTab.cursor];
          if (nextEntry) openEntry(nextEntry);
          else clearPlace();
        }
      }
    },
    [selectedPlace, selectedFolder, nav, dispatchNav, openEntry, clearPlace, onNavEmpty]
  );

  const isMini = selectedPlace !== null && placeMode === "mini";
  const isFull = selectedPlace !== null && placeMode === "full";

  const handleMapClickEmpty = useCallback(() => {
    if (isMini) clearPlace();
  }, [isMini, clearPlace]);

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
          onMapClickEmpty={isMini ? handleMapClickEmpty : undefined}
          selectedPlace={selectedPlace}
          selectedFolder={selectedFolder}
          parentFolderForNewFiles={parentFolderForNewFiles}
          onSelectedFeaturePosition={(x, y) => setFeatureScreenPos({ x, y })}
          mapOverlay={{
            points: mapOverlay.points,
            lines: mapOverlay.lines,
            polygons: mapOverlay.polygons
          }}
          showOverlay={chatSidebarOpen}
        />
      </div>

      {/* Top bar */}
      <div
        className="fixed top-0 inset-x-0 z-30 flex items-center gap-1 pl-20 pr-2 text-sidebar-foreground bg-sidebar/80 backdrop-blur-md border-b border-sidebar-border"
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
        <div
          className="flex-1 min-w-0 flex items-center h-full"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <NavTabs
            tabs={navTabsData}
            activeTabIndex={activeTabIndex}
            canBack={canBack}
            canForward={canForward}
            onTabActivate={handleNavTabActivate}
            onTabClose={handleNavTabClose}
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
      </div>

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
              width: PLACE_CARD_WIDTH,
              transition: "left 200ms linear"
            }}
          >
            <PlaceCard
              place={selectedPlace}
              mode="full"
              onClose={clearPlace}
              onNavigate={handleSelectPlaceFromSidebar}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
            />
          </div>
        )}

        {/* Ping dot — shown for both mini and full modes whenever we have a screen position */}
        {selectedPlace && featureScreenPos && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: featureScreenPos.x,
              top: featureScreenPos.y - TOP_BAR_HEIGHT,
              transform: "translate(-50%, -50%)"
            }}
          >
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-white shadow-sm" />
            </span>
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
              place={selectedPlace}
              mode="mini"
              onClose={clearPlace}
              onNavigate={handleSelectPlaceFromSidebar}
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
            onDeletePath={handleDeletedPath}
            onRenamePath={handleRenamePath}
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

import type { RouteCosting } from "@mapos/contracts";
import type { MapOverlayLayer } from "@shared/types";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { PlaceRecord } from "../components/map-view";
import { useVaultRoot } from "./use-vault-root";

/** A resolved directions endpoint: coordinates plus the label shown in the input. */
export type DirectionsWaypoint = {
  lat: number;
  lng: number;
  label: string;
  /** Absolute path of the vault place this stop came from, when it came from one. Saved as a
   *  `[[wikilink]]` on the route; absent for a geocode result or a bare map pick. */
  filePath?: string;
};
/** Travel mode for a directions request — the routing costing model. */
export type TravelMode = RouteCosting;

export type NavEntry =
  | { kind: "place"; place: PlaceRecord }
  | { kind: "folder"; folderPath: string; label: string }
  // A working set of features. Carries its own overlay `layer` so the tab (and its
  // markers) survive a refresh like any other tab — it is not path-based, so relocate
  // and remove-path skip it. `label` is the overlay's name.
  | { kind: "list"; layerId: string; label: string; layer: MapOverlayLayer }
  // A directions request. Like `list`, it is not path-based and carries its own inputs
  // (an ordered list of stops + mode) so the tab round-trips a refresh; the route geometry
  // is recomputed by the panel, not persisted. `stops[0]` is the origin, the last is the
  // destination, and any in between are waypoints; a null entry is an empty input. At least
  // two entries always exist.
  | {
      kind: "directions";
      id: string;
      label: string;
      stops: (DirectionsWaypoint | null)[];
      mode: TravelMode;
      /**
       * The vault file this route saves into. Absent means unbound: saving creates a new
       * place file, and the entry is then bound to it so a second save updates rather than
       * duplicating. Set up front when opened from a place card's "Draw a route".
       *
       * This is the one thing that makes a directions tab path-aware, so unlike `list` tabs
       * it participates in renames (see relocateEntry) and deletions (see remove_path).
       */
      targetFilePath?: string;
    };

export type NavTab = { id: string; history: NavEntry[]; cursor: number };
export type NavState = { tabs: NavTab[]; activeTab: number };

export type NavAction =
  | { type: "navigate"; entry: NavEntry; newTab: boolean; activate?: boolean }
  | { type: "back" }
  | { type: "forward" }
  | { type: "activate"; tabIndex: number }
  | { type: "close"; tabIndex: number }
  | { type: "remove_path"; path: string; isFolder: boolean }
  | { type: "restore"; tabs: NavTab[]; activeTab: number }
  | { type: "relocate_path"; oldPath: string; newPath: string; isDirectory: boolean }
  | { type: "reorder"; newOrder: string[] }
  | { type: "update-entry"; filePath: string; place: PlaceRecord }
  | { type: "update-list"; layerId: string; layer: MapOverlayLayer }
  | {
      type: "update-directions";
      id: string;
      stops: (DirectionsWaypoint | null)[];
      mode: TravelMode;
    }
  // Fill a directions tab's origin with the user's location once geolocation lands. Narrower
  // than `update-directions` on purpose: the request is issued when the tab opens and can take
  // its full 10s timeout, so writing back a whole stop list would revert everything the user
  // did while waiting. Only stop 0 is touched, and only while it is still blank — a stop they
  // filled themselves in the meantime is their answer, not one to overwrite.
  | { type: "fill-directions-origin"; id: string; waypoint: DirectionsWaypoint }
  // Attach an unbound directions tab to the file its first save created, so saving again
  // updates that file instead of creating a second one. (After a save the tab navigates to
  // the place, but the directions entry stays in history — Back, Save would duplicate.)
  | { type: "bind-directions"; id: string; targetFilePath: string; label: string };

/** Rewrite paths when a file or folder was moved to a new location. */
function relocateFilePath(path: string, oldRoot: string, newRoot: string): string | null {
  if (path === oldRoot) return newRoot;
  if (path.startsWith(`${oldRoot}/`) || path.startsWith(`${oldRoot}\\`)) {
    return newRoot + path.slice(oldRoot.length);
  }
  return null;
}

function placeTitleFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  return base.replace(/\.(md|geojson)$/i, "");
}

function relocateEntry(
  entry: NavEntry,
  oldPath: string,
  newPath: string,
  isDirectory: boolean
): NavEntry {
  // List tabs are not path-based — moves never touch them.
  if (entry.kind === "list") return entry;
  // A directions tab is path-based only through its binding. Following the move matters
  // for more than a broken save: leave the old path in place and a *different* file that
  // later occupies it gets silently overwritten by the next save.
  if (entry.kind === "directions") {
    if (!entry.targetFilePath) return entry;
    const next = isDirectory
      ? relocateFilePath(entry.targetFilePath, oldPath, newPath)
      : entry.targetFilePath === oldPath
        ? newPath
        : null;
    if (next === null) return entry;
    return { ...entry, targetFilePath: next, label: placeTitleFromPath(next) };
  }
  if (entry.kind === "place") {
    const fp = entry.place.filePath;
    if (!isDirectory) {
      if (fp !== oldPath) return entry;
      return {
        kind: "place",
        place: {
          ...entry.place,
          filePath: newPath,
          title: placeTitleFromPath(newPath)
        }
      };
    }
    const next = relocateFilePath(fp, oldPath, newPath);
    if (next === null) return entry;
    return {
      kind: "place",
      place: {
        ...entry.place,
        filePath: next,
        title: placeTitleFromPath(next)
      }
    };
  }
  const folderPath = entry.folderPath;
  if (!isDirectory) return entry;
  const next = relocateFilePath(folderPath, oldPath, newPath);
  if (next === null) return entry;
  return {
    kind: "folder",
    folderPath: next,
    label: folderLabel(next)
  };
}

type PersistedTab =
  | { kind: "place"; filePath: string }
  | { kind: "folder"; folderPath: string }
  | { kind: "list"; layerId: string; label: string; layer: MapOverlayLayer }
  | {
      kind: "directions";
      id: string;
      label: string;
      stops: (DirectionsWaypoint | null)[];
      mode: TravelMode;
      targetFilePath?: string;
    };
type PersistedNavState = { tabs: PersistedTab[]; activeTab: number };

// Scoped per vault — see useVaultRoot. The bare key predates scoping and is
// removed on restore so stale cross-vault tabs don't linger.
const NAV_STORAGE_KEY = "mapos-nav-tabs";

export function folderLabel(folderPath: string): string {
  return folderPath.split(/[/\\]/).filter(Boolean).pop() ?? folderPath;
}

function pathIsUnder(candidate: string, path: string, isFolder: boolean): boolean {
  if (candidate === path) return true;
  return isFolder && (candidate.startsWith(`${path}/`) || candidate.startsWith(`${path}\\`));
}

/**
 * Drop a directions tab's binding when its target file is deleted, leaving the tab itself
 * alone. A binding is a weak reference: losing the file should cost the link, not the stops
 * the user has assembled — so this runs *before* the remove_path filter, which would
 * otherwise take the whole tab with it.
 */
function unbindRemovedTarget(entry: NavEntry, path: string, isFolder: boolean): NavEntry {
  if (entry.kind !== "directions" || !entry.targetFilePath) return entry;
  if (!pathIsUnder(entry.targetFilePath, path, isFolder)) return entry;
  const { targetFilePath: _removed, ...rest } = entry;
  return { ...rest, label: "Directions" };
}

function entryMatchesPath(entry: NavEntry, path: string, isFolder: boolean): boolean {
  // A list tab references no vault path, and a directions tab's binding is handled by
  // unbindRemovedTarget above — neither is ever removed by a deletion.
  if (entry.kind === "list" || entry.kind === "directions") return false;
  if (entry.kind === "place") {
    if (isFolder) {
      return (
        entry.place.filePath === path ||
        entry.place.filePath.startsWith(`${path}/`) ||
        entry.place.filePath.startsWith(`${path}\\`)
      );
    }
    return entry.place.filePath === path;
  }
  if (isFolder) {
    return (
      entry.folderPath === path ||
      entry.folderPath.startsWith(`${path}/`) ||
      entry.folderPath.startsWith(`${path}\\`)
    );
  }
  return false;
}

/** Pure transition for closing a tab; shared by {@link navReducer} and {@link useNavTabs} when the next state is needed before dispatch. */
function applyCloseTab(state: NavState, tabIndex: number): NavState {
  const newTabs = state.tabs.filter((_, i) => i !== tabIndex);
  if (newTabs.length === 0) return { tabs: [], activeTab: -1 };
  let active = state.activeTab;
  if (tabIndex < active) active--;
  else if (tabIndex === active) active = Math.min(active, newTabs.length - 1);
  return { tabs: newTabs, activeTab: active };
}

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "navigate": {
      if (action.newTab || state.tabs.length === 0) {
        const newTab: NavTab = {
          id: crypto.randomUUID(),
          history: [action.entry],
          cursor: 0
        };
        // Background tab on cmd/ctrl-click (matches browser convention) — keep the
        // current activeTab unless there was nothing open or the caller asked to activate.
        const nextActive =
          state.tabs.length === 0 || action.activate ? state.tabs.length : state.activeTab;
        return { tabs: [...state.tabs, newTab], activeTab: nextActive };
      }
      const tab = state.tabs[state.activeTab];
      const newHistory = [...tab.history.slice(0, tab.cursor + 1), action.entry];
      const updatedTab = { ...tab, history: newHistory, cursor: newHistory.length - 1 };
      return {
        ...state,
        tabs: state.tabs.map((t, i) => (i === state.activeTab ? updatedTab : t))
      };
    }
    case "back": {
      const tab = state.tabs[state.activeTab];
      if (!tab || tab.cursor <= 0) return state;
      return {
        ...state,
        tabs: state.tabs.map((t, i) => (i === state.activeTab ? { ...t, cursor: t.cursor - 1 } : t))
      };
    }
    case "forward": {
      const tab = state.tabs[state.activeTab];
      if (!tab || tab.cursor >= tab.history.length - 1) return state;
      return {
        ...state,
        tabs: state.tabs.map((t, i) => (i === state.activeTab ? { ...t, cursor: t.cursor + 1 } : t))
      };
    }
    case "activate":
      return { ...state, activeTab: action.tabIndex };
    case "close":
      return applyCloseTab(state, action.tabIndex);
    case "remove_path": {
      const newTabs = state.tabs
        .map((tab) => {
          const newHistory = tab.history
            .map((entry) => unbindRemovedTarget(entry, action.path, action.isFolder))
            .filter((entry) => !entryMatchesPath(entry, action.path, action.isFolder));
          if (newHistory.length === 0) return null;
          const newCursor = Math.min(tab.cursor, newHistory.length - 1);
          return { ...tab, history: newHistory, cursor: newCursor };
        })
        .filter(Boolean) as NavTab[];
      if (newTabs.length === 0) return { tabs: [], activeTab: -1 };
      return { tabs: newTabs, activeTab: Math.min(state.activeTab, newTabs.length - 1) };
    }
    case "restore":
      return { tabs: action.tabs, activeTab: action.activeTab };
    case "relocate_path": {
      const { oldPath, newPath, isDirectory } = action;
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          history: tab.history.map((entry) => relocateEntry(entry, oldPath, newPath, isDirectory))
        }))
      };
    }
    case "reorder": {
      if (action.newOrder.length !== state.tabs.length) return state;
      const byId = new Map(state.tabs.map((t) => [t.id, t]));
      const reordered = action.newOrder.map((id) => byId.get(id));
      if (reordered.some((t) => t == null)) return state;
      const tabs = reordered as NavTab[];
      if (new Set(tabs.map((t) => t.id)).size !== tabs.length) return state;
      const activeId = state.tabs[state.activeTab]?.id;
      const newActive =
        activeId != null ? tabs.findIndex((t) => t.id === activeId) : state.activeTab;
      return {
        tabs,
        activeTab: newActive >= 0 ? newActive : 0
      };
    }
    case "update-entry": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          history: tab.history.map((entry) =>
            entry.kind === "place" && entry.place.filePath === action.filePath
              ? { ...entry, place: action.place }
              : entry
          )
        }))
      };
    }
    case "update-list": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          history: tab.history.map((entry) =>
            entry.kind === "list" && entry.layerId === action.layerId
              ? { ...entry, layer: action.layer }
              : entry
          )
        }))
      };
    }
    case "update-directions": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          history: tab.history.map((entry) =>
            entry.kind === "directions" && entry.id === action.id
              ? { ...entry, stops: action.stops, mode: action.mode }
              : entry
          )
        }))
      };
    }
    case "fill-directions-origin": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          history: tab.history.map((entry) =>
            entry.kind === "directions" && entry.id === action.id && entry.stops[0] == null
              ? { ...entry, stops: [action.waypoint, ...entry.stops.slice(1)] }
              : entry
          )
        }))
      };
    }
    case "bind-directions": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          history: tab.history.map((entry) =>
            entry.kind === "directions" && entry.id === action.id
              ? { ...entry, targetFilePath: action.targetFilePath, label: action.label }
              : entry
          )
        }))
      };
    }
    default:
      return state;
  }
}

export function useNavTabs({
  openEntry,
  onEmpty
}: {
  openEntry: (entry: NavEntry) => void;
  onEmpty: () => void;
}) {
  const [nav, dispatchNav] = useReducer(navReducer, { tabs: [], activeTab: -1 });
  const navRestoredRef = useRef(false);
  const vaultRoot = useVaultRoot();
  const storageKey = vaultRoot ? `${NAV_STORAGE_KEY}:${vaultRoot}` : null;

  // Persist current tab heads to localStorage whenever nav changes
  useEffect(() => {
    if (!storageKey || !navRestoredRef.current) return;
    // Persist each tab's current head. List tabs carry their own layer, so they (and
    // their markers) round-trip too; if nothing is open, clear the key.
    const persistTabs: PersistedTab[] = [];
    for (const tab of nav.tabs) {
      const current = tab.history[tab.cursor];
      if (current.kind === "place")
        persistTabs.push({ kind: "place", filePath: current.place.filePath });
      else if (current.kind === "folder")
        persistTabs.push({ kind: "folder", folderPath: current.folderPath });
      else if (current.kind === "list")
        persistTabs.push({
          kind: "list",
          layerId: current.layerId,
          label: current.label,
          layer: current.layer
        });
      else if (current.kind === "directions")
        persistTabs.push({
          kind: "directions",
          id: current.id,
          label: current.label,
          stops: current.stops,
          mode: current.mode,
          targetFilePath: current.targetFilePath
        });
      // Exhaustive: a new NavEntry variant must fail to compile here rather than fall
      // through a catch-all `else` and be persisted as the wrong kind.
      else {
        const _exhaustive: never = current;
        void _exhaustive;
      }
    }
    if (persistTabs.length === 0) {
      localStorage.removeItem(storageKey);
      return;
    }
    const toSave: PersistedNavState = {
      tabs: persistTabs,
      activeTab: Math.min(nav.activeTab, persistTabs.length - 1)
    };
    localStorage.setItem(storageKey, JSON.stringify(toSave));
  }, [nav, storageKey]);

  // Restore persisted tabs once the vault root resolves (history is not restored, only the current entry)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot restore; openEntry matches initial layout for fit padding
  useEffect(() => {
    if (!storageKey || navRestoredRef.current) return;
    localStorage.removeItem(NAV_STORAGE_KEY);
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
      navRestoredRef.current = true;
      return;
    }
    let parsed: PersistedNavState;
    try {
      parsed = JSON.parse(saved) as PersistedNavState;
    } catch {
      navRestoredRef.current = true;
      return;
    }
    Promise.all(
      parsed.tabs.map(async (tab): Promise<NavTab | null> => {
        if (tab.kind === "folder") {
          return {
            id: crypto.randomUUID(),
            history: [
              { kind: "folder", folderPath: tab.folderPath, label: folderLabel(tab.folderPath) }
            ],
            cursor: 0
          };
        }
        if (tab.kind === "list") {
          return {
            id: crypto.randomUUID(),
            history: [{ kind: "list", layerId: tab.layerId, label: tab.label, layer: tab.layer }],
            cursor: 0
          };
        }
        if (tab.kind === "directions") {
          // Migrate a legacy persisted tab (origin/destination) to the stops array.
          const legacy = tab as typeof tab & {
            origin?: DirectionsWaypoint | null;
            destination?: DirectionsWaypoint | null;
          };
          const stops = Array.isArray(tab.stops)
            ? tab.stops
            : [legacy.origin ?? null, legacy.destination ?? null];
          // The binding is restored verbatim, never validated here: places:get-by-path
          // reads the in-memory Map with no "initial scan complete" gate, so on a large
          // vault it returns null for perfectly good files. Validating would silently
          // unbind, and the next save would create a stray duplicate. The write itself is
          // the real check.
          return {
            id: crypto.randomUUID(),
            history: [
              {
                kind: "directions",
                id: tab.id,
                label: tab.label,
                stops,
                mode: tab.mode,
                targetFilePath: tab.targetFilePath
              }
            ],
            cursor: 0
          };
        }
        const place = await window.api.places.getByPath(tab.filePath);
        if (!place) return null;
        return {
          id: crypto.randomUUID(),
          history: [{ kind: "place", place }],
          cursor: 0
        };
      })
    ).then((results) => {
      const validTabs = results.filter(Boolean) as NavTab[];
      if (validTabs.length > 0) {
        const activeIdx = Math.min(parsed.activeTab, validTabs.length - 1);
        const entry = validTabs[activeIdx].history[validTabs[activeIdx].cursor];
        dispatchNav({
          type: "restore",
          tabs: validTabs,
          activeTab: activeIdx
        });
        openEntry(entry);
      }
      navRestoredRef.current = true;
    });
  }, [storageKey]);

  const handleNavTabActivate = useCallback(
    (index: number) => {
      const tab = nav.tabs[index];
      if (!tab) return;
      dispatchNav({ type: "activate", tabIndex: index });
      openEntry(tab.history[tab.cursor]);
    },
    [nav, openEntry]
  );

  const handleNavTabClose = useCallback(
    (index: number) => {
      const wasActive = index === nav.activeTab;
      const nextState = applyCloseTab(nav, index);
      dispatchNav({ type: "close", tabIndex: index });
      if (wasActive) {
        if (nextState.tabs.length === 0) {
          onEmpty();
        } else {
          const nextTab = nextState.tabs[nextState.activeTab];
          if (nextTab) openEntry(nextTab.history[nextTab.cursor]);
        }
      }
    },
    [nav, onEmpty, openEntry]
  );

  const handleNavBack = useCallback(() => {
    const tab = nav.tabs[nav.activeTab];
    if (!tab || tab.cursor <= 0) return;
    dispatchNav({ type: "back" });
    openEntry(tab.history[tab.cursor - 1]);
  }, [nav, openEntry]);

  const handleNavForward = useCallback(() => {
    const tab = nav.tabs[nav.activeTab];
    if (!tab || tab.cursor >= tab.history.length - 1) return;
    dispatchNav({ type: "forward" });
    openEntry(tab.history[tab.cursor + 1]);
  }, [nav, openEntry]);

  const handleNavTabReorder = useCallback((newOrder: string[]) => {
    dispatchNav({ type: "reorder", newOrder });
  }, []);

  const activeTab = nav.tabs[nav.activeTab];
  // Stable identity across unrelated renders so the memoized NavTabs can bail.
  const navTabsData = useMemo(
    () =>
      nav.tabs.map((tab) => {
        const current = tab.history[tab.cursor];
        if (current?.kind === "place") {
          return {
            id: tab.id,
            title: current.place.title,
            kind: "place" as const,
            filePath: current.place.filePath
          };
        }
        if (current?.kind === "folder") {
          return { id: tab.id, title: current.label, kind: "folder" as const };
        }
        if (current?.kind === "list") {
          return { id: tab.id, title: current.label, kind: "list" as const };
        }
        if (current?.kind === "directions") {
          return { id: tab.id, title: current.label, kind: "directions" as const };
        }
        return { id: tab.id, title: "", kind: "place" as const, filePath: "" };
      }),
    [nav.tabs]
  );

  return {
    nav,
    dispatchNav,
    navTabsData,
    activeTabIndex: nav.activeTab,
    canBack: activeTab ? activeTab.cursor > 0 : false,
    canForward: activeTab ? activeTab.cursor < activeTab.history.length - 1 : false,
    handleNavTabActivate,
    handleNavTabClose,
    handleNavTabReorder,
    handleNavBack,
    handleNavForward
  };
}

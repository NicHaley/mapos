import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { PlaceRecord } from "../components/map-view";
import { useVaultRoot } from "./use-vault-root";

export type NavEntry =
  | { kind: "place"; place: PlaceRecord }
  | { kind: "folder"; folderPath: string; label: string };

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
  | { type: "update-entry"; filePath: string; place: PlaceRecord };

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

type PersistedTab = { kind: "place"; filePath: string } | { kind: "folder"; folderPath: string };
type PersistedNavState = { tabs: PersistedTab[]; activeTab: number };

// Scoped per vault — see useVaultRoot. The bare key predates scoping and is
// removed on restore so stale cross-vault tabs don't linger.
const NAV_STORAGE_KEY = "mapos-nav-tabs";

export function folderLabel(folderPath: string): string {
  return folderPath.split(/[/\\]/).filter(Boolean).pop() ?? folderPath;
}

function entryMatchesPath(entry: NavEntry, path: string, isFolder: boolean): boolean {
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
          const newHistory = tab.history.filter(
            (entry) => !entryMatchesPath(entry, action.path, action.isFolder)
          );
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
    if (nav.tabs.length === 0) {
      localStorage.removeItem(storageKey);
      return;
    }
    const toSave: PersistedNavState = {
      tabs: nav.tabs.map((tab) => {
        const current = tab.history[tab.cursor];
        if (current.kind === "place") return { kind: "place", filePath: current.place.filePath };
        return { kind: "folder", folderPath: current.folderPath };
      }),
      activeTab: nav.activeTab
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

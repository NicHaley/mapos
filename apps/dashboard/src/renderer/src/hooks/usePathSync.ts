import { useCallback } from "react";
import type { PlaceRecord } from "../components/MapView";
import { type NavEntry, type NavState, navReducer, type useNavTabs } from "./useNavTabs";

export function usePathSync({
  nav,
  dispatchNav,
  selectedPlace,
  selectedFolder,
  setSelectedFolder,
  setSelectedPlace,
  openEntry,
  clearPlace,
  onNavEmpty
}: {
  nav: NavState;
  dispatchNav: ReturnType<typeof useNavTabs>["dispatchNav"];
  selectedPlace: PlaceRecord | null;
  selectedFolder: string | null;
  setSelectedFolder: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedPlace: React.Dispatch<React.SetStateAction<PlaceRecord | null>>;
  openEntry: (entry: NavEntry) => void;
  clearPlace: () => void;
  onNavEmpty: () => void;
}): {
  handleRenamePath: (oldPath: string, newPath: string) => void;
  handlePathRelocated: (oldPath: string, newPath: string, isDirectory: boolean) => void;
  handleDeletedPath: (deletedPath: string, type: "file" | "directory") => void;
} {
  const handleRenamePath = useCallback(
    (oldPath: string, newPath: string) => {
      setSelectedFolder((prev) => {
        if (!prev) return prev;
        if (prev === oldPath) return newPath;
        if (prev.startsWith(`${oldPath}/`) || prev.startsWith(`${oldPath}\\`))
          return newPath + prev.slice(oldPath.length);
        return prev;
      });
    },
    [setSelectedFolder]
  );

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
    [dispatchNav, setSelectedFolder, setSelectedPlace]
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
    [selectedPlace, selectedFolder, nav, dispatchNav, setSelectedFolder, setSelectedPlace, openEntry, clearPlace, onNavEmpty]
  );

  return { handleRenamePath, handlePathRelocated, handleDeletedPath };
}

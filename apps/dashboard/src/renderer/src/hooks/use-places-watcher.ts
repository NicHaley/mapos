import { useEffect, useRef } from "react";

/**
 * Routes external place-file deletions (Finder, git, another editor) into the
 * same teardown that in-app deletes use: `handleDeletedPath` prunes open tabs,
 * clears the selection if it matched, and reopens the next surviving entry.
 * Without this, an externally-deleted file vanishes from the map/index but its
 * tab lingers, pointing at a file that no longer exists.
 */
export function usePlacesWatcher({
  handleDeletedPath
}: {
  handleDeletedPath: (deletedPath: string, type: "file" | "directory") => void;
}): void {
  // Keep the latest callback in a ref so the IPC subscription can stay mounted
  // once, rather than re-subscribing on every `handleDeletedPath` identity change.
  const handleDeletedPathRef = useRef(handleDeletedPath);
  handleDeletedPathRef.current = handleDeletedPath;

  useEffect(() => {
    return window.api.places.onUpdated((update) => {
      if (update.event === "unlink") {
        handleDeletedPathRef.current(update.filePath, "file");
      }
    });
  }, []);
}

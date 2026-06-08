import { useEffect, useState } from "react";

export type AppUpdateState =
  | { phase: "idle" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "downloaded"; version: string }
  | { phase: "failed"; version: string; message: string };

/**
 * Tracks the in-flight auto-update flow (download progress + "Restart" prompt).
 * Manual "Check for Updates…" results are surfaced via a native macOS dialog from
 * the main process — not here.
 *
 * Listeners are intentionally light so this can ride along inside an
 * always-mounted component (the map) without owning any UI of its own.
 */
export function useAppUpdate(): AppUpdateState {
  const [state, setState] = useState<AppUpdateState>({ phase: "idle" });

  useEffect(() => {
    const offAvailable = window.api.updater.onAvailable(({ version }) => {
      setState({ phase: "downloading", version, percent: 0 });
    });
    const offProgress = window.api.updater.onProgress(({ percent }) => {
      // Progress can resume from a failed retry — treat `failed` as a downloading source too.
      setState((s) =>
        s.phase === "downloading" || s.phase === "failed"
          ? { phase: "downloading", version: s.version, percent }
          : s
      );
    });
    const offDownloaded = window.api.updater.onDownloaded(({ version }) => {
      setState({ phase: "downloaded", version });
    });
    const offError = window.api.updater.onError(({ message }) => {
      // Surface failures only when an update was in flight (we know the version).
      // Errors in `idle` are background-check noise — stay silent to match the
      // existing UX for auto-checks.
      setState((s) =>
        s.phase === "downloading" || s.phase === "downloaded" || s.phase === "failed"
          ? { phase: "failed", version: s.version, message }
          : s
      );
    });
    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
    };
  }, []);

  return state;
}

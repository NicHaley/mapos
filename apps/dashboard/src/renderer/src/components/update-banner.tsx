import { Button } from "@mapos/ui/components/button";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

type UpdateState =
  | { phase: "idle" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "downloaded"; version: string }
  | { phase: "failed"; version: string; message: string };

/**
 * Persistent in-app banner for the in-flight auto-update flow (download
 * progress + "Restart" prompt). Manual "Check for Updates…" results are
 * surfaced via a native macOS dialog from the main process — not here.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });

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

  if (state.phase === "idle") return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="pointer-events-auto absolute top-2 right-2 z-40 flex items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar/95 px-3 py-2 text-sm shadow-lg backdrop-blur-md"
    >
      {state.phase === "downloading" ? (
        <span className="text-muted-foreground">
          Downloading update… {Math.round(state.percent)}%
        </span>
      ) : state.phase === "downloaded" ? (
        <>
          <span className="text-foreground">Update {state.version} ready</span>
          <Button size="sm" onClick={() => void window.api.updater.install()}>
            Restart
          </Button>
        </>
      ) : (
        <>
          <span
            className="max-w-[40ch] truncate text-destructive"
            title={state.message || undefined}
          >
            Update {state.version} failed
          </span>
          <Button size="sm" onClick={() => void window.api.updater.retry()}>
            Retry
          </Button>
        </>
      )}
    </motion.div>
  );
}

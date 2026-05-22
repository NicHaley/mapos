import { Button } from "@mapos/ui/components/button";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "check-failed"; message: string }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "downloaded"; version: string };

// Auto-dismiss transient toasts (manual-check feedback) after this delay.
const TRANSIENT_DISMISS_MS = 4000;

/** Top-right toast for update lifecycle: manual check feedback + download/install. */
export function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });

  useEffect(() => {
    const offAvailable = window.api.updater.onAvailable(({ version }) => {
      setState({ phase: "downloading", version, percent: 0 });
    });
    const offProgress = window.api.updater.onProgress(({ percent }) => {
      setState((s) =>
        s.phase === "downloading" || s.phase === "available"
          ? { phase: "downloading", version: "version" in s ? s.version : "", percent }
          : s
      );
    });
    const offDownloaded = window.api.updater.onDownloaded(({ version }) => {
      setState({ phase: "downloaded", version });
    });
    const offError = window.api.updater.onError(({ message }) => {
      // Background auto-check errors are silent (expected during dev / offline).
      // Manual-check errors come via onManualResult. But if a download was in
      // progress, surface the failure so the user isn't left with a stuck bar.
      setState((s) =>
        s.phase === "downloading" || s.phase === "downloaded"
          ? { phase: "check-failed", message }
          : s
      );
    });
    const offManual = window.api.updater.onManualResult((data) => {
      if (data.status === "checking") setState({ phase: "checking" });
      else if (data.status === "up-to-date") setState({ phase: "up-to-date" });
      else setState({ phase: "check-failed", message: data.message });
    });
    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
      offManual();
    };
  }, []);

  // Auto-dismiss transient toasts. "downloading" / "downloaded" persist until
  // the user acts on them.
  useEffect(() => {
    if (state.phase !== "up-to-date" && state.phase !== "check-failed") return;
    const id = setTimeout(() => setState({ phase: "idle" }), TRANSIENT_DISMISS_MS);
    return () => clearTimeout(id);
  }, [state.phase]);

  if (state.phase === "idle" || state.phase === "available") return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="pointer-events-auto absolute top-2 right-2 z-40 flex items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar/95 px-3 py-2 text-sm shadow-lg backdrop-blur-md"
    >
      {state.phase === "checking" ? (
        <span className="text-muted-foreground">Checking for updates…</span>
      ) : state.phase === "up-to-date" ? (
        <span className="text-muted-foreground">You're up to date.</span>
      ) : state.phase === "check-failed" ? (
        <span className="text-muted-foreground">Update check failed: {state.message}</span>
      ) : state.phase === "downloading" ? (
        <span className="text-muted-foreground">
          Downloading update… {Math.round(state.percent)}%
        </span>
      ) : (
        <>
          <span className="text-foreground">Update {state.version} ready</span>
          <Button size="sm" onClick={() => void window.api.updater.install()}>
            Restart
          </Button>
        </>
      )}
    </motion.div>
  );
}

import { Button } from "@mapos/ui/components/button";
import { CircularProgress } from "@mapos/ui/components/circular-progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { useDebouncedCallback } from "@renderer/hooks/use-debounced-callback";
import { formatBytes } from "@renderer/lib/format";
import { type Bbox, bboxArea, bboxContains } from "@renderer/lib/region-coverage";
import { DownloadIcon, GlobeIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useMap } from "react-map-gl/maplibre";
import type { InstalledRegionPack } from "../../../shared/types";
import { type AppUpdateState, useAppUpdate } from "../../hooks/use-app-update";
import { type RegionRow, useRegionPacks } from "../../hooks/use-region-packs";

// Below this zoom the map shows roughly a continent or more, where "is this area
// downloaded" isn't a meaningful question — hide the indicator entirely.
const MIN_ZOOM = 4;

function stop(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

type Coverage =
  | { kind: "covered"; name: string; pack: InstalledRegionPack }
  | { kind: "available" | "error"; row: RegionRow }
  | { kind: "downloading"; row: RegionRow };

/**
 * Subtle pill, top-right of the map, that reflects whether the area in view is available
 * offline. Lives as a child of <MapGL> so it can read the live viewport via useMap(); it
 * holds the center/zoom in its own state so panning never re-renders the parent MapView.
 */
export function RegionCoverageIndicator(): React.JSX.Element | null {
  const maps = useMap();
  const mapRef = maps.current;
  const packs = useRegionPacks(true);
  const update = useAppUpdate();
  const [dismissedUpdateKey, setDismissedUpdateKey] = useState<string | null>(null);
  const [view, setView] = useState<{ lng: number; lat: number; zoom: number } | null>(null);

  const sync = useDebouncedCallback(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    const c = map.getCenter();
    setView({ lng: c.lng, lat: c.lat, zoom: map.getZoom() });
  }, 150);

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    sync(); // seed for the initial viewport
    map.on("moveend", sync);
    return () => {
      map.off("moveend", sync);
      sync.cancel();
    };
  }, [mapRef, sync]);

  const coverage = useMemo<Coverage | null>(() => {
    if (!view || view.zoom < MIN_ZOOM) return null;
    const { lng, lat } = view;

    // Downloaded? — read installed packs directly so this works offline (no manifest needed).
    // Smallest box = the most specific pack covering this spot.
    const installedHere = packs.installedPacks
      .filter((p) => p.bbox && bboxContains(p.bbox, lng, lat))
      .sort((a, b) => bboxArea(a.bbox as Bbox) - bboxArea(b.bbox as Bbox));
    if (installedHere.length > 0) {
      const pack = installedHere[0];
      // Prefer the manifest's display name; offline, fall back to the name recorded
      // in the pack at install time. The raw slug only surfaces for packs installed
      // before names were recorded, when the manifest is also unreachable.
      const name =
        packs.regions.find((r) => r.slug === pack.region)?.name ?? pack.name ?? pack.region;
      return { kind: "covered", name, pack };
    }

    // Otherwise, is a not-yet-downloaded region available here?
    const candidates = packs.regions.filter(
      (r) =>
        r.bbox &&
        bboxContains(r.bbox, lng, lat) &&
        (r.status === "available" ||
          r.status === "error" ||
          r.status === "downloading" ||
          r.status === "verifying")
    );
    if (candidates.length === 0) return null;

    const active = candidates.find((r) => r.status === "downloading" || r.status === "verifying");
    if (active) return { kind: "downloading", row: active };

    // Smallest box = the most specific region covering this spot.
    const target = candidates
      .slice()
      .sort((a, b) => bboxArea(a.bbox as Bbox) - bboxArea(b.bbox as Bbox))[0];
    return { kind: target.status === "error" ? "error" : "available", row: target };
  }, [view, packs.installedPacks, packs.regions]);

  // A new app version, once available, is dismissable: the user may not be ready to
  // restart. We key the dismissal to the current phase/version so a later transition
  // (e.g. download finishes → "ready") surfaces a fresh pill rather than staying hidden.
  const updateKey =
    update.phase === "idle" ? null : `${update.phase}:${"version" in update ? update.version : ""}`;
  const showUpdate = updateKey !== null && updateKey !== dismissedUpdateKey;

  // One slot, top-right. The app-update notification takes priority over region
  // coverage so the two pills never overlap — the region pill is hidden whenever
  // an update notification is showing.
  let slotKey: string | null = null;
  let slotContent: React.JSX.Element | null = null;
  if (showUpdate && update.phase !== "idle") {
    slotKey = `update:${update.phase}`;
    slotContent = (
      <UpdatePill update={update} onClear={() => setDismissedUpdateKey(updateKey)} />
    );
  } else if (coverage) {
    slotKey = `coverage:${coverage.kind}`;
    slotContent =
      coverage.kind === "covered" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/80 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur">
                <GlobeIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="max-w-40 truncate">{coverage.name}</span>
                <span className="shrink-0">• {formatBytes(coverage.pack.totalBytes)}</span>
              </div>
            }
          />
          <TooltipContent side="bottom">Saved on your device for offline use</TooltipContent>
        </Tooltip>
      ) : coverage.kind === "downloading" ? (
        <DownloadingPill row={coverage.row} onCancel={() => packs.cancel(coverage.row.slug)} />
      ) : coverage.kind === "error" ? (
        <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border bg-background/80 pl-3 pr-1 text-xs shadow-sm backdrop-blur">
          <span className="max-w-40 truncate text-destructive">
            Couldn’t download {coverage.row.name}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 rounded-full px-2"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              packs.download(coverage.row.slug);
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border bg-background/80 pl-3 pr-1 text-xs shadow-sm backdrop-blur">
          <span className="max-w-40 truncate text-muted-foreground">{coverage.row.name}</span>
          {/* Size lives in the button (shrink-0), so a long region name truncates
              without ever pushing the download size out of view. */}
          <Button
            size="sm"
            className="h-6 shrink-0 rounded-full px-2.5"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              packs.download(coverage.row.slug);
            }}
          >
            <DownloadIcon className="size-3.5" />
            {formatBytes(coverage.row.latestBytes)}
          </Button>
        </div>
      );
  }

  // top-12 (48px) clears the app's top bar (TOP_BAR_HEIGHT = 2.5 * BASE_UNITS ≈ 40px).
  // AnimatePresence (mode="wait") fades the pill in/out and crossfades between states;
  // keying on the slot kind means progress updates within a state don't re-trigger it.
  return (
    <div className="pointer-events-none absolute right-2 top-12 z-10">
      <AnimatePresence mode="wait">
        {slotContent && (
          <motion.div
            key={slotKey}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {slotContent}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * App-update notification, styled to match the region pills and sharing their slot.
 * Carries a dismiss ("clear") affordance for when the user isn't ready to restart.
 */
function UpdatePill({
  update,
  onClear
}: {
  update: Exclude<AppUpdateState, { phase: "idle" }>;
  onClear: () => void;
}): React.JSX.Element {
  const clearButton = (
    <Button
      size="icon-sm"
      variant="ghost"
      className="size-5"
      aria-label="Dismiss update"
      onPointerDown={stop}
      onClick={(e) => {
        stop(e);
        onClear();
      }}
    >
      <XIcon className="size-3.5" />
    </Button>
  );

  if (update.phase === "downloading") {
    return (
      <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border bg-background/80 pl-2.5 pr-1 text-xs shadow-sm backdrop-blur">
        <CircularProgress percent={Math.round(update.percent)} size={14} className="text-sky-500" />
        <span className="max-w-40 truncate text-muted-foreground">Downloading update…</span>
        {clearButton}
      </div>
    );
  }

  if (update.phase === "downloaded") {
    return (
      <div className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/80 pl-3 pr-1 text-xs shadow-sm backdrop-blur">
        <span className="max-w-40 truncate text-foreground">Update {update.version} ready</span>
        <Button
          size="sm"
          className="h-6 rounded-full px-2.5"
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            void window.api.updater.install();
          }}
        >
          Restart
        </Button>
        {clearButton}
      </div>
    );
  }

  return (
    <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border bg-background/80 pl-3 pr-1 text-xs shadow-sm backdrop-blur">
      <span
        className="max-w-40 truncate text-destructive"
        title={update.message || undefined}
      >
        Update {update.version} failed
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 rounded-full px-2"
        onPointerDown={stop}
        onClick={(e) => {
          stop(e);
          void window.api.updater.retry();
        }}
      >
        Retry
      </Button>
      {clearButton}
    </div>
  );
}

function DownloadingPill({
  row,
  onCancel
}: {
  row: RegionRow;
  onCancel: () => void;
}): React.JSX.Element {
  const percent =
    row.progress && row.progress.total > 0
      ? Math.min(100, Math.round((row.progress.received / row.progress.total) * 100))
      : 0;
  return (
    <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border bg-background/80 pl-2.5 pr-1 text-xs shadow-sm backdrop-blur">
      <CircularProgress percent={percent} size={14} className="text-amber-500" />
      <span className="max-w-40 truncate text-muted-foreground">
        {row.status === "verifying" ? "Verifying" : "Downloading"} {row.name}…
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-5"
        aria-label="Cancel download"
        onPointerDown={stop}
        onClick={(e) => {
          stop(e);
          onCancel();
        }}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

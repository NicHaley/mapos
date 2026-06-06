import { Button } from "@mapos/ui/components/button";
import { CircularProgress } from "@mapos/ui/components/circular-progress";
import { Input } from "@mapos/ui/components/input";
import { Spinner } from "@mapos/ui/components/spinner";
import { cn } from "@mapos/ui/lib/utils";
import {
  DownloadIcon,
  GlobeIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDarkMode } from "../../hooks/use-dark-mode";
import { type RegionRow, type RegionStatus, useRegionPacks } from "../../hooks/use-region-packs";
import { GroupHeader } from "./group-header";
import { type RegionMarker, RegionMap } from "./region-map";

function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const mb = n / 1_000_000;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

// Pin tint by status, so the map mirrors the list at a glance. Not-yet-downloaded
// regions are quiet white dots (zinc in light mode, where white would disappear).
function markerColor(r: RegionRow, dark: boolean): string {
  if (r.status === "error") return "#ef4444";
  if (r.status === "downloading" || r.status === "verifying") return "#f59e0b";
  if (r.status === "installed") return "#10b981";
  if (r.status === "update-available") return "#f59e0b";
  return dark ? "#ffffff" : "#71717a";
}

const isDownloaded = (r: RegionRow): boolean =>
  r.status === "installed" || r.status === "update-available";

// Status-tinted badge — mirrors the Models page's ProviderBadge so the two
// settings pages read as siblings. Color carries the status (emerald =
// downloaded, amber = in progress, red = error, muted = available).
function RegionBadge({ status }: { status: RegionStatus }) {
  const styles =
    status === "installed" || status === "update-available"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : status === "error"
        ? "bg-destructive/15 text-destructive"
        : status === "downloading" || status === "verifying"
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          : "bg-muted text-muted-foreground";
  return (
    <span
      aria-hidden
      className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", styles)}
    >
      <GlobeIcon className="size-4" />
    </span>
  );
}

function RegionRowItem({
  row,
  packs,
  onHover
}: {
  row: RegionRow;
  packs: ReturnType<typeof useRegionPacks>;
  onHover: (id: string | null) => void;
}) {
  const downloading = row.status === "downloading" || row.status === "verifying";
  const percent =
    row.progress && row.progress.total > 0
      ? Math.min(100, Math.round((row.progress.received / row.progress.total) * 100))
      : 0;

  const meta = (() => {
    if (downloading) {
      return row.status === "verifying"
        ? "Verifying…"
        : `${formatBytes(row.progress?.received ?? 0)} / ${formatBytes(row.progress?.total ?? row.latestBytes)}`;
    }
    if (row.status === "error") return row.error ?? "Download failed";
    if (row.status === "installed") return `${formatBytes(row.installed?.totalBytes ?? 0)} on disk`;
    if (row.status === "update-available") return "Update available";
    return formatBytes(row.latestBytes);
  })();

  return (
    <div
      data-region-slug={row.slug}
      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40"
      onMouseEnter={() => onHover(row.slug)}
      onMouseLeave={() => onHover(null)}
    >
      <RegionBadge status={row.status} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{row.name}</span>
        <span
          className={cn(
            "mt-0.5 block truncate text-xs tabular-nums",
            row.status === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {meta}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {row.status === "available" && (
          <Button size="sm" variant="outline" onClick={() => packs.download(row.slug)}>
            <DownloadIcon className="size-3.5" />
            Get
          </Button>
        )}

        {row.status === "update-available" && (
          <Button size="sm" variant="outline" onClick={() => packs.download(row.slug)}>
            <RefreshCwIcon className="size-3.5" />
            Update
          </Button>
        )}

        {row.status === "error" && (
          <Button size="sm" variant="outline" onClick={() => packs.download(row.slug)}>
            Retry
          </Button>
        )}

        {downloading && (
          <>
            <CircularProgress percent={percent} className="text-amber-500" />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Cancel download"
              onClick={() => packs.cancel(row.slug)}
            >
              <XIcon className="size-4" />
            </Button>
          </>
        )}

        {isDownloaded(row) && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${row.name}`}
            onClick={() => void packs.remove(row.slug)}
          >
            <Trash2Icon className="size-4 text-muted-foreground" />
          </Button>
        )}
      </div>
    </div>
  );
}

function RegionList({
  rows,
  packs,
  onHover
}: {
  rows: RegionRow[];
  packs: ReturnType<typeof useRegionPacks>;
  onHover: (id: string | null) => void;
}) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border">
      {rows.map((row) => (
        <RegionRowItem key={row.slug} row={row} packs={packs} onHover={onHover} />
      ))}
    </div>
  );
}

/**
 * Dotted map + searchable, grouped region list — map on top, list below. The single source of
 * truth for both the Settings "Offline" tab and the onboarding Offline step. Downloads run live
 * through the shared `useRegionPacks` hook regardless of where it's mounted.
 */
export function RegionPicker() {
  const packs = useRegionPacks(true);
  const dark = useDarkMode();
  const [focus, setFocus] = useState<string | null>(null);

  // Clicking a map pin scrolls its row into view (no-op if the search filter hides it).
  const listRef = useRef<HTMLDivElement>(null);
  const scrollToRegion = useCallback((slug: string) => {
    listRef.current
      ?.querySelector(`[data-region-slug="${CSS.escape(slug)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const markers = useMemo<RegionMarker[]>(
    () =>
      packs.regions.flatMap((r) =>
        r.center
          ? [
              {
                id: r.slug,
                name: r.name,
                center: r.center,
                color: markerColor(r, dark),
                subtle: r.status === "available"
              }
            ]
          : []
      ),
    [packs.regions, dark]
  );

  // Filter by region name OR its country (group), then split: downloaded regions
  // float to a dedicated section at the top so they stay easy to find no matter how
  // long the list grows; the rest keep their manifest grouping, empty groups dropped.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const groupNameByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of packs.groups) m.set(g.key, g.name);
    return m;
  }, [packs.groups]);

  const matches = useCallback(
    (r: RegionRow): boolean =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      (r.group ? (groupNameByKey.get(r.group)?.toLowerCase().includes(q) ?? false) : false),
    [q, groupNameByKey]
  );

  const downloaded = useMemo(
    () => packs.regions.filter((r) => isDownloaded(r) && matches(r)),
    [packs.regions, matches]
  );
  const availableGroups = useMemo(
    () =>
      packs.groups
        .map((g) => ({ ...g, rows: g.rows.filter((r) => !isDownloaded(r) && matches(r)) }))
        .filter((g) => g.rows.length > 0),
    [packs.groups, matches]
  );
  const nothing = downloaded.length === 0 && availableGroups.length === 0;

  if (packs.error) {
    return (
      <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
        Couldn’t load available regions.
        <br />
        <span className="text-xs">{packs.error}</span>
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={packs.refresh}>
            <RefreshCwIcon className="size-3.5" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (packs.loading && packs.groups.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading regions…
      </div>
    );
  }

  const map = <RegionMap markers={markers} focus={focus} onSelect={scrollToRegion} />;

  const search = (
    <div className="relative shrink-0">
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by region or country…"
        className="pl-8"
      />
    </div>
  );

  const list = (
    // -mr-2/pr-2 parks the scrollbar in the gutter.
    <div ref={listRef} className="-mr-2 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-2">
      {nothing ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {q ? `No regions match “${query}”.` : "No regions available."}
        </p>
      ) : (
        <>
          {downloaded.length > 0 && (
            <section className="flex flex-col gap-2">
              <GroupHeader
                label="Downloaded"
                action={
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatBytes(packs.totalInstalledBytes)} on disk
                  </span>
                }
              />
              <RegionList rows={downloaded} packs={packs} onHover={setFocus} />
            </section>
          )}

          {availableGroups.map((group) => (
            <section key={group.key} className="flex flex-col gap-2">
              <GroupHeader label={group.name} />
              <RegionList rows={group.rows} packs={packs} onHover={setFocus} />
            </section>
          ))}
        </>
      )}
    </div>
  );

  // Map + search stay pinned; only the list below them scrolls.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="w-full shrink-0">{map}</div>
      {search}
      {list}
    </div>
  );
}

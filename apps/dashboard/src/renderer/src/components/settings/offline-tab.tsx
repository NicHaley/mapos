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
import { useCallback, useMemo, useState } from "react";
import { type RegionRow, type RegionStatus, useRegionPacks } from "../../hooks/use-region-packs";
import { GroupHeader } from "./ai/group-header";
import { type GlobeMarker, RegionGlobe } from "./region-globe";

function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const mb = n / 1_000_000;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

// Marker tint (RGB 0–1) by status, so the globe mirrors the list at a glance.
function markerColor(r: RegionRow): [number, number, number] {
  if (r.status === "error") return [0.95, 0.3, 0.3];
  if (r.status === "downloading" || r.status === "verifying") return [0.98, 0.75, 0.14];
  if (r.status === "installed") return [0.13, 0.77, 0.37];
  if (r.status === "update-available") return [0.98, 0.75, 0.14];
  return [0.55, 0.55, 0.62];
}

function markerSize(r: RegionRow): number {
  if (r.status === "installed" || r.status === "update-available") return 0.1;
  if (r.status !== "available") return 0.085;
  return 0.055;
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
  onHover: (center: [number, number] | null) => void;
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
      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40"
      onMouseEnter={() => row.center && onHover(row.center)}
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
  onHover: (center: [number, number] | null) => void;
}) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border">
      {rows.map((row) => (
        <RegionRowItem key={row.slug} row={row} packs={packs} onHover={onHover} />
      ))}
    </div>
  );
}

export function OfflineTab() {
  const packs = useRegionPacks(true);
  const [focus, setFocus] = useState<[number, number] | null>(null);

  const markers = useMemo<GlobeMarker[]>(
    () =>
      packs.regions.flatMap((r) =>
        r.center
          ? [
              {
                id: r.slug,
                // cobe wants [lat, lng]; our center is [lng, lat].
                location: [r.center[1], r.center[0]] as [number, number],
                size: markerSize(r),
                color: markerColor(r)
              }
            ]
          : []
      ),
    [packs.regions]
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

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h2 className="text-base font-medium">Offline regions</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Download a region to use the map, search, and routing without a connection.
        </p>
      </div>

      {packs.error ? (
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
      ) : packs.loading && packs.groups.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading regions…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Globe + search stay pinned; only the list below them scrolls, so
              rows slide up and clip at the search bar's lower edge. The globe
              centers itself (block + margin-inline:auto) within this full-width row. */}
          <div className="w-full shrink-0">
            <RegionGlobe markers={markers} focus={focus} size={200} />
          </div>

          <div className="relative shrink-0">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by region or country…"
              className="pl-8"
            />
          </div>

          {/* Only this region scrolls. -mr-2/pr-2 parks the scrollbar in the gutter. */}
          <div className="-mr-2 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-2">
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
        </div>
      )}
    </div>
  );
}

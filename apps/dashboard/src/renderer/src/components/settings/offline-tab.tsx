import { Button } from "@mapos/ui/components/button";
import { Progress } from "@mapos/ui/components/progress";
import { Spinner } from "@mapos/ui/components/spinner";
import { cn } from "@mapos/ui/lib/utils";
import { CheckIcon, DownloadIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { type RegionRow, useRegionPacks } from "../../hooks/use-region-packs";
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

function StatusDot({ row }: { row: RegionRow }) {
  const cls =
    row.status === "error"
      ? "bg-destructive"
      : row.status === "downloading" || row.status === "verifying"
        ? "bg-amber-500 animate-pulse"
        : row.status === "update-available"
          ? "bg-amber-500"
          : row.status === "installed"
            ? "bg-emerald-500"
            : "bg-muted-foreground/40";
  return <span className={cn("size-2 shrink-0 rounded-full", cls)} />;
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
  const percent =
    row.progress && row.progress.total > 0
      ? Math.min(100, Math.round((row.progress.received / row.progress.total) * 100))
      : 0;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent/50"
      onMouseEnter={() => row.center && onHover(row.center)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flex items-center gap-2.5">
        <StatusDot row={row} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>

        {row.status === "installed" && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-3.5" />
            Downloaded
          </span>
        )}

        {row.status === "available" && (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatBytes(row.latestBytes)}
            </span>
            <Button size="sm" variant="outline" onClick={() => packs.download(row.slug)}>
              <DownloadIcon className="size-3.5" />
              Get
            </Button>
          </>
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

        {(row.status === "downloading" || row.status === "verifying") && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel download"
            onClick={() => packs.cancel(row.slug)}
          >
            <XIcon className="size-4" />
          </Button>
        )}

        {(row.status === "installed" || row.status === "update-available") && (
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

      {(row.status === "downloading" || row.status === "verifying") && (
        <div className="flex items-center gap-2 pl-[18px]">
          <Progress value={percent} className="flex-1" />
          <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {row.status === "verifying"
              ? "Verifying…"
              : `${formatBytes(row.progress?.received ?? 0)} / ${formatBytes(row.progress?.total ?? row.latestBytes)}`}
          </span>
        </div>
      )}

      {row.status === "error" && row.error && (
        <p className="pl-[18px] text-xs text-destructive">{row.error}</p>
      )}
    </div>
  );
}

export function OfflineTab() {
  const packs = useRegionPacks(true);
  const [focus, setFocus] = useState<[number, number] | null>(null);

  const markers = useMemo<GlobeMarker[]>(
    () =>
      packs.regions
        .filter((r) => r.center)
        .map((r) => ({
          id: r.slug,
          // cobe wants [lat, lng]; our center is [lng, lat].
          location: [r.center![1], r.center![0]] as [number, number],
          size: markerSize(r),
          color: markerColor(r)
        })),
    [packs.regions]
  );

  const installedCount = packs.regions.filter(
    (r) => r.status === "installed" || r.status === "update-available"
  ).length;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-medium">Offline regions</h3>
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
      ) : (
        <div className="flex gap-5">
          <div className="sticky top-0 shrink-0 self-start pt-1">
            <RegionGlobe markers={markers} focus={focus} size={200} />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-5">
            {packs.loading && packs.groups.length === 0 ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Loading regions…
              </div>
            ) : (
              packs.groups.map((group) => (
                <div key={group.key} className="flex flex-col gap-0.5">
                  <h4 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.name}
                  </h4>
                  {group.rows.map((row) => (
                    <RegionRowItem key={row.slug} row={row} packs={packs} onHover={setFocus} />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {installedCount > 0 && (
        <div className="mt-1 flex items-center justify-between border-t px-2 pt-3 text-xs text-muted-foreground">
          <span>
            {installedCount} region{installedCount === 1 ? "" : "s"} downloaded
          </span>
          <span className="tabular-nums">{formatBytes(packs.totalInstalledBytes)} on disk</span>
        </div>
      )}
    </div>
  );
}

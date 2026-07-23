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
import { ContinentHeader, GroupHeader } from "./group-header";
import { RegionMap, type RegionMarker } from "./region-map";

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

type LngLat = { lng: number; lat: number };

// Point-in-bbox, mirroring main's installed-regions.ts. bbox is [minLng, minLat, maxLng, maxLat].
function bboxContains(b: [number, number, number, number], lng: number, lat: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

function bboxArea(b: [number, number, number, number]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

const RECOMMENDED_LIMIT = 6;

// A pack whose box spans half the globe or more is an antimeridian artifact: a region
// crossing 180° (Alaska, NZ, Fiji, Russia's Far East…) gets a PMTiles-header bbox that
// wraps to the full -180..180 range, so it "contains" points an ocean away. Useless for
// locating — reject it outright.
function bboxUsable(b: [number, number, number, number]): boolean {
  return b[2] - b[0] < 180;
}

// Coverage for a point: only packs whose box actually contains it — we never suggest a
// far-away pack as "your area". Two guards keep bad bbox data out: antimeridian boxes are
// dropped, and we trust the smallest (most specific) covering box to locate the user, then
// keep only packs on its continent — so a polluted extract box (e.g. an English county
// stretched across the Atlantic) that also "contains" the point is dropped as a
// different-continent match. `toGet` is the not-yet-downloaded matches, smallest box first
// so a subdivision ranks above the whole country; `covered` is true when a covering pack is
// already installed (so we can say "you're set" instead).
function coverageFor(
  regions: RegionRow[],
  point: LngLat
): { toGet: RegionRow[]; covered: boolean } {
  const covering = regions
    .flatMap((r) =>
      r.bbox && bboxUsable(r.bbox) && bboxContains(r.bbox, point.lng, point.lat)
        ? [{ r, area: bboxArea(r.bbox) }]
        : []
    )
    .sort((a, b) => a.area - b.area);
  const anchor = covering[0]?.r.continent;
  const local = anchor ? covering.filter(({ r }) => r.continent === anchor) : covering;
  const toGet = local
    .filter(({ r }) => r.status === "available" || r.status === "error")
    .map(({ r }) => r)
    .slice(0, RECOMMENDED_LIMIT);
  const covered = local.some(({ r }) => isDownloaded(r));
  return { toGet, covered };
}

// Renderer-side geolocation, matching the "My location" map control. Rejects with a
// user-facing message so the picker can explain why no recommendation appeared.
function requestCurrentPosition(): Promise<LngLat> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location access denied"
              : err.code === err.TIMEOUT
                ? "Location timed out"
                : "Location unavailable"
          )
        ),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

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
      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-hover"
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
    <div className="divide-y divide-border overflow-hidden rounded-lg border bg-sidebar-accent/30">
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

  // Recommend the packs covering the user's location. We only try when online (downloads
  // need the network anyway) and once the manifest is loaded; offline, the picker already
  // routes to its "couldn't load regions" state, so nothing extra is shown.
  const [online, setOnline] = useState(() => navigator.onLine);
  const [userPoint, setUserPoint] = useState<LngLat | null>(null);
  const [locError, setLocError] = useState<string | null>(null);
  const [located, setLocated] = useState(false);

  useEffect(() => {
    const on = () => setOnline(true);
    // Reconnecting resets the attempt so a failed/skipped lookup gets one more try.
    const off = () => {
      setOnline(false);
      setLocated(false);
      setLocError(null);
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const manifestReady = !packs.loading && packs.regions.length > 0;
  useEffect(() => {
    if (!online || !manifestReady || located || userPoint) return;
    setLocated(true);
    requestCurrentPosition().then(
      (p) => {
        setUserPoint(p);
        setLocError(null);
      },
      (e: unknown) => setLocError(e instanceof Error ? e.message : String(e))
    );
  }, [online, manifestReady, located, userPoint]);

  const coverage = useMemo(
    () => (userPoint ? coverageFor(packs.regions, userPoint) : null),
    [userPoint, packs.regions]
  );
  const recommended = coverage?.toGet ?? [];
  const recommendedSet = useMemo(
    () => new Set(recommended.map((r) => r.slug)),
    [recommended]
  );

  // Draw attention to the top match: focus its pin (tooltip) and scroll its row in. Cleared
  // as soon as the user hovers any row, so it's a nudge, not a permanent state.
  const topRecommended = recommended[0]?.slug ?? null;
  useEffect(() => {
    if (!topRecommended) return;
    setFocus(topRecommended);
    const id = window.setTimeout(() => scrollToRegion(topRecommended), 0);
    return () => window.clearTimeout(id);
  }, [topRecommended, scrollToRegion]);

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
                subtle: r.status === "available",
                recommended: recommendedSet.has(r.slug)
              }
            ]
          : []
      ),
    [packs.regions, dark, recommendedSet]
  );

  // Downloaded regions float to a dedicated section at the top so they stay easy to
  // find no matter how long the list grows; the rest stay grouped Continent →
  // Country, empty groups dropped. Continents collapse so the ~250-region world list
  // stays scannable.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() => new Set());

  // Country + continent name per group key, so the Downloaded section can be filtered
  // by the same "region / country / continent" search as the tree below it.
  const labelsByGroup = useMemo(() => {
    const m = new Map<string, { group: string; continent: string }>();
    for (const c of packs.continents) {
      for (const g of c.groups) m.set(g.key, { group: g.name, continent: c.name });
    }
    return m;
  }, [packs.continents]);

  const matches = useCallback(
    (r: RegionRow): boolean => {
      if (!q) return true;
      if (r.name.toLowerCase().includes(q)) return true;
      const l = r.group ? labelsByGroup.get(r.group) : undefined;
      return !!l && (l.group.toLowerCase().includes(q) || l.continent.toLowerCase().includes(q));
    },
    [q, labelsByGroup]
  );

  const downloaded = useMemo(
    () => packs.regions.filter((r) => isDownloaded(r) && matches(r)),
    [packs.regions, matches]
  );

  // Continent tree (schema >= 4). A continent or country whose NAME matches the query
  // keeps all its rows; otherwise rows are matched individually. Single-region
  // countries (whole-country packs) collapse into one shared list per continent;
  // subdivided countries (Canada, Germany) keep their own labeled sub-section.
  const continentSections = useMemo(() => {
    return packs.continents
      .map((c) => {
        const cMatch = !q || c.name.toLowerCase().includes(q);
        const visible = c.groups
          .map((g) => {
            const gMatch = cMatch || g.name.toLowerCase().includes(q);
            const rows = g.rows.filter(
              (r) => !isDownloaded(r) && (gMatch || r.name.toLowerCase().includes(q))
            );
            return { key: g.key, name: g.name, rows, solo: g.rows.length === 1 };
          })
          .filter((g) => g.rows.length > 0);
        const soloRows = visible
          .filter((g) => g.solo)
          .flatMap((g) => g.rows)
          .sort((a, b) => a.name.localeCompare(b.name));
        const multiGroups = visible.filter((g) => !g.solo);
        const count = soloRows.length + multiGroups.reduce((n, g) => n + g.rows.length, 0);
        return { key: c.key, name: c.name, soloRows, multiGroups, count };
      })
      .filter((c) => c.count > 0);
  }, [packs.continents, q]);

  // A continent with a download in progress (or a failed one) auto-expands so its
  // progress/retry stays visible; a query expands everything it matched.
  const forced = useMemo(() => {
    const active = (rows: RegionRow[]): boolean =>
      rows.some(
        (r) => r.status === "downloading" || r.status === "verifying" || r.status === "error"
      );
    const s = new Set<string>();
    for (const c of continentSections) {
      if (active(c.soloRows) || c.multiGroups.some((g) => active(g.rows))) s.add(c.key);
    }
    return s;
  }, [continentSections]);

  const isOpen = (key: string): boolean => !!q || forced.has(key) || expandedSet.has(key);
  const toggle = (key: string) =>
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const nothing = downloaded.length === 0 && continentSections.length === 0;

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

  if (packs.loading && packs.continents.length === 0) {
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

  // Location-based recommendation, pinned above everything. Hidden while a search query
  // is active so filtered results stay clean.
  const recommendation =
    !q && online && userPoint && coverage ? (
      recommended.length > 0 ? (
        <section className="flex flex-col gap-2">
          <GroupHeader label="Recommended for your area" />
          <RegionList rows={recommended} packs={packs} onHover={setFocus} />
        </section>
      ) : coverage.covered ? (
        <p className="px-1 text-xs text-muted-foreground">
          You already have offline coverage for your area.
        </p>
      ) : null
    ) : null;

  const locNote = !q && online && !userPoint && locError && (
    <p className="px-1 text-xs text-muted-foreground">
      Couldn’t detect your location — {locError}.
    </p>
  );

  const list = (
    // -mr-2/pr-2 parks the scrollbar in the gutter.
    <div ref={listRef} className="-mr-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-2">
      {recommendation}
      {locNote}
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

          {continentSections.map((cont) => (
            <section key={cont.key} className="flex flex-col gap-2">
              <ContinentHeader
                label={cont.name}
                count={cont.count}
                expanded={isOpen(cont.key)}
                onToggle={() => toggle(cont.key)}
              />
              {isOpen(cont.key) && (
                <div className="flex flex-col gap-3">
                  {cont.soloRows.length > 0 && (
                    <RegionList rows={cont.soloRows} packs={packs} onHover={setFocus} />
                  )}
                  {cont.multiGroups.map((group) => (
                    <section key={group.key} className="flex flex-col gap-1.5">
                      <GroupHeader label={group.name} />
                      <RegionList rows={group.rows} packs={packs} onHover={setFocus} />
                    </section>
                  ))}
                </div>
              )}
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

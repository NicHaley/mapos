import type { Maneuver } from "@mapos/contracts";
import { Button } from "@mapos/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList
} from "@mapos/ui/components/combobox";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { cn } from "@mapos/ui/lib/utils";
import { useMapViewport } from "@renderer/contexts/map-viewport";
import { useDebounce } from "@renderer/hooks/use-debounce";
import type { DirectionsWaypoint, TravelMode } from "@renderer/hooks/use-nav-tabs";
import { type RegionRow, useRegionPacks } from "@renderer/hooks/use-region-packs";
import { formatBytes, formatDistance, formatDuration } from "@renderer/lib/format";
import { type GeocodeSearchResult, searchGeocode } from "@renderer/lib/geocode-search";
import { resolveCoverageAt } from "@renderer/lib/region-coverage";
import type { MapOverlayLayer } from "@shared/types";
import {
  BikeIcon,
  CarIcon,
  CircleDotIcon,
  DownloadIcon,
  FootprintsIcon,
  Loader2Icon,
  LocateFixedIcon,
  MapPinIcon,
  RepeatIcon,
  RouteIcon,
  XIcon
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type DirectionsPanelProps = {
  /** Stable id of the backing directions tab — used to key the route overlay layer. */
  id: string;
  origin: DirectionsWaypoint | null;
  destination: DirectionsWaypoint | null;
  mode: TravelMode;
  /** Persist input/mode changes back to the nav entry. */
  onChange: (next: {
    origin: DirectionsWaypoint | null;
    destination: DirectionsWaypoint | null;
    mode: TravelMode;
  }) => void;
  /** Lift the computed route (as a map overlay layer) up to the app so it draws on the map. */
  onRouteChange: (layer: MapOverlayLayer | null) => void;
  onClose: () => void;
};

const MODES: { mode: TravelMode; label: string; Icon: typeof CarIcon }[] = [
  { mode: "pedestrian", label: "Walk", Icon: FootprintsIcon },
  { mode: "bicycle", label: "Bike", Icon: BikeIcon },
  { mode: "auto", label: "Drive", Icon: CarIcon }
];

const OFFLINE_SIGNATURES = [
  "No downloaded region covers",
  "not available offline",
  "Local Valhalla error"
];
const OFFLINE_MESSAGE =
  "This route isn’t available offline yet. Download a region pack from Settings → Offline.";

/** Strip Electron's IPC-invoke wrapper + error-class prefix so the user sees the reason. */
function cleanErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/, "")
      .replace(/^\w*Error:\s*/, "")
      .trim() || "Couldn’t find a route"
  );
}

function isOfflineRoutingError(msg: string): boolean {
  return OFFLINE_SIGNATURES.some((s) => msg.includes(s));
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Points along the straight segment a→b (endpoints included) so a mid-route coverage gap —
 *  where both endpoints are covered but the middle isn't — is still detected. */
function sampleSegment(
  a: DirectionsWaypoint,
  b: DirectionsWaypoint,
  stepKm = 25,
  cap = 20
): { lng: number; lat: number }[] {
  const pts: { lng: number; lat: number }[] = [{ lng: a.lng, lat: a.lat }];
  const n = Math.min(cap, Math.max(1, Math.ceil(haversineKm(a, b) / stepKm)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    pts.push({ lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t });
  }
  pts.push({ lng: b.lng, lat: b.lat });
  return pts;
}

function buildRouteLayer(
  id: string,
  origin: DirectionsWaypoint,
  destination: DirectionsWaypoint,
  coordinates: [number, number][]
): MapOverlayLayer {
  return {
    id: `directions:${id}`,
    layerName: "Route",
    points: [
      { id: `directions:${id}:a`, lat: origin.lat, lng: origin.lng, title: origin.label },
      {
        id: `directions:${id}:b`,
        lat: destination.lat,
        lng: destination.lng,
        title: destination.label
      }
    ],
    lines: [{ id: `directions:${id}:line`, coordinates, title: "Route" }],
    polygons: []
  };
}

type RouteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; distanceMeters: number; durationSeconds: number; maneuvers: Maneuver[] }
  | { status: "error"; message: string }
  | { status: "needs-region" };

export function DirectionsPanel({
  id,
  origin,
  destination,
  mode,
  onChange,
  onRouteChange,
  onClose
}: DirectionsPanelProps): React.JSX.Element {
  const packs = useRegionPacks(true);
  const [route, setRoute] = useState<RouteState>({ status: "idle" });
  // Bumped to force a re-route (a needed region pack finished downloading). Kept separate
  // from the pack list so the initial pack load doesn't spuriously re-run — and flash — the route.
  const [retryNonce, setRetryNonce] = useState(0);

  // Latest onRouteChange, so the unmount cleanup below never re-fires on identity churn.
  const onRouteChangeRef = useRef(onRouteChange);
  onRouteChangeRef.current = onRouteChange;
  useEffect(() => () => onRouteChangeRef.current(null), []);

  // Auto-retry only when we're actually blocked on a missing region: read the live status via
  // a ref so this fires on pack changes, not on status transitions (which would loop).
  const statusRef = useRef(route.status);
  statusRef.current = route.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: installedPacks is the trigger; status is read via ref to avoid a loop
  useEffect(() => {
    if (statusRef.current === "needs-region") setRetryNonce((n) => n + 1);
  }, [packs.installedPacks]);

  // Compute the route whenever the endpoints or mode change (or a retry is requested).
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is a manual re-route trigger, not read in the body
  useEffect(() => {
    if (!origin || !destination) {
      setRoute({ status: "idle" });
      onRouteChangeRef.current(null);
      return;
    }
    setRoute({ status: "loading" });
    let cancelled = false;
    window.api.services
      .routingDirections({
        locations: [
          { lat: origin.lat, lng: origin.lng },
          { lat: destination.lat, lng: destination.lng }
        ],
        costing: mode
      })
      .then((r) => {
        if (cancelled) return;
        setRoute({
          status: "done",
          distanceMeters: r.distanceMeters,
          durationSeconds: r.durationSeconds,
          maneuvers: r.maneuvers
        });
        onRouteChangeRef.current(
          buildRouteLayer(id, origin, destination, r.geometry.coordinates as [number, number][])
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = cleanErrorMessage(e);
        setRoute(
          isOfflineRoutingError(msg)
            ? { status: "needs-region" }
            : { status: "error", message: msg }
        );
        onRouteChangeRef.current(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, origin, destination, mode, retryNonce]);

  // Which not-yet-downloaded region packs would unblock this route. Recomputed from the
  // live pack state so the download buttons reflect progress and disappear as packs install.
  const coverageGap = useMemo(() => {
    if (route.status !== "needs-region" || !origin || !destination) {
      return { downloadable: [] as RegionRow[], hasUnavailableGap: false };
    }
    const byslug = new Map<string, RegionRow>();
    let hasUnavailableGap = false;
    for (const p of sampleSegment(origin, destination)) {
      const cov = resolveCoverageAt(packs.installedPacks, packs.regions, p.lng, p.lat);
      if (cov.kind === "covered") continue;
      if (cov.kind === "none") hasUnavailableGap = true;
      else byslug.set(cov.row.slug, cov.row);
    }
    return { downloadable: [...byslug.values()], hasUnavailableGap };
  }, [route.status, origin, destination, packs.installedPacks, packs.regions]);

  const setEndpoints = (next: {
    origin?: DirectionsWaypoint | null;
    destination?: DirectionsWaypoint | null;
    mode?: TravelMode;
  }): void => {
    onChange({
      origin: next.origin !== undefined ? next.origin : origin,
      destination: next.destination !== undefined ? next.destination : destination,
      mode: next.mode ?? mode
    });
  };

  return (
    <div
      className={cn(
        surfaceVariants({ variant: "panel" }),
        "relative flex h-full flex-col overflow-hidden rounded-lg shadow-sm ring-1 ring-sidebar-border"
      )}
    >
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-1 p-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <RouteIcon className="size-4 shrink-0 opacity-70" />
          <span className="min-w-0 truncate font-medium text-sidebar-foreground">Directions</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <XIcon />
        </Button>
      </div>

      <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <LocationInput
              value={origin}
              onSelect={(wp) => setEndpoints({ origin: wp })}
              placeholder="Choose starting point"
              icon={<CircleDotIcon className="size-4 shrink-0 opacity-60" />}
              allowCurrentLocation
            />
            <LocationInput
              value={destination}
              onSelect={(wp) => setEndpoints({ destination: wp })}
              placeholder="Choose destination"
              icon={<MapPinIcon className="size-4 shrink-0 opacity-60" />}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Swap origin and destination"
            title="Swap"
            disabled={!origin && !destination}
            onClick={() => setEndpoints({ origin: destination, destination: origin })}
          >
            <RepeatIcon className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          {MODES.map(({ mode: m, label, Icon }) => (
            <button
              key={m}
              type="button"
              onClick={() => setEndpoints({ mode: m })}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                m === mode
                  ? "bg-card text-foreground shadow-sm dark:bg-accent"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-sidebar-border border-t">
        <RouteBody
          state={route}
          coverageGap={coverageGap}
          hasEndpoints={Boolean(origin && destination)}
          onDownload={(slug) => packs.download(slug)}
        />
      </div>
    </div>
  );
}

function RouteBody({
  state,
  coverageGap,
  hasEndpoints,
  onDownload
}: {
  state: RouteState;
  coverageGap: { downloadable: RegionRow[]; hasUnavailableGap: boolean };
  hasEndpoints: boolean;
  onDownload: (slug: string) => void;
}): React.JSX.Element {
  if (!hasEndpoints || state.status === "idle") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-input/30">
          <RouteIcon className="size-5 opacity-70" aria-hidden />
        </div>
        <p className="text-muted-foreground text-sm">
          Choose a starting point and destination to see directions.
        </p>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 px-6 py-10 text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" /> Finding route…
      </div>
    );
  }

  if (state.status === "needs-region") {
    return (
      <div className="flex flex-col gap-3 px-4 py-6">
        {coverageGap.downloadable.length > 0 ? (
          <>
            <p className="text-muted-foreground text-sm">
              Routing here needs{" "}
              {coverageGap.downloadable.length === 1 ? "a map that isn’t" : "maps that aren’t"}{" "}
              downloaded yet.
            </p>
            <div className="flex flex-col gap-2">
              {coverageGap.downloadable.map((row) => {
                const downloading = row.status === "downloading" || row.status === "verifying";
                const percent =
                  row.progress && row.progress.total > 0
                    ? Math.min(100, Math.round((row.progress.received / row.progress.total) * 100))
                    : 0;
                return (
                  <Button
                    key={row.slug}
                    variant="outline"
                    className="h-9 justify-between"
                    disabled={downloading}
                    onClick={() => onDownload(row.slug)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {downloading ? (
                        <Loader2Icon className="size-4 shrink-0 animate-spin" />
                      ) : (
                        <DownloadIcon className="size-4 shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{row.name}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {downloading
                        ? `${row.status === "verifying" ? "Verifying" : `${percent}%`}`
                        : formatBytes(row.latestBytes)}
                    </span>
                  </Button>
                );
              })}
            </div>
            {coverageGap.hasUnavailableGap ? (
              <p className="text-muted-foreground text-xs">
                Part of this route isn’t available as a downloadable map yet.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">{OFFLINE_MESSAGE}</p>
        )}
      </div>
    );
  }

  if (state.status === "error") {
    return <div className="px-4 py-6 text-destructive text-sm">{state.message}</div>;
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-2 px-4 py-3">
        <span className="font-semibold text-lg text-foreground">
          {formatDuration(state.durationSeconds)}
        </span>
        <span className="text-muted-foreground text-sm">
          {formatDistance(state.distanceMeters)}
        </span>
      </div>
      <ol className="flex flex-col">
        {state.maneuvers.map((m, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: maneuvers are a positional, static list
            key={i}
            className="flex items-start gap-3 border-sidebar-border/60 border-t px-4 py-2.5 text-sm"
          >
            <span className="mt-0.5 w-6 shrink-0 text-muted-foreground text-xs tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">{m.instruction}</span>
            {m.distanceMeters > 0 ? (
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                {formatDistance(m.distanceMeters)}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LocationInput({
  value,
  onSelect,
  placeholder,
  icon,
  allowCurrentLocation
}: {
  value: DirectionsWaypoint | null;
  onSelect: (wp: DirectionsWaypoint | null) => void;
  placeholder: string;
  icon: React.ReactNode;
  allowCurrentLocation?: boolean;
}): React.JSX.Element {
  const [query, setQuery] = useState(value?.label ?? "");
  const [results, setResults] = useState<GeocodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const debounced = useDebounce(query, 300);
  const { getViewportBBox } = useMapViewport();

  // Reflect external changes (selection, swap, restore) into the input text.
  useEffect(() => {
    setQuery(value?.label ?? "");
  }, [value?.label]);

  useEffect(() => {
    const q = debounced.trim();
    // Skip when empty or when the text still equals the committed selection.
    if (!q || q === value?.label) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ac = new AbortController();
    const bbox = getViewportBBox() ?? undefined;
    void searchGeocode(q, { signal: ac.signal, bbox, limit: 6 })
      .then((r) => setResults(r.slice(0, 6)))
      .catch((e: unknown) => {
        if (!(e instanceof Error && e.name === "AbortError")) setResults([]);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [debounced, value?.label, getViewportBBox]);

  const useCurrentLocation = (): void => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onSelect({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: "Your location" });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <Combobox<GeocodeSearchResult>
      items={results}
      // Results are already filtered server-side; let every returned item through.
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(r) => r.primaryLabel}
      onValueChange={(r) => {
        if (r) onSelect({ lat: r.lat, lng: r.lng, label: r.primaryLabel });
      }}
    >
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-muted-foreground">
          {icon}
        </span>
        <ComboboxInput placeholder={placeholder} autoComplete="off" className="px-8" />
        <div className="absolute top-1/2 right-1 -translate-y-1/2">
          {locating ? (
            <Loader2Icon className="size-4 shrink-0 animate-spin opacity-60" />
          ) : query ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear"
              onClick={() => {
                setQuery("");
                onSelect(null);
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : allowCurrentLocation ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Use current location"
              title="Use current location"
              onClick={useCurrentLocation}
            >
              <LocateFixedIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {query.trim() && query.trim() !== value?.label ? (
        <ComboboxContent>
          {results.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-sm">
              {loading ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" /> Searching…
                </>
              ) : (
                "No matching places"
              )}
            </div>
          ) : (
            <ComboboxList>
              {results.map((r) => (
                <ComboboxItem key={r.id} value={r} className="items-baseline gap-1.5">
                  <span className="shrink-0 truncate font-medium">{r.primaryLabel}</span>
                  {r.secondaryLabel ? (
                    <span className="min-w-0 truncate text-muted-foreground text-xs">
                      {r.secondaryLabel}
                    </span>
                  ) : null}
                </ComboboxItem>
              ))}
            </ComboboxList>
          )}
        </ComboboxContent>
      ) : null}
    </Combobox>
  );
}

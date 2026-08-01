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
import { useVaultRoot } from "@renderer/hooks/use-vault-root";
import { formatBytes, formatDistance, formatDuration } from "@renderer/lib/format";
import { type GeocodeSearchResult, searchGeocode } from "@renderer/lib/geocode-search";
import { waypointFromPlace } from "@renderer/lib/place-waypoint";
import {
  type Bbox,
  bboxArea,
  bboxContains,
  bboxUsable,
  rejectForeignContinents
} from "@renderer/lib/region-coverage";
import { type RouteFrontmatter, routeIsDirty } from "@shared/route";
import { DIRECTIONS_OVERLAY_PREFIX, type MapOverlayLayer, type PlaceRecord } from "@shared/types";
import {
  ArrowUpDownIcon,
  BikeIcon,
  CarIcon,
  CircleDotIcon,
  CircleIcon,
  DownloadIcon,
  FileTextIcon,
  FootprintsIcon,
  GripVerticalIcon,
  Loader2Icon,
  LocateFixedIcon,
  MapPinIcon,
  PlusIcon,
  RouteIcon,
  XIcon
} from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type DirectionsPanelProps = {
  /** Stable id of the backing directions tab — used to key the route overlay layer. */
  id: string;
  /** Ordered stops: stops[0] = origin, last = destination, any in between are waypoints.
   *  A null entry is a blank input. Always at least two entries. */
  stops: (DirectionsWaypoint | null)[];
  mode: TravelMode;
  /** Indexed vault places, offered alongside geocode results in the location inputs. */
  files?: PlaceRecord[];
  /** Persist stop/mode changes back to the nav entry. */
  onChange: (next: { stops: (DirectionsWaypoint | null)[]; mode: TravelMode }) => void;
  /** Lift the computed route (as a map overlay layer) up to the app so it draws on the map. */
  onRouteChange: (layer: MapOverlayLayer | null) => void;
  /** Emphasize a step's segment on the map (and, when `focus`, ease the camera to it). Null clears. */
  onHighlightSegment: (coordinates: [number, number][] | null, focus: boolean) => void;
  /** The vault file this route saves into; null when unbound (saving creates a new place). */
  targetFilePath?: string | null;
  /** Title of the bound file. Null once the index has loaded means the file is gone. */
  targetTitle?: string | null;
  /** Whether the places index has finished loading, so a null `targetTitle` can be trusted. */
  indexLoaded?: boolean;
  /** The route already stored in the bound file — drives the save copy and the dirty state. */
  savedRoute?: RouteFrontmatter | null;
  /** Persist the route. The panel supplies the shape it is displaying; the app owns the
   *  file writes and what happens to the tab afterwards. */
  onSaveRoute?: (payload: {
    stops: DirectionsWaypoint[];
    mode: TravelMode;
    coordinates: [number, number][];
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Which stop a map click should fill, or null when the map should select normally. */
  onArmedStopChange?: (index: number | null) => void;
  onClose: () => void;
};

const MODES: { mode: TravelMode; label: string; Icon: typeof CarIcon }[] = [
  { mode: "pedestrian", label: "Walk", Icon: FootprintsIcon },
  { mode: "bicycle", label: "Bike", Icon: BikeIcon },
  { mode: "auto", label: "Drive", Icon: CarIcon }
];

// Only a genuine coverage gap ("no pack covers this") should offer a download. A Valhalla
// failure — route over the distance limit, no path between stops — is NOT a missing map, so
// it must fall through to a plain error with its real reason rather than a bogus download prompt.
const OFFLINE_SIGNATURES = ["No downloaded region covers", "not available offline"];

/** Strip Electron's IPC-invoke wrapper + error-class prefixes so the user sees the reason. */
function cleanErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/, "")
      .replace(/^\w*Error:\s*/, "")
      .replace(/^Local Valhalla error:\s*/, "")
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
  stops: DirectionsWaypoint[],
  coordinates: [number, number][]
): MapOverlayLayer {
  return {
    id: `${DIRECTIONS_OVERLAY_PREFIX}${id}`,
    layerName: "Route",
    points: stops.map((s, i) => ({
      id: `${DIRECTIONS_OVERLAY_PREFIX}${id}:stop-${i}`,
      lat: s.lat,
      lng: s.lng,
      title: s.label
    })),
    lines: [{ id: `${DIRECTIONS_OVERLAY_PREFIX}${id}:line`, coordinates, title: "Route" }],
    polygons: []
  };
}

type RouteState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "done";
      /**
       * The `${stopsKey}|${mode}` this shape was computed for. The routing effect flips to
       * `loading` in an effect — i.e. after commit — so there is a window where the stops
       * prop is already new while these coordinates are still the previous route's. Saving
       * in that window would write a LINESTRING that disagrees with its own `route.stops`,
       * and both halves would look plausible forever. Save is gated on this matching.
       */
      key: string;
      distanceMeters: number;
      durationSeconds: number;
      maneuvers: Maneuver[];
      /** Full route shape; maneuvers' shape indices point into this array. */
      coordinates: [number, number][];
    }
  | { status: "error"; message: string }
  | { status: "needs-region" };

/** Whether a missing-region route can be unblocked by one download, or is inherently
 *  cross-region (no single pack covers the whole trip — see the one-graph note above). */
type CoverageGap =
  | { kind: "idle" }
  | { kind: "download"; region: RegionRow }
  | { kind: "cross-region" };

export function DirectionsPanel({
  id,
  stops,
  mode,
  files,
  onChange,
  onRouteChange,
  onHighlightSegment,
  targetFilePath = null,
  targetTitle = null,
  indexLoaded = true,
  savedRoute = null,
  onSaveRoute,
  onArmedStopChange,
  onClose
}: DirectionsPanelProps): React.JSX.Element {
  const packs = useRegionPacks(true);
  // The resolved (non-null) stops in order — what actually gets routed. A stable key over
  // their coordinates drives the routing/coverage effects without depending on array identity.
  const routableStops = useMemo(
    () => stops.filter((s): s is DirectionsWaypoint => s != null),
    [stops]
  );
  const stopsKey = routableStops.map((s) => `${s.lat},${s.lng}`).join("|");
  const [route, setRoute] = useState<RouteState>({ status: "idle" });
  // Bumped to force a re-route (a needed region pack finished downloading). Kept separate
  // from the pack list so the initial pack load doesn't spuriously re-run — and flash — the route.
  const [retryNonce, setRetryNonce] = useState(0);

  // Latest onRouteChange, so the unmount cleanup below never re-fires on identity churn.
  const onRouteChangeRef = useRef(onRouteChange);
  onRouteChangeRef.current = onRouteChange;
  useEffect(() => () => onRouteChangeRef.current(null), []);

  const onHighlightRef = useRef(onHighlightSegment);
  onHighlightRef.current = onHighlightSegment;
  useEffect(() => () => onHighlightRef.current(null, false), []);

  // The step under the cursor. Drives the map highlight below; nothing sticks after the cursor
  // leaves (clicking only eases the camera — see handleStepClick).
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);
  const activeStep = hoveredStep;

  // The slice of the route shape a step covers (its begin→end shape indices), or null when the
  // route isn't ready or the step carries no geometry. Clamped to valid bounds defensively.
  const segmentFor = useCallback(
    (i: number): [number, number][] | null => {
      if (route.status !== "done") return null;
      const m = route.maneuvers[i];
      const coords = route.coordinates;
      if (!m || m.beginShapeIndex === undefined || coords.length === 0) return null;
      const last = coords.length - 1;
      const begin = Math.max(0, Math.min(m.beginShapeIndex, last));
      const end = Math.max(begin, Math.min(m.endShapeIndex ?? m.beginShapeIndex, last));
      return coords.slice(begin, end + 1);
    },
    [route]
  );

  // A route recompute (new stops/mode/retry) makes prior step indices stale — drop the hover.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the route trigger, not setter identity
  useEffect(() => {
    setHoveredStep(null);
  }, [stopsKey, mode, retryNonce]);

  // Draw the hovered step's segment on the map — highlight only, never move the camera (hovering
  // down the list shouldn't pan). Clicking a step eases to it (see handleStepClick).
  useEffect(() => {
    onHighlightRef.current(activeStep === null ? null : segmentFor(activeStep), false);
  }, [activeStep, segmentFor]);

  // Click just eases the camera to frame the step's segment — nothing is pinned or remembered.
  const handleStepClick = useCallback(
    (i: number) => {
      const seg = segmentFor(i);
      if (seg) onHighlightRef.current(seg, true);
    },
    [segmentFor]
  );

  // Auto-retry only when we're actually blocked on a missing region: read the live status via
  // a ref so this fires on pack changes, not on status transitions (which would loop).
  const statusRef = useRef(route.status);
  statusRef.current = route.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: installedPacks is the trigger; status is read via ref to avoid a loop
  useEffect(() => {
    if (statusRef.current === "needs-region") setRetryNonce((n) => n + 1);
  }, [packs.installedPacks]);

  // Compute the route whenever the stops or mode change (or a retry is requested). `stopsKey`
  // is the coordinate-derived trigger; `routableStops` is read fresh from the same render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stopsKey stands in for routableStops; retryNonce is a manual re-route trigger
  useEffect(() => {
    if (routableStops.length < 2) {
      setRoute({ status: "idle" });
      onRouteChangeRef.current(null);
      return;
    }
    setRoute({ status: "loading" });
    let cancelled = false;
    window.api.services
      .routingDirections({
        locations: routableStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        costing: mode
      })
      .then((r) => {
        if (cancelled) return;
        setRoute({
          status: "done",
          key: `${stopsKey}|${mode}`,
          distanceMeters: r.distanceMeters,
          durationSeconds: r.durationSeconds,
          maneuvers: r.maneuvers,
          coordinates: r.geometry.coordinates as [number, number][]
        });
        onRouteChangeRef.current(
          buildRouteLayer(id, routableStops, r.geometry.coordinates as [number, number][])
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
  }, [id, stopsKey, mode, retryNonce]);

  // Offline routing runs inside a *single* region's Valhalla graph — separate packs can't be
  // joined (their coarse tiles collide and border roads are clipped). So a download only helps
  // when one downloadable region covers the *entire* route; otherwise the trip is cross-region
  // and can't be routed offline at all. Recomputed live so the offer reflects download progress.
  const coverageGap = useMemo<CoverageGap>(() => {
    if (route.status !== "needs-region" || routableStops.length < 2) {
      return { kind: "idle" };
    }
    const points: { lng: number; lat: number }[] = [];
    for (let i = 0; i < routableStops.length - 1; i++) {
      points.push(...sampleSegment(routableStops[i], routableStops[i + 1]));
    }
    const coversWholeRoute = (r: RegionRow): boolean =>
      !!r.bbox &&
      bboxUsable(r.bbox) &&
      points.every((p) => bboxContains(r.bbox as Bbox, p.lng, p.lat));
    // Every pack (installed or not) whose bbox spans the whole trip, minus cross-continent
    // false-positives (Greenland's box reaches Iceland) via the route centroid.
    const cx = points.reduce((s, p) => s + p.lng, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const covers = rejectForeignContinents(packs.regions.filter(coversWholeRoute), cx, cy);
    // A pack already on disk spans the trip → routing failed for some other reason (not
    // coverage), so don't offer a redundant download.
    if (covers.some((r) => r.status === "installed" || r.status === "update-available")) {
      return { kind: "idle" };
    }
    const single = covers
      .filter(
        (r) =>
          r.status === "available" ||
          r.status === "error" ||
          r.status === "downloading" ||
          r.status === "verifying"
      )
      .sort((a, b) => bboxArea(a.bbox as Bbox) - bboxArea(b.bbox as Bbox))[0];
    return single ? { kind: "download", region: single } : { kind: "cross-region" };
  }, [route.status, routableStops, packs.regions]);

  // Stable per-row identity, aligned positionally with `stops`, so the drag reorder can track
  // rows even when several are null (a bare index/value isn't unique). Mutated in lockstep with
  // `stops` below; only external changes (tab restore, MCP) desync the length, reconciled at render.
  const [rowKeys, setRowKeys] = useState<string[]>(() => stops.map((_, i) => String(i)));
  if (rowKeys.length !== stops.length) {
    setRowKeys(stops.map((_, i) => String(i)));
  }
  const nextKey = (): string => String(Math.max(-1, ...rowKeys.map(Number)) + 1);

  const setStops = (next: (DirectionsWaypoint | null)[], nextMode?: TravelMode): void => {
    onChange({ stops: next, mode: nextMode ?? mode });
  };
  const updateStop = (i: number, wp: DirectionsWaypoint | null): void => {
    setStops(stops.map((s, j) => (j === i ? wp : s)));
  };
  const addStop = (): void => {
    setStops([...stops, null]);
    setRowKeys([...rowKeys, nextKey()]);
  };
  const removeStop = (i: number): void => {
    if (stops.length <= 2) return;
    setStops(stops.filter((_, j) => j !== i));
    setRowKeys(rowKeys.filter((_, j) => j !== i));
  };
  // Drag reorder: motion hands back the reordered keys; remap stops to match, in lockstep.
  const reorderStops = (nextKeys: string[]): void => {
    const stopByKey = new Map(rowKeys.map((k, i) => [k, stops[i]]));
    setRowKeys(nextKeys);
    setStops(nextKeys.map((k) => stopByKey.get(k) ?? null));
  };
  // Swap start ↔ destination — the two-stop shorthand for reordering.
  const swapStops = (): void => {
    setStops([...stops].reverse());
    setRowKeys([...rowKeys].reverse());
  };

  /**
   * The stop a map click will fill: the blank input the user focused most recently.
   *
   * Deliberately sticky across blur — clicking the map canvas blurs the input first, so
   * disarming on blur would make the feature impossible. The effect below is the sole judge
   * of whether an armed stop is really empty; it disarms when the stop has a value, whether
   * because a pick filled it or because the focused input was never blank. Focusing another
   * input re-targets, and unmounting clears.
   */
  const [armedIndex, setArmedIndex] = useState<number | null>(null);
  useEffect(() => {
    if (armedIndex !== null && stops[armedIndex] != null) setArmedIndex(null);
  }, [armedIndex, stops]);
  const onArmedStopChangeRef = useRef(onArmedStopChange);
  onArmedStopChangeRef.current = onArmedStopChange;
  useEffect(() => {
    onArmedStopChangeRef.current?.(armedIndex);
  }, [armedIndex]);
  // Leaving the panel must not leave the map hijacking clicks for a stop that's gone.
  useEffect(() => () => onArmedStopChangeRef.current?.(null), []);
  /**
   * Arm unconditionally and let the effect above decide whether the stop is actually empty.
   *
   * It must not read `stops[i]` here: the clear button dispatches `onSelect(null)` and then
   * focuses the input in the same handler, so this runs a render before the cleared stop is
   * visible in props. Checking emptiness at that moment would see the *old* value and disarm
   * the row the user just emptied. Focusing a genuinely filled stop still disarms — it arms
   * for one commit, then the effect clears it.
   */
  const armStop = (i: number): void => {
    setArmedIndex(i);
  };

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A route that was saved and then edited is stale on disk. Derived rather than stored:
  // it self-heals after an external edit and survives the remount the panel takes on every
  // tab switch. No auto-save — the route recomputes on every stop pick, so writing on each
  // one would spam the watcher and make an experiment impossible to abandon.
  const dirty = routeIsDirty(savedRoute, routableStops, mode);
  // The binding is only actionable once the index has loaded; until then a null title just
  // means the initial scan hasn't reached the file yet, not that it's gone.
  const targetMissing = targetFilePath != null && indexLoaded && targetTitle == null;
  const canSave =
    !!onSaveRoute &&
    !saving &&
    routableStops.length >= 2 &&
    route.status === "done" &&
    route.key === `${stopsKey}|${mode}` &&
    (dirty || targetFilePath == null);

  const handleSave = async (): Promise<void> => {
    if (!onSaveRoute || route.status !== "done" || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await onSaveRoute({
      stops: routableStops,
      mode,
      coordinates: route.coordinates
    });
    // On success the tab navigates away and this panel unmounts, so only the failure
    // path needs to restore the button.
    if (!result.ok) {
      setSaveError(result.error);
      setSaving(false);
    }
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
        <div className="flex flex-col gap-1.5">
          {stops.length === 2 ? (
            // Two stops: nothing to remove (min is 2) and reordering is just a swap, so a single
            // centered swap button replaces the per-row drag handle + remove controls.
            <div className="flex items-center gap-1">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <LocationInput
                  value={stops[0]}
                  onSelect={(wp) => updateStop(0, wp)}
                  placeholder="Choose starting point"
                  icon={<CircleDotIcon className="size-4 shrink-0 opacity-60" />}
                  files={files}
                  allowCurrentLocation
                  armed={armedIndex === 0}
                  onFocus={() => armStop(0)}
                />
                <LocationInput
                  value={stops[1]}
                  onSelect={(wp) => updateStop(1, wp)}
                  placeholder="Choose destination"
                  icon={<MapPinIcon className="size-4 shrink-0 opacity-60" />}
                  files={files}
                  armed={armedIndex === 1}
                  onFocus={() => armStop(1)}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label="Swap start and destination"
                title="Swap"
                onClick={swapStops}
              >
                <ArrowUpDownIcon className="size-4" />
              </Button>
            </div>
          ) : (
            <Reorder.Group
              axis="y"
              values={rowKeys}
              onReorder={reorderStops}
              as="div"
              className="flex flex-col gap-1.5"
            >
              {stops.map((stop, i) => (
                <StopRow
                  key={rowKeys[i]}
                  rowKey={rowKeys[i]}
                  stop={stop}
                  isFirst={i === 0}
                  isLast={i === stops.length - 1}
                  canRemove={stops.length > 2}
                  files={files}
                  armed={armedIndex === i}
                  onFocus={() => armStop(i)}
                  onSelect={(wp) => updateStop(i, wp)}
                  onRemove={() => removeStop(i)}
                />
              ))}
            </Reorder.Group>
          )}
          <Button variant="ghost" size="sm" className="self-start gap-1.5" onClick={addStop}>
            <PlusIcon className="size-4" /> Add stop
          </Button>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          {MODES.map(({ mode: m, label, Icon }) => (
            <button
              key={m}
              type="button"
              onClick={() => setStops(stops, m)}
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
          hasEndpoints={routableStops.length >= 2}
          onDownload={(slug) => packs.download(slug)}
          activeStep={activeStep}
          onStepEnter={setHoveredStep}
          onStepLeave={() => setHoveredStep(null)}
          onStepClick={handleStepClick}
        />
      </div>

      {onSaveRoute && (
        <div className="flex shrink-0 flex-col gap-1.5 border-sidebar-border border-t p-3">
          {saveError ? (
            <p className="text-destructive text-xs">{saveError}</p>
          ) : targetMissing ? (
            <p className="text-muted-foreground text-xs">
              The file this route was saved to is gone. Saving makes a new place.
            </p>
          ) : targetTitle ? (
            <p className="truncate text-muted-foreground text-xs">
              {savedRoute && !dirty ? `Saved to ${targetTitle}` : `Saving to ${targetTitle}`}
            </p>
          ) : null}
          <Button className="h-9" disabled={!canSave} onClick={() => void handleSave()}>
            {saving ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RouteIcon className="size-4" />
            )}
            {saveLabel({ bound: targetFilePath != null && !targetMissing, savedRoute, dirty })}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Copy for the save button. An unbound tab creates a place; a bound one writes into the
 *  file it is tied to, and says so once there is already a route there to replace. */
function saveLabel({
  bound,
  savedRoute,
  dirty
}: {
  bound: boolean;
  savedRoute: RouteFrontmatter | null;
  dirty: boolean;
}): string {
  if (!bound) return "Save as a new place";
  if (!savedRoute) return "Save route";
  return dirty ? "Update route" : "Route saved";
}

/** One reorderable stop row: a drag handle, a full-width location input, and a remove button. */
function StopRow({
  rowKey,
  stop,
  isFirst,
  isLast,
  canRemove,
  files,
  armed,
  onFocus,
  onSelect,
  onRemove
}: {
  rowKey: string;
  stop: DirectionsWaypoint | null;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
  files?: PlaceRecord[];
  armed?: boolean;
  onFocus?: () => void;
  onSelect: (wp: DirectionsWaypoint | null) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const controls = useDragControls();
  const icon = isFirst ? (
    <CircleDotIcon className="size-4 shrink-0 opacity-60" />
  ) : isLast ? (
    <MapPinIcon className="size-4 shrink-0 opacity-60" />
  ) : (
    <CircleIcon className="size-3.5 shrink-0 opacity-40" />
  );
  return (
    <Reorder.Item
      value={rowKey}
      dragListener={false}
      dragControls={controls}
      as="div"
      className="flex items-center gap-1"
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        onPointerDown={(e) => controls.start(e)}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <LocationInput
          value={stop}
          onSelect={onSelect}
          placeholder={
            isFirst ? "Choose starting point" : isLast ? "Choose destination" : "Add stop"
          }
          icon={icon}
          files={files}
          allowCurrentLocation={isFirst}
          armed={armed}
          onFocus={onFocus}
        />
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Remove stop"
        title="Remove stop"
        disabled={!canRemove}
        onClick={onRemove}
      >
        <XIcon className="size-3.5" />
      </Button>
    </Reorder.Item>
  );
}

function RouteBody({
  state,
  coverageGap,
  hasEndpoints,
  onDownload,
  activeStep,
  onStepEnter,
  onStepLeave,
  onStepClick
}: {
  state: RouteState;
  coverageGap: CoverageGap;
  hasEndpoints: boolean;
  onDownload: (slug: string) => void;
  activeStep: number | null;
  onStepEnter: (i: number) => void;
  onStepLeave: (i: number) => void;
  onStepClick: (i: number) => void;
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
    if (coverageGap.kind === "download") {
      const row = coverageGap.region;
      const downloading = row.status === "downloading" || row.status === "verifying";
      const percent =
        row.progress && row.progress.total > 0
          ? Math.min(100, Math.round((row.progress.received / row.progress.total) * 100))
          : 0;
      return (
        <div className="flex flex-col gap-3 px-4 py-6">
          <p className="text-muted-foreground text-sm">
            Routing here needs a map that isn’t downloaded yet.
          </p>
          <Button
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
        </div>
      );
    }
    // Cross-region: no single downloaded pack can cover the whole trip, and offline packs
    // can't be joined — so a download won't help. Nothing to offer yet; state the limit plainly.
    return (
      <div className="flex flex-col gap-2 px-4 py-6">
        <p className="text-muted-foreground text-sm">
          Offline routing works within one downloaded region, and this trip crosses regions that
          can’t be combined yet.
        </p>
        <p className="text-muted-foreground text-xs">
          Try picking stops within the same region for now.
        </p>
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
        {state.maneuvers.map((m, i) => {
          const locatable = m.beginShapeIndex !== undefined;
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: maneuvers are a positional, static list
              key={i}
              className="border-sidebar-border/60 border-t"
            >
              <button
                type="button"
                disabled={!locatable}
                onMouseEnter={() => onStepEnter(i)}
                onMouseLeave={() => onStepLeave(i)}
                onFocus={() => onStepEnter(i)}
                onBlur={() => onStepLeave(i)}
                onClick={() => onStepClick(i)}
                className={cn(
                  "flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm outline-hidden transition-colors",
                  locatable
                    ? "cursor-pointer hover:bg-hover focus-visible:bg-hover"
                    : "cursor-default",
                  activeStep === i && "bg-hover"
                )}
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
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Cap vault-file matches so the dropdown stays scannable. */
const LOCAL_RESULT_LIMIT = 5;

/** A selectable location: a matched vault place (with a derivable point) or a geocode result. */
type LocationOption = {
  key: string;
  kind: "file" | "place";
  label: string;
  secondary?: string;
  waypoint: DirectionsWaypoint;
};

/** Uppercase the first character; secondary labels arrive un-cased from some providers. */
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The file's containing folder, relative to the vault root ("tokyo-2026", not the abs path). */
function fileRelativeDir(filePath: string, vaultRoot: string): string {
  const rel =
    vaultRoot && filePath.startsWith(vaultRoot)
      ? filePath.slice(vaultRoot.length).replace(/^[/\\]/, "")
      : filePath;
  const slash = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
  return slash > 0 ? rel.slice(0, slash) : "";
}

function LocationInput({
  value,
  onSelect,
  placeholder,
  icon,
  files,
  allowCurrentLocation,
  armed,
  onFocus
}: {
  value: DirectionsWaypoint | null;
  onSelect: (wp: DirectionsWaypoint | null) => void;
  placeholder: string;
  icon: React.ReactNode;
  files?: PlaceRecord[];
  allowCurrentLocation?: boolean;
  /** This stop is the one a map click will fill — ringed so the target is unambiguous. */
  armed?: boolean;
  onFocus?: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState(value?.label ?? "");
  const [results, setResults] = useState<GeocodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounce(query, 300);
  const { getViewportBBox } = useMapViewport();
  const vaultRoot = useVaultRoot();

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

  // Vault places matched instantly against the (un-debounced) query. Only places with a
  // derivable point can be a directions endpoint, so geometry-less notes are skipped.
  const needle = query.trim().toLowerCase();
  const fileOptions = useMemo<LocationOption[]>(() => {
    if (!needle || needle === value?.label?.toLowerCase() || !files) return [];
    const out: LocationOption[] = [];
    for (const f of files) {
      if (f.type === "Search") continue;
      if (!f.title.toLowerCase().includes(needle) && !f.filePath.toLowerCase().includes(needle))
        continue;
      const wp = waypointFromPlace(f);
      if (!wp) continue;
      out.push({
        key: `file:${f.filePath}`,
        kind: "file",
        label: f.title,
        secondary: fileRelativeDir(f.filePath, vaultRoot ?? "") || undefined,
        waypoint: wp
      });
      if (out.length >= LOCAL_RESULT_LIMIT) break;
    }
    return out;
  }, [files, needle, value?.label, vaultRoot]);

  const placeOptions = useMemo<LocationOption[]>(
    () =>
      results.map((r) => ({
        key: `place:${r.id}`,
        kind: "place" as const,
        label: r.primaryLabel,
        secondary: r.secondaryLabel ? capitalize(r.secondaryLabel) : undefined,
        waypoint: { lat: r.lat, lng: r.lng, label: r.primaryLabel }
      })),
    [results]
  );

  const options = useMemo(() => [...fileOptions, ...placeOptions], [fileOptions, placeOptions]);

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
    <Combobox<LocationOption>
      items={options}
      // Files are pre-filtered locally, geocode results server-side; let everything through.
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(o) => o.label}
      onValueChange={(o) => {
        if (o) onSelect(o.waypoint);
      }}
    >
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-muted-foreground">
          {icon}
        </span>
        <ComboboxInput
          ref={inputRef}
          placeholder={placeholder}
          autoComplete="off"
          className={cn("px-8", armed && "ring-2 ring-ring")}
          onFocus={onFocus}
        />
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
                // Clearing is a step towards re-picking, so leave the caret where the user
                // will type next — and the focus re-arms the row for a map click.
                inputRef.current?.focus();
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
          {options.length === 0 ? (
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
              {fileOptions.length > 0 ? (
                <>
                  <LocationGroupHeading>Files</LocationGroupHeading>
                  {fileOptions.map(renderLocationItem)}
                </>
              ) : null}
              {placeOptions.length > 0 ? (
                <>
                  <LocationGroupHeading>Places</LocationGroupHeading>
                  {placeOptions.map(renderLocationItem)}
                </>
              ) : null}
            </ComboboxList>
          )}
        </ComboboxContent>
      ) : null}
    </Combobox>
  );
}

/** Group label matching the search popover's CommandGroup heading style. */
function LocationGroupHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">{children}</div>;
}

function renderLocationItem(o: LocationOption): React.JSX.Element {
  return (
    <ComboboxItem key={o.key} value={o}>
      {o.kind === "file" ? (
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
        <span className="max-w-full shrink-0 truncate font-medium leading-tight">{o.label}</span>
        {o.secondary ? (
          <span className="min-w-0 truncate text-muted-foreground text-xs leading-tight">
            {o.secondary}
          </span>
        ) : null}
      </div>
    </ComboboxItem>
  );
}

import { cn } from "@mapos/ui/lib/utils";
import { ChevronDownIcon, MapPinIcon } from "lucide-react";
import { type MouseEvent, useMemo, useState } from "react";
import type {
  MapOverlayLayer,
  OverlayLine,
  OverlayPoint,
  OverlayPolygon,
  PlaceRecord
} from "../../../shared/types";
import { useFeatureResolver } from "../contexts/feature-resolver";

const MAP_OVERLAY_PREFIX = "map-overlay:";

/** Above this many rows the list collapses to a preview with a "Show all" toggle. */
const COLLAPSE_THRESHOLD = 8;

type FeatureEntry =
  | { kind: "vault"; ref: string; path: string }
  | { kind: "overlay"; ref: string; id: string };

function parseRefs(refsAttr: string | undefined): FeatureEntry[] {
  if (!refsAttr) return [];
  return refsAttr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry): FeatureEntry | null => {
      const colon = entry.indexOf(":");
      if (colon < 0) return null;
      const kind = entry.slice(0, colon);
      const id = entry.slice(colon + 1);
      if (kind === "vault") return { kind: "vault", ref: entry, path: id };
      if (kind === "overlay") return { kind: "overlay", ref: entry, id };
      return null;
    })
    .filter((e): e is FeatureEntry => e !== null);
}

type OverlayMatch =
  | { feature: OverlayPoint; kind: "point"; layerId: string }
  | { feature: OverlayLine; kind: "line"; layerId: string }
  | { feature: OverlayPolygon; kind: "polygon"; layerId: string };

/** Scan all accumulated layers for a feature by id (ids are unique across layers). */
function findInLayers(layers: MapOverlayLayer[], id: string): OverlayMatch | null {
  for (const l of layers) {
    const point = l.points.find((p) => p.id === id);
    if (point) return { feature: point, kind: "point", layerId: l.id };
    const line = l.lines.find((ln) => ln.id === id);
    if (line) return { feature: line, kind: "line", layerId: l.id };
    const polygon = l.polygons.find((pg) => pg.id === id);
    if (polygon) return { feature: polygon, kind: "polygon", layerId: l.id };
  }
  return null;
}

function placeFromOverlayMatch(match: OverlayMatch): PlaceRecord {
  const { feature, kind } = match;
  const filePath = `${MAP_OVERLAY_PREFIX}${feature.id}`;
  const title = ("title" in feature ? feature.title : null) || "Overlay feature";
  const previewMarkdown = feature.preview_markdown ?? "";
  // Only point features carry structured details; lines/polygons (routes/areas) don't.
  const properties = "properties" in feature ? feature.properties : undefined;
  const detail = {
    filePath,
    title,
    type: "Preview" as const,
    previewMarkdown,
    ...(properties && Object.keys(properties).length > 0 ? { properties } : {})
  };
  if (kind === "point") {
    return {
      ...detail,
      geometry: JSON.stringify({
        type: "Point",
        coordinates: [(feature as OverlayPoint).lng, (feature as OverlayPoint).lat]
      })
    };
  }
  if (kind === "line") {
    return {
      ...detail,
      geometry: JSON.stringify({
        type: "LineString",
        coordinates: (feature as OverlayLine).coordinates
      })
    };
  }
  return {
    ...detail,
    geometry: JSON.stringify({
      type: "Polygon",
      coordinates: (feature as OverlayPolygon).coordinates
    })
  };
}

/** Vault subtitle = parent folder. Overlay subtitle = address detail (matches the search list). */
function rowSubtitle(entry: FeatureEntry, place: PlaceRecord | null): string | null {
  if (entry.kind === "vault" && place) {
    const slash = place.filePath.lastIndexOf("/");
    if (slash <= 0) return null;
    return place.filePath.slice(0, slash);
  }
  if (entry.kind === "overlay") {
    return place?.properties?.address ?? null;
  }
  return null;
}

function slugTitleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "").replace(/-/g, " ");
}

type Resolved = {
  entry: FeatureEntry;
  place: PlaceRecord | null;
  /** True when the ref can't be resolved at all (deleted vault file or removed layer). */
  stale: boolean;
};

function FeatureRow({ resolved }: { resolved: Resolved }): React.JSX.Element {
  const { selectedFilePath, onOpenFeature, focusFeature } = useFeatureResolver();
  const { entry, place, stale } = resolved;

  const title =
    place?.title ?? (entry.kind === "vault" ? slugTitleFromPath(entry.path) : "Overlay feature");
  const subtitle = rowSubtitle(entry, place);
  const isSelected = !stale && place != null && selectedFilePath === place.filePath;
  // Only overlay rows map to an emphasizable map feature; vault rows just clear focus.
  const focusId = !stale && entry.kind === "overlay" ? entry.id : null;

  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (stale || !place) return;
    onOpenFeature(place);
  }

  return (
    <button
      type="button"
      disabled={stale}
      onClick={handleClick}
      onMouseEnter={() => focusFeature(focusId)}
      onMouseLeave={() => focusFeature(null)}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors",
        "hover:bg-hover",
        isSelected && "bg-sidebar-accent/60",
        stale && "cursor-default opacity-50 hover:bg-transparent"
      )}
      title={
        stale
          ? entry.kind === "overlay"
            ? "No longer on map"
            : "File no longer exists"
          : undefined
      }
    >
      <MapPinIcon
        className={cn(
          "size-3.5 shrink-0",
          entry.kind === "vault" ? "text-foreground/80" : "text-muted-foreground/70"
        )}
      />
      {/* Single line — name never shrinks, the secondary truncates into the space left —
          so it matches the geocode search results list (see geocode-search-panel). */}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="max-w-full shrink-0 truncate text-sm font-medium text-foreground leading-tight">
          {title}
        </span>
        {subtitle && (
          <span className="min-w-0 truncate text-xs leading-tight text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
    </button>
  );
}

export function FeatureList(props: { refs?: string }): React.JSX.Element | null {
  const { getPlace, overlayLayers } = useFeatureResolver();
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(() => parseRefs(props.refs), [props.refs]);

  const resolved = useMemo<Resolved[]>(() => {
    return entries.map((entry) => {
      if (entry.kind === "vault") {
        const place = getPlace(entry.path) ?? null;
        return { entry, place, stale: place == null };
      }
      const match = findInLayers(overlayLayers, entry.id);
      if (match) {
        return { entry, place: placeFromOverlayMatch(match), stale: false };
      }
      return { entry, place: null, stale: true };
    });
  }, [entries, getPlace, overlayLayers]);

  if (resolved.length === 0) return null;

  const hasOverflow = resolved.length > COLLAPSE_THRESHOLD;
  const visible = expanded || !hasOverflow ? resolved : resolved.slice(0, COLLAPSE_THRESHOLD);

  return (
    <div className="not-prose my-2 flex flex-col overflow-hidden rounded-lg border border-sidebar-border/60 divide-y divide-sidebar-border bg-sidebar-accent/30">
      {visible.map((r) => (
        <FeatureRow key={r.entry.ref} resolved={r} />
      ))}
      {hasOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          {expanded ? "Show fewer" : `Show all ${resolved.length}`}
          <ChevronDownIcon
            className={cn("size-3 transition-transform", expanded ? "rotate-180" : "rotate-0")}
          />
        </button>
      )}
    </div>
  );
}

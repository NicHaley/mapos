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
  if (kind === "point") {
    return {
      filePath,
      title,
      type: "Preview",
      geometry: JSON.stringify({
        type: "Point",
        coordinates: [(feature as OverlayPoint).lng, (feature as OverlayPoint).lat]
      }),
      previewMarkdown
    };
  }
  if (kind === "line") {
    return {
      filePath,
      title,
      type: "Preview",
      geometry: JSON.stringify({
        type: "LineString",
        coordinates: (feature as OverlayLine).coordinates
      }),
      previewMarkdown
    };
  }
  return {
    filePath,
    title,
    type: "Preview",
    geometry: JSON.stringify({
      type: "Polygon",
      coordinates: (feature as OverlayPolygon).coordinates
    }),
    previewMarkdown
  };
}

/** Vault subtitle = parent folder. Overlay subtitle = first non-redundant line of preview_markdown. */
function rowSubtitle(entry: FeatureEntry, place: PlaceRecord | null, title: string): string | null {
  if (entry.kind === "vault" && place) {
    const slash = place.filePath.lastIndexOf("/");
    if (slash <= 0) return null;
    return place.filePath.slice(0, slash);
  }
  if (entry.kind === "overlay" && place?.previewMarkdown) {
    const firstLine = place.previewMarkdown
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!firstLine || firstLine === title) return null;
    return firstLine;
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
  /** Overlay layer this row belongs to (null for vault rows or stale refs). */
  layerId: string | null;
  /** True when the ref can't be resolved at all (deleted vault file or removed layer). */
  stale: boolean;
};

function FeatureRow({ resolved }: { resolved: Resolved }): React.JSX.Element {
  const { selectedFilePath, onOpenFeature } = useFeatureResolver();
  const { entry, place, stale } = resolved;

  const title =
    place?.title ?? (entry.kind === "vault" ? slugTitleFromPath(entry.path) : "Overlay feature");
  const subtitle = rowSubtitle(entry, place, title);
  const isSelected = !stale && place != null && selectedFilePath === place.filePath;

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
      className={cn(
        "flex w-full items-start gap-2.5 px-2.5 py-2 text-left transition-colors",
        "hover:bg-sidebar-accent/50",
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
          "size-3.5 shrink-0 mt-0.5",
          entry.kind === "vault" ? "text-foreground/80" : "text-muted-foreground/70"
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle && (
          <span className="truncate text-xs text-muted-foreground font-mono">{subtitle}</span>
        )}
      </div>
    </button>
  );
}

export function FeatureList(props: { refs?: string }): React.JSX.Element | null {
  const { getPlace, overlayLayers, focusLayer } = useFeatureResolver();
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(() => parseRefs(props.refs), [props.refs]);

  const resolved = useMemo<Resolved[]>(() => {
    return entries.map((entry) => {
      if (entry.kind === "vault") {
        const place = getPlace(entry.path) ?? null;
        return { entry, place, layerId: null, stale: place == null };
      }
      const match = findInLayers(overlayLayers, entry.id);
      if (match) {
        return { entry, place: placeFromOverlayMatch(match), layerId: match.layerId, stale: false };
      }
      return { entry, place: null, layerId: null, stale: true };
    });
  }, [entries, getPlace, overlayLayers]);

  // A card maps to one overlay layer; hovering it focuses that layer on the map.
  const cardLayerId = resolved.find((r) => r.layerId != null)?.layerId ?? null;

  if (resolved.length === 0) return null;

  const hasOverflow = resolved.length > COLLAPSE_THRESHOLD;
  const visible = expanded || !hasOverflow ? resolved : resolved.slice(0, COLLAPSE_THRESHOLD);

  return (
    <div
      className="not-prose my-2 flex flex-col overflow-hidden rounded-lg border border-sidebar-border/60 divide-y divide-sidebar-border bg-sidebar-accent/20"
      onMouseEnter={cardLayerId ? () => focusLayer(cardLayerId) : undefined}
      onMouseLeave={cardLayerId ? () => focusLayer(null) : undefined}
    >
      {visible.map((r) => (
        <FeatureRow key={r.entry.ref} resolved={r} />
      ))}
      {hasOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
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

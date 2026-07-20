import { Button } from "@mapos/ui/components/button";
import { Command, CommandGroup, CommandItem, CommandList } from "@mapos/ui/components/command";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { cn } from "@mapos/ui/lib/utils";
import type { MapOverlayLayer } from "@shared/types";
import { FileTextIcon, ListIcon, MapPinIcon, XIcon } from "lucide-react";
import { useMemo } from "react";
import type { PlaceRecord } from "./map-view";

/** One rendered list row, normalized from an overlay point or a resolved vault place. */
export type FeatureListRow = {
  id: string;
  title: string;
  /** Present when the feature has point geometry — enables click-to-focus on the map. */
  lat?: number;
  lng?: number;
  preview?: string;
  category?: string;
  /** True for a feature already saved in the vault (shown with a file icon). */
  isVault: boolean;
};

/** Best-effort [lng, lat] from a PlaceRecord's GeoJSON geometry string, for Points only. */
function pointCoords(place: PlaceRecord): [number, number] | null {
  if (!place.geometry) return null;
  try {
    const geo = JSON.parse(place.geometry) as { type?: string; coordinates?: unknown };
    if (geo.type === "Point" && Array.isArray(geo.coordinates)) {
      const [lng, lat] = geo.coordinates as number[];
      if (typeof lng === "number" && typeof lat === "number") return [lng, lat];
    }
  } catch {
    /* unparseable geometry — row stays non-focusable */
  }
  return null;
}

/** First non-empty line of a preview note, for the row subtitle. */
function firstLine(md: string | undefined): string | undefined {
  if (!md) return undefined;
  return md
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

export type FeaturesListPanelProps = {
  layer: MapOverlayLayer | null;
  placesByPath: Map<string, PlaceRecord>;
  focusedFeatureId: string | null;
  onClose: () => void;
  onFocusFeature: (row: FeatureListRow) => void;
};

/**
 * The working-set list: a browsable, map-linked view of one overlay layer's features
 * (agent `present_features` output, or a user search). Rows focus their marker on click.
 * Mirrors the search panel's row styling and the place card's panel chrome so it reads as
 * a sibling surface. Saving to the vault lands in a later phase.
 */
export function FeaturesListPanel({
  layer,
  placesByPath,
  focusedFeatureId,
  onClose,
  onFocusFeature
}: FeaturesListPanelProps): React.JSX.Element {
  const rows = useMemo<FeatureListRow[]>(() => {
    if (!layer) return [];
    const out: FeatureListRow[] = [];
    for (const p of layer.points) {
      out.push({
        id: p.id,
        title: p.title,
        lat: p.lat,
        lng: p.lng,
        preview: firstLine(p.preview_markdown),
        category: p.properties?.category,
        isVault: false
      });
    }
    for (const path of layer.vaultPaths ?? []) {
      const place = placesByPath.get(path);
      if (!place) continue;
      const coords = pointCoords(place);
      out.push({
        id: `vault:${path}`,
        title: place.title,
        ...(coords ? { lng: coords[0], lat: coords[1] } : {}),
        isVault: true
      });
    }
    return out;
  }, [layer, placesByPath]);

  return (
    <div
      className={cn(
        surfaceVariants({ variant: "panel" }),
        "relative flex h-full flex-col overflow-hidden rounded-lg shadow-sm ring-1 ring-sidebar-border"
      )}
    >
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-1 p-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <ListIcon className="size-4 shrink-0 opacity-70" />
          <span className="min-w-0 truncate font-medium text-sidebar-foreground">
            {layer?.layerName || "Results"}
          </span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs tabular-nums">
            {rows.length}
          </span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <XIcon />
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-input/30">
            <MapPinIcon className="size-5 opacity-70" aria-hidden />
          </div>
          <p className="text-muted-foreground text-sm">No features in this list.</p>
        </div>
      ) : (
        <Command shouldFilter={false} loop className="flex min-h-0 flex-1 flex-col bg-transparent">
          <CommandList className="max-h-none min-h-0 flex-1 p-1">
            <CommandGroup>
              {rows.map((row) => {
                const RowIcon = row.isVault ? FileTextIcon : MapPinIcon;
                return (
                  <CommandItem
                    key={row.id}
                    value={row.id}
                    onSelect={() => onFocusFeature(row)}
                    className={cn("rounded-md", focusedFeatureId === row.id && "bg-accent")}
                  >
                    <RowIcon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col text-left">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span className="max-w-full shrink-0 truncate font-medium leading-tight">
                          {row.title}
                        </span>
                        {row.category ? (
                          <span className="min-w-0 truncate text-muted-foreground text-xs leading-tight capitalize">
                            {row.category.replace(/_/g, " ")}
                          </span>
                        ) : null}
                      </div>
                      {row.preview ? (
                        <span className="mt-0.5 truncate text-muted-foreground text-xs leading-tight">
                          {row.preview}
                        </span>
                      ) : null}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
    </div>
  );
}

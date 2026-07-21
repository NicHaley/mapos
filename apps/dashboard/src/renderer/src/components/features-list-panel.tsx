import { Avatar, AvatarFallback, AvatarImage } from "@mapos/ui/components/avatar";
import { Button } from "@mapos/ui/components/button";
import { Command, CommandGroup, CommandItem, CommandList } from "@mapos/ui/components/command";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import type { MapOverlayLayer } from "@shared/types";
import {
  CheckIcon,
  FileTextIcon,
  Loader2Icon,
  MapPinIcon,
  PlusIcon,
  TextSearchIcon,
  XIcon
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPickerPopover } from "./folder-picker-popover";
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
  /** Street/context line (geocoder secondaryLabel), shown as the row subtitle. */
  address?: string;
  /** Wikidata QID, if known — used to resolve a Wikimedia thumbnail for the row. */
  wikidataId?: string;
  /** True for a feature already saved in the vault (shown with a file icon). */
  isVault: boolean;
};

/** Commons thumbnails come back at 640px; a row thumb only needs ~2× its 36px slot. */
const ROW_THUMB_WIDTH = 96;
const QID_RE = /^Q\d+$/;

/**
 * Leading media slot for a row: a fixed square that shows a Wikimedia thumbnail when the
 * feature has a resolvable `wikidata_id`, and falls back to the feature icon otherwise.
 * The image lookup (a main-process network round-trip, session-cached) is deferred until
 * the row scrolls into view so opening a long list doesn't fan out dozens of calls at once.
 */
function RowThumbnail({
  wikidataId,
  fallbackIcon: FallbackIcon
}: {
  wikidataId?: string;
  fallbackIcon: ComponentType<{ className?: string }>;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    const el = ref.current;
    if (!el || !wikidataId || !QID_RE.test(wikidataId)) return;
    let cancelled = false;
    const resolve = () => {
      void window.api.wiki.imageLookup(wikidataId).then((img) => {
        if (!cancelled && img) setSrc(img.thumbUrl.replace(/width=\d+/, `width=${ROW_THUMB_WIDTH}`));
      });
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [wikidataId]);

  const fallback = (
    <AvatarFallback className="rounded-md bg-muted text-muted-foreground">
      <FallbackIcon className="size-4" />
    </AvatarFallback>
  );

  return (
    <Avatar ref={ref} className="size-9 shrink-0 rounded-md after:rounded-md">
      {src ? <AvatarImage className="rounded-md" src={src} alt="" /> : null}
      {fallback}
    </Avatar>
  );
}

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
  /** Folder highlighted as the default in the save picker. `null` = vault root. */
  defaultParentFolderPath: string | null;
  onClose: () => void;
  onOpenFeature: (row: FeatureListRow) => void;
  /** Save the given overlay-feature ids to `folderPath`; resolves to the ids written. */
  onSaveFeatures: (rowIds: string[], folderPath: string | null) => Promise<string[]>;
};

/**
 * The working-set list: a browsable, map-linked view of one overlay layer's features
 * (agent `present_features` output, or a user search). Rows focus their marker on click.
 * Mirrors the search panel's row styling and the place card's panel chrome so it reads as
 * a sibling surface. Unsaved features can be written to the vault one at a time (the row
 * `+`) or in bulk (the header). State is per-layer — the panel is remounted (keyed on the
 * layer id) whenever the active list changes, so saved/saving marks reset with it.
 */
export function FeaturesListPanel({
  layer,
  placesByPath,
  defaultParentFolderPath,
  onClose,
  onOpenFeature,
  onSaveFeatures
}: FeaturesListPanelProps): React.JSX.Element {
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set());
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const [addAllOpen, setAddAllOpen] = useState(false);

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
        address: p.properties?.address,
        wikidataId: p.properties?.wikidata_id,
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
        category: place.properties?.category,
        address: place.properties?.address,
        isVault: true
      });
    }
    return out;
  }, [layer, placesByPath]);

  /** Rows that can still be written (overlay features not already in the vault). */
  const unsavedIds = useMemo(
    () => rows.filter((r) => !r.isVault && !savedIds.has(r.id)).map((r) => r.id),
    [rows, savedIds]
  );

  const saveIds = useCallback(
    async (ids: string[], folderPath: string | null) => {
      if (ids.length === 0) return;
      setSavingIds((prev) => new Set([...prev, ...ids]));
      const written = await onSaveFeatures(ids, folderPath);
      setSavedIds((prev) => new Set([...prev, ...written]));
      setSavingIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    [onSaveFeatures]
  );

  const anyBusy = savingIds.size > 0;

  return (
    <div
      className={cn(
        surfaceVariants({ variant: "panel" }),
        "relative flex h-full flex-col overflow-hidden rounded-lg shadow-sm ring-1 ring-sidebar-border"
      )}
    >
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-1 p-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <TextSearchIcon className="size-4 shrink-0 opacity-70" />
          <span className="min-w-0 truncate font-medium text-sidebar-foreground">
            {layer?.layerName || "Results"}
          </span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs tabular-nums">
            {rows.length}
          </span>
        </div>
        {unsavedIds.length > 0 && (
          <FolderPickerPopover
            open={addAllOpen}
            onOpenChange={setAddAllOpen}
            defaultParentFolderPath={defaultParentFolderPath}
            title="Save all to folder"
            side="bottom"
            align="end"
            onSelect={(folderPath) => void saveIds(unsavedIds, folderPath)}
            trigger={
              <Button variant="ghost" size="default" disabled={anyBusy}>
                <PlusIcon className="size-4" />
                Save all
              </Button>
            }
          />
        )}
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
          <CommandList className="max-h-none min-h-0 flex-1">
            <CommandGroup>
              {rows.map((row) => {
                const saved = row.isVault || savedIds.has(row.id);
                const saving = savingIds.has(row.id);
                const RowIcon = saved ? FileTextIcon : MapPinIcon;
                return (
                  <CommandItem
                    key={row.id}
                    value={row.id}
                    onSelect={() => onOpenFeature(row)}
                    className="group items-center rounded-md"
                  >
                    <RowThumbnail wikidataId={row.wikidataId} fallbackIcon={RowIcon} />
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
                      {row.address ?? row.preview ? (
                        <span className="mt-0.5 truncate text-muted-foreground text-xs leading-tight">
                          {row.address ?? row.preview}
                        </span>
                      ) : null}
                    </div>
                    {row.isVault ? null : (
                      <span
                        data-slot="command-shortcut"
                        className="ml-auto flex shrink-0 items-center"
                      >
                        {saving ? (
                          <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : saved ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <CheckIcon className="size-4 shrink-0 text-muted-foreground" />
                              }
                            />
                            <TooltipContent side="right">Saved to vault</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                                  aria-label="Save to vault"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void saveIds([row.id], defaultParentFolderPath);
                                  }}
                                >
                                  <PlusIcon className="size-4" />
                                </Button>
                              }
                            />
                            <TooltipContent side="right">Save to vault</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    )}
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

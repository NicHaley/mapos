import { Avatar, AvatarFallback, AvatarImage } from "@mapos/ui/components/avatar";
import { Button } from "@mapos/ui/components/button";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { cn } from "@mapos/ui/lib/utils";
import { isVaultRelativePath, vaultImageUrl } from "@renderer/extensions/vault-image-extension";
import { type FileGlyphKind, placeGlyphKind } from "@renderer/lib/geometry-wkt";
import { type MapOverlayLayer, isServableImageFile } from "@shared/types";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Loader2Icon,
  MapPinIcon,
  PentagonIcon,
  PlusIcon,
  RouteIcon,
  TextSearchIcon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPickerPopover } from "./folder-picker-popover";
import type { PlaceRecord } from "./map-view";
import { VaultFileIcon } from "./vault-file-icon";

/** The geometry a row stands for — drives its icon and how a click frames the map. */
export type FeatureGeometryKind = "point" | "line" | "polygon";

/** One rendered list row, normalized from an overlay point/line/polygon or a vault place. */
export type FeatureListRow = {
  id: string;
  title: string;
  geometryKind: FeatureGeometryKind;
  /** Present when the feature has point geometry — enables click-to-focus on the map. */
  lat?: number;
  lng?: number;
  preview?: string;
  category?: string;
  /** Street/context line (geocoder secondaryLabel), shown as the row subtitle. */
  address?: string;
  /** Wikidata QID, if known — used to resolve a Wikimedia thumbnail for the row. */
  wikidataId?: string;
  /** Vault file path (vault rows only) — used to resolve the file's cover photo. */
  filePath?: string;
  /** The file's own `icon`/`color` (vault rows only). A cover photo still wins over the emoji. */
  icon?: string;
  color?: string;
  /** The file's real shape (vault rows only). `geometryKind` above is always "point" for a vault
   *  row — it drives click-to-focus, not the glyph — so the icon needs its own field. */
  glyphKind?: FileGlyphKind | null;
  /** True for a feature already saved in the vault (shown with a file icon). */
  isVault: boolean;
};

/** Commons thumbnails come back at 640px; a row thumb only needs ~2× its 36px slot. */
const ROW_THUMB_WIDTH = 96;
const QID_RE = /^Q\d+$/;

/**
 * Leading media slot for a row: a fixed square showing the row's photo, falling back to
 * the feature icon. A vault row uses its file's `cover` frontmatter (served over
 * `mapos-vault:`); an overlay row resolves a Wikimedia thumbnail from its `wikidata_id`.
 * Both resolutions (a file read / a main-process network round-trip) are deferred until the
 * row scrolls into view, so opening a long list doesn't fan out dozens of reads at once.
 */
function RowThumbnail({
  wikidataId,
  vaultFilePath,
  fallback: fallbackContent
}: {
  wikidataId?: string;
  vaultFilePath?: string;
  /** Shown until (or unless) a photo resolves. A node rather than a component type because a
   *  vault row's fallback can be an emoji, which is a string, not an icon component. */
  fallback: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    const el = ref.current;
    const qid = wikidataId && QID_RE.test(wikidataId) ? wikidataId : null;
    if (!el || (!vaultFilePath && !qid)) return;
    let cancelled = false;
    const resolve = async () => {
      // Vault row: read the file's cover frontmatter and serve it over mapos-vault:.
      if (vaultFilePath) {
        const file = await window.api.fs.readFile(vaultFilePath);
        if (cancelled || "error" in file) return;
        const cover = file.cover;
        if (cover && isVaultRelativePath(cover) && isServableImageFile(cover)) {
          setSrc(vaultImageUrl(cover));
        }
        return;
      }
      // Overlay row: resolve the Wikidata QID to a (downsized) Commons thumbnail.
      if (qid) {
        const img = await window.api.wiki.imageLookup(qid);
        if (!cancelled && img)
          setSrc(img.thumbUrl.replace(/width=\d+/, `width=${ROW_THUMB_WIDTH}`));
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        void resolve();
      }
    });
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [wikidataId, vaultFilePath]);

  const fallback = (
    <AvatarFallback className="rounded-md bg-muted text-muted-foreground">
      {fallbackContent}
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
  /** Copy the given overlay features into `folderPath` (repeatable). */
  onSaveFeatures: (rowIds: string[], folderPath: string | null) => Promise<void>;
  /** Remove one feature from this transient list (does not touch the vault). */
  onDismissFeature: (rowId: string) => void;
};

/**
 * The working-set list: a browsable, map-linked view of one overlay layer's features
 * (agent `present_features` output, or a user search). Rows focus their marker on click.
 * Mirrors the search panel's row styling and the place card's panel chrome so it reads as
 * a sibling surface. Overlay features can be added to a vault folder one at a time (the row
 * `+`) or in bulk (the header) — saving is repeatable (a place can live in many folders), so
 * rows carry no "saved" state, only a transient in-flight spinner.
 */
export function FeaturesListPanel({
  layer,
  placesByPath,
  defaultParentFolderPath,
  onClose,
  onOpenFeature,
  onSaveFeatures,
  onDismissFeature
}: FeaturesListPanelProps): React.JSX.Element {
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const [addAllOpen, setAddAllOpen] = useState(false);
  // Id of the row whose folder picker is open (one at a time), or null when none.
  const [saveRowId, setSaveRowId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<FeatureListRow[]>(() => {
    if (!layer) return [];
    const out: FeatureListRow[] = [];
    for (const p of layer.points) {
      out.push({
        id: p.id,
        title: p.title,
        geometryKind: "point",
        lat: p.lat,
        lng: p.lng,
        preview: firstLine(p.preview_markdown),
        category: p.properties?.category,
        address: p.properties?.address,
        wikidataId: p.properties?.wikidata_id,
        isVault: false
      });
    }
    for (const l of layer.lines) {
      out.push({
        id: l.id,
        title: l.title || "Route",
        geometryKind: "line",
        preview: firstLine(l.preview_markdown),
        isVault: false
      });
    }
    for (const pg of layer.polygons) {
      out.push({
        id: pg.id,
        title: pg.title || "Area",
        geometryKind: "polygon",
        preview: firstLine(pg.preview_markdown),
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
        geometryKind: "point",
        ...(coords ? { lng: coords[0], lat: coords[1] } : {}),
        category: place.properties?.category,
        address: place.properties?.address,
        filePath: path,
        icon: place.icon,
        color: place.color,
        glyphKind: placeGlyphKind(place),
        isVault: true
      });
    }
    return out;
  }, [layer, placesByPath]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10
  });

  /** Overlay point features that can be written (vault rows are already files; the save
   *  path is point-only). Saving is repeatable — a place can be copied into any number of
   *  folders — so there's no "already saved" state to exclude here. */
  const overlayIds = useMemo(
    () => rows.filter((r) => !r.isVault && r.geometryKind === "point").map((r) => r.id),
    [rows]
  );

  const saveIds = useCallback(
    async (ids: string[], folderPath: string | null) => {
      if (ids.length === 0) return;
      setSavingIds((prev) => new Set([...prev, ...ids]));
      await onSaveFeatures(ids, folderPath);
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
        {overlayIds.length > 0 && (
          <FolderPickerPopover
            open={addAllOpen}
            onOpenChange={setAddAllOpen}
            defaultParentFolderPath={defaultParentFolderPath}
            title="Save all to folder"
            side="bottom"
            align="end"
            onSelect={(folderPath) => void saveIds(overlayIds, folderPath)}
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
          <p className="text-muted-foreground text-sm">No places in this list yet.</p>
        </div>
      ) : (
        // Virtualized so a large result set (thousands of features) renders only the rows
        // in view — the map draws the full set via its symbol layer, not this list.
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const row = rows[vItem.index];
              const saving = savingIds.has(row.id);
              const canSave = !row.isVault && row.geometryKind === "point";
              // A vault row goes through VaultFileIcon so the file's own emoji/colour shows here
              // too; an overlay row has no file, so it keeps the plain geometry glyph.
              const rowIcon = row.isVault ? (
                <VaultFileIcon
                  name={row.filePath ?? row.title}
                  geometryKind={row.glyphKind}
                  icon={row.icon}
                  color={row.color}
                />
              ) : row.geometryKind === "line" ? (
                <RouteIcon className="size-4" />
              ) : row.geometryKind === "polygon" ? (
                <PentagonIcon className="size-4" />
              ) : (
                <MapPinIcon className="size-4" />
              );
              return (
                <div
                  key={row.id}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${vItem.start}px)` }}
                >
                  {/* The row itself is the button; per-row actions are absolutely-positioned
                      siblings, not descendants, so we don't nest buttons inside a button. The
                      hover background lives on the wrapper (matching CommandItem) so hovering an
                      action button keeps the whole row highlighted. */}
                  <div className="group relative rounded-md transition-colors hover:bg-hover">
                    <button
                      type="button"
                      onClick={() => onOpenFeature(row)}
                      className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 pr-14 text-left text-sm outline-hidden focus-visible:bg-hover"
                    >
                      <RowThumbnail
                        wikidataId={row.wikidataId}
                        vaultFilePath={row.filePath}
                        fallback={rowIcon}
                      />
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
                        {(row.address ?? row.preview) ? (
                          <span className="mt-0.5 truncate text-muted-foreground text-xs leading-tight">
                            {row.address ?? row.preview}
                          </span>
                        ) : null}
                      </div>
                    </button>
                    <span className="-translate-y-1/2 absolute top-1/2 right-1.5 flex items-center gap-0.5">
                      {canSave &&
                        (saving ? (
                          <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <FolderPickerPopover
                            open={saveRowId === row.id}
                            onOpenChange={(o) => setSaveRowId(o ? row.id : null)}
                            defaultParentFolderPath={defaultParentFolderPath}
                            title="Save place to folder"
                            side="bottom"
                            align="end"
                            onSelect={(folderPath) => void saveIds([row.id], folderPath)}
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-6 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                                aria-label="Save to vault"
                                title="Save to vault"
                              >
                                <PlusIcon className="size-4" />
                              </Button>
                            }
                          />
                        ))}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                        aria-label="Remove from list"
                        title="Remove from list"
                        onClick={() => onDismissFeature(row.id)}
                      >
                        <XIcon className="size-4" />
                      </Button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

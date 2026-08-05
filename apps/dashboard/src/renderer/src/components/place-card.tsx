import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@mapos/ui/components/breadcrumb";
import { Button } from "@mapos/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { InputGroupButton } from "@mapos/ui/components/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from "@mapos/ui/components/popover";
import { ScrollArea } from "@mapos/ui/components/scroll-area";
import { Surface, surfaceVariants } from "@mapos/ui/components/surface";
import {
  ErrorTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import {
  VaultImage,
  isVaultRelativePath,
  relPathFromVaultUrl,
  vaultImageUrl
} from "@renderer/extensions/vault-image-extension";
import { WikilinkExtension, type WikilinkItem } from "@renderer/extensions/wikilink-extension";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { useDebouncedCallback } from "@renderer/hooks/use-debounced-callback";
import { DRAW_SHAPE_LABELS, type DrawMode, type DrawShape } from "@renderer/lib/draw";
import type { GeocodeSearchResult } from "@renderer/lib/geocode-search";
import { flattenMdFiles, resolveWikilinkTarget } from "@renderer/lib/wikilinks";
import type { RouteFrontmatter } from "@shared/route";
import { type Editor, Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import {
  EllipsisIcon,
  FolderOpenIcon,
  ImageIcon,
  ImageOffIcon,
  Link2Icon,
  Link2OffIcon,
  MapPinIcon,
  MapPinOffIcon,
  MapPinPlus,
  Maximize2Icon,
  PencilIcon,
  PencilRulerIcon,
  PentagonIcon,
  PlusIcon,
  RouteIcon,
  SearchIcon,
  SplineIcon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { type PlaceRecord, type PropertyType, isServableImageFile } from "../../../shared/types";
import { AutoSizeTextArea } from "./autosize-text-area";
import { FolderPickerPopover } from "./folder-picker-popover";
import { GeocodeSearchPanel } from "./geocode-search-panel";
import { ImageLightbox, type LightboxData } from "./image-lightbox";
import { PropertiesPanel } from "./properties-panel";

/** GeoJSON top-level members with dedicated UI (title / body editor), not the grid. */
const GJ_EXCLUDED = new Set(["name", "description"]);

/** Stable empty list — PropertiesPanel is memoized, so props must keep identity. */
const EMPTY_KEY_TYPES: Array<{ key: string; type: PropertyType }> = [];

/** The trigger's label once the place has geometry: coordinates for a point, the
 *  shape's name otherwise (there is nothing that short and useful to say about a ring). */
function formatGeometrySummary(
  geometryJson: string | undefined,
  savedRoute: RouteFrontmatter | null
): string {
  if (!geometryJson) return "";
  // A route's shape is a LineString, so without this it would read as a plain "Line".
  if (savedRoute) {
    return `Route · ${savedRoute.stops.length} stops`;
  }
  try {
    const geo = JSON.parse(geometryJson) as {
      type: string;
      coordinates: [number, number];
    };
    if (geo.type === "Point" && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      const [lng, lat] = geo.coordinates;
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
    if (geo.type === "LineString") return "Line";
    if (geo.type === "Polygon") return "Area";
  } catch {
    /* ignore */
  }
  return "Location";
}

/** The dropdown's draw options, in menu order. */
const DRAW_OPTIONS: Array<{ shape: DrawShape; icon: typeof MapPinPlus }> = [
  { shape: "point", icon: MapPinPlus },
  { shape: "linestring", icon: SplineIcon },
  { shape: "polygon", icon: PentagonIcon }
];

type LoadedDoc =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "vault";
      body: string;
      frontmatter: Record<string, unknown>;
      keys: Array<{ key: string; type: PropertyType }>;
      /** Vault-relative path of the hero image (reserved `cover` frontmatter key). */
      cover?: string;
      /** Provenance URL for the cover (reserved `cover_source` frontmatter key). */
      coverSource?: string;
    }
  | { kind: "preview"; body: string }
  | {
      kind: "geojson-layer";
      properties: Record<string, unknown>;
      featureCount: number;
      geometryTypes: string[];
    };

type PlaceCardMarkdownPaneProps = {
  filePath: string;
  initialMarkdown: string;
  isPreview: boolean;
  mode: "mini" | "full";
  isDark: boolean;
  /** Focus the editor once the initial content is loaded (opening an existing file). */
  autoFocus?: boolean;
  onNavigate?: (place: PlaceRecord, newTab?: boolean) => void;
  /** Wikilink click — open the linked place without leaving the current card
   * (mini/peek). Falls back to onNavigate when unset. */
  onOpenWikilink?: (place: PlaceRecord, newTab?: boolean) => void;
  onEditorReady: (editor: Editor | null) => void;
  /** Override the default writePlaceBody persistence. */
  onPersist?: (content: string) => void;
  /** Called with the display URL when an inline image is clicked (opens the lightbox). */
  onImageClick?: (src: string) => void;
};

const TabIndent = Extension.create({
  name: "tabIndent",
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.can().sinkListItem("listItem")) {
          return this.editor.commands.sinkListItem("listItem");
        }
        return this.editor.commands.insertContent("  ");
      },
      "Shift-Tab": () => {
        if (this.editor.can().liftListItem("listItem")) {
          return this.editor.commands.liftListItem("listItem");
        }
        return false;
      }
    };
  }
});

function PlaceCardMarkdownPane({
  filePath,
  initialMarkdown,
  isPreview,
  mode,
  isDark,
  autoFocus,
  onNavigate,
  onOpenWikilink,
  onEditorReady,
  onPersist,
  onImageClick
}: PlaceCardMarkdownPaneProps): React.JSX.Element {
  const vaultFilesRef = useRef<WikilinkItem[]>([]);
  const onImageClickRef = useRef(onImageClick);
  onImageClickRef.current = onImageClick;
  const currentPathRef = useRef(filePath);
  currentPathRef.current = filePath;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  onOpenWikilinkRef.current = onOpenWikilink;

  const [linkUrl, setLinkUrl] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const linkInputRef = useRef<HTMLInputElement>(null);

  const onPersistRef = useRef(onPersist);
  onPersistRef.current = onPersist;

  const debouncedPersist = useDebouncedCallback((markdown: string) => {
    if (onPersistRef.current) {
      onPersistRef.current(markdown);
    } else {
      void window.api.fs.writePlaceBody(currentPathRef.current, markdown);
    }
  }, 600);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: true }
      }),
      Markdown,
      TabIndent,
      // inline: markdown image tokens are inline (inside paragraphs); a block-level
      // image node can't be placed there and the token would fall back to raw text.
      VaultImage.configure({
        allowBase64: false,
        inline: true,
        HTMLAttributes: { class: "cursor-zoom-in" },
        onImageClick: (src: string) => onImageClickRef.current?.(src)
      }),
      WikilinkExtension.configure({
        onClickWikilink: async (title: string, newTab: boolean) => {
          const item = resolveWikilinkTarget(vaultFilesRef.current, title);
          if (!item) return;
          const result = await window.api.places.getByPath(item.filePath);
          if (!result) return;
          const open = onOpenWikilinkRef.current ?? onNavigateRef.current;
          open?.(result as PlaceRecord, newTab);
        },
        suggestion: {
          items({ query }: { query: string }) {
            const q = query.toLowerCase();
            return vaultFilesRef.current
              .filter(
                (f) =>
                  f.filePath !== currentPathRef.current &&
                  (f.title.toLowerCase().includes(q) || f.relPath.toLowerCase().includes(q))
              )
              .slice(0, 20);
          }
        }
      })
    ],
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none text-sidebar-foreground h-full min-h-[4rem] focus:outline-none"
      }
    }
  });

  useEffect(() => {
    void window.api.fs.listDir().then((nodes) => {
      const files = flattenMdFiles(nodes);
      const titleCounts = new Map<string, number>();
      for (const f of files) titleCounts.set(f.title, (titleCounts.get(f.title) ?? 0) + 1);
      // Duplicate titles get a path-qualified link so resolution stays unambiguous.
      vaultFilesRef.current = files.map((f) => ({
        ...f,
        linkTarget: (titleCounts.get(f.title) ?? 0) > 1 ? f.relPath : f.title
      }));
    });
  }, []);

  const didAutoFocusRef = useRef(false);

  useLayoutEffect(() => {
    if (!editor) return;
    // emitUpdate: false prevents tiptap firing `update` for programmatic content loads.
    // Without it, mounting/re-mounting the editor schedules a debounced writePlaceBody
    // that can race with concurrent frontmatter writes (e.g. a location clear) and
    // restore stale frontmatter it happened to read at an unlucky moment.
    editor.commands.setContent(initialMarkdown, {
      contentType: "markdown",
      emitUpdate: false
    });
    // Once only — this effect also re-runs when the file changes on disk, and a
    // background change must not yank focus. scrollIntoView: false keeps the
    // card scrolled to the top when the body is long.
    if (autoFocus && !isPreview && !didAutoFocusRef.current) {
      didAutoFocusRef.current = true;
      editor.commands.focus("end", { scrollIntoView: false });
    }
  }, [editor, initialMarkdown, autoFocus, isPreview]);

  useEffect(() => {
    if (!editor) return;
    // emitUpdate: false — tiptap's setEditable fires an `update` event by default,
    // which would schedule a debounced body-save of whatever content is loaded and
    // race with concurrent frontmatter writes. Toggling editability is not a content
    // change, so it should never trigger persistence.
    editor.setEditable(!isPreview, false);
  }, [editor, isPreview]);

  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  useEffect(() => {
    if (!editor || isPreview) return;
    const onDocUpdate = () => {
      debouncedPersist(editor.getMarkdown());
    };
    editor.on("update", onDocUpdate);
    return () => {
      editor.off("update", onDocUpdate);
    };
  }, [editor, isPreview, debouncedPersist]);

  function openLinkInput() {
    const existing = editor?.getAttributes("link").href as string | undefined;
    setLinkUrl(existing ?? "");
    setShowLinkInput(true);
    setTimeout(() => linkInputRef.current?.focus(), 0);
  }

  function applyLink() {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    } else {
      editor.chain().focus().unsetLink().run();
    }
    setShowLinkInput(false);
    setLinkUrl("");
  }

  function handleLinkKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") applyLink();
    if (e.key === "Escape") {
      setShowLinkInput(false);
      setLinkUrl("");
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus dead zone is a pointer-only convenience; the editor itself is keyboard-focusable
    <div
      className={cn("px-4 pb-3", mode === "full" && "flex-1 min-h-0", !isPreview && "cursor-text")}
      onClick={(e) => {
        // The editor only occupies its content height; clicks on the empty
        // space around it should still start editing at the end of the body.
        if (e.target === e.currentTarget) editor?.chain().focus("end").run();
      }}
    >
      {editor && (
        <BubbleMenu editor={editor} options={{ onHide: () => setShowLinkInput(false) }}>
          {showLinkInput ? (
            <div className="flex items-center gap-1.5 bg-sidebar border border-sidebar-border rounded-lg shadow-lg px-2.5 py-1.5">
              <Link2Icon className="size-3 text-sidebar-foreground/40 shrink-0" />
              <input
                ref={linkInputRef}
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={handleLinkKeyDown}
                placeholder="https://…"
                className="text-xs bg-transparent outline-none text-sidebar-foreground w-44 placeholder:text-sidebar-foreground/30"
              />
              <button
                type="button"
                onClick={applyLink}
                className="text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
              >
                Apply
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-0.5 bg-sidebar border border-sidebar-border rounded-lg shadow-lg p-1">
              <button
                type="button"
                onClick={() => editor.chain().focus().toggleBold().run()}
                className={cn(
                  "rounded px-1.5 py-0.5 text-xs font-bold transition-colors",
                  editor.isActive("bold")
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-hover"
                )}
              >
                B
              </button>
              <button
                type="button"
                onClick={() => editor.chain().focus().toggleItalic().run()}
                className={cn(
                  "rounded px-1.5 py-0.5 text-xs italic transition-colors",
                  editor.isActive("italic")
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-hover"
                )}
              >
                I
              </button>
              <div className="w-px h-3.5 bg-sidebar-border mx-0.5" />
              {editor.isActive("link") ? (
                <button
                  type="button"
                  onClick={() => editor.chain().focus().unsetLink().run()}
                  className="rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-hover transition-colors"
                  title="Remove link"
                >
                  <Link2OffIcon className="size-3" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openLinkInput}
                  className="rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-hover transition-colors"
                  title="Add link"
                >
                  <Link2Icon className="size-3" />
                </button>
              )}
            </div>
          )}
        </BubbleMenu>
      )}
      <EditorContent
        editor={editor}
        className={cn("h-full", isDark && "dark")}
        onClick={(e) => {
          if (e.target === e.currentTarget) editor?.chain().focus("end").run();
        }}
      />
    </div>
  );
}

// Memoized: while a mini card tracks the map, App re-renders per frame to move the
// card's wrapper; the card itself only needs to render when its props change.
export const PlaceCard = memo(function PlaceCard({
  place,
  onClose,
  mode = "mini",
  onExpand,
  onNavigate,
  onGetDirections,
  onOpenWikilink,
  onSaveSearchToVault,
  defaultParentFolderPath = null,
  onCommitPointLocation,
  onClearPointLocation,
  onStartDrawing,
  onEditGeometry,
  onPlanRoute,
  savedRoute = null,
  activeDrawMode = null,
  onRename,
  onDelete,
  onOpenFolder
}: {
  place: PlaceRecord;
  onClose: () => void;
  mode?: "mini" | "full";
  onExpand?: () => void;
  onNavigate?: (place: PlaceRecord, newTab?: boolean) => void;
  /** Open a directions tab with this place as the destination. Shown when the place has geometry. */
  onGetDirections?: (place: PlaceRecord) => void;
  /** Wikilink click — open the linked place in a mini/peek card instead of
   * navigating the panel. Falls back to onNavigate when unset. */
  onOpenWikilink?: (place: PlaceRecord, newTab?: boolean) => void;
  /** When set with a search preview, shows Save (+) to create a place file in a chosen folder. */
  onSaveSearchToVault?: (folderPath: string | null) => Promise<void>;
  /** Folder highlighted as the default in the save picker. `null` = vault root. */
  defaultParentFolderPath?: string | null;
  /** Persist a point to the vault file; return whether the write succeeded. */
  onCommitPointLocation?: (filePath: string, lat: number, lng: number) => Promise<boolean>;
  /** Remove `geometry` from the vault file. */
  onClearPointLocation?: (filePath: string) => Promise<boolean>;
  /** Start drawing this file's geometry on the map. */
  onStartDrawing?: (filePath: string, shape: DrawShape) => void;
  /** Edit the file's existing geometry on the map. Receives its GeoJSON JSON string. */
  onEditGeometry?: (filePath: string, geometry: string) => void;
  /** Open a directions tab bound to this file, so its route saves back here. */
  /** `fresh` asks for a blank route rather than this file's saved one — see "Draw a route". */
  onPlanRoute?: (filePath: string, opts?: { fresh?: boolean }) => void;
  /** This file's saved route. Resolve it from the places index, not from `place` — records
   *  built by a map click come from SQLite rows and never carry one. */
  savedRoute?: RouteFrontmatter | null;
  /** The mode of the draw session running against this file, if any. */
  activeDrawMode?: DrawMode | null;
  /** Called after a successful file rename with the old and new paths. */
  onRename?: (oldPath: string, newPath: string) => void;
  /** Called after the place file has been deleted on disk. */
  onDelete?: (filePath: string) => void;
  /** Open a vault folder (breadcrumb click). Receives the absolute folder path. */
  onOpenFolder?: (folderPath: string) => void;
}): React.JSX.Element {
  const [currentFilePath, setCurrentFilePath] = useState(place.filePath);
  // With a rename-stable mount key, a relocation initiated outside this card
  // arrives as a filePath prop change rather than a remount; adopt the new path.
  const [prevPlacePath, setPrevPlacePath] = useState(place.filePath);
  if (place.filePath !== prevPlacePath) {
    setPrevPlacePath(place.filePath);
    setCurrentFilePath(place.filePath);
  }
  const [doc, setDoc] = useState<LoadedDoc>(() =>
    place.previewMarkdown !== undefined
      ? { kind: "preview", body: place.previewMarkdown ?? "" }
      : { kind: "loading" }
  );
  const [savingSearch, setSavingSearch] = useState(false);
  const [saveToVaultOpen, setSaveToVaultOpen] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [addLocationOpen, setAddLocationOpen] = useState(false);
  const [locationMenuOpen, setLocationMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  // The search popover anchors to an inert overlay of the location row, so the row's
  // button is free to be the dropdown's trigger. Focus returns here on close.
  const locationTriggerRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  // Set when "Rename" is chosen so the menu returns focus to the title input
  // (instead of its trigger) once it closes.
  const renameRequestedRef = useRef(false);
  // Set when this card renames its own file, so the load effect can skip the
  // reload the filePath change would otherwise trigger — content is unchanged.
  const selfRenamedToRef = useRef<string | null>(null);
  const isDark = useDarkMode();

  const filePathBaseName =
    currentFilePath
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.(md|geojson)$/i, "") ?? "";
  const currentTitle = place.previewMarkdown !== undefined ? place.title : filePathBaseName;
  const [titleInput, setTitleInput] = useState(currentTitle);

  const loading = doc.kind === "loading";

  // Local reads resolve in a few ms; an immediate indicator just flashes.
  // Defer it so fast loads render nothing briefly and slow loads get feedback.
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowLoadingIndicator(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoadingIndicator(true), 200);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const onEditorReady = useCallback((ed: Editor | null) => {
    editorRef.current = ed;
  }, []);

  // Ancestor folders for the top-bar breadcrumb. Previews aren't on disk yet,
  // so they get no folder trail (just the title crumb).
  const [vaultRoot, setVaultRoot] = useState<string | null>(null);
  useEffect(() => {
    void window.api.fs.getVaultRoot().then(setVaultRoot);
  }, []);
  const breadcrumbFolders = useMemo(() => {
    if (place.previewMarkdown !== undefined || !vaultRoot) return [];
    if (currentFilePath !== vaultRoot && !currentFilePath.startsWith(vaultRoot)) return [];
    const sep = currentFilePath.includes("\\") ? "\\" : "/";
    const rel = currentFilePath.slice(vaultRoot.length).replace(/^[/\\]/, "");
    const segments = rel.split(/[/\\]/).slice(0, -1);
    return segments.map((name, i) => ({
      name,
      path: `${vaultRoot}${sep}${segments.slice(0, i + 1).join(sep)}`
    }));
  }, [place.previewMarkdown, vaultRoot, currentFilePath]);

  const coverPath = doc.kind === "vault" ? doc.cover : undefined;
  // Bumped when the cover file's bytes change on disk so the <img> re-fetches
  // past the protocol's no-cache response (?v= param).
  const [coverRev, setCoverRev] = useState(0);
  useEffect(() => {
    if (!coverPath) return;
    return window.api.fs.onFileContentChanged(({ filePath }) => {
      if (filePath.replaceAll("\\", "/").endsWith(`/${coverPath}`)) {
        setCoverRev((r) => r + 1);
      }
    });
  }, [coverPath]);

  // Search previews carry no cover file; when the result has a Wikidata id,
  // resolve its Commons (P18) photo as a remote hero. Vault docs never use
  // this — their only image source is the `cover` frontmatter key.
  const wikidataQid =
    place.previewMarkdown !== undefined && typeof place.properties?.wikidata_id === "string"
      ? place.properties.wikidata_id
      : undefined;
  const [remoteCover, setRemoteCover] = useState<{
    thumbUrl: string;
    pageUrl: string;
  } | null>(null);
  // Display URL of a vault cover that failed to load (stale path, unreadable
  // file). Keyed by src, so a rewrite of the cover file (new ?v=) retries.
  const [failedCoverSrc, setFailedCoverSrc] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxData | null>(null);
  useEffect(() => {
    setRemoteCover(null);
    if (!wikidataQid || !/^Q\d+$/.test(wikidataQid)) return;
    let cancelled = false;
    void window.api.wiki.imageLookup(wikidataQid).then((img) => {
      if (!cancelled && img) setRemoteCover(img);
    });
    return () => {
      cancelled = true;
    };
  }, [wikidataQid]);

  /** Set (relPath) or remove (null) the cover in one atomic frontmatter write.
   *  Either way any stale Commons provenance link is dropped with it. */
  const applyCover = useCallback(
    async (relPath: string | null) => {
      const result = await window.api.fs.writeFrontmatterProperties(currentFilePath, {
        cover: relPath,
        cover_source: null
      });
      if (result.success) {
        setDoc((d) =>
          d.kind === "vault" ? { ...d, cover: relPath ?? undefined, coverSource: undefined } : d
        );
      }
    },
    [currentFilePath]
  );

  const coverInputRef = useRef<HTMLInputElement>(null);

  const gjFrontmatter = useMemo(
    () =>
      doc.kind === "geojson-layer"
        ? Object.fromEntries(Object.entries(doc.properties).filter(([k]) => !GJ_EXCLUDED.has(k)))
        : null,
    [doc]
  );

  const writeGeoJsonProperty = useCallback(
    async (key: string, value: unknown) => {
      await window.api.fs.writeGeoJsonProperty(currentFilePath, key, value);
    },
    [currentFilePath]
  );

  async function handleCoverFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires a change event.
    e.target.value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await window.api.fs.importAttachment({
      suggestedName: file.name,
      bytes
    });
    if (result.success) await applyCover(result.relPath);
  }

  useEffect(() => {
    void place.geometry;
    if (selfRenamedToRef.current === place.filePath) {
      selfRenamedToRef.current = null;
      return;
    }
    if (place.previewMarkdown !== undefined) {
      setDoc({ kind: "preview", body: place.previewMarkdown ?? "" });
      return;
    }
    if (place.type === "GeoJsonLayer") {
      setDoc({ kind: "loading" });
      let cancelled = false;
      void window.api.fs.readGeoJson(place.filePath).then((data) => {
        if (cancelled || !data) return;
        const features = (data.features as unknown[]) ?? [];
        const featureCount = features.length;
        const geometryTypes = [
          ...new Set(
            features
              .map((f) => (f as { geometry?: { type?: string } }).geometry?.type)
              .filter((t): t is string => Boolean(t))
          )
        ];
        const { type: _t, features: _f, ...properties } = data as Record<string, unknown>;
        setDoc({
          kind: "geojson-layer",
          properties,
          featureCount,
          geometryTypes
        });
      });
      return () => {
        cancelled = true;
      };
    }
    setDoc({ kind: "loading" });
    let cancelled = false;
    void Promise.all([
      window.api.fs.readFile(place.filePath),
      window.api.properties.listAllKeys()
    ]).then(([result, vaultKeys]) => {
      if (cancelled) return;
      if ("error" in result) {
        setDoc({ kind: "error", message: result.error });
        return;
      }
      setDoc({
        kind: "vault",
        body: result.body,
        frontmatter: result.frontmatter,
        keys: vaultKeys,
        cover: result.cover,
        coverSource: result.coverSource
      });
    });
    return () => {
      cancelled = true;
    };
  }, [place.filePath, place.previewMarkdown, place.geometry, place.type]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        const active = document.activeElement;
        if (active?.getAttribute("aria-label") === "Place name") {
          // Cancel the edit by reverting the draft. We deliberately do NOT blur:
          // blurring would fire handleTitleBlur synchronously, before this revert
          // re-renders, so it would still read the modified draft and commit it.
          // Leaving the field focused with the restored title is both correct and
          // re-editable.
          setTitleInput(currentTitle);
          setTitleError(null);
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, currentTitle]);

  useEffect(() => {
    if (place.geometry) setAddLocationOpen(false);
  }, [place.geometry]);

  // A freshly created file opens with its title focused and selected so the
  // user can rename it immediately. Editable (non-preview) places only.
  useEffect(() => {
    if (!place.justCreated || place.previewMarkdown !== undefined) return;
    const el = titleInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [place.justCreated, place.previewMarkdown]);

  const handleAddLocationOpenChange = useCallback((open: boolean) => {
    setAddLocationOpen(open);
  }, []);

  const handleAddLocationSearchSelect = useCallback(
    async (r: GeocodeSearchResult) => {
      if (!onCommitPointLocation) return;
      const ok = await onCommitPointLocation(currentFilePath, r.lat, r.lng);
      if (ok) setAddLocationOpen(false);
    },
    [currentFilePath, onCommitPointLocation]
  );

  const handleClearLocation = useCallback(async () => {
    if (!onClearPointLocation) return;
    const ok = await onClearPointLocation(currentFilePath);
    if (ok) setAddLocationOpen(false);
  }, [currentFilePath, onClearPointLocation]);

  const handleStartDrawing = useCallback(
    (shape: DrawShape) => {
      setLocationMenuOpen(false);
      onStartDrawing?.(currentFilePath, shape);
    },
    [currentFilePath, onStartDrawing]
  );

  const handleEditGeometry = useCallback(() => {
    if (!place.geometry) return;
    setLocationMenuOpen(false);
    onEditGeometry?.(currentFilePath, place.geometry);
  }, [currentFilePath, place.geometry, onEditGeometry]);

  const handlePlanRoute = useCallback(() => {
    setLocationMenuOpen(false);
    onPlanRoute?.(currentFilePath);
  }, [currentFilePath, onPlanRoute]);

  /** "Draw a route" — always starts over, even when the file already has a route, so it reads
   *  as a sibling of "Draw a line" / "Draw an area" rather than a second way to edit. */
  const handleDrawRoute = useCallback(() => {
    setLocationMenuOpen(false);
    onPlanRoute?.(currentFilePath, { fresh: true });
  }, [currentFilePath, onPlanRoute]);

  function validateTitle(name: string): string | null {
    if (!name.trim()) return "Name cannot be empty";
    if (/[/\\]/.test(name)) return "Name cannot contain slashes";
    return null;
  }

  async function handleTitleBlur() {
    if (place.previewMarkdown !== undefined) {
      setTitleInput(currentTitle);
      return;
    }
    const newName = titleInput.trim();
    const error = validateTitle(newName);
    if (error || newName === currentTitle) {
      setTitleInput(currentTitle);
      setTitleError(null);
      return;
    }
    const result = await window.api.fs.renameFile(currentFilePath, newName);
    if (result.success) {
      selfRenamedToRef.current = result.newPath;
      onRename?.(currentFilePath, result.newPath);
      setCurrentFilePath(result.newPath);
      setTitleError(null);
    } else {
      setTitleError(result.error ?? "Rename failed");
    }
  }

  async function confirmDelete() {
    if (isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    const result = await window.api.fs.deletePath(currentFilePath);
    setIsDeleting(false);
    if (!result.success) {
      setDeleteError(result.error);
      return;
    }
    onDelete?.(currentFilePath);
    setDeleteOpen(false);
  }

  function handleTitleEnter() {
    if (place.previewMarkdown !== undefined) return;
    const error = validateTitle(titleInput);
    setTitleError(error);
    if (!error) {
      (document.activeElement as HTMLElement | null)?.blur();
      editorRef.current?.chain().focus().run();
    }
  }

  // `cover` is free-form frontmatter: only treat it as a hero when it plausibly
  // names an image the vault protocol will serve.
  const vaultCover =
    coverPath && isVaultRelativePath(coverPath) && isServableImageFile(coverPath)
      ? coverPath
      : undefined;
  const coverSrc = vaultCover ? vaultImageUrl(vaultCover, coverRev) : remoteCover?.thumbUrl;
  const coverVisible = Boolean(coverSrc) && coverSrc !== failedCoverSrc;

  function openCoverLightbox(): void {
    if (vaultCover) {
      setLightbox({
        src: vaultImageUrl(vaultCover, coverRev),
        pageUrl: doc.kind === "vault" ? doc.coverSource : undefined,
        caption: vaultCover.split("/").pop()
      });
    } else if (remoteCover) {
      setLightbox({
        // The hero thumb is card-sized; ask Commons for a larger render.
        src: remoteCover.thumbUrl.replace(/width=\d+/, "width=1600"),
        pageUrl: remoteCover.pageUrl
      });
    }
  }

  // Mini mode keeps the actions pinned over the content (old compact styling);
  // full mode puts them in the ChatPane-style top bar.
  const miniActionCount =
    1 + // close (always shown)
    Number(place.previewMarkdown !== undefined && Boolean(onSaveSearchToVault)) + // save
    Number(Boolean(onGetDirections) && Boolean(place.geometry) && !savedRoute) + // directions
    Number(Boolean(onExpand)); // expand
  // Mini keeps a slightly smaller cluster since it floats over content; the
  // title's reserved padding below is `miniActionCount * MINI_ACTION_PX`.
  const actionSize = mode === "mini" ? "icon-sm" : "icon";

  const actionButtons = (
    <>
      {place.previewMarkdown !== undefined && onSaveSearchToVault && (
        <Tooltip>
          <FolderPickerPopover
            open={saveToVaultOpen}
            onOpenChange={setSaveToVaultOpen}
            defaultParentFolderPath={defaultParentFolderPath}
            title="Save place to folder"
            side="bottom"
            align="end"
            onSelect={(folderPath) => {
              void (async () => {
                setSavingSearch(true);
                try {
                  await onSaveSearchToVault(folderPath);
                } finally {
                  setSavingSearch(false);
                }
              })();
            }}
            trigger={
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size={actionSize}
                    disabled={savingSearch}
                    aria-label="Save to vault"
                  >
                    <PlusIcon />
                  </Button>
                }
              />
            }
          />
          <TooltipContent side="bottom">Save to vault</TooltipContent>
        </Tooltip>
      )}
      {mode === "full" && place.previewMarkdown === undefined && (
        <Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <TooltipTrigger
                  render={<Button variant="ghost" size={actionSize} aria-label="More actions" />}
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="end"
              finalFocus={() => {
                if (renameRequestedRef.current) {
                  renameRequestedRef.current = false;
                  // Focus + select all once the menu has finished closing, so
                  // the whole title is highlighted ready to overtype.
                  requestAnimationFrame(() => {
                    titleInputRef.current?.focus({ preventScroll: true });
                    titleInputRef.current?.select();
                  });
                  return false; // we manage focus ourselves for rename
                }
                return true;
              }}
            >
              <DropdownMenuItem onClick={() => onNavigate?.(place, true)}>
                <PlusIcon />
                Open in new tab
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void window.api.fs.revealInFinder(currentFilePath)}>
                <FolderOpenIcon />
                Reveal in Finder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  renameRequestedRef.current = true;
                }}
              >
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              {doc.kind === "vault" && (
                <DropdownMenuItem onClick={() => coverInputRef.current?.click()}>
                  <ImageIcon />
                  {coverPath ? "Change cover photo" : "Set cover photo"}
                </DropdownMenuItem>
              )}
              {doc.kind === "vault" && coverPath && (
                <DropdownMenuItem onClick={() => void applyCover(null)}>
                  <ImageOffIcon />
                  Remove cover photo
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
              >
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
      )}
      {/* Not for a saved route: "directions to this trip" would route to the midpoint of
          its own line, and the card already offers "Edit route" for the real action. */}
      {onGetDirections && place.geometry && !savedRoute && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size={actionSize}
                onClick={() => onGetDirections(place)}
                aria-label="Get directions"
              >
                <RouteIcon />
              </Button>
            }
          />
          <TooltipContent side="bottom">Get directions</TooltipContent>
        </Tooltip>
      )}
      {mode === "mini" && onExpand && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size={actionSize}
                onClick={onExpand}
                aria-label="Open full view"
              >
                <Maximize2Icon />
              </Button>
            }
          />
          <TooltipContent side="bottom">Open full view</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size={actionSize} onClick={onClose} aria-label="Close">
              <XIcon />
            </Button>
          }
        />
        <TooltipContent side="bottom">Close</TooltipContent>
      </Tooltip>
    </>
  );

  /** Routing is a way of giving this file a line, so it sits with the drawn shapes rather than
   *  with the search — even though it opens the directions panel, not a draw session. Shown
   *  whatever the file already holds, exactly like the other draw options: each one starts a
   *  new shape that replaces the old on save. Declared once here because it slots into the
   *  middle of the DRAW_OPTIONS list below. */
  const drawRouteMenuItem = onPlanRoute ? (
    <DropdownMenuItem onClick={handleDrawRoute}>
      <RouteIcon />
      Draw a route
    </DropdownMenuItem>
  ) : null;

  /** Editing an existing route replaces "Edit shape", which would open a draw session on the
   *  route's line. That line is *derived* from the stops, and committing a hand-edit writes
   *  `route: null` (see commitVaultGeometry) — so the shape editor silently downgrades a route
   *  to a plain line. The directions panel is the only coherent way to change one. */
  const editRouteMenuItem =
    onPlanRoute && savedRoute ? (
      <DropdownMenuItem onClick={handlePlanRoute}>
        <RouteIcon />
        Edit route
      </DropdownMenuItem>
    ) : null;

  return (
    <div
      className={cn("pointer-events-auto", mode === "full" ? "h-full" : undefined)}
      style={mode === "mini" ? { width: 272 } : undefined}
    >
      <input
        ref={coverInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => void handleCoverFileChosen(e)}
      />
      <div
        className={cn(
          surfaceVariants({ variant: "panel" }),
          "relative overflow-hidden flex flex-col",
          mode === "mini"
            ? "rounded-lg border border-sidebar-border shadow-lg max-h-84"
            : "h-full rounded-lg shadow-sm ring-1 ring-sidebar-border"
        )}
      >
        {mode === "mini" ? (
          /* Compact popup: actions pinned top-right over the content. */
          <Surface
            variant="cluster"
            // The cluster shadow reads as a floating toolbar over the map or a
            // cover image; with no image it sits on the card's own surface and
            // the shadow looks like an errant box — drop it in that case.
            // The cluster's baked h-8 fits size-8 buttons flush; these are icon-sm
            // (size-7), so let the height hug them flush instead.
            className={cn("absolute top-2 right-2 z-10 h-auto", !coverVisible && "shadow-none")}
          >
            {actionButtons}
          </Surface>
        ) : (
          /* Static top bar (mirrors ChatPane): breadcrumb left, actions right.
          Everything else — cover included — scrolls beneath it. */
          <div className="flex min-h-12 shrink-0 items-center justify-between gap-1 p-2">
            <Breadcrumb className="min-w-0 flex-1 px-2">
              <BreadcrumbList className="flex-nowrap gap-1 sm:gap-1.5">
                {breadcrumbFolders.map((folder) => (
                  <Fragment key={folder.path}>
                    <BreadcrumbItem className="min-w-0">
                      <BreadcrumbLink
                        className="truncate"
                        render={
                          <button type="button" onClick={() => onOpenFolder?.(folder.path)} />
                        }
                      >
                        {folder.name}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                  </Fragment>
                ))}
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate">{currentTitle}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex items-center gap-1">{actionButtons}</div>
          </div>
        )}
        <ScrollArea className="flex-1 min-h-0 overflow-y-auto">
          <div className={cn("flex flex-col", mode === "full" && "min-h-full")}>
            {coverVisible && (
              <button
                type="button"
                onClick={openCoverLightbox}
                aria-label="View image"
                className="block w-full shrink-0 cursor-zoom-in"
              >
                <img
                  src={coverSrc}
                  alt=""
                  draggable={false}
                  onError={() =>
                    vaultCover ? setFailedCoverSrc(coverSrc ?? null) : setRemoteCover(null)
                  }
                  className={cn("w-full object-cover", mode === "mini" ? "h-28" : "h-40")}
                />
              </button>
            )}
            {/* Header */}
            <div className="flex items-start px-3 py-2 shrink-0">
              <div
                className="flex-1 min-w-0 pt-1"
                // In mini mode the pinned actions overlay the title row unless a
                // cover pushes it down — reserve their width (icon-sm = 28px each).
                style={
                  mode === "mini" && !coverVisible
                    ? { paddingRight: miniActionCount * 28 }
                    : undefined
                }
              >
                <ErrorTooltip error={titleError}>
                  <AutoSizeTextArea
                    inputRef={titleInputRef}
                    aria-label="Place name"
                    className={cn(
                      "min-w-0 text-2xl font-semibold text-sidebar-foreground leading-snug rounded transition-colors",
                      place.previewMarkdown !== undefined ? "cursor-default" : "cursor-text",
                      titleError && "ring-2 ring-inset ring-destructive"
                    )}
                    onBlur={handleTitleBlur}
                    onChange={(v) => {
                      const singleLine = v.replace(/\r?\n/g, " ");
                      setTitleInput(singleLine);
                      setTitleError(validateTitle(singleLine));
                    }}
                    onEnter={handleTitleEnter}
                    onTab={handleTitleEnter}
                    placeholder=""
                    readOnly={place.previewMarkdown !== undefined}
                    value={titleInput}
                  />
                </ErrorTooltip>
              </div>
            </div>

            {place.previewMarkdown === undefined &&
              place.type !== "GeoJsonLayer" &&
              onCommitPointLocation && (
                <div className="relative px-2 pb-4 shrink-0">
                  {/* The geocode search lives in a popover anchored to an inert copy
                      of the row's box, leaving the visible button free to be the
                      dropdown trigger. Base UI allows one trigger per overlay. */}
                  <Popover
                    open={addLocationOpen}
                    onOpenChange={handleAddLocationOpenChange}
                    modal={false}
                  >
                    <PopoverTrigger
                      aria-hidden
                      tabIndex={-1}
                      className="pointer-events-none absolute inset-x-2 top-0 h-8"
                    />
                    <PopoverContent
                      className="w-96 p-0"
                      align="start"
                      side="bottom"
                      sideOffset={6}
                      finalFocus={locationTriggerRef}
                    >
                      <PopoverTitle className="sr-only">
                        {place.geometry ? "Change location" : "Add a location"}
                      </PopoverTitle>
                      <GeocodeSearchPanel
                        active={addLocationOpen}
                        placeholder="Search for a location"
                        onSelectResult={handleAddLocationSearchSelect}
                        inputEndSlot={
                          place.geometry && onClearPointLocation ? (
                            <InputGroupButton
                              type="button"
                              size="sm"
                              onClick={() => void handleClearLocation()}
                            >
                              Clear
                            </InputGroupButton>
                          ) : null
                        }
                      />
                    </PopoverContent>
                  </Popover>
                  <DropdownMenu open={locationMenuOpen} onOpenChange={setLocationMenuOpen}>
                    <DropdownMenuTrigger
                      render={
                        <button
                          ref={locationTriggerRef}
                          type="button"
                          className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-sidebar-foreground ring-sidebar-ring outline-hidden transition-colors hover:bg-hover hover:text-sidebar-accent-foreground focus-visible:ring-2"
                        >
                          {place.geometry ? (
                            <MapPinIcon className="size-4 shrink-0" />
                          ) : (
                            <MapPinPlus className="size-4 shrink-0" />
                          )}
                          <span className="truncate">
                            {activeDrawMode === "select"
                              ? "Editing on the map…"
                              : activeDrawMode
                                ? "Drawing on the map…"
                                : place.geometry
                                  ? formatGeometrySummary(place.geometry, savedRoute)
                                  : "Add a location"}
                          </span>
                        </button>
                      }
                    />
                    <DropdownMenuContent align="start" side="bottom" sideOffset={6}>
                      <DropdownMenuItem
                        onClick={() => {
                          setLocationMenuOpen(false);
                          setAddLocationOpen(true);
                        }}
                      >
                        <SearchIcon />
                        Search for a location
                      </DropdownMenuItem>
                      {(onStartDrawing || drawRouteMenuItem) && <DropdownMenuSeparator />}
                      {onStartDrawing
                        ? DRAW_OPTIONS.map(({ shape, icon: Icon }) => (
                            <Fragment key={shape}>
                              <DropdownMenuItem onClick={() => handleStartDrawing(shape)}>
                                <Icon />
                                {DRAW_SHAPE_LABELS[shape]}
                              </DropdownMenuItem>
                              {shape === "linestring" && drawRouteMenuItem}
                            </Fragment>
                          ))
                        : drawRouteMenuItem}
                      {place.geometry &&
                        (editRouteMenuItem || onEditGeometry || onClearPointLocation) && (
                          <DropdownMenuSeparator />
                        )}
                      {place.geometry && editRouteMenuItem}
                      {place.geometry && !savedRoute && onEditGeometry && (
                        <DropdownMenuItem onClick={handleEditGeometry}>
                          <PencilRulerIcon />
                          Edit shape
                        </DropdownMenuItem>
                      )}
                      {place.geometry && onClearPointLocation && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setLocationMenuOpen(false);
                            void handleClearLocation();
                          }}
                        >
                          <MapPinOffIcon />
                          Remove location
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}

            {/* Properties (same loading gate as editor so metadata + frontmatter stay in sync) */}
            {place.previewMarkdown === undefined && doc.kind === "vault" && (
              <PropertiesPanel
                filePath={currentFilePath}
                frontmatter={doc.frontmatter}
                allVaultKeyTypes={doc.keys}
              />
            )}
            {/* Preview place (search result / chat feature): the same properties grid,
            read-only, so it looks exactly like the vault file it becomes on save. */}
            {place.previewMarkdown !== undefined &&
              place.properties &&
              Object.keys(place.properties).length > 0 && (
                <PropertiesPanel
                  readOnly
                  filePath={currentFilePath}
                  frontmatter={place.properties}
                  allVaultKeyTypes={EMPTY_KEY_TYPES}
                />
              )}
            {doc.kind === "geojson-layer" && gjFrontmatter && (
              <PropertiesPanel
                filePath={currentFilePath}
                frontmatter={gjFrontmatter}
                allVaultKeyTypes={EMPTY_KEY_TYPES}
                onWriteProperty={writeGeoJsonProperty}
                reorderable={false}
              />
            )}

            {/* Body content */}
            {loading && showLoadingIndicator && (
              <div className="px-4 pb-3 text-sm text-sidebar-foreground/50">Loading…</div>
            )}
            {doc.kind === "error" && (
              <div className="px-4 pb-3 text-sm text-destructive">{doc.message}</div>
            )}
            {/* A preview body is read-only, so when it's empty the editor is just
            dead space (min-h-4rem) — skip it in the compact mini card. */}
            {!loading &&
              doc.kind !== "error" &&
              !(mode === "mini" && doc.kind === "preview" && doc.body.trim() === "") && (
                <PlaceCardMarkdownPane
                  filePath={currentFilePath}
                  initialMarkdown={
                    doc.kind === "geojson-layer"
                      ? String(doc.properties.description ?? "")
                      : doc.body
                  }
                  isPreview={doc.kind === "preview"}
                  mode={mode}
                  isDark={isDark}
                  // Freshly created files focus the title for an immediate rename instead.
                  autoFocus={!place.justCreated}
                  onNavigate={onNavigate}
                  onOpenWikilink={onOpenWikilink}
                  onEditorReady={onEditorReady}
                  onPersist={
                    doc.kind === "geojson-layer"
                      ? (content) =>
                          void window.api.fs.writeGeoJsonProperty(
                            currentFilePath,
                            "description",
                            content
                          )
                      : undefined
                  }
                  onImageClick={(src) =>
                    // Vault images get their filename as the caption; remote
                    // image URLs carry no meaningful name.
                    setLightbox({
                      src,
                      caption: relPathFromVaultUrl(src)?.split("/").pop()
                    })
                  }
                />
              )}
          </div>
        </ScrollArea>
      </div>
      {lightbox && (
        <ImageLightbox key={lightbox.src} image={lightbox} onClose={() => setLightbox(null)} />
      )}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteOpen(false);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{currentTitle}&rdquo;.
            </AlertDialogDescription>
            {deleteError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (isDeleting) return;
                setDeleteOpen(false);
                setDeleteError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={() => {
                void confirmDelete();
              }}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

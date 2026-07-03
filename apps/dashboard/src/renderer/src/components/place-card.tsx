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
import { ErrorTooltip } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import {
  VaultImage,
  isVaultRelativePath,
  vaultImageUrl
} from "@renderer/extensions/vault-image-extension";
import { WikilinkExtension, type WikilinkItem } from "@renderer/extensions/wikilink-extension";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { useDebouncedCallback } from "@renderer/hooks/use-debounced-callback";
import type { GeocodeSearchResult } from "@renderer/lib/geocode-search";
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
  MapPinPlus,
  Maximize2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { FileNode, PlaceRecord, PropertyType } from "../../../shared/types";
import { AutoSizeTextArea } from "./autosize-text-area";
import { FolderPickerPopover } from "./folder-picker-popover";
import { GeocodeSearchPanel } from "./geocode-search-panel";
import { ImageLightbox, type LightboxData } from "./image-lightbox";
import { PropertiesPanel } from "./properties-panel";

function formatPointLocationShort(geometryJson: string | undefined): string {
  if (!geometryJson) return "";
  try {
    const geo = JSON.parse(geometryJson) as {
      type: string;
      coordinates: [number, number];
    };
    if (geo.type === "Point" && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      const [lng, lat] = geo.coordinates;
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
  } catch {
    /* ignore */
  }
  return "Location";
}

function flattenMdFiles(nodes: FileNode[]): WikilinkItem[] {
  const result: WikilinkItem[] = [];
  for (const node of nodes) {
    if (node.type === "file" && node.name.endsWith(".md")) {
      result.push({ title: node.name.replace(/\.md$/i, ""), filePath: node.path });
    } else if (node.type === "directory" && node.children) {
      result.push(...flattenMdFiles(node.children));
    }
  }
  return result;
}

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
  onNavigate?: (place: PlaceRecord, newTab?: boolean) => void;
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
  onNavigate,
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
          const item = vaultFilesRef.current.find((f) => f.title === title);
          if (!item) return;
          const result = await window.api.places.getByPath(item.filePath);
          if (result) onNavigateRef.current?.(result as PlaceRecord, newTab);
        },
        suggestion: {
          items({ query }: { query: string }) {
            const q = query.toLowerCase();
            return vaultFilesRef.current
              .filter(
                (f) => f.filePath !== currentPathRef.current && f.title.toLowerCase().includes(q)
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
      vaultFilesRef.current = flattenMdFiles(nodes);
    });
  }, []);

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
  }, [editor, initialMarkdown]);

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
    <div className={cn("px-4 pb-3", mode === "full" && "flex-1 min-h-0")}>
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
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
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
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                )}
              >
                I
              </button>
              <div className="w-px h-3.5 bg-sidebar-border mx-0.5" />
              {editor.isActive("link") ? (
                <button
                  type="button"
                  onClick={() => editor.chain().focus().unsetLink().run()}
                  className="rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                  title="Remove link"
                >
                  <Link2OffIcon className="size-3" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openLinkInput}
                  className="rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                  title="Add link"
                >
                  <Link2Icon className="size-3" />
                </button>
              )}
            </div>
          )}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} className={cn("h-full", isDark && "dark")} />
    </div>
  );
}

export function PlaceCard({
  place,
  onClose,
  mode = "mini",
  onExpand,
  onNavigate,
  onSaveSearchToVault,
  defaultParentFolderPath = null,
  onCommitPointLocation,
  onClearPointLocation,
  onRename,
  onDelete,
  onOpenFolder
}: {
  place: PlaceRecord;
  onClose: () => void;
  mode?: "mini" | "full";
  onExpand?: () => void;
  onNavigate?: (place: PlaceRecord, newTab?: boolean) => void;
  /** When set with a search preview, shows Save (+) to create a place file in a chosen folder. */
  onSaveSearchToVault?: (folderPath: string | null) => Promise<void>;
  /** Folder highlighted as the default in the save picker. `null` = vault root. */
  defaultParentFolderPath?: string | null;
  /** Persist a point to the vault file; return whether the write succeeded. */
  onCommitPointLocation?: (filePath: string, lat: number, lng: number) => Promise<boolean>;
  /** Remove `geometry` from the vault file. */
  onClearPointLocation?: (filePath: string) => Promise<boolean>;
  /** Called after a successful file rename with the old and new paths. */
  onRename?: (oldPath: string, newPath: string) => void;
  /** Called after the place file has been deleted on disk. */
  onDelete?: (filePath: string) => void;
  /** Open a vault folder (breadcrumb click). Receives the absolute folder path. */
  onOpenFolder?: (folderPath: string) => void;
}): React.JSX.Element {
  const [currentFilePath, setCurrentFilePath] = useState(place.filePath);
  const [doc, setDoc] = useState<LoadedDoc>(() =>
    place.previewMarkdown !== undefined
      ? { kind: "preview", body: place.previewMarkdown ?? "" }
      : { kind: "loading" }
  );
  const [savingSearch, setSavingSearch] = useState(false);
  const [saveToVaultOpen, setSaveToVaultOpen] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [addLocationOpen, setAddLocationOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  // Set when "Rename" is chosen so the menu returns focus to the title input
  // (instead of its trigger) once it closes.
  const renameRequestedRef = useRef(false);
  const isDark = useDarkMode();

  const filePathBaseName =
    currentFilePath
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.(md|geojson)$/i, "") ?? "";
  const currentTitle = place.previewMarkdown !== undefined ? place.title : filePathBaseName;
  const [titleInput, setTitleInput] = useState(currentTitle);

  const loading = doc.kind === "loading";

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

  const handleSetCover = useCallback(
    async (relPath: string) => {
      const result = await window.api.fs.writeFrontmatterProperty(
        currentFilePath,
        "cover",
        relPath
      );
      if (result.success) {
        // A manually chosen cover has no Commons provenance — drop any stale link.
        await window.api.fs.writeFrontmatterProperty(currentFilePath, "cover_source", null);
        setDoc((d) => (d.kind === "vault" ? { ...d, cover: relPath, coverSource: undefined } : d));
      }
    },
    [currentFilePath]
  );

  async function handleRemoveCover() {
    const result = await window.api.fs.writeFrontmatterProperty(currentFilePath, "cover", null);
    if (result.success) {
      await window.api.fs.writeFrontmatterProperty(currentFilePath, "cover_source", null);
      setDoc((d) => (d.kind === "vault" ? { ...d, cover: undefined, coverSource: undefined } : d));
    }
  }

  const coverInputRef = useRef<HTMLInputElement>(null);

  async function handleCoverFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires a change event.
    e.target.value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await window.api.fs.importAttachment({ suggestedName: file.name, bytes });
    if (result.success) await handleSetCover(result.relPath);
  }

  useEffect(() => {
    void place.geometry;
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
        setDoc({ kind: "geojson-layer", properties, featureCount, geometryTypes });
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

  const vaultCover = coverPath && isVaultRelativePath(coverPath) ? coverPath : undefined;
  const coverVisible = Boolean(vaultCover) || remoteCover !== null;

  function openCoverLightbox(): void {
    if (vaultCover) {
      setLightbox({
        src: vaultImageUrl(vaultCover, coverRev),
        pageUrl: doc.kind === "vault" ? doc.coverSource : undefined
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
    1 +
    Number(place.previewMarkdown !== undefined && Boolean(onSaveSearchToVault)) +
    Number(Boolean(onExpand));

  const actionButtons = (
    <>
      {place.previewMarkdown !== undefined && onSaveSearchToVault && (
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
            <Button
              variant="ghost"
              size="icon"
              disabled={savingSearch}
              aria-label="Save place to vault"
              title="Save to folder"
            >
              <PlusIcon />
            </Button>
          }
        />
      )}
      {mode === "mini" && onExpand && (
        <Button variant="ghost" size="icon" onClick={onExpand} aria-label="Open full view">
          <Maximize2Icon />
        </Button>
      )}
      {mode === "full" && place.previewMarkdown === undefined && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" aria-label="More actions" />}
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
              Open in New Tab
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
                {coverPath ? "Change Cover Photo" : "Set Cover Photo"}
              </DropdownMenuItem>
            )}
            {doc.kind === "vault" && coverPath && (
              <DropdownMenuItem onClick={() => void handleRemoveCover()}>
                <ImageOffIcon />
                Remove Cover Photo
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
      )}
      <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
        <XIcon />
      </Button>
    </>
  );

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
          "relative bg-sidebar/95 backdrop-blur-md overflow-hidden flex flex-col",
          mode === "mini"
            ? "rounded-lg border border-sidebar-border shadow-lg max-h-72"
            : "h-full rounded-lg shadow-sm ring-1 ring-sidebar-border"
        )}
      >
        {mode === "mini" ? (
          /* Compact popup: actions pinned top-right over the content. */
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg bg-sidebar/60 backdrop-blur-sm">
            {actionButtons}
          </div>
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
                  src={vaultCover ? vaultImageUrl(vaultCover, coverRev) : remoteCover?.thumbUrl}
                  alt=""
                  draggable={false}
                  onError={vaultCover ? undefined : () => setRemoteCover(null)}
                  className={cn("w-full object-cover", mode === "mini" ? "h-28" : "h-40")}
                />
              </button>
            )}
            {/* Header */}
            <div className="flex items-start px-3 py-2 shrink-0">
              <div
                className="flex-1 min-w-0 pt-1"
                // In mini mode the pinned actions overlay the title row unless a
                // cover pushes it down — reserve their width.
                style={
                  mode === "mini" && !coverVisible
                    ? { paddingRight: miniActionCount * 36 }
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
                <div className="px-2 pb-4 shrink-0">
                  <Popover
                    open={addLocationOpen}
                    onOpenChange={handleAddLocationOpenChange}
                    modal={false}
                  >
                    <PopoverTrigger
                      render={
                        <button
                          type="button"
                          className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-sidebar-foreground ring-sidebar-ring outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
                        >
                          {place.geometry ? (
                            <MapPinIcon className="size-4 shrink-0" />
                          ) : (
                            <MapPinPlus className="size-4 shrink-0" />
                          )}
                          <span className="truncate">
                            {place.geometry
                              ? formatPointLocationShort(place.geometry)
                              : "Add a location"}
                          </span>
                        </button>
                      }
                    />
                    <PopoverContent className="w-96 p-0" align="start" side="bottom" sideOffset={6}>
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
                  allVaultKeyTypes={[]}
                />
              )}
            {doc.kind === "geojson-layer" &&
              (() => {
                const GJ_EXCLUDED = new Set(["name", "description"]);
                const gjFrontmatter = Object.fromEntries(
                  Object.entries(doc.properties).filter(([k]) => !GJ_EXCLUDED.has(k))
                );
                return (
                  <PropertiesPanel
                    filePath={currentFilePath}
                    frontmatter={gjFrontmatter}
                    allVaultKeyTypes={[]}
                    onWriteProperty={async (key, value) => {
                      await window.api.fs.writeGeoJsonProperty(currentFilePath, key, value);
                    }}
                    reorderable={false}
                  />
                );
              })()}

            {/* Body content */}
            {loading && (
              <div className="px-4 pb-3 text-sm text-sidebar-foreground/50">Loading…</div>
            )}
            {doc.kind === "error" && (
              <div className="px-4 pb-3 text-sm text-destructive">{doc.message}</div>
            )}
            {!loading && doc.kind !== "error" && (
              <PlaceCardMarkdownPane
                filePath={currentFilePath}
                initialMarkdown={
                  doc.kind === "geojson-layer" ? String(doc.properties.description ?? "") : doc.body
                }
                isPreview={doc.kind === "preview"}
                mode={mode}
                isDark={isDark}
                onNavigate={onNavigate}
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
                onImageClick={(src) => setLightbox({ src })}
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
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

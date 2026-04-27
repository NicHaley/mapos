import { WikilinkExtension, type WikilinkItem } from "@renderer/extensions/wikilink-extension";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { useDebouncedCallback } from "@renderer/hooks/use-debounced-callback";
import type { PhotonSearchResult } from "@renderer/lib/photon";
import { cn } from "@mapos/ui/lib/utils";
import { type Editor, Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import {
  Link2Icon,
  Link2OffIcon,
  MapPinIcon,
  MapPinPlus,
  Maximize2Icon,
  PlusIcon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileNode, PlaceRecord } from "../../../shared/types";
import { AutoSizeTextArea } from "./autosize-text-area";
import { PhotonSearchPanel } from "./photon-search-panel";
import { PropertiesPanel } from "./properties-panel";
import { InputGroupButton } from "@mapos/ui/components/input-group";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mapos/ui/components/popover";
import { ScrollArea } from "@mapos/ui/components/scroll-area";
import { ErrorTooltip } from "@mapos/ui/components/tooltip";

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
  | { kind: "vault"; body: string; frontmatter: Record<string, unknown>; keys: string[] }
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
  onPersist
}: PlaceCardMarkdownPaneProps): React.JSX.Element {
  const vaultFilesRef = useRef<WikilinkItem[]>([]);
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
        link: { openOnClick: false }
      }),
      Markdown,
      TabIndent,
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
    <ScrollArea className={cn("overflow-y-auto px-4 pb-3", mode === "full" && "flex-1 min-h-0")}>
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
    </ScrollArea>
  );
}

export function PlaceCard({
  place,
  onClose,
  mode = "mini",
  onExpand,
  onNavigate,
  onSaveSearchToVault,
  onCommitPointLocation,
  onClearPointLocation,
  onRename
}: {
  place: PlaceRecord;
  onClose: () => void;
  mode?: "mini" | "full";
  onExpand?: () => void;
  onNavigate?: (place: PlaceRecord, newTab?: boolean) => void;
  /** When set with a search preview, shows Save (+) to create a place file in the active folder. */
  onSaveSearchToVault?: () => Promise<void>;
  /** Persist a point to the vault file; return whether the write succeeded. */
  onCommitPointLocation?: (filePath: string, lat: number, lng: number) => Promise<boolean>;
  /** Remove `geometry` from the vault file. */
  onClearPointLocation?: (filePath: string) => Promise<boolean>;
  /** Called after a successful file rename with the old and new paths. */
  onRename?: (oldPath: string, newPath: string) => void;
}): React.JSX.Element {
  const [currentFilePath, setCurrentFilePath] = useState(place.filePath);
  const [doc, setDoc] = useState<LoadedDoc>(() =>
    place.previewMarkdown !== undefined
      ? { kind: "preview", body: place.previewMarkdown ?? "" }
      : { kind: "loading" }
  );
  const [savingSearch, setSavingSearch] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [addLocationOpen, setAddLocationOpen] = useState(false);
  const editorRef = useRef<Editor | null>(null);
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
        keys: vaultKeys
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
          setTitleInput(currentTitle);
          setTitleError(null);
          (active as HTMLElement).blur();
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

  const handleAddLocationOpenChange = useCallback((open: boolean) => {
    setAddLocationOpen(open);
  }, []);

  const handleAddLocationSearchSelect = useCallback(
    async (r: PhotonSearchResult) => {
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

  function handleTitleEnter() {
    if (place.previewMarkdown !== undefined) return;
    const error = validateTitle(titleInput);
    setTitleError(error);
    if (!error) {
      (document.activeElement as HTMLElement | null)?.blur();
      editorRef.current?.chain().focus().run();
    }
  }

  return (
    <div
      className={cn("pointer-events-auto", mode === "full" ? "h-full" : undefined)}
      style={mode === "mini" ? { width: 272 } : undefined}
    >
      <div
        className={cn(
          "bg-sidebar/80 backdrop-blur-md overflow-hidden flex flex-col",
          mode === "mini"
            ? "rounded-lg border border-sidebar-border shadow-lg max-h-[calc(100vh-3.5rem)]"
            : "h-full rounded-lg shadow-sm ring-1 ring-sidebar-border"
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-2 px-4 pt-4 pb-3 shrink-0">
          <div className="flex-1 min-w-0">
            <ErrorTooltip error={titleError}>
              <AutoSizeTextArea
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
            {/* {doc.kind === "geojson-layer" && (
              <div className="mt-0.5 text-xs text-sidebar-foreground/50">
                {doc.featureCount} feature{doc.featureCount !== 1 ? "s" : ""}
                {doc.geometryTypes.length > 0 && ` · ${doc.geometryTypes.join(", ")}`}
              </div>
            )} */}
          </div>
          {place.previewMarkdown !== undefined && onSaveSearchToVault && (
            <button
              type="button"
              disabled={savingSearch}
              onClick={() => {
                void (async () => {
                  setSavingSearch(true);
                  try {
                    await onSaveSearchToVault();
                  } finally {
                    setSavingSearch(false);
                  }
                })();
              }}
              className="shrink-0 mt-0.5 rounded p-1 hover:bg-sidebar-accent text-sidebar-foreground/40 hover:text-sidebar-foreground transition-colors disabled:opacity-50"
              aria-label="Save place to vault"
              title="Save to active folder"
            >
              <PlusIcon className="size-3.5" />
            </button>
          )}
          {mode === "mini" && onExpand && (
            <button
              onClick={onExpand}
              className="shrink-0 mt-0.5 rounded p-1 hover:bg-sidebar-accent text-sidebar-foreground/40 hover:text-sidebar-foreground transition-colors"
              type="button"
              aria-label="Open full view"
            >
              <Maximize2Icon className="size-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="shrink-0 mt-0.5 rounded p-1 hover:bg-sidebar-accent text-sidebar-foreground/40 hover:text-sidebar-foreground transition-colors"
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
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
                  <PhotonSearchPanel
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
            allVaultKeys={doc.keys}
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
                allVaultKeys={[]}
                onWriteProperty={async (key, value) => {
                  await window.api.fs.writeGeoJsonProperty(currentFilePath, key, value);
                }}
                reorderable={false}
              />
            );
          })()}

        {/* Body content */}
        {loading && <div className="px-4 pb-3 text-sm text-sidebar-foreground/50">Loading…</div>}
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
                    void window.api.fs.writeGeoJsonProperty(currentFilePath, "description", content)
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

import { WikilinkExtension, type WikilinkItem } from "@renderer/extensions/WikilinkExtension";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { cn } from "@renderer/lib/utils";
import Link from "@tiptap/extension-link";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Link2Icon, Link2OffIcon, MapPinIcon, Maximize2Icon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FileNode, PlaceRecord, PropertyTypes } from "../../../shared/types";
import { PropertiesPanel } from "./PropertiesPanel";
import { ScrollArea } from "./ui/scroll-area";
import { ErrorTooltip } from "./ui/tooltip";

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

export function PlaceCard({
  place,
  onClose,
  mode = "mini",
  onExpand,
  onNavigate,
  onSaveSearchToVault
}: {
  place: PlaceRecord;
  onClose: () => void;
  mode?: "mini" | "full";
  onExpand?: () => void;
  onNavigate?: (place: PlaceRecord, newTab?: boolean) => void;
  /** When set with a search preview, shows Save (+) to create a place file in the active folder. */
  onSaveSearchToVault?: () => Promise<void>;
}): React.JSX.Element {
  const [currentFilePath, setCurrentFilePath] = useState(place.filePath);
  const [loading, setLoading] = useState(false);
  const [savingSearch, setSavingSearch] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const isLoadingRef = useRef(false);
  const vaultFilesRef = useRef<WikilinkItem[]>([]);
  const currentFilePathRef = useRef(currentFilePath);
  currentFilePathRef.current = currentFilePath;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const isDark = useDarkMode();
  const [linkUrl, setLinkUrl] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [propertyTypes, setPropertyTypes] = useState<PropertyTypes>({});
  const [propertyOrder, setPropertyOrder] = useState<string[]>([]);
  const linkInputRef = useRef<HTMLInputElement>(null);

  const filePathBaseName = currentFilePath.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ?? "";
  const currentTitle = place.previewMarkdown !== undefined ? place.title : filePathBaseName;
  const [titleInput, setTitleInput] = useState(currentTitle);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }),
      Markdown,
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
                (f) =>
                  f.filePath !== currentFilePathRef.current && f.title.toLowerCase().includes(q)
              )
              .slice(0, 20);
          }
        }
      })
    ],
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none text-sidebar-foreground min-h-[4rem] focus:outline-none"
      }
    },
    onUpdate({ editor: e }) {
      if (isLoadingRef.current) return;
      handleEditorChange(e.getMarkdown());
    }
  });

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
    setTitleInput(currentTitle);
  }, [currentTitle]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(place.previewMarkdown === undefined);
  }, [editor, place.previewMarkdown]);

  useEffect(() => {
    if (!editor) return;
    setCurrentFilePath(place.filePath);
    setLoading(true);
    isLoadingRef.current = true;
    if (place.previewMarkdown !== undefined) {
      editor.commands.setContent(place.previewMarkdown || "", { contentType: "markdown" });
      setLoading(false);
      isLoadingRef.current = false;
      return;
    }
    window.api.fs.readFile(place.filePath).then((result) => {
      if ("error" in result) {
        setLoading(false);
        isLoadingRef.current = false;
        return;
      }
      editor.commands.setContent(result.body, { contentType: "markdown" });
      setFrontmatter(result.frontmatter);
      setLoading(false);
      isLoadingRef.current = false;
    });
  }, [place.filePath, place.previewMarkdown, editor]);

  useEffect(() => {
    window.api.fs.listDir().then((nodes) => {
      vaultFilesRef.current = flattenMdFiles(nodes);
    });
  }, []);

  useEffect(() => {
    Promise.all([window.api.properties.readTypes(), window.api.properties.readOrder()]).then(
      ([types, order]) => {
        setPropertyTypes(types);
        setPropertyOrder(order);
      }
    );
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  function handleEditorChange(markdown: string) {
    if (place.previewMarkdown !== undefined) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      await window.api.fs.writePlaceBody(currentFilePath, markdown);
    }, 600);
  }

  function validateTitle(name: string): string | null {
    if (!name.trim()) return "Name cannot be empty";
    if (/[/\\:*?"<>|]/.test(name)) return "Name contains invalid characters";
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
      setCurrentFilePath(result.newPath);
      setTitleError(null);
    } else {
      setTitleError(result.error ?? "Rename failed");
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const error = validateTitle(titleInput);
      setTitleError(error);
      if (!error) {
        e.currentTarget.blur();
        editor?.commands.focus();
      }
    }
  }

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

  const fileName = currentFilePath.split(/[/\\]/).pop() ?? currentFilePath;

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
            <p className="text-[11px] font-medium text-sidebar-foreground/40 uppercase tracking-widest mb-0.5">
              {place.type}
            </p>
            <ErrorTooltip error={titleError}>
              <input
                type="text"
                value={titleInput}
                readOnly={place.previewMarkdown !== undefined}
                onChange={(e) => {
                  setTitleInput(e.target.value);
                  setTitleError(validateTitle(e.target.value));
                }}
                aria-label="Place name"
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                spellCheck={false}
                className={cn(
                  "w-full min-w-0 text-2xl font-semibold text-sidebar-foreground leading-snug rounded transition-colors focus:outline-none bg-transparent border-0 p-0 shadow-none",
                  place.previewMarkdown !== undefined ? "cursor-default" : "cursor-text",
                  titleError && "ring-2 ring-inset ring-destructive"
                )}
              />
            </ErrorTooltip>
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

        {/* Tags */}
        {place.tags && place.tags.length > 0 && (
          <div className="px-4 pb-3 flex flex-wrap gap-1 shrink-0">
            {place.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-sidebar-accent px-2 py-0.5 text-[11px] text-sidebar-foreground/60"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Properties */}
        {place.previewMarkdown === undefined && (
          <PropertiesPanel
            filePath={currentFilePath}
            frontmatter={frontmatter}
            propertyTypes={propertyTypes}
            propertyOrder={propertyOrder}
            onTypesChange={setPropertyTypes}
            onOrderChange={setPropertyOrder}
          />
        )}

        {/* Body content */}
        {!loading && (
          <ScrollArea
            className={cn("overflow-y-auto px-4 pb-3", mode === "full" && "flex-1 min-h-0")}
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
            <EditorContent editor={editor} className={cn(isDark && "dark")} />
          </ScrollArea>
        )}

        {/* Footer: coords + file */}
        <div className="border-t border-sidebar-border px-4 py-2.5 flex items-center justify-between gap-2 shrink-0 mt-auto">
          <div className="flex items-center gap-1.5 text-[11px] text-sidebar-foreground/40">
            <MapPinIcon className="size-3 shrink-0" />
            <span>
              {(() => {
                try {
                  if (!place.geometry) return "—";
                  const geo = JSON.parse(place.geometry) as {
                    type: string;
                    coordinates: [number, number];
                  };
                  if (geo.type === "Point") {
                    return `${geo.coordinates[1].toFixed(4)}, ${geo.coordinates[0].toFixed(4)}`;
                  }
                  return geo.type;
                } catch {
                  return "—";
                }
              })()}
            </span>
          </div>
          {place.previewMarkdown === undefined ? (
            <span
              className="text-[11px] text-sidebar-foreground/30 truncate max-w-[100px]"
              title={currentFilePath}
            >
              {fileName}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

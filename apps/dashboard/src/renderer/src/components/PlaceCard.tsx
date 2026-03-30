import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { cn } from "@renderer/lib/utils";
import Link from "@tiptap/extension-link";
import { Markdown } from "@tiptap/markdown";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Link2Icon, Link2OffIcon, MapPinIcon, Maximize2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlaceRecord } from "./MapView";
import { ScrollArea } from "./ui/scroll-area";
import { ErrorTooltip } from "./ui/tooltip";

export function PlaceCard({
  place,
  onClose,
  mode = "mini",
  onExpand
}: {
  place: PlaceRecord;
  onClose: () => void;
  mode?: "mini" | "full";
  onExpand?: () => void;
}): React.JSX.Element {
  const [currentFilePath, setCurrentFilePath] = useState(place.filePath);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const isLoadingRef = useRef(false);
  const isDark = useDarkMode();
  const [linkUrl, setLinkUrl] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const linkInputRef = useRef<HTMLInputElement>(null);

  const currentTitle = currentFilePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false }), Markdown],
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
        if (document.activeElement === titleRef.current) {
          if (titleRef.current) titleRef.current.textContent = currentTitle;
          setTitleError(null);
          titleRef.current?.blur();
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, currentTitle]);

  useEffect(() => {
    if (!editor) return;
    setCurrentFilePath(place.filePath);
    setLoading(true);
    isLoadingRef.current = true;
    window.api.fs.readFile(place.filePath).then((result) => {
      if ("error" in result) {
        setLoading(false);
        isLoadingRef.current = false;
        return;
      }
      editor.commands.setContent(result.body);
      setLoading(false);
      isLoadingRef.current = false;
    });
  }, [place.filePath, editor]);

  useEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== currentTitle) {
      titleRef.current.textContent = currentTitle;
    }
  }, [currentTitle]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  function handleEditorChange(markdown: string) {
    if (saving) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      await window.api.fs.writePlaceBody(currentFilePath, markdown);
      setSaving(false);
    }, 600);
  }

  function validateTitle(name: string): string | null {
    if (!name.trim()) return "Name cannot be empty";
    if (/[/\\:*?"<>|]/.test(name)) return "Name contains invalid characters";
    return null;
  }

  function handleTitleInput() {
    const text = titleRef.current?.textContent ?? "";
    setTitleError(validateTitle(text));
  }

  async function handleTitleBlur() {
    const newName = titleRef.current?.textContent?.trim() ?? "";
    const error = validateTitle(newName);
    if (error || newName === currentTitle) {
      if (titleRef.current) titleRef.current.textContent = currentTitle;
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

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLHeadingElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const text = titleRef.current?.textContent ?? "";
      const error = validateTitle(text);
      setTitleError(error);
      if (!error) {
        titleRef.current?.blur();
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

  const fileName = currentFilePath.split("/").pop() ?? currentFilePath;

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
              <h2
                ref={titleRef}
                contentEditable
                suppressContentEditableWarning
                aria-label="Place name"
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                onInput={handleTitleInput}
                spellCheck={false}
                className={cn(
                  "text-2xl font-semibold text-sidebar-foreground leading-snug cursor-text rounded transition-colors focus:outline-none",
                  titleError && "ring-2 ring-inset ring-destructive"
                )}
              >
                {currentTitle}
              </h2>
            </ErrorTooltip>
          </div>
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

        {/* Body content */}
        {!loading && (
          <ScrollArea
            className={cn("overflow-y-auto px-4 pb-3", mode === "full" && "flex-1 min-h-0")}
          >
            {editor && (
              <BubbleMenu
                editor={editor}
                tippyOptions={{ duration: 100, onHide: () => setShowLinkInput(false) }}
              >
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
          <span
            className="text-[11px] text-sidebar-foreground/30 truncate max-w-[100px]"
            title={currentFilePath}
          >
            {fileName}
          </span>
        </div>
      </div>
    </div>
  );
}

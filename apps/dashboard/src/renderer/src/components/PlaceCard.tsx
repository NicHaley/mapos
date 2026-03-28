import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  thematicBreakPlugin
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { cn } from "@renderer/lib/utils";
import { MapPinIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlaceRecord } from "./MapView";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";
import { ErrorTooltip } from "./ui/tooltip";

export function PlaceCard({
  place,
  onClose,
  sidebarOpen = true
}: {
  place: PlaceRecord;
  onClose: () => void;
  sidebarOpen?: boolean;
}): React.JSX.Element {
  const [currentFilePath, setCurrentFilePath] = useState(place.filePath);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const editorRef = useRef<MDXEditorMethods>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDark = useDarkMode();

  const currentTitle = currentFilePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";

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
    setCurrentFilePath(place.filePath);
    setLoading(true);
    window.api.fs.readFile(place.filePath).then((result) => {
      if ("error" in result) {
        setLoading(false);
        return;
      }
      editorRef.current?.setMarkdown(result.body);
      setLoading(false);
    });
  }, [place.filePath]);

  useEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== currentTitle) {
      titleRef.current.textContent = currentTitle;
    }
  }, [currentTitle]);

  // Cleanup save timer on unmount
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
        editorRef.current?.focus();
      }
    }
  }

  const fileName = currentFilePath.split("/").pop() ?? currentFilePath;

  return (
    <div
      className="fixed z-20 pointer-events-auto top-2 transition-[left] duration-200 ease-linear"
      style={{ left: sidebarOpen ? "calc(16rem + 0.25rem)" : "0.75rem", width: 272 }}
    >
      <div className="rounded-lg border border-sidebar-border bg-sidebar/80 backdrop-blur-md shadow-lg overflow-hidden flex flex-col max-h-[calc(100vh-3.5rem)]">
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
        {loading && <Skeleton className="mx-4 mb-3 h-16 rounded shrink-0" />}

        {!loading && (
          <ScrollArea className="overflow-y-auto px-4 pb-3">
            <MDXEditor
              ref={editorRef}
              markdown=""
              onChange={handleEditorChange}
              className={isDark ? "dark-theme dark-editor" : undefined}
              plugins={[
                headingsPlugin(),
                listsPlugin(),
                quotePlugin(),
                thematicBreakPlugin(),
                linkPlugin(),
                markdownShortcutPlugin()
              ]}
              placeholder="Add notes…"
              contentEditableClassName="prose prose-sm dark:prose-invert max-w-none text-sidebar-foreground text-[13px] min-h-[4rem] focus:outline-none !p-0"
            />
          </ScrollArea>
        )}

        {/* Footer: coords + file */}
        <div className="border-t border-sidebar-border px-4 py-2.5 flex items-center justify-between gap-2 shrink-0">
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

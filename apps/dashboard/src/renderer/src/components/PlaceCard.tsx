import { cn } from "@renderer/lib/utils";
import { MapPinIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { PlaceRecord } from "./MapView";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";

const STATUS_META: Record<string, { label: string; className: string }> = {
  "want-to-go": { label: "Want to go", className: "text-blue-500" },
  visited: { label: "Visited", className: "text-green-500" },
  maybe: { label: "Maybe", className: "text-amber-500" }
};

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
  const [body, setBody] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleMode, setTitleMode] = useState<"view" | "edit">("view");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const currentTitle = currentFilePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (mode === "edit") {
          setMode("view");
        } else if (titleMode === "edit") {
          setTitleMode("view");
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, mode, titleMode]);

  useEffect(() => {
    setCurrentFilePath(place.filePath);
    setBody(null);
    setMode("view");
    setTitleMode("view");
    setLoading(true);
    window.api.fs.readFile(place.filePath).then((result) => {
      if ("error" in result) {
        setLoading(false);
        return;
      }
      setBody(result.body);
      setLoading(false);
    });
  }, [place.filePath]);

  // Auto-resize textarea to fit content
  useEffect(() => {
    if (mode === "edit" && textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
    }
  }, [mode]);

  useEffect(() => {
    if (titleMode === "edit") titleInputRef.current?.focus();
  }, [titleMode]);

  function handleBodyClick() {
    if (mode === "view" && body !== null) {
      setDraft(body);
      setMode("edit");
    }
  }

  async function handleBlur() {
    if (mode !== "edit" || saving) return;
    setSaving(true);
    const result = await window.api.fs.writePlaceBody(currentFilePath, draft);
    if (result.success) {
      setBody(draft.trim());
    }
    setSaving(false);
    setMode("view");
  }

  function handleTitleClick() {
    setTitleDraft(currentTitle);
    setTitleMode("edit");
  }

  async function handleTitleBlur() {
    const newName = titleDraft.trim();
    if (!newName || newName === currentTitle) {
      setTitleMode("view");
      return;
    }
    const result = await window.api.fs.renameFile(currentFilePath, newName as string);
    if (result.success) {
      setCurrentFilePath(result.newPath);
    }
    setTitleMode("view");
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      titleInputRef.current?.blur();
    } else if (e.key === "Escape") {
      setTitleMode("view");
    }
  }

  const status = STATUS_META[place.status];
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
              {place.category ?? place.type}
            </p>
            {titleMode === "view" ? (
              <h2
                onClick={handleTitleClick}
                className="text-sm font-semibold text-sidebar-foreground leading-snug cursor-text hover:bg-sidebar-accent/40 rounded px-0.5 -mx-0.5 transition-colors"
              >
                {currentTitle}
              </h2>
            ) : (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                className="w-full text-sm font-semibold text-sidebar-foreground bg-sidebar border border-sidebar-ring rounded px-0.5 -mx-0.5 focus:outline-none"
                spellCheck={false}
              />
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 mt-0.5 rounded p-1 hover:bg-sidebar-accent text-sidebar-foreground/40 hover:text-sidebar-foreground transition-colors"
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        {/* Status */}
        {status && (
          <div className="px-4 pb-3 shrink-0">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-sidebar-accent",
                status.className
              )}
            >
              {status.label}
            </span>
          </div>
        )}

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
            {mode === "view" ? (
              <div
                onClick={handleBodyClick}
                className={cn(
                  "min-h-[2rem] rounded cursor-text",
                  body ? "hover:bg-sidebar-accent/40 transition-colors" : "flex items-center"
                )}
              >
                {body ? (
                  <Streamdown className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-sidebar-foreground text-[13px]">
                    {body}
                  </Streamdown>
                ) : (
                  <span className="text-[12px] text-sidebar-foreground/30 italic select-none">
                    Click to add notes…
                  </span>
                )}
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={handleBlur}
                className="w-full min-h-[4rem] resize-none rounded border border-sidebar-border bg-sidebar font-mono text-xs text-sidebar-foreground focus:outline-none focus:ring-1 focus:ring-sidebar-ring p-2 overflow-hidden"
                spellCheck={false}
              />
            )}
          </ScrollArea>
        )}

        {/* Footer: coords + file */}
        <div className="border-t border-sidebar-border px-4 py-2.5 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-[11px] text-sidebar-foreground/40">
            <MapPinIcon className="size-3 shrink-0" />
            <span>
              {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
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

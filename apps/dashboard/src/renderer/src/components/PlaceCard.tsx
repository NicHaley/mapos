import { cn } from "@renderer/lib/utils";
import { MapPinIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import type { PlaceRecord } from "./MapView";

const STATUS_META: Record<string, { label: string; className: string }> = {
  "want-to-go": { label: "Want to go", className: "text-blue-500" },
  visited: { label: "Visited", className: "text-green-500" },
  maybe: { label: "Maybe", className: "text-amber-500" }
};

export function PlaceCard({
  place,
  onClose
}: {
  place: PlaceRecord;
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const status = STATUS_META[place.status];
  const fileName = place.filePath.split("/").pop() ?? place.filePath;

  return (
    <div
      className="fixed z-20 pointer-events-auto top-2"
      style={{ left: "calc(16rem + 0.75rem)", width: 272 }}
    >
      <div className="rounded-lg border border-sidebar-border bg-sidebar/80 backdrop-blur-md shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-2 px-4 pt-4 pb-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium text-sidebar-foreground/40 uppercase tracking-widest mb-0.5">
              {place.category ?? place.type}
            </p>
            <h2 className="text-sm font-semibold text-sidebar-foreground leading-snug">
              {place.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 mt-0.5 rounded p-1 hover:bg-sidebar-accent text-sidebar-foreground/40 hover:text-sidebar-foreground transition-colors"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        {/* Status */}
        {status && (
          <div className="px-4 pb-3">
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
          <div className="px-4 pb-3 flex flex-wrap gap-1">
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

        {/* Footer: coords + file */}
        <div className="border-t border-sidebar-border px-4 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-sidebar-foreground/40">
            <MapPinIcon className="size-3 shrink-0" />
            <span>
              {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
            </span>
          </div>
          <span
            className="text-[11px] text-sidebar-foreground/30 truncate max-w-[100px]"
            title={place.filePath}
          >
            {fileName}
          </span>
        </div>
      </div>
    </div>
  );
}

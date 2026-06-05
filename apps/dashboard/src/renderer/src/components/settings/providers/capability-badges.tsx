import { Badge } from "@mapos/ui/components/badge";
import { cn } from "@mapos/ui/lib/utils";
import { type ModelCapabilities, formatContextWindow } from "@shared/ai-models";
import type { CapabilitySource } from "@shared/ai-providers";
import { EyeIcon, SparklesIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";

/**
 * Glanceable capability summary for a model. The tools badge is the important one for MapOS:
 * a model with no tool support can't drive the vault tools, so it's flagged as a warning rather
 * than just omitted. `assumed` marks capabilities we couldn't fetch and are defaulting.
 *
 * `compact` renders a dense, icons-only row (context number + bare capability icons) for the tight
 * monospace rows in the model picker, where full pills would be too heavy.
 */
export function CapabilityBadges({
  caps,
  source,
  compact = false
}: {
  caps: ModelCapabilities;
  source?: CapabilitySource;
  compact?: boolean;
}): React.JSX.Element {
  if (compact) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-xs tabular-nums">{formatContextWindow(caps.contextWindow)}</span>
        {caps.supportsTools ? (
          <WrenchIcon className="size-3.5" aria-label="Tools" />
        ) : (
          <TriangleAlertIcon className="size-3.5 text-destructive" aria-label="No tools" />
        )}
        {caps.supportsImages && <EyeIcon className="size-3.5" aria-label="Vision" />}
        {caps.thinking !== "off" && <SparklesIcon className="size-3.5" aria-label="Thinking" />}
        {source === "assumed" && <span className={cn("text-[10px] uppercase")}>assumed</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant="secondary">{formatContextWindow(caps.contextWindow)} context</Badge>
      {caps.supportsTools ? (
        <Badge variant="secondary">
          <WrenchIcon />
          Tools
        </Badge>
      ) : (
        <Badge variant="destructive">
          <TriangleAlertIcon />
          No tools
        </Badge>
      )}
      {caps.supportsImages && (
        <Badge variant="secondary">
          <EyeIcon />
          Vision
        </Badge>
      )}
      {caps.thinking !== "off" && (
        <Badge variant="secondary">
          <SparklesIcon />
          Thinking
        </Badge>
      )}
      {source === "assumed" && <Badge variant="outline">assumed</Badge>}
    </div>
  );
}

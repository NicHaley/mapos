import { Badge } from "@mapos/ui/components/badge";
import { type ModelCapabilities, formatContextWindow } from "@shared/ai-models";
import type { CapabilitySource } from "@shared/ai-providers";
import { EyeIcon, SparklesIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";

/**
 * Glanceable capability summary for a model. The tools badge is the important one for MapOS:
 * a model with no tool support can't drive the vault tools, so it's flagged as a warning rather
 * than just omitted. `assumed` marks capabilities we couldn't fetch and are defaulting.
 */
export function CapabilityBadges({
  caps,
  source
}: {
  caps: ModelCapabilities;
  source?: CapabilitySource;
}): React.JSX.Element {
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

import { cn } from "@mapos/ui/lib/utils";
import { WrenchIcon } from "lucide-react";
import { SiAnthropic, SiOllama } from "react-icons/si";

export function ProviderBadge({
  kind,
  size = "md"
}: {
  kind: "cloud" | "local" | "custom";
  size?: "sm" | "md";
}): React.JSX.Element {
  const styles =
    kind === "cloud"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : kind === "local"
        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        : "bg-muted text-muted-foreground";
  const wrapper = size === "sm" ? "size-5 rounded" : "size-7 rounded-md";
  const icon = size === "sm" ? "size-3" : "size-4";
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center text-xs font-semibold",
        wrapper,
        styles
      )}
    >
      {kind === "cloud" ? (
        <SiAnthropic className={icon} />
      ) : kind === "local" ? (
        <SiOllama className={icon} />
      ) : (
        <WrenchIcon className={icon} />
      )}
    </span>
  );
}

import { CircularProgress } from "@mapos/ui/components/circular-progress";
import { cn } from "@mapos/ui/lib/utils";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { ProviderBadge } from "./provider-badge";

export function ModelRow({
  kind,
  label,
  meta,
  selected,
  disabled,
  onClick,
  pulling,
  pullPercent,
  trailing
}: {
  kind: "cloud" | "local" | "custom";
  label: string;
  meta?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  pulling?: boolean;
  pullPercent?: number;
  /** Glanceable static info rendered before the disclosure chevron (e.g. size label, cloud icon). Action buttons live in the detail sheet's footer instead. */
  trailing?: React.ReactNode;
}): React.JSX.Element {
  // Pulling rows stay clickable so the user can open the detail sheet to cancel.
  const interactive = !disabled;
  return (
    // biome-ignore lint/a11y/useSemanticElements: div + role + onKeyDown matches a button's a11y semantics without inheriting <button>'s default form-submission and styling.
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-disabled={!interactive || undefined}
      onClick={() => {
        if (interactive) onClick();
      }}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex items-center gap-3 border-l-2 border-l-transparent px-3 py-2.5 transition-colors",
        selected && "border-l-emerald-500 bg-accent",
        interactive && !selected && "hover:bg-accent/40",
        interactive ? "cursor-pointer" : "cursor-default",
        disabled && "opacity-50"
      )}
    >
      <ProviderBadge kind={kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          {selected && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
        </div>
        {meta && <div className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pulling ? (
          <CircularProgress percent={pullPercent ?? 0} className="text-emerald-500" />
        ) : (
          trailing
        )}
        <ChevronRightIcon className="size-4 text-muted-foreground/60" aria-hidden />
      </div>
    </div>
  );
}

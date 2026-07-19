import { Button } from "@mapos/ui/components/button";
import { ProviderBadge } from "./provider-badge";

/** The popular catalog providers offered in the zero-provider empty state. */
const POPULAR_PROVIDERS: { name: string; label: string }[] = [
  { name: "anthropic", label: "Anthropic" },
  { name: "openai-codex", label: "Codex" },
  { name: "github-copilot", label: "Copilot" }
];

/**
 * Shown when no providers are configured yet — a guided path that opens the connect drawer for a
 * popular catalog provider (or a custom endpoint) so the list never dead-ends on an empty box.
 *
 * `showHeading` is on by default for Settings; onboarding passes `false` because its own step header
 * already names the section, so the inner "No providers yet" title would be redundant.
 */
export function ProvidersEmptyState({
  onPick,
  onCustom,
  onBrowseAll,
  showHeading = true
}: {
  onPick: (name: string, label: string) => void;
  onCustom: () => void;
  onBrowseAll: () => void;
  showHeading?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      {showHeading && (
        <>
          <div className="font-medium text-sm">No providers yet</div>
          <p className="mt-0.5 text-muted-foreground text-xs">Add a provider to pick a model.</p>
        </>
      )}
      <div className={`flex items-start justify-center gap-2 ${showHeading ? "mt-5" : ""}`}>
        {POPULAR_PROVIDERS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onPick(p.name, p.label)}
            className="flex w-20 flex-col items-center gap-2 rounded-lg p-2 transition-colors hover:bg-hover"
          >
            <ProviderBadge knownProvider={p.name} label={p.label} size="lg" />
            <span className="text-xs font-medium leading-tight">{p.label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onCustom}
          className="flex w-20 flex-col items-center gap-2 rounded-lg p-2 transition-colors hover:bg-hover"
        >
          <ProviderBadge label="Custom" size="lg" />
          <span className="text-xs font-medium leading-tight">Custom</span>
        </button>
      </div>
      <Button variant="link" size="sm" className="mt-4" onClick={onBrowseAll}>
        See all providers
      </Button>
    </div>
  );
}

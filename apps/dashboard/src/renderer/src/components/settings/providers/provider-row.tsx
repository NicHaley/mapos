import { Button } from "@mapos/ui/components/button";
import type { ProviderView } from "@shared/ai-providers";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { ProviderBadge } from "./provider-badge";

/** A glanceable connection-status label for a provider row. */
function ProviderStatus({ p }: { p: ProviderView }): React.JSX.Element {
  const ok = "font-medium text-emerald-600 text-xs dark:text-emerald-400";
  const muted = "text-muted-foreground text-xs";
  if (p.knownProvider) {
    if (p.auth.configured) {
      return <span className={ok}>{p.auth.method === "oauth" ? "Signed in" : "API key set"}</span>;
    }
    return <span className={muted}>Not connected</span>;
  }
  if (p.auth.method === "none") return <span className={muted}>No auth</span>;
  return p.auth.configured ? (
    <span className={ok}>Connected</span>
  ) : (
    <span className={muted}>No token</span>
  );
}

/**
 * A configured-provider row: badge, label/endpoint, connection status, and edit/delete actions.
 * Shared by the Settings providers list and the onboarding AI step so both stay consistent.
 */
export function ProviderRow({
  provider,
  onEdit,
  onDelete
}: {
  provider: ProviderView;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40">
      <ProviderBadge knownProvider={provider.knownProvider} label={provider.label} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{provider.label}</div>
        {!provider.knownProvider && (
          <div className="truncate text-muted-foreground text-xs">{provider.baseUrl}</div>
        )}
      </div>
      <ProviderStatus p={provider} />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={provider.knownProvider ? "Manage connection" : "Edit provider"}
        onClick={onEdit}
      >
        <PencilIcon className="size-4 text-muted-foreground" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Delete provider" onClick={onDelete}>
        <Trash2Icon className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

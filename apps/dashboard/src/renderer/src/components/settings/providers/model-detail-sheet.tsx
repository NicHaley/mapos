import { Button } from "@mapos/ui/components/button";
import type { FetchedModel, ProviderView } from "@shared/ai-providers";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { SettingsSheet } from "../settings-sheet";
import { CapabilityBadges } from "./capability-badges";
import { ProviderBadge } from "./provider-badge";

/**
 * Detail drawer for a single model: provider, capabilities, and the "make default" action. Opened
 * from a model row in {@link ProviderModelsList} (the chevron affordance). Selecting sets the global
 * active model via the same `setActive` path the chat switcher uses. Locked when the provider isn't
 * connected — connecting happens through the group's Edit action, not here.
 */
export function ModelDetailSheet({
  open,
  onOpenChange,
  provider,
  model,
  isActive,
  onMadeDefault
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null during the close animation, before a model is chosen. */
  provider: ProviderView | null;
  model: FetchedModel | null;
  isActive: boolean;
  /** Fired after a successful default change, so the host can reload its state. */
  onMadeDefault: () => void | Promise<void>;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const connected = provider?.auth.configured ?? false;

  async function makeDefault(): Promise<void> {
    if (!provider || !model) return;
    setPending(true);
    const result = await window.api.ai.setActive(provider.id, model.id, model.capabilities);
    setPending(false);
    if (result.ok) {
      await onMadeDefault();
      onOpenChange(false);
    }
  }

  const footer =
    !provider || !model ? null : isActive ? (
      <Button variant="outline" className="w-full" disabled>
        <CheckIcon className="size-4 text-emerald-500" />
        Current default
      </Button>
    ) : (
      <Button
        className="w-full"
        onClick={() => void makeDefault()}
        disabled={pending || !connected}
      >
        {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
        Make default model
      </Button>
    );

  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Model"
      description={provider ? `via ${provider.label}` : undefined}
      footer={footer}
    >
      {provider && model && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <ProviderBadge
              knownProvider={provider.knownProvider}
              label={provider.label}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <div className="break-all font-mono text-base">{model.id}</div>
              <div className="text-muted-foreground text-sm">{provider.label}</div>
            </div>
          </div>

          <div>
            <div className="mb-2 font-medium text-muted-foreground text-xs">Capabilities</div>
            <CapabilityBadges caps={model.capabilities} source={model.capabilitySource} />
          </div>

          {!connected && (
            <p className="text-muted-foreground text-xs">
              Connect this provider (Edit) before you can make this the default model.
            </p>
          )}
        </div>
      )}
    </SettingsSheet>
  );
}

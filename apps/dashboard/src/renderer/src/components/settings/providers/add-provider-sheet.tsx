import { Badge } from "@mapos/ui/components/badge";
import { Button } from "@mapos/ui/components/button";
import type { KnownProviderOption } from "@shared/ai-providers";
import { Loader2Icon, PlugZapIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsSheet } from "../settings-sheet";

/**
 * "Add provider" chooser. Two sources: Pi's bundled cloud catalog (no URL/protocol typing) and a
 * "Custom endpoint" escape hatch for anything else (a self-hosted runtime like Ollama or LM Studio,
 * LiteLLM, a corporate proxy). Picking a catalog provider opens the connect drawer — nothing is
 * persisted until the user actually connects there.
 */
export function AddProviderSheet({
  open,
  onOpenChange,
  addedKnownProviders,
  onPickKnown,
  onChooseCustom
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Catalog names already added, so we don't offer duplicates. */
  addedKnownProviders: Set<string>;
  onPickKnown: (option: KnownProviderOption) => void;
  onChooseCustom: () => void;
}): React.JSX.Element {
  const [known, setKnown] = useState<KnownProviderOption[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setKnown(null);
    void window.api.ai.listKnownProviders().then(setKnown);
  }, [open]);

  const available = known?.filter((k) => !addedKnownProviders.has(k.name)) ?? null;

  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add provider"
      description="Pick a provider from the catalog or add a custom endpoint."
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
          <SlidersHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Custom endpoint</div>
            <div className="text-xs text-muted-foreground">
              Use to configure local AI or proxies.
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onChooseCustom}>
            Add
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">From catalog</span>
          {available === null ? (
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              Loading catalog…
            </div>
          ) : available.length === 0 ? (
            <div className="px-1 py-3 text-xs text-muted-foreground">
              All catalog providers have been added.
            </div>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-lg border">
              {available.map((k) => (
                <div key={k.name} className="flex items-center gap-3 px-3 py-2.5">
                  <PlugZapIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{k.label}</span>
                      {k.oauthAvailable && <Badge variant="secondary">Sign-in</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{k.modelCount} models</div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => onPickKnown(k)}>
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SettingsSheet>
  );
}

import { Badge } from "@mapos/ui/components/badge";
import { Button } from "@mapos/ui/components/button";
import type { KnownProviderOption } from "@shared/ai-providers";
import { Loader2Icon, PlugZapIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsSheet } from "../settings-sheet";

/**
 * "Add provider" chooser. Lists Pi's bundled catalog so adding a mainstream provider is one click
 * (no URL/protocol typing), and keeps a "Custom endpoint" escape hatch for anything not in the
 * catalog (Ollama on a weird port, LiteLLM, a corporate proxy).
 */
export function AddProviderSheet({
  open,
  onOpenChange,
  addedKnownProviders,
  onAddKnown,
  onChooseCustom
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Catalog names already added, so we don't offer duplicates. */
  addedKnownProviders: Set<string>;
  onAddKnown: (name: string) => Promise<void>;
  onChooseCustom: () => void;
}): React.JSX.Element {
  const [known, setKnown] = useState<KnownProviderOption[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKnown(null);
    void window.api.aiv2.listKnownProviders().then(setKnown);
  }, [open]);

  const available = known?.filter((k) => !addedKnownProviders.has(k.name)) ?? null;

  async function add(name: string): Promise<void> {
    setAdding(name);
    await onAddKnown(name);
    setAdding(null);
  }

  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add provider"
      description="Pick a provider from the catalog — models and protocol come built in — or add a custom endpoint."
    >
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={onChooseCustom}
          className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
        >
          <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Custom endpoint</div>
            <div className="text-xs text-muted-foreground">
              Any OpenAI-compatible URL — Ollama, LiteLLM, a self-hosted proxy.
            </div>
          </div>
        </button>

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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void add(k.name)}
                    disabled={adding !== null}
                  >
                    {adding === k.name ? <Loader2Icon className="size-4 animate-spin" /> : null}
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

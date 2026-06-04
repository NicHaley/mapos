import { Badge } from "@mapos/ui/components/badge";
import { Button } from "@mapos/ui/components/button";
import {
  type KnownProviderOption,
  LOCAL_PRESETS,
  type LocalPresetOption
} from "@shared/ai-providers";
import { HardDriveIcon, Loader2Icon, PlugZapIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsSheet } from "../settings-sheet";

/**
 * "Add provider" chooser. Three sources: pre-filled local runtimes (Ollama, LM Studio, llama.cpp),
 * Pi's bundled cloud catalog (one click — no URL/protocol typing), and a "Custom endpoint" escape
 * hatch for anything else (a local runtime on a non-default port, LiteLLM, a corporate proxy).
 */
export function AddProviderSheet({
  open,
  onOpenChange,
  addedKnownProviders,
  addedLocalPresets,
  onAddKnown,
  onAddLocal,
  onChooseCustom
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Catalog names already added, so we don't offer duplicates. */
  addedKnownProviders: Set<string>;
  /** Local preset ids already added, so we don't offer duplicates. */
  addedLocalPresets: Set<string>;
  onAddKnown: (name: string) => Promise<void>;
  onAddLocal: (preset: LocalPresetOption) => Promise<void>;
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
  const localPresets = LOCAL_PRESETS.filter((p) => !addedLocalPresets.has(p.id));

  async function add(name: string): Promise<void> {
    setAdding(name);
    await onAddKnown(name);
    setAdding(null);
  }

  async function addLocal(preset: LocalPresetOption): Promise<void> {
    setAdding(preset.id);
    await onAddLocal(preset);
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
              Any OpenAI-compatible URL — a local runtime on a custom port, LiteLLM, a proxy.
            </div>
          </div>
        </button>

        {localPresets.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Local runtimes</span>
            <div className="divide-y divide-border overflow-hidden rounded-lg border">
              {localPresets.map((p) => (
                <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                  <HardDriveIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.label}</div>
                    <div className="text-xs text-muted-foreground">{p.description}</div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void addLocal(p)}
                    disabled={adding !== null}
                  >
                    {adding === p.id ? <Loader2Icon className="size-4 animate-spin" /> : null}
                    Add
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

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

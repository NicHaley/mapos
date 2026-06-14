import { Button } from "@mapos/ui/components/button";
import { cn } from "@mapos/ui/lib/utils";
import type { AiState, ProviderView } from "@shared/ai-providers";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { KnownProviderAuth } from "../settings/providers/known-provider-auth";
import { ProviderBadge } from "../settings/providers/provider-badge";
import { CmdEnterHint } from "./cmd-enter-hint";

/**
 * Onboarding's simplified take on the AI Models settings page: connect a seeded cloud provider inline
 * (the first listed model is auto-activated on connect). Local models are configured later via Pi's
 * custom-provider support in Settings.
 */
export function AiStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<AiState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void window.api.ai.getState().then(setState);
    // Keep in sync with main-side changes (e.g. a connection auto-activating a model).
    return window.api.ai.onChanged(() => {
      void window.api.ai.getState().then(setState);
    });
  }, []);

  const knownProviders = state?.providers.filter((p) => !!p.knownProvider) ?? [];
  const cloudConnected = knownProviders.some((p) => p.auth.configured);
  const active = state?.active ?? null;

  /** After connecting in the inline panel, auto-pick the provider's first listed model. */
  async function handleProviderChanged(providerId: string): Promise<void> {
    const next = await window.api.ai.getState();
    setState(next);
    if (next.active) return;
    const p = next.providers.find((x) => x.id === providerId);
    if (!p?.auth.configured) return;
    const result = await window.api.ai.listModels(p.id);
    if (!result.ok || result.models.length === 0) return;
    const m = result.models[0];
    await window.api.ai.setActive(p.id, m.id, m.capabilities);
    setState(await window.api.ai.getState());
  }

  const primaryEnabled = cloudConnected;
  useCmdEnter(() => onNext(), primaryEnabled);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Connect an AI provider</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Use Claude, GPT and more over the network. Sign in or paste an API key. You can add more
        providers — including local endpoints — anytime in Settings.
      </p>

      <div className="mt-6 flex flex-col gap-2">
        {!state && (
          <div className="flex items-center gap-2 py-2 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading providers…
          </div>
        )}
        {knownProviders.map((p) => {
          const expanded = expandedId === p.id;
          return (
            <div key={p.id} className="overflow-hidden rounded-lg border">
              <button
                type="button"
                onClick={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
              >
                <ProviderBadge knownProvider={p.knownProvider} label={p.label} />
                <span className="min-w-0 flex-1 truncate font-medium text-sm">{p.label}</span>
                <ProviderConnState p={p} />
                <ChevronDownIcon
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground/60 transition-transform",
                    expanded && "rotate-180"
                  )}
                  aria-hidden
                />
              </button>
              {expanded && (
                <div className="border-t bg-muted/20">
                  <KnownProviderAuth provider={p} onChanged={() => void handleProviderChanged(p.id)} />
                </div>
              )}
            </div>
          );
        })}
        {active && (
          <p className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
            <CheckIcon className="size-3.5 text-emerald-500" />
            Using <span className="font-mono">{active.model}</span> — switch anytime in Settings.
          </p>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button size="lg" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button size="lg" variant="ghost" onClick={onNext}>
            Set up later
          </Button>
          <Button size="lg" disabled={!primaryEnabled} onClick={onNext}>
            Continue
            <CmdEnterHint tone="primary" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Glanceable connection status for an inline provider row (mirrors Settings → Sources). */
function ProviderConnState({ p }: { p: ProviderView }): React.JSX.Element {
  if (p.auth.configured) {
    return (
      <span className="shrink-0 font-medium text-emerald-600 text-xs dark:text-emerald-400">
        {p.auth.method === "oauth" ? "Signed in" : "API key set"}
      </span>
    );
  }
  return <span className="shrink-0 text-muted-foreground text-xs">Not connected</span>;
}

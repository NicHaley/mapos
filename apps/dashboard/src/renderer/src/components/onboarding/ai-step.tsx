import { Button } from "@mapos/ui/components/button";
import { cn } from "@mapos/ui/lib/utils";
import type { AiState, ProviderView } from "@shared/ai-providers";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { KnownProviderAuth } from "../settings/providers/known-provider-auth";
import { ModelSwitcher } from "../settings/providers/model-switcher";
import { ProviderBadge } from "../settings/providers/provider-badge";
import { CmdEnterHint } from "./cmd-enter-hint";

/**
 * The marquee catalog providers offered inline during onboarding — mirrors `SEEDED_PROVIDERS` in
 * main/ai.ts. Ensured present on mount so a stale `ai.json` (predating the current seed list) still
 * shows the full set rather than just whatever happens to be stored.
 */
const MARQUEE_PROVIDERS = ["anthropic", "openai-codex", "github-copilot"] as const;

/**
 * Onboarding's simplified take on the AI Models settings page: connect a marquee cloud provider
 * inline, then pick a model from the same switcher used in chat and settings. Custom and local
 * endpoints (a self-hosted Ollama, LM Studio, a proxy) are configured later in Settings → AI Models.
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
    let active = true;

    async function ensureMarqueeAndLoad(): Promise<void> {
      const initial = await window.api.ai.getState();
      const present = new Set(
        initial.providers.map((p) => p.knownProvider).filter((n): n is string => !!n)
      );
      const missing = MARQUEE_PROVIDERS.filter((name) => !present.has(name));
      for (const name of missing) await window.api.ai.addKnownProvider(name);
      const next = missing.length > 0 ? await window.api.ai.getState() : initial;
      if (active) setState(next);
    }

    void ensureMarqueeAndLoad();
    // Keep in sync with main-side changes (e.g. a connection auto-activating a model).
    const off = window.api.ai.onChanged(() => {
      void window.api.ai.getState().then((s) => {
        if (active) setState(s);
      });
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const knownProviders = state?.providers.filter((p) => !!p.knownProvider) ?? [];
  const active = state?.active ?? null;
  const hasConnected = state?.providers.some((p) => p.auth.configured) ?? false;

  async function reload(): Promise<void> {
    setState(await window.api.ai.getState());
  }

  // A model is active once a provider is connected; that's the real "ready to continue" signal.
  const primaryEnabled = !!active;
  useCmdEnter(() => onNext(), primaryEnabled);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Connect an AI provider</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Use Claude, GPT and more over the network — sign in or paste an API key. Need a custom or
        local endpoint (Ollama, LM Studio, a proxy)? Add one anytime in Settings → AI Models.
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
                  <KnownProviderAuth provider={p} onChanged={() => void reload()} />
                </div>
              )}
            </div>
          );
        })}

        {state && hasConnected && (
          <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <div className="font-medium text-sm">Model</div>
              <div className="text-muted-foreground text-xs">
                {active ? (
                  <span className="flex items-center gap-1.5">
                    <CheckIcon className="size-3.5 text-emerald-500" />
                    Switch anytime in chat or Settings.
                  </span>
                ) : (
                  "Pick a model to finish setup."
                )}
              </div>
            </div>
            <ModelSwitcher state={state} onSelected={() => void reload()} />
          </div>
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

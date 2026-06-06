import { Button } from "@mapos/ui/components/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from "@mapos/ui/components/item";
import { cn } from "@mapos/ui/lib/utils";
import { type AiState, EMBEDDED_PROVIDER_ID, type ProviderView } from "@shared/ai-providers";
import type { RecommendedModel } from "@shared/local-llm";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  GlobeIcon,
  Loader2Icon,
  LockIcon,
  MonitorIcon
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { KnownProviderAuth } from "../settings/providers/known-provider-auth";
import { ProviderBadge } from "../settings/providers/provider-badge";
import { CmdEnterHint } from "./cmd-enter-hint";

export type AiChoice = "local" | "cloud" | null;

type DlState = { downloadedBytes: number; totalBytes: number };

function formatGB(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function RadioDot({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        on ? "border-foreground bg-foreground text-background" : "border-border"
      )}
    >
      {on && <CheckIcon className="size-3" strokeWidth={3} />}
    </span>
  );
}

/**
 * Onboarding's simplified take on the AI Models settings page: pick local (download the
 * machine-recommended GGUF and keep going — the main process activates it when the download lands)
 * or connect a seeded cloud provider inline (the first listed model is auto-activated on connect).
 */
export function AiStep({
  choice,
  onChoiceChange,
  onBack,
  onNext
}: {
  choice: AiChoice;
  onChoiceChange: (next: AiChoice) => void;
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [models, setModels] = useState<RecommendedModel[] | null>(null);
  const [state, setState] = useState<AiState | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DlState>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.localLlm.listRecommended().then(setModels);
    void window.api.ai.getState().then(setState);
    // Keep in sync with main-side changes (e.g. a download finishing and auto-activating).
    return window.api.ai.onChanged(() => {
      void window.api.ai.getState().then(setState);
    });
  }, []);

  useEffect(() => {
    return window.api.localLlm.onDownloadProgress((d) => {
      setDownloads((m) => {
        if (d.done) {
          const next = { ...m };
          delete next[d.modelId];
          return next;
        }
        return { ...m, [d.modelId]: { downloadedBytes: d.downloadedBytes, totalBytes: d.totalBytes } };
      });
    });
  }, []);

  // The single model the local card offers: the best fit for this machine.
  const rec = models?.find((m) => m.recommended) ?? models?.[0] ?? null;
  const recDl = rec ? downloads[rec.id] : undefined;
  const recDownloading = !!recDl;
  const recPct = recDl && recDl.totalBytes > 0 ? Math.round((recDl.downloadedBytes / recDl.totalBytes) * 100) : 0;

  const knownProviders = state?.providers.filter((p) => !!p.knownProvider) ?? [];
  const cloudConnected = knownProviders.some((p) => p.auth.configured);
  const cloudActive =
    state?.active && state.active.providerId !== EMBEDDED_PROVIDER_ID ? state.active : null;

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

  const primaryEnabled =
    choice === "local" ? !!rec && !busy : choice === "cloud" ? cloudConnected : false;

  async function primaryAction(): Promise<void> {
    if (!primaryEnabled) return;
    if (choice === "cloud") {
      onNext();
      return;
    }
    if (!rec) return;
    if (rec.installed) {
      setBusy(true);
      setError(null);
      const result = await window.api.ai.setActive(EMBEDDED_PROVIDER_ID, rec.id, rec.capabilities);
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onNext();
      return;
    }
    // Fire-and-forget: the download runs in the main process (and survives the onboarding
    // reload); main auto-activates the model on completion if nothing else was chosen.
    if (!recDownloading) void window.api.localLlm.download(rec.id);
    onNext();
  }
  useCmdEnter(() => void primaryAction(), primaryEnabled);

  const localDescription = !rec ? (
    "Private & offline."
  ) : rec.installed ? (
    <>
      Private & offline. <span className="font-medium text-foreground">{rec.label}</span> is already
      downloaded.
    </>
  ) : (
    <>
      Private & offline. Downloads{" "}
      <span className="font-medium text-foreground">{rec.label}</span> ({formatGB(rec.sizeBytes)}) —
      the balanced default.
    </>
  );

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">How should MapOS run AI?</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Pick a starting point to get going. You can switch models and add providers anytime in
        Settings.
      </p>

      <ItemGroup className="mt-6 grid grid-cols-2 items-stretch gap-3">
        <Item
          render={<button type="button" />}
          variant="outline"
          selected={choice === "local"}
          onClick={() => onChoiceChange("local")}
          className="flex-col items-stretch gap-3 cursor-pointer not-data-[selected]:hover:bg-accent/50"
        >
          <div className="flex w-full items-start justify-between">
            <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
              <MonitorIcon className="size-4" />
            </span>
            <RadioDot on={choice === "local"} />
          </div>
          <ItemContent className="flex-none">
            <ItemTitle>Run on this Mac</ItemTitle>
            <ItemDescription>{localDescription}</ItemDescription>
          </ItemContent>
          <div className="flex items-center gap-2">
            {recDownloading ? (
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
                <Loader2Icon className="size-3 animate-spin" />
                Downloading… {recPct}%
              </span>
            ) : (
              <>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 text-xs dark:text-emerald-400">
                  Recommended
                </span>
                <span className="text-muted-foreground text-xs">No account needed</span>
              </>
            )}
          </div>
        </Item>

        <Item
          render={<button type="button" />}
          variant="outline"
          selected={choice === "cloud"}
          onClick={() => onChoiceChange("cloud")}
          className="flex-col items-stretch gap-3 cursor-pointer not-data-[selected]:hover:bg-accent/50"
        >
          <div className="flex w-full items-start justify-between">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <GlobeIcon className="size-4" />
            </span>
            <RadioDot on={choice === "cloud"} />
          </div>
          <ItemContent className="flex-none">
            <ItemTitle>Connect a provider</ItemTitle>
            <ItemDescription>
              Use Claude, GPT and more over the network. Sign in or paste an API key.
            </ItemDescription>
          </ItemContent>
          <div className="flex items-center gap-1.5">
            <ProviderBadge knownProvider="anthropic" size="sm" />
            <ProviderBadge knownProvider="openai" size="sm" />
            <ProviderBadge knownProvider="github-copilot" size="sm" />
          </div>
        </Item>
      </ItemGroup>

      {choice === "local" && rec && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
          <LockIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-muted-foreground text-sm">
            {rec.installed
              ? "Already on this Mac — nothing leaves your device, no key to manage."
              : `One-time ${formatGB(rec.sizeBytes)} download. Runs entirely on this Mac — nothing leaves your device, no key to manage.`}
          </p>
        </div>
      )}

      {choice === "cloud" && (
        <div className="mt-4 flex flex-col gap-2">
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
                    <KnownProviderAuth
                      provider={p}
                      onChanged={() => void handleProviderChanged(p.id)}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {cloudActive && (
            <p className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
              <CheckIcon className="size-3.5 text-emerald-500" />
              Using <span className="font-mono">{cloudActive.model}</span> — switch anytime in
              Settings.
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-8 flex items-center justify-between">
        <Button size="lg" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button size="lg" variant="ghost" onClick={onNext}>
            Set up later
          </Button>
          <Button size="lg" disabled={!primaryEnabled} onClick={() => void primaryAction()}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {choice === "local" && rec && !rec.installed && !recDownloading ? (
              <>
                <DownloadIcon className="size-4" />
                Download & continue
              </>
            ) : (
              "Continue"
            )}
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

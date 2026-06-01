import { Button, buttonVariants } from "@mapos/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from "@mapos/ui/components/item";
import { cn } from "@mapos/ui/lib/utils";
import { ANTHROPIC_MODELS, OLLAMA_MODELS } from "@shared/ai-models";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { SiAnthropic, SiOllama } from "react-icons/si";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { MAGIC_OLLAMA_BASE_URL } from "../settings/ai/constants";
import { ModelRow } from "../settings/ai/model-row";
import { OllamaBanner } from "../settings/ai/ollama-banner";
import { useOllamaDetection } from "../settings/ai/use-ollama-detection";
import { CmdEnterHint } from "./cmd-enter-hint";

const DEFAULT_ANTHROPIC_MODEL = ANTHROPIC_MODELS[0]?.id ?? "claude-sonnet-4-6";

type Choice = "cloud" | "local" | null;

export function AiStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [choice, setChoice] = useState<Choice>(null);

  // When no provider is chosen yet, ⌘↵ means "Skip for now". Once a provider is selected, its
  // own panel owns the shortcut (e.g. CloudPanel saves the key), so the step-level one stands down.
  useCmdEnter(onNext, choice === null);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Pick your AI</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        MapOS uses an AI to chat about places, run searches, and edit files. Choose now —
        you can switch any time in Settings.
      </p>

      <ItemGroup className="mt-6 gap-2">
        <Item
          render={<button type="button" />}
          variant="outline"
          selected={choice === "cloud"}
          onClick={() => setChoice("cloud")}
          className="cursor-pointer not-data-[selected]:hover:bg-accent/50"
        >
          <ItemMedia className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
            <SiAnthropic className="size-4" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Cloud (Anthropic)</ItemTitle>
            <ItemDescription>Best quality. Bring your own API key.</ItemDescription>
          </ItemContent>
        </Item>
        <Item
          render={<button type="button" />}
          variant="outline"
          selected={choice === "local"}
          onClick={() => setChoice("local")}
          className="cursor-pointer not-data-[selected]:hover:bg-accent/50"
        >
          <ItemMedia className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
            <SiOllama className="size-4" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Local (Ollama)</ItemTitle>
            <ItemDescription>Runs entirely on this Mac. Private, no key.</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>

      <div className="mt-6">
        {choice === "cloud" && <CloudPanel onSaved={onNext} />}
        {choice === "local" && <LocalPanel onSaved={onNext} />}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <Button variant="ghost" onClick={onNext}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}

function CloudPanel({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const apiKeyId = useId();
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    if (apiKey.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await window.api.aiConfig.update({
      provider: "anthropic",
      anthropic: { model: DEFAULT_ANTHROPIC_MODEL, apiKey }
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved();
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setError(null);
    setTestMessage(null);
    const result = await window.api.aiConfig.testConnection({
      provider: "anthropic",
      apiKey,
      model: DEFAULT_ANTHROPIC_MODEL
    });
    setTesting(false);
    if (result.ok) {
      setTestMessage("Connection ok");
      window.setTimeout(() => setTestMessage(null), 2000);
    } else {
      setError(result.error);
    }
  }

  const canSubmit = apiKey.length > 0 && !busy && !testing;

  useCmdEnter(() => void handleSave(), canSubmit);

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <InputGroup className="bg-background">
        <InputGroupInput
          id={apiKeyId}
          type={reveal ? "text" : "password"}
          placeholder="sk-ant-..."
          aria-label="Anthropic API key"
          value={apiKey}
          disabled={busy}
          onChange={(e) => {
            setApiKey(e.target.value);
            if (error) setError(null);
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            variant="ghost"
            size="icon-xs"
            onClick={() => setReveal((r) => !r)}
            disabled={busy}
            aria-label={reveal ? "Hide key" : "Show key"}
          >
            {reveal ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Get an API key <ExternalLinkIcon className="size-3" />
        </a>
        {testMessage && <span className="ml-auto text-xs text-emerald-500">{testMessage}</span>}
        <Button
          variant="secondary"
          size="sm"
          className={!testMessage ? "ml-auto" : ""}
          onClick={() => void handleTest()}
          disabled={!canSubmit}
        >
          {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Test
        </Button>
        <Button size="sm" onClick={() => void handleSave()} disabled={!canSubmit}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Save & continue
          <CmdEnterHint tone="primary" />
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function LocalPanel({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const baseUrl = MAGIC_OLLAMA_BASE_URL;
  const { detection, installed, refresh: refreshOllama } = useOllamaDetection(baseUrl);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number>(0);
  const [pullError, setPullError] = useState<string | null>(null);

  useEffect(() => {
    return window.api.aiConfig.onPullProgress((data) => {
      if (data.modelId !== pullingModel) return;
      if (typeof data.percent === "number") {
        const next = data.percent;
        setPullPercent((prev) => (next > prev ? next : prev));
      }
      if (data.status === "done") {
        void refreshOllama();
      }
    });
  }, [pullingModel, refreshOllama]);

  const selectInstalled = useCallback(
    async (modelId: string): Promise<void> => {
      const result = await window.api.aiConfig.update({
        provider: "local",
        local: { mode: "magic", magic: { model: modelId } }
      });
      if (!result.ok) {
        setPullError(result.error);
        return;
      }
      onSaved();
    },
    [onSaved]
  );

  async function pullAndSelect(modelId: string): Promise<void> {
    setPullError(null);
    setPullingModel(modelId);
    setPullPercent(0);
    const result = await window.api.aiConfig.ollamaPull(baseUrl, modelId);
    setPullingModel(null);
    setPullPercent(0);
    if (!result.ok) {
      setPullError(result.error);
      return;
    }
    await refreshOllama();
    await selectInstalled(modelId);
  }

  if (detection === "checking") {
    return (
      <div className="flex h-[60px] items-center justify-center rounded-lg border text-xs text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  if (detection !== "running") {
    return <OllamaBanner onRecheck={() => void refreshOllama()} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y divide-border overflow-hidden rounded-lg border">
        {OLLAMA_MODELS.map((m) => {
          const isInstalled = installed.includes(m.id);
          const isPulling = pullingModel === m.id;
          return (
            <ModelRow
              key={m.id}
              kind="local"
              label={m.label}
              meta={`${m.size} · ${m.hint}`}
              selected={false}
              pulling={isPulling}
              pullPercent={isPulling ? pullPercent : undefined}
              onClick={() => {
                if (isPulling) return;
                if (isInstalled) {
                  void selectInstalled(m.id);
                } else {
                  void pullAndSelect(m.id);
                }
              }}
              trailing={
                isInstalled ? (
                  <span className="text-xs tabular-nums text-muted-foreground">{m.size}</span>
                ) : (
                  <span
                    className={cn(
                      buttonVariants({ variant: "secondary", size: "sm" }),
                      "pointer-events-none"
                    )}
                  >
                    Download
                  </span>
                )
              }
            />
          );
        })}
      </div>
      {pullError && <p className="text-xs text-destructive">{pullError}</p>}
    </div>
  );
}

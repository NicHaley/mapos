import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import { Button, buttonVariants } from "@mapos/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import { Progress } from "@mapos/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@mapos/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mapos/ui/components/tabs";
import { cn } from "@mapos/ui/lib/utils";
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  Trash2Icon
} from "lucide-react";
import { ANTHROPIC_MODELS, OLLAMA_MODELS } from "@shared/ai-models";
import { useCallback, useEffect, useMemo, useState } from "react";

type AiSettingsState = Awaited<ReturnType<typeof window.api.aiConfig.getSettingsState>>;
type Provider = AiSettingsState["provider"];
type LocalMode = AiSettingsState["local"]["mode"];

const CUSTOM_MODEL_VALUE = "__custom__";

// Magic mode is hard-fixed to localhost. Mirror the main-process constant; if it ever needs to vary,
// expose a getter from the preload bridge.
const MAGIC_OLLAMA_BASE_URL = "http://localhost:11434";

function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Anthropic form ────────────────────────────────────────────────────────────

function AnthropicForm({
  state,
  onSaved
}: {
  state: AiSettingsState["anthropic"];
  onSaved: () => void;
}): React.JSX.Element {
  const initialIsKnownModel = ANTHROPIC_MODELS.some((m) => m.id === state.model);
  const [modelChoice, setModelChoice] = useState<string>(
    initialIsKnownModel ? state.model : CUSTOM_MODEL_VALUE
  );
  const [customModel, setCustomModel] = useState<string>(initialIsKnownModel ? "" : state.model);
  const [apiKey, setApiKey] = useState<string>("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const effectiveModel =
    modelChoice === CUSTOM_MODEL_VALUE ? customModel.trim() : modelChoice;
  const modelDirty = effectiveModel !== state.model && effectiveModel.length > 0;
  const apiKeyDirty = apiKey.length > 0;
  const dirty = modelDirty || apiKeyDirty;

  async function handleSave(): Promise<void> {
    if (!dirty || !effectiveModel) return;
    setBusy(true);
    setError(null);
    setSavedMessage(null);
    const update: Parameters<typeof window.api.aiConfig.update>[0] = {
      anthropic: {
        ...(modelDirty ? { model: effectiveModel } : {}),
        ...(apiKeyDirty ? { apiKey } : {})
      }
    };
    const result = await window.api.aiConfig.update(update);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setApiKey("");
    setSavedMessage("Saved");
    onSaved();
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setError(null);
    setTestMessage(null);
    const result = await window.api.aiConfig.testConnection({
      provider: "anthropic",
      ...(apiKey.length > 0 ? { apiKey } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {})
    });
    setTesting(false);
    if (result.ok) {
      setTestMessage("Connection ok");
      window.setTimeout(() => setTestMessage(null), 2000);
    } else {
      setError(result.error);
    }
  }

  const canTest = (apiKey.length > 0 || state.hasApiKey) && effectiveModel.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <Section title="API key" description={state.hasApiKey ? "Saved. Enter a new key to replace it." : "Paste your Anthropic API key."}>
        <div className="flex flex-col gap-2">
          <InputGroup>
            <InputGroupInput
              type={reveal ? "text" : "password"}
              placeholder={state.hasApiKey ? "•••••••••••••••" : "sk-ant-..."}
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
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          >
            Get an API key <ExternalLinkIcon className="size-3" />
          </a>
        </div>
      </Section>

      <Section title="Model" description="Pick a Claude model or enter a custom model ID.">
        <div className="flex flex-col gap-2">
          <Select
            value={modelChoice}
            onValueChange={(v) => {
              if (typeof v === "string") setModelChoice(v);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ANTHROPIC_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_MODEL_VALUE}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {modelChoice === CUSTOM_MODEL_VALUE && (
            <InputGroup>
              <InputGroupInput
                placeholder="claude-sonnet-4-7"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                disabled={busy}
                spellCheck={false}
              />
            </InputGroup>
          )}
        </div>
      </Section>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void handleSave()} disabled={busy || !dirty || !effectiveModel}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Save
        </Button>
        <Button
          variant="secondary"
          onClick={() => void handleTest()}
          disabled={testing || busy || !canTest}
        >
          {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Test connection
        </Button>
        {savedMessage && <span className="text-xs text-emerald-500">{savedMessage}</span>}
        {testMessage && <span className="text-xs text-emerald-500">{testMessage}</span>}
      </div>
    </div>
  );
}

// ── Magic local form ──────────────────────────────────────────────────────────

type DetectionState = "checking" | "running" | "stopped";

function ModelRow({
  modelId,
  label,
  meta,
  installed,
  selected,
  pulling,
  deleting,
  pullPercent,
  onSelect,
  onPull,
  onCancelPull,
  onDelete
}: {
  modelId: string;
  label: string;
  meta?: string;
  installed: boolean;
  selected: boolean;
  pulling: boolean;
  deleting?: boolean;
  pullPercent?: number;
  onSelect: () => void;
  onPull: () => void;
  onCancelPull: () => void;
  onDelete?: () => void;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        selected ? "border-foreground/40 bg-accent" : "border-border"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          {selected && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{modelId}</div>
        {meta && <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div>}
        {pulling && (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={pullPercent ?? 0} className="flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {pullPercent ?? 0}%
            </span>
            <Button variant="ghost" size="sm" onClick={onCancelPull}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      {!pulling && (
        <div className="flex items-center gap-1">
          {installed ? (
            <Button
              variant={selected ? "secondary" : "default"}
              size="sm"
              onClick={onSelect}
              disabled={deleting}
            >
              {selected ? "Selected" : "Use"}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onPull}>
              <DownloadIcon className="size-3.5" />
              Download
            </Button>
          )}
          {installed && onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              disabled={deleting}
              aria-label="Delete model"
              title="Delete model"
            >
              {deleting ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Trash2Icon className="size-4" />
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function MagicLocalForm({
  state,
  onSaved
}: {
  state: AiSettingsState["local"]["magic"];
  onSaved: () => void;
}): React.JSX.Element {
  const [detection, setDetection] = useState<DetectionState>("checking");
  const [installed, setInstalled] = useState<string[]>([]);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number>(0);
  const [pullError, setPullError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const baseUrl = MAGIC_OLLAMA_BASE_URL;

  const refresh = useCallback(async () => {
    const detected = await window.api.aiConfig.ollamaDetect(baseUrl);
    setDetection(detected.running ? "running" : "stopped");
    if (detected.running) {
      const list = await window.api.aiConfig.ollamaListInstalled(baseUrl);
      setInstalled(list);
    }
  }, [baseUrl]);

  useEffect(() => {
    void refresh();
    // Re-poll every 2s while the form is mounted so the user sees Ollama come online without leaving the tab.
    const id = window.setInterval(() => {
      if (detection !== "running") void refresh();
    }, 2000);
    return () => window.clearInterval(id);
  }, [refresh, detection]);

  useEffect(() => {
    return window.api.aiConfig.onPullProgress((data) => {
      if (data.modelId !== pullingModel) return;
      // Only accept numeric, non-decreasing values. Ollama's post-download events
      // (verifying, writing manifest, cleanup) carry no percent and would otherwise
      // snap the bar back to 0 right before completion.
      if (typeof data.percent === "number") {
        const next = data.percent;
        setPullPercent((prev) => (next > prev ? next : prev));
      }
      if (data.status === "done") {
        // Refresh installed list when a pull completes; selection follows on the resolved promise below.
        void refresh();
      }
    });
  }, [pullingModel, refresh]);

  async function selectModel(modelId: string): Promise<void> {
    setPendingSelect(modelId);
    const result = await window.api.aiConfig.update({
      provider: "local",
      local: { mode: "magic", magic: { model: modelId } }
    });
    setPendingSelect(null);
    if (!result.ok) {
      setPullError(result.error);
      return;
    }
    setSavedMessage("Saved");
    onSaved();
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

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
    await refresh();
    await selectModel(modelId);
  }

  function cancelCurrentPull(): void {
    if (!pullingModel) return;
    void window.api.aiConfig.ollamaCancelPull(baseUrl, pullingModel);
    setPullingModel(null);
    setPullPercent(0);
  }

  async function confirmDelete(): Promise<void> {
    const target = pendingDeleteModel;
    if (!target) return;
    setDeletingModel(target);
    setDeleteError(null);
    const result = await window.api.aiConfig.ollamaDelete(baseUrl, target);
    setDeletingModel(null);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    setPendingDeleteModel(null);
    await refresh();
    // Main has already cleared local.magic.model when the deleted model was active; pull the new state.
    onSaved();
  }

  const curatedIds = useMemo(() => new Set(OLLAMA_MODELS.map((m) => m.id)), []);
  const otherInstalled = installed.filter((m) => !curatedIds.has(m));

  if (detection === "checking") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Checking for Ollama…
      </div>
    );
  }

  if (detection === "stopped") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-dashed px-4 py-5">
        <div>
          <h3 className="text-base font-medium">Ollama isn't running</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            MapOS uses Ollama to run local models. Install it once and we'll detect it here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer noopener"
            className={buttonVariants({ variant: "default", size: "default" })}
          >
            Install Ollama
            <ExternalLinkIcon className="size-3.5" />
          </a>
          <Button variant="ghost" onClick={() => void refresh()}>
            Re-check
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Recommended models"
        description="Curated for tool calling on consumer hardware."
      >
        <div className="flex flex-col gap-2">
          {OLLAMA_MODELS.map((m) => {
            const isInstalled = installed.includes(m.id);
            const isSelected = state.model === m.id;
            const isPulling = pullingModel === m.id;
            return (
              <ModelRow
                key={m.id}
                modelId={m.id}
                label={m.label}
                meta={`${m.size} • ${m.hint}`}
                installed={isInstalled}
                selected={isSelected || pendingSelect === m.id}
                pulling={isPulling}
                deleting={deletingModel === m.id}
                pullPercent={isPulling ? pullPercent : undefined}
                onSelect={() => void selectModel(m.id)}
                onPull={() => void pullAndSelect(m.id)}
                onCancelPull={cancelCurrentPull}
                onDelete={() => setPendingDeleteModel(m.id)}
              />
            );
          })}
        </div>
      </Section>

      {otherInstalled.length > 0 && (
        <Section title="Already installed" description="Models you've pulled outside of MapOS.">
          <div className="flex flex-col gap-2">
            {otherInstalled.map((m) => {
              const isSelected = state.model === m;
              return (
                <ModelRow
                  key={m}
                  modelId={m}
                  label={m}
                  installed
                  selected={isSelected || pendingSelect === m}
                  pulling={false}
                  deleting={deletingModel === m}
                  onSelect={() => void selectModel(m)}
                  onPull={() => {}}
                  onCancelPull={() => {}}
                  onDelete={() => setPendingDeleteModel(m)}
                />
              );
            })}
          </div>
        </Section>
      )}

      {pullError && <p className="text-xs text-destructive">{pullError}</p>}
      {savedMessage && <p className="text-xs text-emerald-500">{savedMessage}</p>}

      <AlertDialog
        open={!!pendingDeleteModel}
        onOpenChange={(o) => {
          if (!o && !deletingModel) {
            setPendingDeleteModel(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this model?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-xs">{pendingDeleteModel}</span> will be removed from
              Ollama and the disk space freed. You can re-download it later.
            </AlertDialogDescription>
            {deleteError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (deletingModel) return;
                setPendingDeleteModel(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!deletingModel}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deletingModel ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Advanced local form ───────────────────────────────────────────────────────

function AdvancedLocalForm({
  state,
  onSaved
}: {
  state: AiSettingsState["local"]["advanced"];
  onSaved: () => void;
}): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(state.baseUrl);
  const [model, setModel] = useState(state.model);
  const [authToken, setAuthToken] = useState("");
  const [revealToken, setRevealToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const dirty =
    baseUrl.trim() !== state.baseUrl || model.trim() !== state.model || authToken.length > 0;

  async function handleSave(): Promise<void> {
    if (!dirty) return;
    setBusy(true);
    setError(null);
    setSavedMessage(null);
    const result = await window.api.aiConfig.update({
      provider: "local",
      local: {
        mode: "advanced",
        advanced: {
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          ...(authToken.length > 0 ? { authToken } : {})
        }
      }
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAuthToken("");
    setSavedMessage("Saved");
    onSaved();
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setTestMessage(null);
    setError(null);
    const result = await window.api.aiConfig.testConnection({
      provider: "local",
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(authToken.trim() ? { authToken: authToken.trim() } : {})
    });
    setTesting(false);
    if (result.ok) {
      setTestMessage("Connection ok");
      window.setTimeout(() => setTestMessage(null), 2000);
    } else {
      setError(result.error);
    }
  }

  const canTest = baseUrl.trim().length > 0 && model.trim().length > 0;

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Base URL"
        description="Any endpoint that speaks Anthropic's /v1/messages API (Ollama, LiteLLM, etc.)."
      >
        <InputGroup>
          <InputGroupInput
            placeholder="http://localhost:11434"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
        </InputGroup>
      </Section>

      <Section
        title="Auth token"
        description={state.hasAuthToken ? "Saved. Enter a new token to replace it." : "Optional bearer token."}
      >
        <InputGroup>
          <InputGroupInput
            type={revealToken ? "text" : "password"}
            placeholder={state.hasAuthToken ? "•••••••••••" : "Optional"}
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              variant="ghost"
              size="icon-xs"
              onClick={() => setRevealToken((r) => !r)}
              disabled={busy}
              aria-label={revealToken ? "Hide token" : "Show token"}
            >
              {revealToken ? <EyeOffIcon /> : <EyeIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </Section>

      <Section title="Model name" description="Exact model ID exposed by your endpoint.">
        <InputGroup>
          <InputGroupInput
            placeholder="qwen2.5:14b"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
        </InputGroup>
      </Section>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void handleSave()} disabled={busy || !dirty}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Save
        </Button>
        <Button
          variant="secondary"
          onClick={() => void handleTest()}
          disabled={testing || busy || !canTest}
        >
          {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Test connection
        </Button>
        {savedMessage && <span className="text-xs text-emerald-500">{savedMessage}</span>}
        {testMessage && <span className="text-xs text-emerald-500">{testMessage}</span>}
      </div>
    </div>
  );
}

// ── AI tab root ───────────────────────────────────────────────────────────────

export function AiTab(): React.JSX.Element {
  const [state, setState] = useState<AiSettingsState | null>(null);

  const reload = useCallback(async () => {
    const next = await window.api.aiConfig.getSettingsState();
    setState(next);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Map the (provider, local.mode) pair onto a single tab value. */
  function activeTab(s: AiSettingsState): "cloud" | "local" | "advanced" {
    if (s.provider === "anthropic") return "cloud";
    return s.local.mode === "advanced" ? "advanced" : "local";
  }

  async function handleTabChange(next: string): Promise<void> {
    if (!state) return;
    if (next === "cloud") {
      if (state.provider === "anthropic") return;
      const result = await window.api.aiConfig.update({ provider: "anthropic" });
      if (result.ok) await reload();
      return;
    }
    if (next === "local" || next === "advanced") {
      const targetMode: LocalMode = next === "advanced" ? "advanced" : "magic";
      if (state.provider === "local" && state.local.mode === targetMode) return;
      const result = await window.api.aiConfig.update({
        provider: "local",
        local: { mode: targetMode }
      });
      if (result.ok) await reload();
    }
  }

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium">Models</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Choose how MapOS connects to a model. The selected tab is the active configuration.
        </p>
      </div>
      <Tabs
        className="flex-col"
        value={activeTab(state)}
        onValueChange={(v) => {
          if (typeof v === "string") void handleTabChange(v);
        }}
      >
        <TabsList className="self-start">
          <TabsTrigger value="cloud">Cloud</TabsTrigger>
          <TabsTrigger value="local">Local</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="cloud" className="pt-4">
          <AnthropicForm state={state.anthropic} onSaved={() => void reload()} />
        </TabsContent>

        <TabsContent value="local" className="pt-4">
          <MagicLocalForm state={state.local.magic} onSaved={() => void reload()} />
        </TabsContent>

        <TabsContent value="advanced" className="flex flex-col gap-4 pt-4">
          <p className="text-xs text-muted-foreground">
            For custom endpoints — bring your own base URL (Mac mini, LiteLLM, etc.).
          </p>
          <AdvancedLocalForm state={state.local.advanced} onSaved={() => void reload()} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Helper to bridge `Provider` value ────────────────────────────────────────
// Without this guard TS doesn't narrow `value: string` to `Provider`.
// Kept colocated to avoid leaking internal types out of the tab module.
export type AiTabProvider = Provider;

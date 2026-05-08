import { Alert, AlertTitle } from "@mapos/ui/components/alert";
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
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@mapos/ui/components/popover";
import { Progress } from "@mapos/ui/components/progress";
import { cn } from "@mapos/ui/lib/utils";
import { ANTHROPIC_MODELS, OLLAMA_MODELS } from "@shared/ai-models";
import {
  CheckIcon,
  CloudIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WrenchIcon
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { SiAnthropic, SiOllama } from "react-icons/si";
import { SettingsSheet } from "./settings-sheet";

type AiSettingsState = Awaited<ReturnType<typeof window.api.aiConfig.getSettingsState>>;
type CustomEndpoint = AiSettingsState["local"]["advanced"]["endpoints"][number];

const MAGIC_OLLAMA_BASE_URL = "http://localhost:11434";

type DetectionState = "checking" | "running" | "stopped";

// ── Group header ──────────────────────────────────────────────────────────────

function GroupHeader({
  label,
  action
}: {
  label: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {action}
    </div>
  );
}

// ── Provider badge ────────────────────────────────────────────────────────────

function ProviderBadge({
  kind,
  size = "md"
}: {
  kind: "cloud" | "local" | "custom";
  size?: "sm" | "md";
}): React.JSX.Element {
  const styles =
    kind === "cloud"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : kind === "local"
        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        : "bg-muted text-muted-foreground";
  const wrapper = size === "sm" ? "size-5 rounded" : "size-7 rounded-md";
  const icon = size === "sm" ? "size-3" : "size-4";
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center text-xs font-semibold",
        wrapper,
        styles
      )}
    >
      {kind === "cloud" ? (
        <SiAnthropic className={icon} />
      ) : kind === "local" ? (
        <SiOllama className={icon} />
      ) : (
        <WrenchIcon className={icon} />
      )}
    </span>
  );
}

// ── Model info popover ────────────────────────────────────────────────────────

function ModelInfo({
  fullId,
  description,
  rows
}: {
  fullId: string;
  description?: string;
  rows: { label: string; value: string }[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
        {fullId}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {rows.length > 0 && (
        <dl className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd className="truncate text-right text-xs font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// ── Model row ─────────────────────────────────────────────────────────────────

function ModelRow({
  kind,
  label,
  meta,
  selected,
  selectable,
  disabled,
  title,
  onClick,
  affordance,
  infoContent,
  pulling,
  pullPercent,
  onCancelPull
}: {
  kind: "cloud" | "local" | "custom";
  label: string;
  meta?: string;
  selected: boolean;
  selectable: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  affordance: React.ReactNode;
  infoContent?: React.ReactNode;
  pulling?: boolean;
  pullPercent?: number;
  onCancelPull?: () => void;
}): React.JSX.Element {
  const interactive = selectable && !disabled;
  return (
    // biome-ignore lint/a11y/useSemanticElements: Row contains nested action buttons (Download, Trash, etc.) so a real <button> would be invalid HTML; div + role + onKeyDown gives the same a11y semantics.
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      title={title}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (interactive) onClick();
      }}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex items-center gap-3 border-l-2 border-l-transparent px-3 py-2.5 transition-colors",
        selected && "border-l-emerald-500 bg-accent",
        interactive && !selected && "hover:bg-accent/40",
        interactive ? "cursor-pointer" : "cursor-default",
        disabled && "opacity-50"
      )}
    >
      <ProviderBadge kind={kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          {selected && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
        </div>
        {meta && <div className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</div>}
        {pulling && (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={pullPercent ?? 0} className="flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">{pullPercent ?? 0}%</span>
            {onCancelPull && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancelPull();
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
      {!pulling && (
        <div className="flex shrink-0 items-center gap-1.5">
          {infoContent && (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Model details"
                    title="Model details"
                  />
                }
              >
                <InfoIcon className="size-4 text-muted-foreground" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72">
                {infoContent}
              </PopoverContent>
            </Popover>
          )}
          {affordance}
        </div>
      )}
    </div>
  );
}

// ── API keys popover ──────────────────────────────────────────────────────────

function ApiKeysPopover({
  open,
  onOpenChange,
  state,
  onSaved,
  trigger
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AiSettingsState["anthropic"];
  onSaved: () => void;
  trigger: React.ReactNode;
}): React.JSX.Element {
  const apiKeyId = useId();
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  // Reset transient state when the popover closes.
  useEffect(() => {
    if (!open) {
      setApiKey("");
      setReveal(false);
      setError(null);
      setSavedMessage(null);
      setTestMessage(null);
    }
  }, [open]);

  async function handleSave(): Promise<void> {
    if (apiKey.length === 0) return;
    setBusy(true);
    setError(null);
    setSavedMessage(null);
    const result = await window.api.aiConfig.update({ anthropic: { apiKey } });
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
      ...(state.model ? { model: state.model } : {})
    });
    setTesting(false);
    if (result.ok) {
      setTestMessage("Connection ok");
      window.setTimeout(() => setTestMessage(null), 2000);
    } else {
      setError(result.error);
    }
  }

  async function handleRemove(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await window.api.aiConfig.update({ anthropic: { apiKey: null } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved();
  }

  const canTest = (apiKey.length > 0 || state.hasApiKey) && state.model.length > 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger as React.ReactElement} />
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>API keys</PopoverTitle>
          <PopoverDescription>
            Stored locally per provider. Used for cloud models.
          </PopoverDescription>
        </PopoverHeader>
        {state.hasApiKey ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Anthropic</span>
              <span className="text-xs text-emerald-500">Connected</span>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleTest()}
                disabled={testing || busy || !canTest}
              >
                {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
                Test
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void handleRemove()}
                disabled={busy}
              >
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                Remove
              </Button>
              {testMessage && <span className="text-xs text-emerald-500">{testMessage}</span>}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor={apiKeyId} className="text-xs font-medium">
                Anthropic
              </label>
              <InputGroup className="bg-background">
                <InputGroupInput
                  id={apiKeyId}
                  type={reveal ? "text" : "password"}
                  placeholder="sk-ant-..."
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
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={busy || apiKey.length === 0}
              >
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                Save
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleTest()}
                disabled={testing || busy || !canTest}
              >
                {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
                Test
              </Button>
              {savedMessage && <span className="text-xs text-emerald-500">{savedMessage}</span>}
              {testMessage && <span className="text-xs text-emerald-500">{testMessage}</span>}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Custom endpoint dialog ────────────────────────────────────────────────────

function CustomEndpointSheet({
  open,
  onOpenChange,
  endpoint,
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When defined, the sheet edits this endpoint; when null, it creates a new one. */
  endpoint: CustomEndpoint | null;
  /** Called after a successful save. The new endpoint id is passed when one was just created. */
  onSaved: (createdId: string | null) => void;
}): React.JSX.Element {
  const labelId = useId();
  const baseUrlId = useId();
  const authTokenId = useId();
  const modelId = useId();
  const isEdit = endpoint !== null;
  const initialLabel = endpoint?.label ?? "";
  const initialBaseUrl = endpoint?.baseUrl ?? "";
  const initialModel = endpoint?.model ?? "";
  const [label, setLabel] = useState(initialLabel);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [model, setModel] = useState(initialModel);
  const [authToken, setAuthToken] = useState("");
  const [revealToken, setRevealToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  // Re-sync from props each time the dialog opens (or the target endpoint changes).
  useEffect(() => {
    if (open) {
      setLabel(initialLabel);
      setBaseUrl(initialBaseUrl);
      setModel(initialModel);
      setAuthToken("");
      setRevealToken(false);
      setError(null);
      setTestMessage(null);
    }
  }, [open, initialLabel, initialBaseUrl, initialModel]);

  const dirty =
    label.trim() !== initialLabel ||
    baseUrl.trim() !== initialBaseUrl ||
    model.trim() !== initialModel ||
    authToken.length > 0;
  const canSave = baseUrl.trim().length > 0 && model.trim().length > 0;

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const trimmedLabel = label.trim();
    if (isEdit && endpoint) {
      const result = await window.api.aiConfig.updateCustomEndpoint(endpoint.id, {
        label: trimmedLabel,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(authToken.length > 0 ? { authToken } : {})
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved(null);
      onOpenChange(false);
      return;
    }
    const result = await window.api.aiConfig.addCustomEndpoint({
      label: trimmedLabel,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(authToken.length > 0 ? { authToken } : {})
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.id);
    onOpenChange(false);
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
  const hasSavedToken = endpoint?.hasAuthToken ?? false;

  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit endpoint" : "Add custom endpoint"}
      description="Any endpoint that speaks Anthropic's /v1/messages API (Ollama, LiteLLM, etc.)."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => void handleTest()}
            disabled={testing || busy || !canTest}
          >
            {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Test connection
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy || !dirty || !canSave}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={labelId} className="text-xs font-medium">
            Label
          </label>
          <InputGroup className="bg-background">
            <InputGroupInput
              id={labelId}
              placeholder="LiteLLM staging"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              spellCheck={false}
            />
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={baseUrlId} className="text-xs font-medium">
            Base URL
          </label>
          <InputGroup className="bg-background">
            <InputGroupInput
              id={baseUrlId}
              placeholder="http://localhost:11434"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={busy}
              spellCheck={false}
            />
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={authTokenId} className="text-xs font-medium">
            Auth token
          </label>
          <InputGroup className="bg-background">
            <InputGroupInput
              id={authTokenId}
              type={revealToken ? "text" : "password"}
              placeholder={hasSavedToken ? "•••••••••••" : "Optional"}
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
          <p className="text-[11px] text-muted-foreground">
            {hasSavedToken ? "Saved. Enter a new token to replace it." : "Optional bearer token."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={modelId} className="text-xs font-medium">
            Model name
          </label>
          <InputGroup className="bg-background">
            <InputGroupInput
              id={modelId}
              placeholder="qwen2.5:14b"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
              spellCheck={false}
            />
          </InputGroup>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {testMessage && <p className="text-xs text-emerald-500">{testMessage}</p>}
      </div>
    </SettingsSheet>
  );
}

// ── Ollama banner ─────────────────────────────────────────────────────────────

function OllamaBanner({ onRecheck }: { onRecheck: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2.5 text-sm">
      <div className="flex flex-col">
        <span className="font-medium">Ollama isn't running</span>
        <span className="text-xs text-muted-foreground">
          Local models require Ollama. Install it once and we'll detect it here.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <a
          href="https://ollama.com/download"
          target="_blank"
          rel="noreferrer noopener"
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          Install
          <ExternalLinkIcon className="size-3.5" />
        </a>
        <Button variant="ghost" size="sm" onClick={onRecheck}>
          Re-check
        </Button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function anthropicCapabilityMeta(modelId: string): string {
  // Minimal capability summary derived from the curated entry; falls back to a generic line.
  const entry = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  if (!entry) return "Cloud model";
  const ctx = entry.capabilities.contextWindow;
  const ctxLabel =
    ctx >= 1_000_000
      ? "1M context"
      : ctx >= 1000
        ? `${Math.round(ctx / 1000)}K context`
        : `${ctx} ctx`;
  const parts = [ctxLabel];
  if (entry.capabilities.supportsImages) parts.push("vision");
  if (entry.capabilities.supportsTools) parts.push("tools");
  return parts.join(" · ");
}

function currentModelDisplay(
  state: AiSettingsState
): { kind: "cloud" | "local" | "custom"; label: string } | null {
  if (state.provider === "anthropic") {
    const id = state.anthropic.model;
    if (!id) return null;
    const entry = ANTHROPIC_MODELS.find((m) => m.id === id);
    return { kind: "cloud", label: entry?.label ?? id };
  }
  if (state.local.mode === "advanced") {
    const active = state.local.advanced.endpoints.find(
      (e) => e.id === state.local.advanced.activeId
    );
    if (!active) return null;
    return { kind: "custom", label: active.label || active.model };
  }
  const id = state.local.magic.model;
  if (!id) return null;
  const entry = OLLAMA_MODELS.find((m) => m.id === id);
  return { kind: "local", label: entry?.label ?? id };
}

function customEndpointMeta(endpoint: CustomEndpoint): string {
  const host = (() => {
    if (!endpoint.baseUrl) return "";
    try {
      return new URL(endpoint.baseUrl).host || endpoint.baseUrl;
    } catch {
      return endpoint.baseUrl;
    }
  })();
  return [endpoint.model, host].filter(Boolean).join(" · ") || "Custom endpoint";
}

function ctxLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K tokens`;
  return `${tokens} tokens`;
}

function thinkingLabel(t: "adaptive" | "enabled" | false): string {
  if (t === "adaptive") return "Adaptive";
  if (t === "enabled") return "Enabled";
  return "No";
}

function anthropicInfoContent(modelId: string): React.ReactNode {
  const entry = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  if (!entry) return null;
  const c = entry.capabilities;
  return (
    <ModelInfo
      fullId={entry.id}
      rows={[
        { label: "Context", value: ctxLabel(c.contextWindow) },
        { label: "Vision", value: c.supportsImages ? "Yes" : "No" },
        { label: "Tools", value: c.supportsTools ? "Yes" : "No" },
        { label: "Thinking", value: thinkingLabel(c.thinking) }
      ]}
    />
  );
}

function ollamaCuratedInfoContent(model: (typeof OLLAMA_MODELS)[number]): React.ReactNode {
  const c = model.capabilities;
  return (
    <ModelInfo
      fullId={model.id}
      description={model.hint}
      rows={[
        { label: "Disk", value: model.size },
        { label: "Context", value: ctxLabel(c.contextWindow) },
        { label: "Vision", value: c.supportsImages ? "Yes" : "No" },
        { label: "Tools", value: c.supportsTools ? "Yes" : "No" }
      ]}
    />
  );
}

function ollamaGenericInfoContent(modelId: string): React.ReactNode {
  return (
    <ModelInfo
      fullId={modelId}
      description="Installed locally via Ollama. Capabilities default to off — local model behavior through the Anthropic-compat shim varies by model."
      rows={[]}
    />
  );
}

function customInfoContent(endpoint: CustomEndpoint): React.ReactNode {
  return (
    <ModelInfo
      fullId={endpoint.model || "(no model set)"}
      rows={[
        { label: "Endpoint", value: endpoint.baseUrl || "—" },
        { label: "Auth", value: endpoint.hasAuthToken ? "Token saved" : "None" }
      ]}
    />
  );
}

// ── AI tab root ───────────────────────────────────────────────────────────────

export function AiTab(): React.JSX.Element {
  const [state, setState] = useState<AiSettingsState | null>(null);

  // Ollama detection + installed list
  const [detection, setDetection] = useState<DetectionState>("checking");
  const [installed, setInstalled] = useState<string[]>([]);

  // Pull state
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number>(0);
  const [pullError, setPullError] = useState<string | null>(null);

  // Selection in flight (for optimistic emerald check)
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  // Delete state
  const [pendingDeleteModel, setPendingDeleteModel] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // UI overlays
  const [keysOpen, setKeysOpen] = useState(false);
  /** When the dialog is open, this is null for "create new" or the endpoint id for "edit". */
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customDialogEndpointId, setCustomDialogEndpointId] = useState<string | null>(null);
  const [pendingDeleteEndpoint, setPendingDeleteEndpoint] = useState<string | null>(null);
  const [deletingEndpoint, setDeletingEndpoint] = useState<string | null>(null);
  const [deleteEndpointError, setDeleteEndpointError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const baseUrl = MAGIC_OLLAMA_BASE_URL;

  const reload = useCallback(async () => {
    const next = await window.api.aiConfig.getSettingsState();
    setState(next);
  }, []);

  const refreshOllama = useCallback(async () => {
    const detected = await window.api.aiConfig.ollamaDetect(baseUrl);
    setDetection(detected.running ? "running" : "stopped");
    if (detected.running) {
      const list = await window.api.aiConfig.ollamaListInstalled(baseUrl);
      setInstalled(list);
    } else {
      setInstalled([]);
    }
  }, [baseUrl]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void refreshOllama();
    const id = window.setInterval(() => {
      if (detection !== "running") void refreshOllama();
    }, 2000);
    return () => window.clearInterval(id);
  }, [refreshOllama, detection]);

  useEffect(() => {
    return window.api.aiConfig.onPullProgress((data) => {
      if (data.modelId !== pullingModel) return;
      // Ollama's post-download events (verifying, writing manifest, cleanup) carry no percent;
      // accept only numeric, non-decreasing values so the bar doesn't snap back to 0.
      if (typeof data.percent === "number") {
        const next = data.percent;
        setPullPercent((prev) => (next > prev ? next : prev));
      }
      if (data.status === "done") {
        void refreshOllama();
      }
    });
  }, [pullingModel, refreshOllama]);

  function flashSaved(): void {
    setSavedMessage("Saved");
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

  async function selectCloud(modelId: string): Promise<void> {
    if (!state) return;
    // Cloud rows are disabled when no key is saved; this is defensive only.
    if (!state.anthropic.hasApiKey) return;
    setPendingSelect(modelId);
    const result = await window.api.aiConfig.update({
      provider: "anthropic",
      anthropic: { model: modelId }
    });
    setPendingSelect(null);
    if (!result.ok) return;
    await reload();
    flashSaved();
  }

  async function selectLocal(modelId: string): Promise<void> {
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
    await reload();
    flashSaved();
  }

  async function selectEndpoint(id: string): Promise<void> {
    setPendingSelect(`endpoint:${id}`);
    const result = await window.api.aiConfig.update({
      provider: "local",
      local: { mode: "advanced", advanced: { activeId: id } }
    });
    setPendingSelect(null);
    if (!result.ok) return;
    await reload();
    flashSaved();
  }

  function openAddEndpointDialog(): void {
    setCustomDialogEndpointId(null);
    setCustomDialogOpen(true);
  }

  function openEditEndpointDialog(id: string): void {
    setCustomDialogEndpointId(id);
    setCustomDialogOpen(true);
  }

  async function confirmDeleteEndpoint(): Promise<void> {
    const target = pendingDeleteEndpoint;
    if (!target) return;
    setDeletingEndpoint(target);
    setDeleteEndpointError(null);
    const result = await window.api.aiConfig.removeCustomEndpoint(target);
    setDeletingEndpoint(null);
    if (!result.ok) {
      setDeleteEndpointError(result.error);
      return;
    }
    setPendingDeleteEndpoint(null);
    await reload();
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
    await refreshOllama();
    await selectLocal(modelId);
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
    await refreshOllama();
    // Main has already cleared local.magic.model when the deleted model was active; pull the new state.
    await reload();
  }

  const curatedOllamaIds = useMemo(() => new Set(OLLAMA_MODELS.map((m) => m.id)), []);
  const otherInstalled = useMemo(
    () => installed.filter((m) => !curatedOllamaIds.has(m)),
    [installed, curatedOllamaIds]
  );

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  const ollamaRunning = detection === "running";
  const endpoints = state.local.advanced.endpoints;
  const cloudSelected = (modelId: string): boolean =>
    state.provider === "anthropic" && state.anthropic.model === modelId;
  const localSelected = (modelId: string): boolean =>
    state.provider === "local" &&
    state.local.mode === "magic" &&
    state.local.magic.model === modelId;
  const endpointSelected = (id: string): boolean =>
    state.provider === "local" &&
    state.local.mode === "advanced" &&
    state.local.advanced.activeId === id;
  const editingEndpoint = customDialogEndpointId
    ? (endpoints.find((e) => e.id === customDialogEndpointId) ?? null)
    : null;
  const pendingDeleteEndpointEntry = pendingDeleteEndpoint
    ? (endpoints.find((e) => e.id === pendingDeleteEndpoint) ?? null)
    : null;
  const current = currentModelDisplay(state);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-medium">Models</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Pick a model. Cloud models run on the provider's servers; local models run on this Mac.
        </p>
        {current && (
          <Alert className="mt-3 flex items-center gap-2">
            <ProviderBadge kind={current.kind} size="sm" />
            <AlertTitle>Currently using {current.label}</AlertTitle>
          </Alert>
        )}
      </div>

      {!ollamaRunning && detection !== "checking" && (
        <OllamaBanner onRecheck={() => void refreshOllama()} />
      )}

      {/* Anthropic */}
      <section className="flex flex-col gap-2">
        <GroupHeader
          label="Anthropic"
          action={
            <ApiKeysPopover
              open={keysOpen}
              onOpenChange={setKeysOpen}
              state={state.anthropic}
              onSaved={() => void reload()}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  {state.anthropic.hasApiKey ? "Manage" : "Connect your account"}
                </Button>
              }
            />
          }
        />
        <div className="divide-y divide-border overflow-hidden rounded-lg border">
          {ANTHROPIC_MODELS.map((m) => {
            const selected = cloudSelected(m.id) || pendingSelect === m.id;
            const noKey = !state.anthropic.hasApiKey;
            return (
              <ModelRow
                key={`cloud:${m.id}`}
                kind="cloud"
                label={m.label}
                meta={anthropicCapabilityMeta(m.id)}
                selected={selected}
                selectable={!noKey}
                disabled={noKey}
                title={noKey ? "Connect your Anthropic account to use this model" : undefined}
                onClick={() => void selectCloud(m.id)}
                infoContent={anthropicInfoContent(m.id)}
                affordance={
                  <span
                    className="flex size-7 shrink-0 items-center justify-center rounded-[min(var(--radius-md),12px)] text-muted-foreground"
                    aria-label="Cloud model"
                    role="img"
                  >
                    <CloudIcon className="size-4" aria-hidden />
                  </span>
                }
              />
            );
          })}
        </div>
      </section>

      {/* Local */}
      <section className="flex flex-col gap-2">
        <GroupHeader label="Local" />
        <div className="divide-y divide-border overflow-hidden rounded-lg border">
          {OLLAMA_MODELS.map((m) => {
            const isInstalled = installed.includes(m.id);
            const isSelected = localSelected(m.id) || pendingSelect === m.id;
            const isPulling = pullingModel === m.id;
            const isDeleting = deletingModel === m.id;
            return (
              <ModelRow
                key={`local:${m.id}`}
                kind="local"
                label={m.label}
                meta={`${m.size} · ${m.hint}`}
                selected={isSelected}
                selectable={isInstalled && !isPulling && !isDeleting}
                onClick={() => void selectLocal(m.id)}
                infoContent={ollamaCuratedInfoContent(m)}
                pulling={isPulling}
                pullPercent={isPulling ? pullPercent : undefined}
                onCancelPull={cancelCurrentPull}
                affordance={
                  isInstalled ? (
                    <>
                      <span className="text-xs tabular-nums text-muted-foreground">{m.size}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDeleteModel(m.id);
                        }}
                        disabled={isDeleting}
                        aria-label="Delete model"
                        title="Delete model"
                      >
                        {isDeleting ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <Trash2Icon className="size-4" />
                        )}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void pullAndSelect(m.id);
                      }}
                      disabled={!ollamaRunning || pullingModel !== null}
                      aria-label="Download model"
                      title={!ollamaRunning ? "Start Ollama to download" : "Download model"}
                    >
                      <DownloadIcon className="size-4" />
                    </Button>
                  )
                }
              />
            );
          })}
          {otherInstalled.map((modelId) => {
            const isSelected = localSelected(modelId) || pendingSelect === modelId;
            const isDeleting = deletingModel === modelId;
            return (
              <ModelRow
                key={`local:${modelId}`}
                kind="local"
                label={modelId}
                meta="Installed locally via Ollama"
                selected={isSelected}
                selectable={!isDeleting}
                onClick={() => void selectLocal(modelId)}
                infoContent={ollamaGenericInfoContent(modelId)}
                affordance={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteModel(modelId);
                    }}
                    disabled={isDeleting}
                    aria-label="Delete model"
                    title="Delete model"
                  >
                    {isDeleting ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-4" />
                    )}
                  </Button>
                }
              />
            );
          })}
        </div>
      </section>

      {/* Custom */}
      <section className="flex flex-col gap-2">
        <GroupHeader
          label="Custom"
          action={
            <Button type="button" variant="outline" size="sm" onClick={openAddEndpointDialog}>
              {endpoints.length === 0 ? (
                "Add"
              ) : (
                <>
                  <PlusIcon className="size-3.5" />
                  Add
                </>
              )}
            </Button>
          }
        />
        {endpoints.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-lg border">
            {endpoints.map((endpoint) => {
              const isSelected =
                endpointSelected(endpoint.id) || pendingSelect === `endpoint:${endpoint.id}`;
              const isDeleting = deletingEndpoint === endpoint.id;
              return (
                <ModelRow
                  key={`endpoint:${endpoint.id}`}
                  kind="custom"
                  label={endpoint.label || endpoint.model || "Custom endpoint"}
                  meta={customEndpointMeta(endpoint)}
                  selected={isSelected}
                  selectable={!isDeleting}
                  onClick={() => void selectEndpoint(endpoint.id)}
                  infoContent={customInfoContent(endpoint)}
                  affordance={
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditEndpointDialog(endpoint.id);
                        }}
                        disabled={isDeleting}
                        aria-label="Edit endpoint"
                        title="Edit endpoint"
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDeleteEndpoint(endpoint.id);
                        }}
                        disabled={isDeleting}
                        aria-label="Delete endpoint"
                        title="Delete endpoint"
                      >
                        {isDeleting ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <Trash2Icon className="size-4" />
                        )}
                      </Button>
                    </>
                  }
                />
              );
            })}
          </div>
        ) : (
          <div className="flex h-[60px] items-center justify-center rounded-lg border px-3 text-xs text-muted-foreground">
            No custom endpoints
          </div>
        )}
      </section>

      {pullError && <p className="text-xs text-destructive">{pullError}</p>}
      {savedMessage && <p className="text-xs text-emerald-500">{savedMessage}</p>}

      <CustomEndpointSheet
        open={customDialogOpen}
        onOpenChange={(o) => {
          setCustomDialogOpen(o);
          if (!o) setCustomDialogEndpointId(null);
        }}
        endpoint={editingEndpoint}
        onSaved={(createdId) => {
          void (async () => {
            await reload();
            // Newly created endpoints become the active selection — matches the previous
            // "save advanced config and use it" flow so users don't have to click twice.
            if (createdId) {
              await selectEndpoint(createdId);
            }
          })();
        }}
      />

      <AlertDialog
        open={!!pendingDeleteEndpoint}
        onOpenChange={(o) => {
          if (!o && !deletingEndpoint) {
            setPendingDeleteEndpoint(null);
            setDeleteEndpointError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteEndpointEntry?.label ||
                pendingDeleteEndpointEntry?.model ||
                "This endpoint"}{" "}
              will be removed. The model files at the remote endpoint are not affected.
            </AlertDialogDescription>
            {deleteEndpointError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteEndpointError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (deletingEndpoint) return;
                setPendingDeleteEndpoint(null);
                setDeleteEndpointError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!deletingEndpoint}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteEndpoint();
              }}
            >
              {deletingEndpoint ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

import { Button } from "@mapos/ui/components/button";
import { Input } from "@mapos/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@mapos/ui/components/select";
import { cn } from "@mapos/ui/lib/utils";
import type { ProviderAuthKind, ProviderProtocol, ProviderView } from "@shared/ai-providers";
import {
  CheckCircle2Icon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlugZapIcon,
  Trash2Icon
} from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsSheet } from "../settings-sheet";

const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  anthropic: "Anthropic (Messages API)",
  openai: "OpenAI-compatible"
};

const AUTH_LABELS: Record<ProviderAuthKind, string> = {
  none: "None",
  "api-key": "API key (x-api-key)",
  bearer: "Bearer token"
};

/**
 * Add or edit one provider. A single form replaces the three separate add/edit surfaces (API
 * key sheet, custom endpoint sheet, magic model picker) of the legacy design — protocol + baseUrl
 * + auth are just fields. Built-in providers keep their protocol locked since it's structural.
 */
export function ProviderEditorSheet({
  open,
  onOpenChange,
  provider,
  onSaved,
  onRequestDelete
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new provider; otherwise edit this one. */
  provider: ProviderView | null;
  onSaved: (createdId?: string) => void;
  /** When editing, fires a removal request (closes the sheet; the host confirms + deletes). */
  onRequestDelete?: () => void;
}): React.JSX.Element {
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<ProviderProtocol>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [authKind, setAuthKind] = useState<ProviderAuthKind>("none");
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const isEdit = !!provider;

  // Hydrate the form from the target whenever the sheet opens.
  useEffect(() => {
    if (!open) return;
    setLabel(provider?.label ?? "");
    setProtocol(provider?.protocol ?? "openai");
    setBaseUrl(provider?.baseUrl ?? "");
    setAuthKind(provider?.authKind ?? "none");
    setSecret("");
    setReveal(false);
    setError(null);
  }, [open, provider]);

  // A test result only describes the values that produced it — invalidate it as soon as any of
  // those inputs change so we never show a stale "Connected" against an edited endpoint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the tested inputs
  useEffect(() => {
    setTestResult(null);
  }, [protocol, baseUrl, authKind, secret]);

  function buildInput(): {
    label: string;
    protocol: ProviderProtocol;
    baseUrl: string;
    authKind: ProviderAuthKind;
    secret?: string;
  } {
    return {
      label: label.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      authKind,
      // Only send the secret when the user typed one; an empty field leaves the saved one intact.
      ...(secret.trim().length > 0 ? { secret: secret.trim() } : {})
    };
  }

  // Revealing a saved-but-untyped secret pulls the decrypted value into the field first, so the
  // eye shows the real key (editable in place) instead of toggling an empty input.
  async function handleToggleReveal(): Promise<void> {
    if (!reveal && secret.length === 0 && provider?.hasSecret) {
      const result = await window.api.ai.revealSecret(provider.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSecret(result.secret);
    }
    setReveal((r) => !r);
  }

  async function handleTest(): Promise<void> {
    if (!baseUrl.trim()) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    const result = await window.api.ai.testProvider(buildInput(), provider?.id);
    setTesting(false);
    setTestResult(
      result.ok
        ? {
            ok: true,
            message: `${result.modelCount} model${result.modelCount === 1 ? "" : "s"} available`
          }
        : { ok: false, message: result.error }
    );
  }

  async function handleSave(): Promise<void> {
    const trimmedBase = baseUrl.trim();
    if (!trimmedBase) {
      setError("Base URL is required.");
      return;
    }
    setBusy(true);
    setError(null);
    const input = buildInput();
    const result = provider
      ? await window.api.ai.updateProvider(provider.id, input)
      : await window.api.ai.addProvider(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved("id" in result ? result.id : undefined);
    onOpenChange(false);
  }

  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit provider" : "Add provider"}
      description="A provider is a protocol, an endpoint, and how it authenticates. Models are fetched live from it."
      footer={
        <div className="flex items-center gap-2">
          {isEdit && onRequestDelete && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={onRequestDelete}
            >
              <Trash2Icon className="size-4" />
              Remove
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => void handleTest()}
            disabled={busy || testing || baseUrl.trim().length === 0}
          >
            {testing ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <PlugZapIcon className="size-4" />
            )}
            Test
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy || baseUrl.trim().length === 0}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      }
    >
      <div className="flex min-h-full flex-col gap-4">
        <Field label="Name">
          <Input
            value={label}
            placeholder={PROTOCOL_LABELS[protocol]}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        <Field label="Protocol">
          <Select
            items={PROTOCOL_LABELS}
            value={protocol}
            onValueChange={(v) => setProtocol(v as ProviderProtocol)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="anthropic">{PROTOCOL_LABELS.anthropic}</SelectItem>
                <SelectItem value="openai">{PROTOCOL_LABELS.openai}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Base URL">
          <Input
            value={baseUrl}
            placeholder="http://localhost:11434"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>

        <Field label="Authentication">
          <Select
            items={AUTH_LABELS}
            value={authKind}
            onValueChange={(v) => setAuthKind(v as ProviderAuthKind)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="none">{AUTH_LABELS.none}</SelectItem>
                <SelectItem value="api-key">{AUTH_LABELS["api-key"]}</SelectItem>
                <SelectItem value="bearer">{AUTH_LABELS.bearer}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {authKind !== "none" && (
          <Field
            label="Secret"
            hint={
              isEdit && provider?.hasSecret
                ? "A secret is saved. Leave blank to keep it, or type a new one to replace."
                : undefined
            }
          >
            <InputGroup className="bg-background">
              <InputGroupAddon>
                <KeyRoundIcon />
              </InputGroupAddon>
              <InputGroupInput
                type={reveal ? "text" : "password"}
                placeholder={isEdit && provider?.hasSecret ? "•••••••• saved" : "sk-..."}
                value={secret}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setSecret(e.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void handleToggleReveal()}
                  aria-label={reveal ? "Hide secret" : "Show secret"}
                >
                  {reveal ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        )}

        {(testResult || error) && (
          <div
            className={cn(
              "mt-auto flex items-start gap-1.5 rounded-md px-3 py-2 text-xs",
              testResult?.ok
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {testResult?.ok && <CheckCircle2Icon className="mt-px size-3.5 shrink-0" />}
            <span className="min-w-0 break-words">{testResult ? testResult.message : error}</span>
          </div>
        )}
      </div>
    </SettingsSheet>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground/80">{hint}</span>}
    </div>
  );
}

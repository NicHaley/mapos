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
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@mapos/ui/components/select";
import type { ProviderAuthKind, ProviderProtocol, ProviderView } from "@shared/ai-providers";
import { EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
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
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new provider; otherwise edit this one. */
  provider: ProviderView | null;
  onSaved: (createdId?: string) => void;
}): React.JSX.Element {
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<ProviderProtocol>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [authKind, setAuthKind] = useState<ProviderAuthKind>("none");
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleSave(): Promise<void> {
    const trimmedBase = baseUrl.trim();
    if (!trimmedBase) {
      setError("Base URL is required.");
      return;
    }
    setBusy(true);
    setError(null);
    const input = {
      label: label.trim(),
      protocol,
      baseUrl: trimmedBase,
      authKind,
      // Only send the secret when the user typed one; an empty field leaves the saved one intact.
      ...(secret.trim().length > 0 ? { secret: secret.trim() } : {})
    };
    const result = provider
      ? await window.api.aiv2.updateProvider(provider.id, input)
      : await window.api.aiv2.addProvider(input);
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
        <div className="flex items-center justify-end gap-2">
          {error && <span className="mr-auto text-xs text-destructive">{error}</span>}
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
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={label}
            placeholder={PROTOCOL_LABELS[protocol]}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        <Field
          label="Protocol"
          hint={provider?.builtin ? "Locked for built-in providers." : undefined}
        >
          <Select
            value={protocol}
            onValueChange={(v) => setProtocol(v as ProviderProtocol)}
            disabled={!!provider?.builtin}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">{PROTOCOL_LABELS.anthropic}</SelectItem>
              <SelectItem value="openai">{PROTOCOL_LABELS.openai}</SelectItem>
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
          <Select value={authKind} onValueChange={(v) => setAuthKind(v as ProviderAuthKind)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{AUTH_LABELS.none}</SelectItem>
              <SelectItem value="api-key">{AUTH_LABELS["api-key"]}</SelectItem>
              <SelectItem value="bearer">{AUTH_LABELS.bearer}</SelectItem>
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
                  onClick={() => setReveal((r) => !r)}
                  aria-label={reveal ? "Hide secret" : "Show secret"}
                >
                  {reveal ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
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

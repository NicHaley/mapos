import { Button } from "@mapos/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import { EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { SettingsSheet } from "../settings-sheet";
import type { CustomEndpoint } from "./types";

export function CustomEndpointSheet({
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

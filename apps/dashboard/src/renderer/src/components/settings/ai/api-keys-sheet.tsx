import { Button } from "@mapos/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import { ExternalLinkIcon, EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { SiAnthropic } from "react-icons/si";
import { SettingsSheet } from "../settings-sheet";
import type { AiSettingsState } from "./types";

export function ApiKeysSheet({
  open,
  onOpenChange,
  state,
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AiSettingsState["anthropic"];
  onSaved: () => void;
}): React.JSX.Element {
  const apiKeyId = useId();
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  // Reset transient state when the sheet closes.
  useEffect(() => {
    if (!open) {
      setApiKey("");
      setReveal(false);
      setError(null);
      setTestMessage(null);
    }
  }, [open]);

  async function handleSave(): Promise<void> {
    if (apiKey.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await window.api.aiConfig.update({ anthropic: { apiKey } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setApiKey("");
    onSaved();
    onOpenChange(false);
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
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Anthropic API key"
      description="Used to call Claude models. Stored on this Mac, sent only to Anthropic."
      footer={
        state.hasApiKey ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {testMessage && <span className="mr-auto text-xs text-emerald-500">{testMessage}</span>}
            <Button
              variant="secondary"
              onClick={() => void handleTest()}
              disabled={testing || busy || !canTest}
            >
              {testing ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Test connection
            </Button>
            <Button variant="destructive" onClick={() => void handleRemove()} disabled={busy}>
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {testMessage && <span className="mr-auto text-xs text-emerald-500">{testMessage}</span>}
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
              onClick={() => void handleSave()}
              disabled={busy || apiKey.length === 0}
            >
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
        )
      }
    >
      {state.hasApiKey ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
            <SiAnthropic className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>Connected to Anthropic.</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Remove this key before pasting a different one.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
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
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          >
            Get an API key <ExternalLinkIcon className="size-3" />
          </a>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </SettingsSheet>
  );
}

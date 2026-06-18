import { Button } from "@mapos/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import { cn } from "@mapos/ui/lib/utils";
import type { ProviderView } from "@shared/ai-providers";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon
} from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Auth controls for a known (Pi catalog) provider. This is the UX answer to the manual-token
 * problem: a subscription provider shows a one-click "Sign in" (OAuth), and any provider offers a
 * guided API-key paste as the alternative. No protocol/baseUrl/token form for mainstream providers.
 */
export function KnownProviderAuth({
  provider,
  onChanged,
  padded = true
}: {
  provider: ProviderView;
  onChanged: () => void;
  /** Whether the root carries its own inset. Off when the host (a sheet) already pads its body. */
  padded?: boolean;
}): React.JSX.Element {
  const name = provider.knownProvider as string; // only rendered for known providers
  const { auth } = provider;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [oauthMsg, setOauthMsg] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);

  // Stream OAuth progress for this provider so the user sees "open your browser" (callback flow) or
  // a code to enter (device flow) rather than a bare spinner.
  useEffect(() => {
    return window.api.ai.onOAuthProgress((data) => {
      if (data.provider !== name) return;
      if (data.status === "awaiting-browser") {
        setOauthMsg("Complete sign-in in your browser…");
        if (data.url) setOauthUrl(data.url);
      } else if (data.status === "device-code") {
        if (data.userCode && data.verificationUri) {
          setDeviceCode({ userCode: data.userCode, verificationUri: data.verificationUri });
        }
        setOauthMsg(null);
        setOauthUrl(null);
      } else if (data.status === "starting") {
        setOauthMsg("Starting…");
      } else if (data.status === "done" || data.status === "error") {
        setOauthMsg(null);
        setOauthUrl(null);
        setDeviceCode(null);
      } else {
        setOauthMsg(data.status);
      }
    });
  }, [name]);

  async function signIn(): Promise<void> {
    setBusy(true);
    setError(null);
    setDeviceCode(null);
    const result = await window.api.ai.oauthLogin(name);
    setBusy(false);
    setOauthMsg(null);
    setOauthUrl(null);
    setDeviceCode(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChanged();
  }

  async function saveKey(): Promise<void> {
    if (keyDraft.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await window.api.ai.setApiKey(name, keyDraft.trim());
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setKeyDraft("");
    setShowKey(false);
    onChanged();
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setError(null);
    await window.api.ai.disconnect(name);
    setBusy(false);
    onChanged();
  }

  // Connected state — show how, and offer disconnect.
  if (auth.configured) {
    return (
      <div className={cn("flex items-center gap-2", padded && "px-3 py-2.5")}>
        <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />
        <span className="flex-1 text-sm">
          {auth.method === "oauth" ? "Signed in (subscription)" : "API key saved"}
        </span>
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button variant="ghost" size="sm" onClick={() => void disconnect()} disabled={busy}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Disconnect
        </Button>
      </div>
    );
  }

  // Not connected — sign in (if available) and/or paste a key.
  return (
    <div className={cn("flex flex-col gap-2", padded && "px-3 py-2.5")}>
      <div className="flex flex-wrap items-center gap-2">
        {auth.oauthAvailable && (
          <Button size="sm" onClick={() => void signIn()} disabled={busy}>
            {busy && !showKey ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Sign in with {provider.label}
          </Button>
        )}
        <Button
          variant={auth.oauthAvailable ? "ghost" : "secondary"}
          size="sm"
          onClick={() => setShowKey((s) => !s)}
          disabled={busy}
        >
          {auth.oauthAvailable ? "Use API key instead" : "Add API key"}
        </Button>
      </div>

      {oauthMsg && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          <span>{oauthMsg}</span>
          {oauthUrl && (
            <a
              href={oauthUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-foreground hover:underline"
            >
              Open browser <ExternalLinkIcon className="size-3" />
            </a>
          )}
          <button
            type="button"
            onClick={() => void window.api.ai.oauthCancel()}
            className="ml-auto text-foreground hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {deviceCode && (
        <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
          <span className="text-xs text-muted-foreground">
            Enter this code at{" "}
            <a
              href={deviceCode.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
              className="text-foreground hover:underline"
            >
              {deviceCode.verificationUri.replace(/^https?:\/\//, "")}
            </a>
          </span>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-2 py-1.5 text-center font-mono text-base tracking-[0.3em]">
              {deviceCode.userCode}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(deviceCode.userCode)}
            >
              Copy
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            <span>Waiting for you to authorize…</span>
            <button
              type="button"
              onClick={() => void window.api.ai.oauthCancel()}
              className="ml-auto text-foreground hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showKey && (
        <InputGroup className="bg-background">
          <InputGroupAddon>
            <KeyRoundIcon />
          </InputGroupAddon>
          <InputGroupInput
            type={reveal ? "text" : "password"}
            placeholder="Paste API key"
            value={keyDraft}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveKey();
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              variant="ghost"
              size="icon-xs"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? "Hide key" : "Show key"}
            >
              {reveal ? <EyeOffIcon /> : <EyeIcon />}
            </InputGroupButton>
            <InputGroupButton
              variant="default"
              onClick={() => void saveKey()}
              disabled={busy || keyDraft.trim().length === 0}
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Save
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      )}

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

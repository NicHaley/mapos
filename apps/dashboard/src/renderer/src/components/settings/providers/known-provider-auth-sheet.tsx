import { Button } from "@mapos/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import type { ProviderView } from "@shared/ai-providers";
import {
  CheckCircle2Icon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  Trash2Icon
} from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsSheet } from "../settings-sheet";
import { OauthProgress } from "./oauth-progress";
import { useKnownProviderConnect } from "./use-known-provider-connect";

/** What the drawer is connecting: a not-yet-persisted catalog entry, or an existing provider row. */
export type ConnectTarget =
  | { kind: "new"; name: string; label: string }
  | { kind: "existing"; provider: ProviderView };

/**
 * Connect drawer for a known (Pi catalog) provider. Follows the form-drawer convention: the primary
 * action lives in the footer. For a `new` target nothing is persisted until that action succeeds —
 * the provider row is written on connect, so an abandoned drawer leaves the list untouched.
 *
 * The footer adapts to the chosen method: "Sign in with X" for OAuth providers, "Connect" once an
 * API key is being entered (the only path for key-only providers).
 */
export function KnownProviderAuthSheet({
  open,
  onOpenChange,
  target,
  onChanged,
  onConnected,
  onRequestDelete
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null while no row/catalog entry is targeted (e.g. during the close animation). */
  target: ConnectTarget | null;
  /** Fired on any auth change (connect or disconnect) so the host can reload its state. */
  onChanged: () => void;
  /** Fired only after a successful connect, so the host can prompt a model selection. */
  onConnected: () => void;
  /** For an existing row, fires a removal request (closes the sheet; the host confirms + deletes). */
  onRequestDelete?: () => void;
}): React.JSX.Element {
  const name = target
    ? target.kind === "existing"
      ? (target.provider.knownProvider ?? "")
      : target.name
    : "";
  const label = target ? (target.kind === "existing" ? target.provider.label : target.label) : "";
  const persistOnConnect = target?.kind === "new";

  const [resolvedOauth, setResolvedOauth] = useState<boolean | null>(null);
  const [keyMode, setKeyMode] = useState(false);

  const connect = useKnownProviderConnect(name, { onChanged, persistOnConnect });

  // A brand-new (not-yet-persisted) provider has no row to read oauth availability from, so resolve
  // it from the catalog when the drawer opens. Reset the key/sign-in mode on each open.
  useEffect(() => {
    if (!open) return;
    setKeyMode(false);
    if (target?.kind !== "new") {
      setResolvedOauth(null);
      return;
    }
    let cancelled = false;
    setResolvedOauth(null);
    void window.api.ai.listKnownProviders().then((list) => {
      if (cancelled) return;
      setResolvedOauth(list.find((k) => k.name === name)?.oauthAvailable ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, target?.kind, name]);

  const existingAuth = target?.kind === "existing" ? target.provider.auth : null;
  const configured = existingAuth?.configured ?? false;
  const oauthAvailable = existingAuth ? existingAuth.oauthAvailable : (resolvedOauth ?? false);
  const resolving = target?.kind === "new" && resolvedOauth === null;
  // Key entry is the active method for key-only providers, or once the user opts into it.
  const keyEntry = !oauthAvailable || keyMode;

  async function primaryConnect(): Promise<void> {
    const ok = keyEntry ? await connect.saveKey() : await connect.signIn();
    if (ok) {
      onConnected();
      onOpenChange(false);
    }
  }

  // Removal lives in the footer for an existing row; the X / backdrop already handle dismissal.
  const removeButton =
    target?.kind === "existing" && onRequestDelete ? (
      <Button
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={connect.busy}
        onClick={onRequestDelete}
      >
        <Trash2Icon className="size-4" />
        Remove
      </Button>
    ) : (
      <span />
    );

  const footer = !target ? null : configured ? (
    <div className="flex items-center justify-between gap-2">
      {removeButton}
      <Button variant="outline" onClick={() => void connect.disconnect()} disabled={connect.busy}>
        {connect.busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
        Disconnect
      </Button>
    </div>
  ) : (
    <div className="flex items-center justify-between gap-2">
      {removeButton}
      <Button
        onClick={() => void primaryConnect()}
        disabled={connect.busy || resolving || (keyEntry && !connect.canSaveKey)}
      >
        {connect.busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
        {keyEntry ? "Connect" : `Sign in with ${label}`}
      </Button>
    </div>
  );

  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={target ? `Connect ${label}` : "Connect"}
      description="Sign in or paste an API key. MapOS fetches available models live once connected."
      footer={footer}
    >
      {target &&
        (configured ? (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />
            <span>
              {existingAuth?.method === "oauth" ? "Signed in (subscription)." : "API key saved."}
            </span>
          </div>
        ) : resolving ? (
          <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {oauthAvailable && !keyMode && (
              <p className="text-muted-foreground text-sm">
                Sign in to use your {label} subscription, or{" "}
                <button
                  type="button"
                  className="text-foreground underline"
                  onClick={() => setKeyMode(true)}
                >
                  use an API key
                </button>
                .
              </p>
            )}

            {keyEntry && (
              <div className="flex flex-col gap-2">
                <InputGroup className="bg-background">
                  <InputGroupAddon>
                    <KeyRoundIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    type={connect.reveal ? "text" : "password"}
                    placeholder="Paste API key"
                    value={connect.keyDraft}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => connect.setKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void primaryConnect();
                      }
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => connect.setReveal((r) => !r)}
                      aria-label={connect.reveal ? "Hide key" : "Show key"}
                    >
                      {connect.reveal ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {oauthAvailable && (
                  <button
                    type="button"
                    className="self-start text-muted-foreground text-xs underline"
                    onClick={() => setKeyMode(false)}
                  >
                    Back to sign in
                  </button>
                )}
              </div>
            )}

            <OauthProgress connect={connect} />
            {connect.error && <span className="text-xs text-destructive">{connect.error}</span>}
          </div>
        ))}
    </SettingsSheet>
  );
}

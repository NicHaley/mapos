import { Button } from "@mapos/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import { cn } from "@mapos/ui/lib/utils";
import type { ProviderView } from "@shared/ai-providers";
import { CheckCircle2Icon, EyeIcon, EyeOffIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { OauthProgress } from "./oauth-progress";
import { useKnownProviderConnect } from "./use-known-provider-connect";

/**
 * Inline auth controls for a known (Pi catalog) provider, used in onboarding's expandable rows. The
 * settings drawer renders the same connect logic (via {@link useKnownProviderConnect}) but moves the
 * primary action into the drawer footer; here the actions stay inline.
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
  const connect = useKnownProviderConnect(name, { onChanged });
  // For an OAuth provider, sign-in is primary and the key field is a secondary toggle. For a
  // key-only provider there's nothing to toggle, so show the field directly — no extra click.
  const [showKey, setShowKey] = useState(false);
  const showKeyField = showKey || !auth.oauthAvailable;

  // Connected state — show how, and offer disconnect.
  if (auth.configured) {
    return (
      <div className={cn("flex items-center gap-2", padded && "px-3 py-2.5")}>
        <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />
        <span className="flex-1 text-sm">
          {auth.method === "oauth" ? "Signed in (subscription)" : "API key saved"}
        </span>
        {connect.error && <span className="text-xs text-destructive">{connect.error}</span>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void connect.disconnect()}
          disabled={connect.busy}
        >
          {connect.busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Disconnect
        </Button>
      </div>
    );
  }

  // Not connected — sign in (if available) and/or paste a key.
  return (
    <div className={cn("flex flex-col gap-2", padded && "px-3 py-2.5")}>
      {auth.oauthAvailable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void connect.signIn()} disabled={connect.busy}>
            {connect.busy && !showKey ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Sign in with {provider.label}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowKey((s) => !s)}
            disabled={connect.busy}
          >
            Use API key instead
          </Button>
        </div>
      )}

      <OauthProgress connect={connect} />

      {showKeyField && (
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
                void connect.saveKey();
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
            <InputGroupButton
              variant="default"
              onClick={() => void connect.saveKey()}
              disabled={connect.busy || !connect.canSaveKey}
            >
              {connect.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Save
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      )}

      {connect.error && <span className="text-xs text-destructive">{connect.error}</span>}
    </div>
  );
}

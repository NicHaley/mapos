import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import type { KnownProviderConnect } from "./use-known-provider-connect";

/**
 * Shared OAuth progress UI: the "complete sign-in in your browser" line (callback flow) and the
 * device-code panel (GitHub Copilot). Rendered by both the onboarding inline panel and the settings
 * connect drawer, driven by {@link useKnownProviderConnect}.
 */
export function OauthProgress({ connect }: { connect: KnownProviderConnect }): React.JSX.Element {
  const { oauthMsg, oauthUrl, deviceCode, cancelOauth } = connect;
  return (
    <>
      {oauthMsg && (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          <span>{oauthMsg}</span>
          {oauthUrl && (
            <a
              href={oauthUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-foreground hover:underline"
            >
              Open <ExternalLinkIcon className="size-3" />
            </a>
          )}
          <button
            type="button"
            onClick={cancelOauth}
            className="ml-auto text-foreground hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {deviceCode && (
        <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
          <span className="text-muted-foreground text-xs">
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
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs hover:bg-accent/40"
              onClick={() => void navigator.clipboard.writeText(deviceCode.userCode)}
            >
              Copy
            </button>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            <span>Waiting for you to authorize…</span>
            <button
              type="button"
              onClick={cancelOauth}
              className="ml-auto text-foreground hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

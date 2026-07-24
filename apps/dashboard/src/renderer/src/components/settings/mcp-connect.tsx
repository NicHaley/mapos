import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@mapos/ui/components/collapsible";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle
} from "@mapos/ui/components/item";
import { Switch } from "@mapos/ui/components/switch";
import { cn } from "@mapos/ui/lib/utils";
import type { McpConnectionInfo } from "@shared/types";
import { CheckIcon, ChevronRightIcon, CopyIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  activityClientName,
  formatTimeAgo,
  isRecentActivity,
  useNow
} from "../../lib/mcp-activity";

// Ready-to-paste config for each MCP client, with the live URL + token baked in. `hint` names
// where the snippet goes. Clients that speak Streamable HTTP take the URL directly; stdio-only
// clients (Claude Desktop) go through the community `mcp-remote` shim.
function clientSnippets(
  url: string,
  token: string
): { label: string; hint: string; code: string }[] {
  const auth = `Authorization: Bearer ${token}`;
  return [
    {
      label: "Claude Code",
      hint: "Run in your terminal",
      code: `claude mcp add mapos --transport http ${url} --header "${auth}" --scope user`
    },
    {
      label: "Claude Desktop",
      hint: "claude_desktop_config.json",
      code: JSON.stringify(
        { mcpServers: { mapos: { command: "npx", args: ["mcp-remote", url, "--header", auth] } } },
        null,
        2
      )
    },
    {
      label: "Cursor",
      hint: "~/.cursor/mcp.json",
      code: JSON.stringify(
        { mcpServers: { mapos: { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2
      )
    },
    {
      label: "Codex",
      hint: "~/.codex/config.toml",
      // `url` selects the Streamable HTTP transport; custom headers (our bearer token) go under
      // the nested http_headers table.
      code: `[mcp_servers.mapos]\nurl = "${url}"\n\n[mcp_servers.mapos.http_headers]\nAuthorization = "Bearer ${token}"`
    }
  ];
}

// Copy action for use inside an InputGroup addon. Writes via the native clipboard over IPC —
// the renderer's navigator.clipboard is blocked by the app's deny-by-default permission handler.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void window.api.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <InputGroupButton onClick={copy} className="gap-1.5">
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Copy"}
    </InputGroupButton>
  );
}

// "Did it work?" indicator built on witnessed requests, the only signal a stateless MCP server
// has: green while activity is recent, a factual "last active …" once it goes quiet (an idle
// client is indistinguishable from a removed one), dashed while nothing has ever connected.
function ConnectionStatus({ lastActivity }: { lastActivity: McpConnectionInfo["lastActivity"] }) {
  const now = useNow();
  if (!lastActivity) {
    return (
      <div className="flex items-center gap-2.5 rounded-md border border-dashed border-input px-3.5 py-3 text-sm text-muted-foreground">
        <span className="inline-block size-2 rounded-full bg-muted-foreground/40" />
        Waiting for a client to connect…
      </div>
    );
  }
  const name = activityClientName(lastActivity);
  const ago = formatTimeAgo(now, lastActivity.at);
  if (isRecentActivity(lastActivity, now)) {
    return (
      <div className="flex items-center gap-2.5 rounded-md border border-emerald-600/20 bg-emerald-500/10 px-3.5 py-3 text-sm">
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-emerald-600">
          <CheckIcon className="size-3 text-white" strokeWidth={3.5} />
        </span>
        <span className="text-emerald-800 dark:text-emerald-200">
          Connected — <span className="font-medium">{name}</span>{" "}
          <span className="text-emerald-700/70 dark:text-emerald-300/70">
            {lastActivity.version ? `v${lastActivity.version} · ` : ""}
            active {ago}
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-input px-3.5 py-3 text-sm text-muted-foreground">
      <span className="inline-block size-2 rounded-full bg-muted-foreground/40" />
      <span>
        <span className="font-medium text-foreground">{name}</span> — last active {ago}
      </span>
    </div>
  );
}

/**
 * The MCP server setup surface: enable toggle, live connection status, a client picker that
 * shows one ready-to-paste snippet at a time, and the access token behind a disclosure. Shared
 * by Settings › Connections and the onboarding Connect step so both render the same content.
 */
export function McpConnect() {
  const [info, setInfo] = useState<McpConnectionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState(0);
  const [tokenOpen, setTokenOpen] = useState(false);

  useEffect(() => {
    void window.api.mcp.getConnectionInfo().then(setInfo);
  }, []);

  useEffect(() => {
    return window.api.mcp.onActivity((activity) => {
      setInfo((prev) => (prev ? { ...prev, lastActivity: activity } : prev));
    });
  }, []);

  const toggle = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      setInfo(await window.api.mcp.setEnabled(enabled));
    } finally {
      setBusy(false);
    }
  }, []);

  const regenerate = useCallback(async () => {
    setBusy(true);
    setInfo(await window.api.mcp.regenerateToken());
    setBusy(false);
  }, []);

  if (!info) return null;

  const snippets = clientSnippets(info.url, info.token);
  const active = snippets[client] ?? snippets[0];

  return (
    <div className="flex w-full min-w-0 flex-col gap-7">
      <Item className="px-0">
        <ItemContent>
          <ItemTitle>MCP server</ItemTitle>
          <ItemDescription>
            Let an AI client drive MapOS. Runs locally, reachable only with your token.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch checked={info.enabled} disabled={busy} onCheckedChange={(c) => void toggle(c)} />
        </ItemActions>
      </Item>

      {info.enabled && (
        <>
          <ConnectionStatus lastActivity={info.lastActivity} />

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Connect a client</span>
              <span className="text-sm text-muted-foreground">
                Pick your client and paste the snippet. The token is already included.
              </span>
            </div>

            {/* w-fit hugs the tabs when they fit, max-w-full caps them at the (narrow onboarding)
                column and scrolls internally rather than pushing the page wider. */}
            <div className="flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {snippets.map((s, i) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => setClient(i)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    i === client
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-input bg-background">
              <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                <span className="text-xs font-medium text-foreground">{active.hint}</span>
                <CopyButton text={active.code} />
              </div>
              <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-foreground">
                <code>{active.code}</code>
              </pre>
            </div>
          </div>

          <Collapsible open={tokenOpen} onOpenChange={setTokenOpen} className="flex flex-col gap-3">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRightIcon
                className={cn("size-4 transition-transform", tokenOpen && "rotate-90")}
              />
              <KeyRoundIcon className="size-3.5" />
              Access token
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-col gap-2">
                <InputGroup className="bg-background">
                  <InputGroupInput readOnly value={info.token} className="font-mono text-xs" />
                  <InputGroupAddon align="inline-end">
                    <CopyButton text={info.token} />
                    <InputGroupButton
                      disabled={busy}
                      onClick={() => void regenerate()}
                      className="gap-1.5"
                    >
                      <RefreshCwIcon />
                      Regenerate
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <p className="text-xs text-muted-foreground">
                  Regenerating revokes access from clients you've connected before — they'll need
                  the new value.
                </p>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </div>
  );
}

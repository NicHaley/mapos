import { Button } from "@mapos/ui/components/button";
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
  ItemMedia,
  ItemTitle
} from "@mapos/ui/components/item";
import { Switch } from "@mapos/ui/components/switch";
import { cn } from "@mapos/ui/lib/utils";
import type { McpClientId, McpClientTarget, McpConnectionInfo } from "@shared/types";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useState } from "react";
import { SiClaude, SiOpenai } from "react-icons/si";
import {
  activityClientName,
  formatTimeAgo,
  isRecentActivity,
  useNow
} from "../../lib/mcp-activity";

// Cursor's mark isn't in the Simple Icons set bundled with react-icons 5.6.0, so its path is
// inlined from Simple Icons (CC0). Static data — nothing here reaches the network.
function CursorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  );
}

/**
 * Mark and tile treatment per client. Both Claude entries share the Claude mark deliberately:
 * they're the same product family, and the tab label distinguishes the CLI from the desktop app.
 *
 * Colours are the brands' own. Claude has a chromatic one (#D97757) so the tile is tinted with it
 * and the mark drawn in it. Cursor and OpenAI are monochrome brands (#000000), so they take
 * `text-foreground` — which *is* their colour, and unlike a hardcoded black it stays legible when
 * the panel is in dark mode. Inventing an accent for them would be prettier and wrong.
 */
const CLIENT_BRANDS: Record<
  McpClientId,
  { Icon: ComponentType<{ className?: string }>; tile: string }
> = {
  "claude-code": { Icon: SiClaude, tile: "border-[#D97757]/30 bg-[#D97757]/10 text-[#D97757]" },
  "claude-desktop": { Icon: SiClaude, tile: "border-[#D97757]/30 bg-[#D97757]/10 text-[#D97757]" },
  cursor: { Icon: CursorIcon, tile: "border-input bg-foreground/5 text-foreground" },
  codex: { Icon: SiOpenai, tile: "border-input bg-foreground/5 text-foreground" }
};

// One entry per tab. A `client` tab offers the one-click install and, below it, that same client's
// paste-it-yourself snippet — both in one place, so a client is never described in two sections.
// The `other` tab is the raw connection details for anything MapOS can't configure itself; it has
// no install button because there's no config file to write.
type Tab =
  | { kind: "client"; label: string; client: McpClientTarget }
  | { kind: "other"; label: string; fields: { label: string; value: string }[] };

// The per-client snippets come from main (`client.manual`), generated from the same launcher the
// install writes, so the two can't drift.
//
// Everything routes through the bundled stdio bridge rather than the HTTP URL directly: the
// bridge is spawned by the client, so it can start MapOS when it isn't running, and it reads the
// token from disk instead of carrying a copy in the client's config.
function tabsFor(info: McpConnectionInfo): Tab[] {
  return [
    ...info.clients.map((client): Tab => ({ kind: "client", label: client.label, client })),
    {
      kind: "other",
      label: "Other",
      fields: [
        { label: "Command (stdio)", value: info.stdioCommand },
        { label: "URL (Streamable HTTP)", value: info.url },
        { label: "Header", value: `Authorization: Bearer ${info.token}` }
      ]
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
function ConnectionStatus({
  lastActivity
}: {
  lastActivity: McpConnectionInfo["lastActivity"];
}) {
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

// Enabled, but the listener never bound. Takes the place of the status indicator rather than
// letting it read "waiting for a client to connect…", which would be a lie: nothing is listening,
// so no snippet below this can work until the conflict is resolved.
function ServerError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-red-600/20 bg-red-500/10 px-3.5 py-3 text-sm">
      <TriangleAlertIcon className="mt-px size-4 shrink-0 text-red-600 dark:text-red-400" />
      <span className="text-red-800 dark:text-red-200">{message}</span>
    </div>
  );
}

/**
 * A snippet in a labelled, copyable block. `hint` names where the code goes (a config path, or
 * "Run in your terminal").
 */
function Snippet({ hint, code }: { hint: string; code: string }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-input bg-background">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
        <span className="font-mono text-xs font-medium text-foreground">{hint}</span>
        <CopyButton text={code} />
      </div>
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * One client's tab: the one-click install on top, that client's own snippet behind a disclosure
 * below it. Pairing them is the point — the automatic path is what most people want, and the
 * manual path is right there for anyone who'd rather see the file, without sending them to a
 * different section. The disclosure state is intentionally not keyed to the client, so opening it
 * once keeps it open as you compare tabs.
 *
 * The panel claims nothing about whether the client is installed — see `listMcpClients`.
 */
function ClientPanel({
  client,
  state,
  busy,
  onInstall
}: {
  client: McpClientTarget;
  state: { installed: boolean; error?: string };
  busy: boolean;
  onInstall: () => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const { Icon, tile } = CLIENT_BRANDS[client.id];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Item variant="outline" size="sm">
        {/* Sits alongside the whole title+path block rather than on the title line, so the mark
          reads as the row's identity. `self-center` overrides ItemMedia's default self-start,
          which only makes sense for media that aligns to the first line. */}
        <ItemMedia className={cn("size-10 self-center rounded-md border", tile)}>
          <Icon className="size-[18px]" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Add to {client.label}</ItemTitle>
          {/* Only the config path is monospace; prose about it isn't. */}
          {state.error ? (
            <ItemDescription className="text-destructive">{state.error}</ItemDescription>
          ) : state.installed ? (
            <ItemDescription>Restart {client.label} to pick it up</ItemDescription>
          ) : (
            <ItemDescription className="font-mono text-xs">{client.configLabel}</ItemDescription>
          )}
        </ItemContent>
        <ItemActions>
          {client.configured ? (
            <span className="flex items-center gap-1.5 pr-1 text-sm text-muted-foreground">
              <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
              Added
            </span>
          ) : (
            <Button size="sm" disabled={busy} onClick={onInstall}>
              {busy ? "Adding…" : "Add to client"}
            </Button>
          )}
        </ItemActions>
      </Item>

      <Collapsible open={manualOpen} onOpenChange={setManualOpen} className="flex flex-col gap-3">
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRightIcon
            className={cn("size-4 transition-transform", manualOpen && "rotate-90")}
          />
          <SlidersHorizontalIcon className="size-3.5" />
          Manual setup
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Snippet hint={client.manual.hint} code={client.manual.code} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * The MCP server setup surface: enable toggle, live connection status, a one-click install per
 * known client, and the paste-it-yourself snippets plus access token behind disclosures. Shared
 * by Settings › Connections and the onboarding Connect step so both render the same content.
 */
export function McpConnect() {
  const [info, setInfo] = useState<McpConnectionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<McpClientId | null>(null);
  // Per-client outcome of an install attempt in this session, keyed by client id.
  const [outcomes, setOutcomes] = useState<
    Partial<Record<McpClientId, { installed: boolean; error?: string }>>
  >({});
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

  const install = useCallback(async (id: McpClientId) => {
    setInstalling(id);
    try {
      const result = await window.api.mcp.installClient(id);
      if (result.ok) setInfo(result.info);
      setOutcomes((prev) => ({
        ...prev,
        [id]: result.ok ? { installed: true } : { installed: false, error: result.error }
      }));
    } finally {
      setInstalling(null);
    }
  }, []);

  if (!info) return null;

  const tabs = tabsFor(info);
  const active = tabs[client] ?? tabs[0];

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
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

      <div className="flex w-full min-w-0 flex-col gap-7">
        {info.enabled && (
          <>
            {info.startError ? (
              <ServerError message={info.startError} />
            ) : (
              <ConnectionStatus lastActivity={info.lastActivity} />
            )}

            {/* The connect block and the token disclosure are one group: `Manual setup` and
              `Access token` read as sibling disclosures, so they sit on the tighter gap-4 rhythm
              rather than the gap-7 that separates the status band from everything below. */}
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Connect a client</span>
                  <span className="text-sm text-muted-foreground">
                    Adding writes MapOS into the client's config file. Quit the client first if it's
                    open, then reopen it.
                  </span>
                </div>

                {/* w-fit hugs the tabs when they fit, max-w-full caps them at the (narrow
                onboarding) column and scrolls internally rather than pushing the page wider. */}
                <div className="flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {tabs.map((t, i) => (
                    <button
                      key={t.label}
                      type="button"
                      onClick={() => setClient(i)}
                      className={cn(
                        "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                        i === client
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {active.kind === "client" ? (
                  <ClientPanel
                    client={active.client}
                    state={outcomes[active.client.id] ?? { installed: false }}
                    busy={installing === active.client.id}
                    onInstall={() => void install(active.client.id)}
                  />
                ) : (
                  <div className="flex min-w-0 flex-col gap-3">
                    {active.fields.map((f) => (
                      <div key={f.label} className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">{f.label}</span>
                        <InputGroup className="bg-background">
                          <InputGroupInput readOnly value={f.value} className="font-mono text-xs" />
                          <InputGroupAddon align="inline-end">
                            <CopyButton text={f.value} />
                          </InputGroupAddon>
                        </InputGroup>
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      The command works in any client that spawns a stdio server, and starts MapOS
                      if it's closed. The URL and header are for clients that only speak Streamable
                      HTTP, which need MapOS already open.
                    </p>
                  </div>
                )}
              </div>

              <Collapsible
                open={tokenOpen}
                onOpenChange={setTokenOpen}
                className="flex flex-col gap-3"
              >
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
                      Clients set up with the snippets above read the token from disk and pick up a
                      new one on their next connection. Any client you configured with the URL and
                      header directly needs the new value pasted in.
                    </p>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

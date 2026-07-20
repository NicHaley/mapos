import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import { Switch } from "@mapos/ui/components/switch";
import type { McpConnectionInfo } from "@shared/types";
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// Ready-to-paste config for each MCP client, with the live URL + token baked in. Clients that
// speak Streamable HTTP take the URL directly; stdio-only clients (Claude Desktop) go through
// the community `mcp-remote` shim.
function clientSnippets(url: string, token: string): { label: string; code: string }[] {
  const auth = `Authorization: Bearer ${token}`;
  return [
    {
      label: "Claude Code",
      code: `claude mcp add mapos --transport http ${url} --header "${auth}" --scope user`
    },
    {
      label: "Claude Desktop",
      code: JSON.stringify(
        { mcpServers: { mapos: { command: "npx", args: ["mcp-remote", url, "--header", auth] } } },
        null,
        2
      )
    },
    {
      label: "Cursor",
      code: JSON.stringify(
        { mcpServers: { mapos: { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2
      )
    },
    {
      label: "OpenAI Codex",
      // ~/.codex/config.toml — `url` selects the Streamable HTTP transport; custom headers
      // (our bearer token) go under the nested http_headers table.
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

function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function ConnectionsTab() {
  const [info, setInfo] = useState<McpConnectionInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.api.mcp.getConnectionInfo().then(setInfo);
  }, []);

  const toggle = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setInfo(await window.api.mcp.setEnabled(enabled));
    setBusy(false);
  }, []);

  const regenerate = useCallback(async () => {
    setBusy(true);
    setInfo(await window.api.mcp.regenerateToken());
    setBusy(false);
  }, []);

  if (!info) return null;

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="MCP server"
        description="Let an AI client (Claude, Cursor, Codex, …) drive MapOS through the Model Context Protocol. The server runs locally on your machine and is reachable only with the token below."
      >
        <div className="flex items-center justify-between rounded-lg border border-input bg-background px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-sm font-medium">Enable MCP server</span>
            <span className="text-xs text-muted-foreground">
              {info.enabled ? (info.running ? `Listening on ${info.url}` : "Starting…") : "Off"}
            </span>
          </div>
          <Switch checked={info.enabled} disabled={busy} onCheckedChange={(c) => void toggle(c)} />
        </div>
      </Section>

      {info.enabled && (
        <>
          <Section
            title="Access token"
            description="Every request must include this token. Regenerate it to revoke access from clients you've connected before, they will need the new value."
          >
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
          </Section>

          <Section
            title="Connect a client"
            description="Paste the snippet for your client. The token is already included."
          >
            <div className="flex flex-col gap-4">
              {clientSnippets(info.url, info.token).map(({ label, code }) => (
                <InputGroup key={label} className="flex-col items-stretch bg-background">
                  <InputGroupAddon
                    align="block-start"
                    className="justify-between border-b bg-muted/40"
                  >
                    <span className="text-xs font-medium text-foreground">{label}</span>
                    <CopyButton text={code} />
                  </InputGroupAddon>
                  <pre className="overflow-x-auto py-2 pl-3 font-mono text-xs">
                    <code className="inline-block pr-3">{code}</code>
                  </pre>
                </InputGroup>
              ))}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

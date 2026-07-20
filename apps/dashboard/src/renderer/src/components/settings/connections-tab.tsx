import { Button } from "@mapos/ui/components/button";
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
    }
  ];
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <Button variant="outline" size="sm" onClick={copy} className="shrink-0 gap-1.5">
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {label ?? (copied ? "Copied" : "Copy")}
    </Button>
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
        description="Let an AI client (Claude, Cursor, …) drive MapOS through the Model Context Protocol. The server runs locally on your machine and is reachable only with the token below."
      >
        <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2.5">
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
            description="Every request must include this token. Regenerate it to revoke access from clients you've connected before — they'll need the new value."
          >
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs">
                {info.token}
              </code>
              <CopyButton text={info.token} />
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void regenerate()}
                className="shrink-0 gap-1.5"
              >
                <RefreshCwIcon className="size-3.5" />
                Regenerate
              </Button>
            </div>
          </Section>

          <Section
            title="Connect a client"
            description="Paste the snippet for your client. The token is already included."
          >
            <div className="flex flex-col gap-4">
              {clientSnippets(info.url, info.token).map(({ label, code }) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{label}</span>
                    <CopyButton text={code} />
                  </div>
                  <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs">
                    <code>{code}</code>
                  </pre>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

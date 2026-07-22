import { McpConnect } from "./mcp-connect";
import { PageHeader } from "./page-header";

export function ConnectionsTab() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Connections" description="Connect AI clients over MCP." />
      <McpConnect />
    </div>
  );
}

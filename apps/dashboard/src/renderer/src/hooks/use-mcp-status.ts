import type { McpConnectionInfo } from "@shared/types";
import { useEffect, useState } from "react";
import { isRecentActivity, useNow } from "../lib/mcp-activity";
import { useMcpBusy } from "./use-mcp-busy";

export type McpStatus = "disconnected" | "connected" | "active";

/**
 * Three-state health of the local MCP link, for the map-controls indicator:
 * - "active": a tool call is in flight (or just settled) — an agent is driving MapOS right now.
 * - "connected": the server is running and a client made a request within the recent window. MCP
 *   is stateless with no heartbeat, so recent activity is the only honest "a client is here"
 *   signal (same basis as the Settings › Connections status).
 * - "disconnected": server off, or nothing recent.
 *
 * Connection info is read once and then kept live: `onConnectionChanged` reflects the server
 * being toggled on/off, and `onActivity` refreshes the last-seen request.
 */
export function useMcpStatus(): McpStatus {
  const busy = useMcpBusy();
  const now = useNow();
  const [info, setInfo] = useState<McpConnectionInfo | null>(null);

  useEffect(() => {
    void window.api.mcp.getConnectionInfo().then(setInfo);
  }, []);
  useEffect(() => window.api.mcp.onConnectionChanged(setInfo), []);
  useEffect(
    () =>
      window.api.mcp.onActivity((activity) =>
        setInfo((prev) => (prev ? { ...prev, lastActivity: activity } : prev))
      ),
    []
  );

  // A stopped server can't be connected or active, no matter how recent the last request was.
  if (!info?.running) return "disconnected";
  if (busy) return "active";
  if (info.lastActivity && isRecentActivity(info.lastActivity, now)) return "connected";
  return "disconnected";
}

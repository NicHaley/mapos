import type { McpActivity } from "@shared/types";
import { useEffect, useState } from "react";

/**
 * Activity younger than this renders as "Connected". MCP clients only send requests while
 * actively used (there's no heartbeat), so beyond this window the honest claim downgrades to
 * "last active …" rather than pretending to know the client is still there.
 */
export const MCP_RECENT_ACTIVITY_MS = 5 * 60_000;

export function isRecentActivity(activity: McpActivity, now: number): boolean {
  return now - activity.at < MCP_RECENT_ACTIVITY_MS;
}

/** Identity comes from the client's `initialize` handshake and can be unknown after a restart. */
export function activityClientName(activity: McpActivity): string {
  return activity.name ?? "MCP client";
}

/** Coarse relative time for activity labels: "just now", "3m ago", "2h ago", "5d ago". */
export function formatTimeAgo(now: number, at: number): string {
  const mins = Math.floor(Math.max(0, now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Ticking clock so relative labels and the recency window stay current while on screen. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

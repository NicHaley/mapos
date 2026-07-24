import { ipcMain } from "electron";
import type { McpConnectionInfo } from "../shared/types";
import { sendToRenderer } from "./main-window";
import {
  getOrCreateMcpConfig,
  regenerateMcpTokenInConfig,
  setMcpEnabledInConfig
} from "./mapos-config";
import { mcpManager } from "./mcp/manager";

function connectionInfo(appStateDir: string): McpConnectionInfo {
  const cfg = getOrCreateMcpConfig(appStateDir);
  return {
    enabled: cfg.enabled,
    running: mcpManager.isRunning(),
    port: cfg.port,
    token: cfg.token,
    url: `http://127.0.0.1:${cfg.port}/mcp`,
    lastActivity: mcpManager.getLastActivity()
  };
}

/**
 * IPC for the MCP Connections settings panel: read connection info, toggle the server, and
 * rotate the token. All app-level (not per-vault) — the config lives in `userData/mapos.json`.
 */
export function registerMcpIpc(appStateDir: string): void {
  // Push the new state to the renderer so live indicators (e.g. the map-controls status dot)
  // update the moment the server is toggled or its token rotates — not just on next fetch.
  const broadcast = (info: McpConnectionInfo): void => {
    sendToRenderer("mcp:connection-changed", info);
  };

  ipcMain.handle("mcp:get-connection-info", () => connectionInfo(appStateDir));

  ipcMain.handle("mcp:set-enabled", async (_e, enabled: boolean) => {
    setMcpEnabledInConfig(appStateDir, enabled);
    const cfg = getOrCreateMcpConfig(appStateDir);
    if (enabled) await mcpManager.start(cfg.port, cfg.token);
    else await mcpManager.stop();
    const info = connectionInfo(appStateDir);
    broadcast(info);
    return info;
  });

  ipcMain.handle("mcp:regenerate-token", async () => {
    const cfg = regenerateMcpTokenInConfig(appStateDir);
    mcpManager.setToken(cfg.token);
    const info = connectionInfo(appStateDir);
    broadcast(info);
    return info;
  });
}

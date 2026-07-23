import { ipcMain } from "electron";
import type { McpConnectionInfo } from "../shared/types";
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
    lastClient: mcpManager.getLastClient()
  };
}

/**
 * IPC for the MCP Connections settings panel: read connection info, toggle the server, and
 * rotate the token. All app-level (not per-vault) — the config lives in `userData/mapos.json`.
 */
export function registerMcpIpc(appStateDir: string): void {
  ipcMain.handle("mcp:get-connection-info", () => connectionInfo(appStateDir));

  ipcMain.handle("mcp:set-enabled", async (_e, enabled: boolean) => {
    setMcpEnabledInConfig(appStateDir, enabled);
    const cfg = getOrCreateMcpConfig(appStateDir);
    if (enabled) await mcpManager.start(cfg.port, cfg.token);
    else await mcpManager.stop();
    return connectionInfo(appStateDir);
  });

  ipcMain.handle("mcp:regenerate-token", async () => {
    const cfg = regenerateMcpTokenInConfig(appStateDir);
    mcpManager.setToken(cfg.token);
    return connectionInfo(appStateDir);
  });
}

import { ipcMain } from "electron";
import type { McpClientId, McpConnectionInfo, McpStdioLauncher } from "../shared/types";
import { mcpBridgePath } from "./asset-paths";
import { sendToRenderer } from "./main-window";
import {
  getOrCreateMcpConfig,
  regenerateMcpTokenInConfig,
  setMcpEnabledInConfig
} from "./mapos-config";
import { installMcpClient, listMcpClients, stdioShellCommand } from "./mcp/clients";
import { mcpManager } from "./mcp/manager";

/**
 * The spawn recipe for the stdio bridge. `process.execPath` is the MapOS binary itself, run as
 * plain Node — no separate runtime to ship and nothing for the user to install. The bridge is
 * handed `--state-dir` rather than the port and token so that rotating the token in Settings
 * doesn't invalidate a config the user has already pasted into their client.
 */
function stdioLauncher(appStateDir: string): McpStdioLauncher {
  return {
    command: process.execPath,
    args: [mcpBridgePath(), "--state-dir", appStateDir],
    env: { ELECTRON_RUN_AS_NODE: "1" }
  };
}

function connectionInfo(appStateDir: string): McpConnectionInfo {
  const cfg = getOrCreateMcpConfig(appStateDir);
  const stdio = stdioLauncher(appStateDir);
  return {
    enabled: cfg.enabled,
    running: mcpManager.isRunning(),
    port: cfg.port,
    token: cfg.token,
    url: `http://127.0.0.1:${cfg.port}/mcp`,
    stdio,
    stdioCommand: stdioShellCommand(stdio),
    clients: listMcpClients(stdio),
    startError: mcpManager.getStartError(),
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
    // A failed start comes back as `startError` on the returned info rather than a rejected
    // invoke: the panel has to render the reason, and the switch itself is already persisted.
    if (enabled) await mcpManager.start(cfg.port, cfg.token).catch(() => {});
    else await mcpManager.stop();
    const info = connectionInfo(appStateDir);
    broadcast(info);
    return info;
  });

  // One-click install: write the `mapos` entry into a known client's config. The refreshed info
  // rides along on success so the panel's "Installed" state updates without a second round trip.
  ipcMain.handle("mcp:install-client", (_e, id: McpClientId) => {
    const result = installMcpClient(id, stdioLauncher(appStateDir));
    if (!result.ok) return result;
    const info = connectionInfo(appStateDir);
    broadcast(info);
    return { ok: true as const, info };
  });

  ipcMain.handle("mcp:regenerate-token", async () => {
    const cfg = regenerateMcpTokenInConfig(appStateDir);
    mcpManager.setToken(cfg.token);
    const info = connectionInfo(appStateDir);
    broadcast(info);
    return info;
  });
}

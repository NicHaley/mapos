import {
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
  createServer
} from "node:http";
import type { GeocodeResult } from "@mapos/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpActivity, PlaceRecord } from "../../shared/types";
import {
  type StashedGeometry,
  type VaultOperation,
  buildMaposCustomTools,
  buildMaposSystemPrompt
} from "../mcp-server";
import type { ToolDefinition } from "../tool-defs";
import { isAuthorized } from "./auth";
import { registerMaposTools } from "./bridge";

const MCP_PATH = "/mcp";
const SERVER_NAME = "mapos";
const SERVER_VERSION = "0.1.0";

type ActiveVault = {
  vaultRoot: string;
  places: Map<string, PlaceRecord>;
  /** Electron userData dir — where region packs live (app-scoped, not vault-scoped). */
  appStateDir: string;
};

/**
 * Hosts the local MCP server: an in-process HTTP listener on 127.0.0.1 that speaks the MCP
 * Streamable-HTTP transport and exposes the staged MapOS tools (`buildMaposCustomTools`).
 *
 * The listener is bound once for the app's lifetime (so a client connection survives vault
 * switches), while the *tool set* is vault-scoped: `setActiveVault` rebuilds it against the
 * active vault's index/filesystem, `clearActiveVault` empties it. Requests run in
 * stateless mode — a fresh `Server` + transport per request reading the current tool set — so
 * there's no session bookkeeping and a mid-request vault swap can't corrupt state.
 */
export class McpManager {
  private http: HttpServer | null = null;
  private port = 0;
  private token = "";
  private tools: ToolDefinition[] = [];
  private instructions: string | undefined;

  // Most recent authorized request, timestamped on every hit. Identity (name/version) comes
  // from the most recent `initialize` handshake and is carried forward across plain tool calls,
  // which don't identify themselves in stateless mode. Backs the "Connected / last active"
  // indicator in the renderer; seeded from config at startup so a restart doesn't read as
  // "waiting" while a configured client is still talking.
  private lastActivity: McpActivity | null = null;
  /** Fired on every authorized request; wired to the renderer + config persistence in index.ts. */
  onActivity: ((activity: McpActivity) => void) | null = null;
  /** Fired when a tool call starts/ends; wired to the renderer's "working" shimmer in index.ts. */
  onToolPhase: ((phase: "start" | "end", tool: string) => void) | null = null;

  // App-scoped stores, reused across the whole desktop session (there's no per-conversation
  // scope in MCP). Cleared on vault change so handles never leak across vaults.
  private readonly geocodeStore = new Map<string, GeocodeResult>();
  private readonly geometryStore = new Map<string, StashedGeometry>();

  isRunning(): boolean {
    return this.http !== null;
  }

  /** The most recent authorized request (live or seeded from config), or null if none. */
  getLastActivity(): McpActivity | null {
    return this.lastActivity;
  }

  /** Adopt activity persisted in config at startup. Live activity always wins over the seed. */
  seedActivity(activity: McpActivity | null): void {
    if (!this.lastActivity) this.lastActivity = activity;
  }

  /** Start the HTTP listener on 127.0.0.1:port. No-op if already running. */
  async start(port: number, token: string): Promise<void> {
    if (this.http) return;
    this.port = port;
    this.token = token;
    const http = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      http.once("error", onError);
      http.listen(port, "127.0.0.1", () => {
        http.off("error", onError);
        resolve();
      });
    });
    this.http = http;
  }

  /** Close the listener and release the port. Safe to call when not running. */
  async stop(): Promise<void> {
    const http = this.http;
    this.http = null;
    // `lastActivity` survives stop/start on purpose: it's a historical fact ("last active 2h
    // ago"), not a live-connection claim, so disabling the server doesn't invalidate it.
    if (!http) return;
    // http.close() only resolves once every connection has drained; a connected MCP client's
    // keep-alive socket (or an idle keep-alive socket from a prior request) would otherwise
    // keep it pending forever. Force those closed so the listener actually releases the port.
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
  }

  /** Rotate the accepted token (existing clients must re-connect with the new one). */
  setToken(token: string): void {
    this.token = token;
    // Rotating the token orphans previously-connected clients, so their past activity no longer
    // proves a working setup — back to "waiting" until one connects with the new value.
    this.lastActivity = null;
  }

  /** (Re)build the tool set for the active vault. Called from bootVault once it's ready. */
  setActiveVault(v: ActiveVault): void {
    this.instructions = buildMaposSystemPrompt(v.vaultRoot);
    this.geocodeStore.clear();
    this.geometryStore.clear();
    this.tools = buildMaposCustomTools(
      v.places,
      v.vaultRoot,
      v.appStateDir,
      // Undo tracking + geometry-stash persistence are out of scope for v1 (no-ops).
      (_op: VaultOperation) => {},
      this.geocodeStore,
      this.geometryStore,
      () => {}
    );
  }

  /** Drop the active tool set (vault torn down). The listener stays up, tools/list goes empty. */
  clearActiveVault(): void {
    this.tools = [];
    this.instructions = undefined;
    this.geocodeStore.clear();
    this.geometryStore.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(req.url ?? "").startsWith(MCP_PATH)) {
      res.writeHead(404).end();
      return;
    }
    if (!isAuthorized(req, this.token)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="mapos"'
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null
        })
      );
      return;
    }

    // Stateless: new Server + transport per request, reading the current tool set.
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: this.instructions }
    );
    registerMaposTools(
      server,
      () => this.tools,
      (phase, tool) => this.onToolPhase?.(phase, tool)
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${this.port}`, `localhost:${this.port}`],
      allowedOrigins: [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
      // Any authorized request proves a configured client is talking. Only the request carrying
      // the `initialize` handshake knows who (stateless mode: fresh Server per request), so
      // other requests inherit the last known identity and refresh the timestamp.
      const version = server.getClientVersion();
      const identity = version
        ? { name: version.name, version: version.version }
        : { name: this.lastActivity?.name, version: this.lastActivity?.version };
      this.lastActivity = { ...identity, at: Date.now() };
      this.onActivity?.(this.lastActivity);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null
          })
        );
      }
    }
  }
}

/** Single app-wide manager instance. */
export const mcpManager = new McpManager();

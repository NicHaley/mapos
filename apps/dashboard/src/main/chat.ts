import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession
} from "@earendil-works/pi-coding-agent";
import type { GeocodeResult } from "@mapos/contracts";
import { type BrowserWindow, ipcMain } from "electron";
import { resolveCapabilities } from "../shared/ai-models";
import type { PlaceRecord, UndoEntry } from "../shared/types";
import { AiConfigError, loadAiConfigForRequest } from "./ai";
import { getRuntimeAuthStorage } from "./ai-auth";
import {
  type ActiveConversation,
  appendMessages,
  appendToIndex,
  compactIndex,
  getConversationFilePath,
  getConversationStateFilePath,
  initConversationsDir,
  loadConvState,
  readConversationIndex,
  saveConvState,
  setConversationsDir
} from "./conversations";
import { removeFeatures, syncFeatureForFile } from "./db";
import { vaultDotDir } from "./mapos-config";
import { BUILTIN_TOOL_NAMES, buildMaposCustomTools, buildMaposSystemPrompt } from "./mcp-server";
import { parsePlaceFile } from "./watcher";

const LOCAL_PROVIDER_KEY = "mapos-local";

/**
 * Resolve a Pi {@link Model} from MapOS's request config, going through {@link ModelRegistry}
 * for both providers so we plug into Pi's standard auth/model lifecycle:
 *
 * - **Anthropic** — `getModel("anthropic", id)` returns a model from Pi's bundled `MODELS` map.
 *   AuthStorage is given the user's key under `"anthropic"`.
 * - **Local / custom OpenAI-compatible** — `modelRegistry.registerProvider()` declares a
 *   MapOS-owned provider (Ollama, LiteLLM proxy, OpenAI itself, ...) with the user's
 *   `baseUrl` and a single model row. Pi's built-in `streamOpenAICompletions` handles
 *   the wire format; the registry handles auth resolution.
 */
async function resolveModel(
  aiConfig: ReturnType<typeof loadAiConfigForRequest>,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry
): Promise<Model<Api>> {
  // POC v2: a known Pi catalog provider. Auth (API key or auto-refreshed OAuth) already lives in
  // the shared persistent AuthStorage under `piProvider`, so we just resolve the catalog model and
  // let Pi apply the right credentials and headers (incl. Anthropic's OAuth beta header).
  if (aiConfig.piProvider) {
    const model = getModel(aiConfig.piProvider as never, aiConfig.model as never) as
      | Model<Api>
      | undefined;
    if (!model) {
      throw new AiConfigError(
        "AI_NOT_CONFIGURED",
        `Model "${aiConfig.model}" isn't in Pi's catalog for "${aiConfig.piProvider}". Pick a different model in Settings.`
      );
    }
    return model;
  }

  if (aiConfig.provider === "anthropic") {
    authStorage.setRuntimeApiKey("anthropic", aiConfig.apiKey);
    // `getModel` is typed to require a known model id but actually returns `undefined`
    // for unknown ones at runtime. Check explicitly so a stale settings value surfaces
    // as a clear "reconfigure" prompt instead of a downstream crash inside Pi.
    const model = getModel("anthropic", aiConfig.model as never) as Model<Api> | undefined;
    if (!model) {
      throw new AiConfigError(
        "AI_NOT_CONFIGURED",
        `Anthropic model "${aiConfig.model}" isn't recognized by Pi. Pick a different model in Settings.`
      );
    }
    return model;
  }

  // Pi's openai-completions provider uses the OpenAI SDK, which appends `/chat/completions`
  // to baseUrl. Ollama serves its OpenAI-compatible API at `/v1/chat/completions`, so we
  // need to ensure baseUrl ends with `/v1` when the user supplied a bare host:port.
  const trimmed = aiConfig.baseUrl.replace(/\/+$/, "");
  const parsed = (() => {
    try {
      return new URL(trimmed);
    } catch {
      return null;
    }
  })();
  const baseUrl =
    parsed && (parsed.pathname === "" || parsed.pathname === "/") ? `${trimmed}/v1` : trimmed;

  // Ollama doesn't validate the token but pi-ai requires a non-empty string when
  // authHeader is true. Fall back to MapOS's existing placeholder.
  const apiKey = aiConfig.authToken || "ollama";
  authStorage.setRuntimeApiKey(LOCAL_PROVIDER_KEY, apiKey);

  // Prefer the capabilities resolved with this request (the v2 path captures the model's real
  // context window at selection time); fall back to the legacy per-model lookup.
  const contextWindow =
    aiConfig.capabilities?.contextWindow ??
    resolveCapabilities("local", aiConfig.model).contextWindow;

  modelRegistry.registerProvider(LOCAL_PROVIDER_KEY, {
    name: baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") ? "Local" : "Custom",
    baseUrl,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: aiConfig.model,
        name: aiConfig.model,
        api: "openai-completions",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 4096
      }
    ]
  });

  const model = modelRegistry.find(LOCAL_PROVIDER_KEY, aiConfig.model);
  if (!model) {
    throw new AiConfigError(
      "AI_NOT_CONFIGURED",
      `Couldn't register local model "${aiConfig.model}" at ${baseUrl} with Pi's ModelRegistry.`
    );
  }
  return model;
}

type SessionEntry = {
  session: AgentSession;
  unsubscribe: () => void;
  /** Hash of the ai-config used to construct the session; invalidated when settings change. */
  configKey: string;
};

/** Per-turn bookkeeping. Persistence comes from `session.state.messages`, not here. */
type TurnState = {
  /** `session.state.messages.length` snapshot taken just before `session.prompt()`. */
  priorLen: number;
  /** Set when the agent loop has emitted agent_end so finishTurn() runs exactly once. */
  finished: boolean;
};

export function setupChat(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  vaultRoot: string
): () => void {
  setConversationsDir(join(vaultDotDir(vaultRoot), "conversations"));

  /** Long-lived Pi agent sessions keyed by convId. Reused across messages for multi-turn. */
  const sessions = new Map<string, SessionEntry>();
  /** Conversation state in memory. Hydrated lazily when a tab loads or sends. */
  const conversations = new Map<string, ActiveConversation>();
  /** Per-turn undo stack, keyed by convId. */
  const undoEntries = new Map<string, UndoEntry>();
  /** Active turn streaming state, keyed by convId. */
  const turnStates = new Map<string, TurnState>();
  /**
   * Geocoder results cached per conversation, keyed by `GeocodeResult.id`, so
   * `present_features` can resolve a `result_id` back to the source result and derive
   * its facts (rather than trusting the model's reformatting). Scoped to the conversation
   * — not the Pi session — so it survives across turns AND across session re-creation on a
   * config change. In-memory only: empty after an app restart, after which a stale
   * `result_id` reports a cache miss and the agent re-searches.
   */
  const geocodeCaches = new Map<string, Map<string, GeocodeResult>>();
  function geocodeCacheForConv(convId: string): Map<string, GeocodeResult> {
    let cache = geocodeCaches.get(convId);
    if (!cache) {
      cache = new Map();
      geocodeCaches.set(convId, cache);
    }
    return cache;
  }

  initConversationsDir();

  function ensureLoaded(id: string): ActiveConversation | null {
    const existing = conversations.get(id);
    if (existing) return existing;
    try {
      const filePath = getConversationFilePath(id);
      if (!existsSync(filePath)) return null;
      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages = lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Message];
        } catch {
          return [];
        }
      });
      const meta = readConversationIndex().find((e) => e.id === id);
      const state = loadConvState(id);
      const conv: ActiveConversation = {
        id,
        messages,
        sdkSessionId: meta?.sdkSessionId,
        layers: state.layers,
        ...(meta?.title ? { title: meta.title } : {})
      };
      conversations.set(id, conv);
      return conv;
    } catch {
      return null;
    }
  }

  /** Build a fresh MCP tool set bound to this conversation's callbacks. */
  function makeMaposToolsForConv(convId: string) {
    return buildMaposCustomTools(
      mainWindow,
      places,
      vaultRoot,
      (op) => {
        const entry = undoEntries.get(convId);
        if (!entry) return;
        if (!entry.operations.some((o) => o.path === op.path)) {
          entry.operations.push(op);
        }
      },
      (layer) => {
        const conv = conversations.get(convId);
        if (!conv) return;
        // Replace any existing layer with the same id (re-run of the same tool
        // call), otherwise append. Order is preserved.
        conv.layers = [...(conv.layers ?? []).filter((l) => l.id !== layer.id), layer];
        saveConvState(convId, { layers: conv.layers });
      },
      () => {
        const conv = conversations.get(convId);
        if (!conv) return;
        conv.layers = [];
        saveConvState(convId, { layers: [] });
      },
      () => (conversations.get(convId)?.layers?.length ?? 0) > 0,
      geocodeCacheForConv(convId)
    );
  }

  function configKeyFor(aiConfig: ReturnType<typeof loadAiConfigForRequest>): string {
    return `${aiConfig.provider}|${aiConfig.model}|${aiConfig.apiKey || aiConfig.authToken || aiConfig.baseUrl}`;
  }

  async function ensureSessionForConv(
    convId: string,
    aiConfig: ReturnType<typeof loadAiConfigForRequest>,
    priorMessages: Message[]
  ): Promise<AgentSession> {
    const existing = sessions.get(convId);
    const key = configKeyFor(aiConfig);
    if (existing && existing.configKey === key) {
      return existing.session;
    }
    if (existing) {
      existing.unsubscribe();
      existing.session.dispose();
      sessions.delete(convId);
    }

    // Known Pi providers (v2) authenticate through the shared persistent AuthStorage so OAuth
    // tokens resolve and auto-refresh across requests. Everything else uses a throwaway inMemory
    // store seeded with the request's key — Pi's ModelRegistry.create() would otherwise read
    // ~/.pi/agent/models.json and leak custom-provider state into the user's home directory.
    const authStorage = aiConfig.piProvider ? getRuntimeAuthStorage() : AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = await resolveModel(aiConfig, authStorage, modelRegistry);

    // Pi's `thinkingLevel` option doesn't include "off" — the only way to disable
    // thinking at construction time is to omit the field and rely on the model's
    // own clamping (local models registered with `reasoning: false` clamp to off).
    const thinking = aiConfig.capabilities.thinking;
    const thinkingLevel = thinking === "off" ? undefined : thinking;

    // Pi's `tools:` is a global allowlist that filters BOTH built-ins AND customTools
    // (see pi-coding-agent agent-session.js:1799). So we need to enumerate the custom
    // tool names alongside the built-ins; deriving from the actual definitions avoids
    // a hand-maintained list that can drift from `buildMaposCustomTools`.
    const customTools = makeMaposToolsForConv(convId);
    const customToolNames = customTools.map((t) => t.name);

    const { session } = await createAgentSession({
      cwd: vaultRoot,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel,
      tools: [...BUILTIN_TOOL_NAMES, ...customToolNames],
      customTools,
      sessionManager: SessionManager.inMemory()
    });

    // Replay persisted history so the agent can see prior turns. Only applies when
    // the session is freshly created (e.g. after an app restart or a config change);
    // ongoing sessions already hold their own state. Messages are already in Pi's
    // native shape on disk — no conversion needed.
    if (priorMessages.length > 0) {
      session.state.messages = priorMessages;
    }

    const unsubscribe = session.subscribe((event) => {
      handleAgentEvent(convId, event);
    });

    sessions.set(convId, { session, unsubscribe, configKey: key });
    return session;
  }

  function handleAgentEvent(convId: string, event: AgentSessionEvent): void {
    const turn = turnStates.get(convId);
    if (!turn) return;
    if (mainWindow.isDestroyed()) return;

    // Provider errors arrive as a `message_end` with `stopReason: "error"` and
    // `errorMessage` set, NOT as a `message_update` of type `"error"`. Surface it
    // so the UI doesn't hang silently.
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message;
      if (msg.stopReason === "error" && msg.errorMessage) {
        console.error("[chat] provider error:", msg.errorMessage);
        mainWindow.webContents.send("chat:error", { convId, message: msg.errorMessage });
        finishTurn(convId);
        return;
      }
    }

    switch (event.type) {
      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          mainWindow.webContents.send("chat:chunk", { convId, text: ev.delta });
        } else if (ev.type === "thinking_delta") {
          mainWindow.webContents.send("chat:thinking_chunk", { convId, text: ev.delta });
        }
        break;
      }
      case "tool_execution_start": {
        mainWindow.webContents.send("chat:tool_call", {
          convId,
          id: event.toolCallId,
          name: event.toolName,
          input: event.args
        });
        break;
      }
      case "tool_execution_end": {
        mainWindow.webContents.send("chat:tool_result", {
          convId,
          tool_use_id: event.toolCallId,
          content: extractToolResultText(event.result),
          isError: event.isError
        });
        break;
      }
      case "agent_end": {
        finishTurn(convId);
        break;
      }
      default:
        break;
    }
  }

  function extractToolResultText(result: unknown): string {
    if (!result || typeof result !== "object") return "";
    const r = result as { content?: Array<{ type?: string; text?: string }> };
    if (!Array.isArray(r.content)) return "";
    return r.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  function finishTurn(convId: string): void {
    const turn = turnStates.get(convId);
    if (!turn || turn.finished) return;
    turn.finished = true;
    const conv = conversations.get(convId);
    const sessionEntry = sessions.get(convId);
    if (!conv || !sessionEntry) {
      turnStates.delete(convId);
      return;
    }

    // Everything the agent appended this turn lives in session.state.messages
    // beyond `priorLen`. That includes the UserMessage that `session.prompt()`
    // pushed, which we already persisted up front — so skip the first row.
    const all = sessionEntry.session.state.messages;
    const newRows = all.slice(turn.priorLen + 1);
    if (newRows.length > 0) {
      conv.messages.push(...newRows);
      appendMessages(conv, newRows);
    }

    // Overlay layers produced this turn are already persisted via onLayerUpdate
    // and pushed to the renderer over `map:overlay-add`, so cards resolve their
    // refs against the live layer set — no per-message snapshot needed.
    if (!mainWindow.isDestroyed()) {
      const canUndo = (undoEntries.get(convId)?.operations.length ?? 0) > 0;
      mainWindow.webContents.send("chat:done", {
        convId,
        canUndo,
        newMessages: newRows
      });
    }
    turnStates.delete(convId);
  }

  ipcMain.handle("chat:load-conversation", (_event, id: string) => {
    const conv = ensureLoaded(id);
    if (!conv) return { messages: [], layers: [] };
    return {
      messages: conv.messages,
      layers: conv.layers ?? []
    };
  });

  ipcMain.handle("chat:list-conversations", () => readConversationIndex());

  ipcMain.on(
    "chat:send",
    async (_event, payload: { convId: string; message: string }): Promise<void> => {
      const { convId, message } = payload;

      // If a turn is in-flight, abort it before starting a new one.
      const existing = sessions.get(convId);
      if (existing?.session.isStreaming) {
        await existing.session.abort().catch(() => {});
      }

      // Reset undo stack for this new turn.
      undoEntries.set(convId, { operations: [] });

      let conv = ensureLoaded(convId);
      if (!conv) {
        conv = { id: convId, messages: [] };
        conversations.set(convId, conv);
      }

      // Persist the user message up front in Pi's native shape so a crash
      // mid-stream doesn't lose it. `session.prompt()` will push an equivalent
      // UserMessage into state; finishTurn skips it when slicing.
      const userMsg: UserMessage = {
        role: "user",
        content: message,
        timestamp: Date.now()
      };
      const priorMessages = [...conv.messages];
      conv.messages.push(userMsg);
      appendMessages(conv, [userMsg]);

      let aiConfig: ReturnType<typeof loadAiConfigForRequest>;
      try {
        aiConfig = loadAiConfigForRequest();
      } catch (err) {
        if (err instanceof AiConfigError && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("chat:error", {
            convId,
            message: err.message,
            code: err.code,
            reconfigureProvider:
              err.code === "AI_NOT_CONFIGURED" || err.code === "AI_DECRYPT_FAILED"
                ? "ai"
                : undefined
          });
        }
        return;
      }

      try {
        const session = await ensureSessionForConv(convId, aiConfig, priorMessages);

        // Refresh system prompt every turn so vault path is current.
        session.state.systemPrompt = buildMaposSystemPrompt(vaultRoot);

        if (!conv.sdkSessionId) {
          conv.sdkSessionId = session.sessionId;
          appendToIndex(conv);
        }

        // Snapshot length before prompt() so finishTurn can slice exactly what
        // this turn appended.
        turnStates.set(convId, {
          priorLen: session.state.messages.length,
          finished: false
        });

        await session.prompt(message);
        // agent_end event handler calls finishTurn; nothing more to do here.
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send("chat:error", { convId, message: errMsg });
        }
        turnStates.delete(convId);
      }
    }
  );

  ipcMain.on("chat:abort", async (_event, payload: { convId: string }) => {
    const entry = sessions.get(payload.convId);
    if (entry) {
      await entry.session.abort().catch(() => {});
    }
    turnStates.delete(payload.convId);
  });

  ipcMain.handle("chat:undo", async (_event, convId: string) => {
    const entry = undoEntries.get(convId);
    if (!entry || entry.operations.length === 0) {
      return { success: false, error: "Nothing to undo" };
    }
    const errors: string[] = [];
    for (const op of [...entry.operations].reverse()) {
      try {
        if (op.previousContent === null) {
          removeFeatures([op.path]);
          if (existsSync(op.path)) rmSync(op.path);
        } else {
          mkdirSync(dirname(op.path), { recursive: true });
          writeFileSync(op.path, op.previousContent, "utf-8");
          const record = await parsePlaceFile(op.path);
          syncFeatureForFile(op.path, record);
        }
      } catch (e) {
        errors.push(`${op.path}: ${e}`);
      }
    }
    undoEntries.delete(convId);
    return { success: errors.length === 0, errors };
  });

  ipcMain.handle("chat:rename-conversation", (_event, id: string, rawTitle: string) => {
    const title = rawTitle.trim();
    if (!title) return { success: false, error: "Title cannot be empty" };
    try {
      const entries = readConversationIndex();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx < 0) return { success: false, error: "Conversation not found" };
      const existing = entries[idx];
      if (!existing) return { success: false, error: "Conversation not found" };
      entries[idx] = { ...existing, title };
      compactIndex(entries);
      const conv = conversations.get(id);
      if (conv) conv.title = title;
      return { success: true };
    } catch (err) {
      console.error("[main] failed to rename conversation:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("chat:delete-conversation", async (_event, id: string) => {
    try {
      const entry = sessions.get(id);
      if (entry) {
        await entry.session.abort().catch(() => {});
        entry.unsubscribe();
        entry.session.dispose();
        sessions.delete(id);
      }
      turnStates.delete(id);
      const convFile = getConversationFilePath(id);
      if (existsSync(convFile)) rmSync(convFile);
      const stateFile = getConversationStateFilePath(id);
      if (existsSync(stateFile)) rmSync(stateFile);
      const entries = readConversationIndex().filter((e) => e.id !== id);
      compactIndex(entries);
      conversations.delete(id);
      undoEntries.delete(id);
      geocodeCaches.delete(id);
    } catch (err) {
      console.error("[main] failed to delete conversation:", err);
    }
  });

  const CHAT_HANDLE_CHANNELS = [
    "chat:load-conversation",
    "chat:list-conversations",
    "chat:undo",
    "chat:delete-conversation",
    "chat:rename-conversation"
  ] as const;
  const CHAT_ON_CHANNELS = ["chat:send", "chat:abort"] as const;

  return function stopChat(): void {
    for (const entry of sessions.values()) {
      entry.unsubscribe();
      entry.session.dispose();
    }
    sessions.clear();
    conversations.clear();
    undoEntries.clear();
    turnStates.clear();
    for (const ch of CHAT_HANDLE_CHANNELS) ipcMain.removeHandler(ch);
    for (const ch of CHAT_ON_CHANNELS) ipcMain.removeAllListeners(ch);
  };
}

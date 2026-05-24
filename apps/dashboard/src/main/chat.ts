import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import { type BrowserWindow, ipcMain } from "electron";
import type { PersistedMessage, PersistedToolCall, PlaceRecord, UndoEntry } from "../shared/types";
import {
  type ActiveConversation,
  appendMessage,
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
import { AiConfigError, loadAiConfigForRequest } from "./ai-config";
import { removeFeatures, syncFeatureForFile } from "./db";
import { vaultDotDir } from "./mapos-config";
import { ALLOWED_TOOLS, buildMaposCustomTools, buildMaposSystemPrompt } from "./mcp-server";
import { parsePlaceFile } from "./watcher";

/** Matches any `<features>` tag whose `refs` attribute contains an `overlay:` entry. */
const OVERLAY_REF_PATTERN = /<features\b[^>]*\brefs=["'][^"']*\boverlay:/i;
function hasOverlayRef(text: string): boolean {
  return OVERLAY_REF_PATTERN.test(text);
}

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
function resolveModel(
  aiConfig: ReturnType<typeof loadAiConfigForRequest>,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry
): Model<Api> {
  if (aiConfig.provider === "anthropic") {
    authStorage.setRuntimeApiKey("anthropic", aiConfig.apiKey);
    return getModel("anthropic", aiConfig.model as never) as Model<Api>;
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
        contextWindow: 32768,
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

/** Per-turn streaming accumulators, keyed by convId. */
type TurnState = {
  text: string;
  thinking: string;
  toolCalls: PersistedToolCall[];
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
          return [JSON.parse(line) as PersistedMessage];
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
        overlay: state.overlay,
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
      (overlay) => {
        const conv = conversations.get(convId);
        if (!conv) return;
        conv.overlay = overlay;
        saveConvState(convId, { overlay });
      },
      () => conversations.get(convId)?.overlay
    );
  }

  function configKeyFor(aiConfig: ReturnType<typeof loadAiConfigForRequest>): string {
    return `${aiConfig.provider}|${aiConfig.model}|${aiConfig.apiKey || aiConfig.authToken || aiConfig.baseUrl}`;
  }

  async function ensureSessionForConv(
    convId: string,
    aiConfig: ReturnType<typeof loadAiConfigForRequest>
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

    const authStorage = AuthStorage.inMemory();
    // Pi's ModelRegistry.create() reads ~/.pi/agent/models.json by default; use inMemory()
    // so MapOS doesn't leak custom-provider state into the user's home directory.
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = resolveModel(aiConfig, authStorage, modelRegistry);

    const { session } = await createAgentSession({
      cwd: vaultRoot,
      authStorage,
      modelRegistry,
      model,
      tools: ["read", "bash", "grep", "find"],
      customTools: makeMaposToolsForConv(convId),
      sessionManager: SessionManager.inMemory()
    });

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

    switch (event.type) {
      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          turn.text += ev.delta;
          mainWindow.webContents.send("chat:chunk", { convId, text: ev.delta });
        } else if (ev.type === "thinking_delta") {
          turn.thinking += ev.delta;
          mainWindow.webContents.send("chat:thinking_chunk", { convId, text: ev.delta });
        }
        break;
      }
      case "tool_execution_start": {
        turn.toolCalls.push({ id: event.toolCallId, name: event.toolName, input: event.args });
        mainWindow.webContents.send("chat:tool_call", {
          convId,
          id: event.toolCallId,
          name: event.toolName,
          input: event.args
        });
        break;
      }
      case "tool_execution_end": {
        const tc = turn.toolCalls.find((t) => t.id === event.toolCallId);
        const resultText = extractToolResultText(event.result);
        if (tc) {
          tc.result = resultText;
          tc.isError = event.isError;
        }
        mainWindow.webContents.send("chat:tool_result", {
          convId,
          tool_use_id: event.toolCallId,
          content: resultText,
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
    if (!conv) return;

    const assistantMsg: PersistedMessage = {
      role: "assistant",
      content: turn.text,
      thinking: turn.thinking || undefined,
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
      timestamp: new Date().toISOString(),
      ...(hasOverlayRef(turn.text) && conv.overlay ? { overlaySnapshot: conv.overlay } : {})
    };
    conv.messages.push(assistantMsg);
    appendMessage(conv, assistantMsg);

    if (!mainWindow.isDestroyed()) {
      const canUndo = (undoEntries.get(convId)?.operations.length ?? 0) > 0;
      mainWindow.webContents.send("chat:done", { convId, canUndo });
    }
    turnStates.delete(convId);
  }

  ipcMain.handle("chat:load-conversation", (_event, id: string) => {
    const conv = ensureLoaded(id);
    if (!conv) return { messages: [], overlay: null };
    return { messages: conv.messages, overlay: conv.overlay ?? null };
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

      // Reset undo stack and turn state for this new turn.
      undoEntries.set(convId, { operations: [] });
      turnStates.set(convId, { text: "", thinking: "", toolCalls: [], finished: false });

      let conv = ensureLoaded(convId);
      if (!conv) {
        conv = { id: convId, messages: [] };
        conversations.set(convId, conv);
      }

      const userMsg: PersistedMessage = {
        role: "user",
        content: message,
        timestamp: new Date().toISOString()
      };
      conv.messages.push(userMsg);
      appendMessage(conv, userMsg);

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
        turnStates.delete(convId);
        return;
      }

      try {
        const session = await ensureSessionForConv(convId, aiConfig);

        // Refresh system prompt every turn so vault path is current.
        session.state.systemPrompt = buildMaposSystemPrompt(vaultRoot);

        if (!conv.sdkSessionId) {
          conv.sdkSessionId = session.sessionId;
          appendToIndex(conv);
        }

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

  ipcMain.on("chat:clear-overlay", (_event, payload: { convId: string }) => {
    const conv = conversations.get(payload.convId);
    if (!conv) return;
    conv.overlay = null;
    saveConvState(payload.convId, { overlay: null });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("map:overlay-clear");
    }
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
  const CHAT_ON_CHANNELS = ["chat:send", "chat:abort", "chat:clear-overlay"] as const;

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

// ALLOWED_TOOLS is exported for parity with the old surface in case callers reference it.
export { ALLOWED_TOOLS };

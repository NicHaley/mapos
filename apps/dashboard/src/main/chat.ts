import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type BrowserWindow, ipcMain } from "electron";
import type { PersistedMessage, PlaceRecord, UndoEntry } from "../shared/types";
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
import { ALLOWED_TOOLS, buildMaposSystemPrompt, createMaposMcpServer } from "./mcp-server";
import { parsePlaceFile } from "./watcher";

export function setupChat(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  vaultRoot: string
): () => void {
  // Conversations live inside the vault's .mapos/ folder so they're scoped per-vault and travel with it.
  setConversationsDir(join(vaultDotDir(vaultRoot), "conversations"));

  /** In-flight Claude Agent SDK queries, keyed by convId. Lets multiple chats stream concurrently. */
  const queries = new Map<string, { close: () => void }>();
  /** Conversation state in memory. Hydrated lazily when a tab loads or sends. */
  const conversations = new Map<string, ActiveConversation>();
  /** Per-turn undo stack, keyed by convId — undo is scoped to the most recent turn of that conversation. */
  const undoEntries = new Map<string, UndoEntry>();

  initConversationsDir();

  /** Load conversation from disk into the in-memory map (idempotent). */
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
        overlay: state.overlay
      };
      conversations.set(id, conv);
      return conv;
    } catch {
      return null;
    }
  }

  /** Build a fresh MCP server for a specific conversation; closures bind callbacks to convId. */
  function makeMcpServerForConv(convId: string) {
    return createMaposMcpServer(
      mainWindow,
      places,
      vaultRoot,
      (op) => {
        const entry = undoEntries.get(convId);
        if (!entry) return;
        // Only snapshot the first write per path per turn (keep original pre-turn content).
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

  ipcMain.handle("chat:load-conversation", (_event, id: string) => {
    const conv = ensureLoaded(id);
    if (!conv) return { messages: [], overlay: null };
    return { messages: conv.messages, overlay: conv.overlay ?? null };
  });

  ipcMain.handle("chat:list-conversations", () => {
    return readConversationIndex();
  });

  ipcMain.on(
    "chat:send",
    async (_event, payload: { convId: string; message: string }): Promise<void> => {
      const { convId, message } = payload;

      // Cancel any in-flight query for this conv (resend / retry case).
      const inflight = queries.get(convId);
      if (inflight) {
        inflight.close();
        queries.delete(convId);
      }

      // Reset undo stack for this conv's new turn.
      undoEntries.set(convId, { operations: [] });

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

      // Resolve provider config per request (no cache) so changes in Settings take effect immediately.
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

      const abortController = new AbortController();

      try {
        const q = query({
          prompt: message,
          options: {
            ...(conv.sdkSessionId ? { resume: conv.sdkSessionId } : {}),
            abortController,
            cwd: vaultRoot,
            model: aiConfig.model,
            systemPrompt: buildMaposSystemPrompt(vaultRoot),
            allowedTools: [...ALLOWED_TOOLS],
            tools: [...ALLOWED_TOOLS],
            includePartialMessages: true,
            // thinking: { type: "adaptive" },
            mcpServers: {
              mapos: makeMcpServerForConv(convId)
            },
            env: {
              ...process.env,
              ...(aiConfig.provider === "local"
                ? {
                    ANTHROPIC_BASE_URL: aiConfig.baseUrl,
                    ANTHROPIC_AUTH_TOKEN: aiConfig.authToken,
                    ANTHROPIC_API_KEY: ""
                  }
                : {
                    ANTHROPIC_API_KEY: aiConfig.apiKey
                  }),
              MAPOS_VAULT_ROOT: vaultRoot
            }
          }
        });

        queries.set(convId, q);

        let fullText = "";
        let fullThinking = "";
        const fullToolCalls: Array<{
          id: string;
          name: string;
          input: unknown;
          result?: string;
          isError?: boolean;
        }> = [];

        for await (const msg of q) {
          if (mainWindow.isDestroyed()) break;

          if (msg.type === "stream_event") {
            const event = (
              msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }
            ).event;
            if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
              const text = event.delta.text ?? "";
              fullText += text;
              mainWindow.webContents.send("chat:chunk", { convId, text });
            } else if (
              event?.type === "content_block_delta" &&
              event.delta?.type === "thinking_delta"
            ) {
              const thinking = (event.delta as { thinking?: string }).thinking ?? "";
              fullThinking += thinking;
              mainWindow.webContents.send("chat:thinking_chunk", { convId, text: thinking });
            }
          } else if (msg.type === "assistant") {
            const content = (
              msg as {
                message?: {
                  content?: Array<{
                    type?: string;
                    text?: string;
                    id?: string;
                    name?: string;
                    input?: unknown;
                  }>;
                };
              }
            ).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_use" && block.name) {
                  const id = block.id ?? "";
                  fullToolCalls.push({ id, name: block.name, input: block.input ?? {} });
                  mainWindow.webContents.send("chat:tool_call", {
                    convId,
                    id,
                    name: block.name,
                    input: block.input ?? {}
                  });
                }
              }
            }
          } else if (msg.type === "user") {
            const userMsg = msg as {
              message?: {
                content?: Array<{
                  type?: string;
                  tool_use_id?: string;
                  content?: unknown;
                  is_error?: boolean;
                }>;
              };
            };
            const content = userMsg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result" && block.tool_use_id) {
                  const resultText =
                    typeof block.content === "string"
                      ? block.content
                      : Array.isArray(block.content)
                        ? (block.content as Array<{ type?: string; text?: string }>)
                            .filter((b) => b.type === "text")
                            .map((b) => b.text ?? "")
                            .join("")
                        : "";
                  const isError = block.is_error ?? false;
                  const tc = fullToolCalls.find((t) => t.id === block.tool_use_id);
                  if (tc) {
                    tc.result = resultText;
                    tc.isError = isError;
                  }
                  mainWindow.webContents.send("chat:tool_result", {
                    convId,
                    tool_use_id: block.tool_use_id,
                    content: resultText,
                    isError
                  });
                }
              }
            }
          } else if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
            const initSessionId = (msg as { session_id?: string }).session_id;
            if (initSessionId) {
              conv.sdkSessionId = initSessionId;
              appendToIndex(conv);
            }
          } else if (msg.type === "result" && (msg as { subtype?: string }).subtype === "success") {
            const assistantMsg: PersistedMessage = {
              role: "assistant",
              content: fullText,
              thinking: fullThinking || undefined,
              toolCalls: fullToolCalls.length > 0 ? fullToolCalls : undefined,
              timestamp: new Date().toISOString()
            };
            conv.messages.push(assistantMsg);
            appendMessage(conv, assistantMsg);
            if (!mainWindow.isDestroyed()) {
              const canUndo = (undoEntries.get(convId)?.operations.length ?? 0) > 0;
              mainWindow.webContents.send("chat:done", { convId, canUndo });
            }
            break;
          } else if (msg.type === "result" && (msg as { subtype?: string }).subtype !== "success") {
            const errMsg = (msg as { errors?: string[] }).errors?.join("; ") ?? "Unknown error";
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send("chat:error", { convId, message: errMsg });
            }
            break;
          } else if (
            (msg as { type?: string }).type === "assistant" &&
            (msg as { error?: string }).error
          ) {
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send("chat:error", {
                convId,
                message: (msg as { error: string }).error
              });
            }
            break;
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send("chat:error", { convId, message: errMsg });
        }
      } finally {
        queries.delete(convId);
      }
    }
  );

  ipcMain.on("chat:abort", (_event, payload: { convId: string }) => {
    const q = queries.get(payload.convId);
    if (q) {
      q.close();
      queries.delete(payload.convId);
    }
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
          // File was created this turn — delete it
          removeFeatures([op.path]);
          if (existsSync(op.path)) rmSync(op.path);
        } else {
          // File was modified or deleted — restore it
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

  ipcMain.handle("chat:delete-conversation", (_event, id: string) => {
    try {
      // Cancel any in-flight query first
      const q = queries.get(id);
      if (q) {
        q.close();
        queries.delete(id);
      }
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
    "chat:delete-conversation"
  ] as const;
  const CHAT_ON_CHANNELS = ["chat:send", "chat:abort", "chat:clear-overlay"] as const;

  return function stopChat(): void {
    for (const q of queries.values()) q.close();
    queries.clear();
    conversations.clear();
    undoEntries.clear();
    for (const ch of CHAT_HANDLE_CHANNELS) ipcMain.removeHandler(ch);
    for (const ch of CHAT_ON_CHANNELS) ipcMain.removeAllListeners(ch);
  };
}

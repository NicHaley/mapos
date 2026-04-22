import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type BrowserWindow, ipcMain } from "electron";
import type { MapOverlayPayload, PersistedMessage, PlaceRecord, UndoEntry } from "../shared/types";
import {
  type ActiveConversation,
  appendMessage,
  appendToIndex,
  compactIndex,
  getConversationFilePath,
  getConversationStateFilePath,
  initConversationsDir,
  loadConvState,
  loadMostRecentConversation,
  newConversationId,
  readConversationIndex,
  saveConvState,
  setConversationsDir
} from "./conversations";
import { indexFeatures, removeFeatures } from "./db";
import { ALLOWED_TOOLS, buildMaposSystemPrompt, createMaposMcpServer } from "./mcp-server";
import { parsePlaceFile } from "./watcher";

export function setupChat(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  vaultRoot: string,
  appStateDir: string
): () => void {
  setConversationsDir(join(appStateDir, "conversations"));

  const apiKey = import.meta.env.MAIN_VITE_ANTHROPIC_API_KEY;
  const mapboxAccessToken = import.meta.env.MAIN_VITE_MAPBOX_ACCESS_TOKEN;
  let currentQuery: { close: () => void } | null = null;
  let currentUndoEntry: UndoEntry | null = null;

  const onVaultWrite = (op: { path: string; previousContent: string | null }): void => {
    if (!currentUndoEntry) return;
    // Only snapshot the first write per path per turn (keep original pre-turn content)
    const alreadyTracked = currentUndoEntry.operations.some((o) => o.path === op.path);
    if (!alreadyTracked) {
      currentUndoEntry.operations.push(op);
    }
  };

  const onOverlayUpdate = (overlay: MapOverlayPayload | null): void => {
    if (!currentConversation) return;
    currentConversation.overlay = overlay;
    saveConvState(currentConversation.id, { overlay });
  };

  initConversationsDir();

  let currentConversation: ActiveConversation | null = loadMostRecentConversation();
  if (currentConversation) {
    console.log(
      "[main] loaded conversation:",
      currentConversation.id,
      "messages:",
      currentConversation.messages.length
    );
  }

  const maposServer = createMaposMcpServer(
    mainWindow,
    places,
    vaultRoot,
    onVaultWrite,
    onOverlayUpdate,
    () => currentConversation?.overlay
  );

  ipcMain.handle("chat:load-history", () => {
    return {
      messages: currentConversation?.messages ?? [],
      overlay: currentConversation?.overlay ?? null
    };
  });

  ipcMain.handle("chat:list-conversations", () => {
    return readConversationIndex();
  });

  ipcMain.handle("chat:switch-conversation", (_event, id: string) => {
    try {
      currentUndoEntry = null;
      const lines = readFileSync(getConversationFilePath(id), "utf-8").split("\n").filter(Boolean);
      const messages = lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as PersistedMessage];
        } catch {
          return [];
        }
      });
      const meta = readConversationIndex().find((e) => e.id === id);
      const state = loadConvState(id);
      currentConversation = {
        id,
        messages,
        sdkSessionId: meta?.sdkSessionId,
        overlay: state.overlay
      };
      return { messages, overlay: state.overlay };
    } catch {
      return { messages: [], overlay: null };
    }
  });

  ipcMain.on("chat:send", async (_event, message: string) => {
    if (currentQuery) {
      currentQuery.close();
      currentQuery = null;
    }

    // Reset undo stack for this new turn
    currentUndoEntry = { operations: [] };

    if (!currentConversation) {
      currentConversation = { id: newConversationId(), messages: [] };
    }

    const userMsg: PersistedMessage = {
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    };
    currentConversation.messages.push(userMsg);
    appendMessage(currentConversation, userMsg);

    const abortController = new AbortController();

    try {
      const q = query({
        prompt: message,
        options: {
          ...(currentConversation.sdkSessionId ? { resume: currentConversation.sdkSessionId } : {}),
          abortController,
          cwd: vaultRoot,
          model: "claude-sonnet-4-6",
          systemPrompt: buildMaposSystemPrompt(vaultRoot),
          allowedTools: [...ALLOWED_TOOLS],
          tools: [...ALLOWED_TOOLS],
          includePartialMessages: true,
          thinking: { type: "adaptive" },
          mcpServers: {
            mapbox: {
              command: "npx",
              args: ["-y", "@mapbox/mcp-server"],
              env: {
                MAPBOX_ACCESS_TOKEN: mapboxAccessToken
              }
            },
            mapos: maposServer
          },
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: apiKey,
            ANTHROPIC_BASE_URL: import.meta.env.MAIN_VITE_ANTHROPIC_BASE_URL,
            MAPOS_VAULT_ROOT: vaultRoot
          }
        }
      });

      currentQuery = q;

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
            mainWindow.webContents.send("chat:chunk", text);
          } else if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "thinking_delta"
          ) {
            const thinking = (event.delta as { thinking?: string }).thinking ?? "";
            fullThinking += thinking;
            mainWindow.webContents.send("chat:thinking_chunk", thinking);
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
                  tool_use_id: block.tool_use_id,
                  content: resultText,
                  isError
                });
              }
            }
          }
        } else if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
          const initSessionId = (msg as { session_id?: string }).session_id;
          if (initSessionId && currentConversation) {
            currentConversation.sdkSessionId = initSessionId;
            appendToIndex(currentConversation);
          }
        } else if (msg.type === "result" && (msg as { subtype?: string }).subtype === "success") {
          if (currentConversation) {
            const assistantMsg: PersistedMessage = {
              role: "assistant",
              content: fullText,
              thinking: fullThinking || undefined,
              toolCalls: fullToolCalls.length > 0 ? fullToolCalls : undefined,
              timestamp: new Date().toISOString()
            };
            currentConversation.messages.push(assistantMsg);
            appendMessage(currentConversation, assistantMsg);
          }
          if (!mainWindow.isDestroyed()) {
            const canUndo = (currentUndoEntry?.operations.length ?? 0) > 0;
            mainWindow.webContents.send("chat:done", { canUndo });
          }
          break;
        } else if (msg.type === "result" && (msg as { subtype?: string }).subtype !== "success") {
          const errMsg = (msg as { errors?: string[] }).errors?.join("; ") ?? "Unknown error";
          if (!mainWindow.isDestroyed()) mainWindow.webContents.send("chat:error", errMsg);
          break;
        } else if (
          (msg as { type?: string }).type === "assistant" &&
          (msg as { error?: string }).error
        ) {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("chat:error", (msg as { error: string }).error);
          }
          break;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send("chat:error", msg);
    } finally {
      currentQuery = null;
    }
  });

  ipcMain.on("chat:abort", () => {
    if (currentQuery) {
      currentQuery.close();
      currentQuery = null;
    }
  });

  ipcMain.handle("chat:undo", async () => {
    if (!currentUndoEntry || currentUndoEntry.operations.length === 0) {
      return { success: false, error: "Nothing to undo" };
    }
    const errors: string[] = [];
    for (const op of [...currentUndoEntry.operations].reverse()) {
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
          if (record) indexFeatures([record]);
        }
      } catch (e) {
        errors.push(`${op.path}: ${e}`);
      }
    }
    currentUndoEntry = null;
    return { success: errors.length === 0, errors };
  });

  ipcMain.on("chat:reset", () => {
    currentConversation = null;
    currentUndoEntry = null;
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("map:overlay-clear");
    }
  });

  ipcMain.on("chat:clear-overlay", () => {
    onOverlayUpdate(null);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("map:overlay-clear");
    }
  });

  ipcMain.handle("chat:delete-conversation", (_event, id: string) => {
    try {
      const convFile = getConversationFilePath(id);
      if (existsSync(convFile)) rmSync(convFile);
      const stateFile = getConversationStateFilePath(id);
      if (existsSync(stateFile)) rmSync(stateFile);
      const entries = readConversationIndex().filter((e) => e.id !== id);
      compactIndex(entries);
      if (currentConversation?.id === id) {
        currentConversation = null;
      }
    } catch (err) {
      console.error("[main] failed to delete conversation:", err);
    }
  });

  const CHAT_HANDLE_CHANNELS = [
    "chat:load-history",
    "chat:list-conversations",
    "chat:switch-conversation",
    "chat:undo",
    "chat:delete-conversation"
  ] as const;
  const CHAT_ON_CHANNELS = ["chat:send", "chat:abort", "chat:reset", "chat:clear-overlay"] as const;

  return function stopChat(): void {
    currentQuery?.close();
    currentQuery = null;
    currentConversation = null;
    currentUndoEntry = null;
    for (const ch of CHAT_HANDLE_CHANNELS) ipcMain.removeHandler(ch);
    for (const ch of CHAT_ON_CHANNELS) ipcMain.removeAllListeners(ch);
  };
}

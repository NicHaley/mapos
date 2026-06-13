import type { Message } from "@earendil-works/pi-ai";
import type {
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatToolCallPayload,
  ChatToolResultPayload,
  MapOverlayLayer
} from "@shared/types";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useReducer, useRef } from "react";

export type ActiveToolCall = {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
};

/** Client-side error rows interleaved with Pi messages in the store. */
export type ErrorRow = {
  role: "error";
  id: string;
  content: string;
  /** When set, renderer surfaces a Reconfigure link that deep-links into Settings. */
  reconfigureProvider?: "ai";
};

/** Discriminated union of what the chat pane renders, in order. */
export type StoredRow = Message | ErrorRow;

export type ConvChatState = {
  messages: StoredRow[];
  streamingContent: string;
  streamingThinking: string;
  activeToolCalls: ActiveToolCall[];
  /** True after submit until done/error/stop — covers pre-chunk gap (not represented by stream fields). */
  assistantPending: boolean;
  canUndo: boolean;
  /** Whether messages have been hydrated from disk for this convId. */
  loaded: boolean;
};

type ChatStoreState = {
  byId: Record<string, ConvChatState>;
};

type ChatStoreAction =
  | {
      type: "loaded";
      convId: string;
      messages: Message[];
    }
  | { type: "user_message"; convId: string; content: string }
  | { type: "chunk"; convId: string; text: string }
  | { type: "thinking_chunk"; convId: string; text: string }
  | { type: "tool_call"; convId: string; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      convId: string;
      tool_use_id: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "done";
      convId: string;
      canUndo: boolean;
      newMessages: Message[];
    }
  | { type: "undo_confirmed"; convId: string }
  | { type: "error"; convId: string; message: string; reconfigureProvider?: "ai" }
  | { type: "abort"; convId: string }
  | { type: "remove"; convId: string };

export const emptyConv: ConvChatState = {
  messages: [],
  streamingContent: "",
  streamingThinking: "",
  activeToolCalls: [],
  assistantPending: false,
  canUndo: false,
  loaded: false
};

function updateConv(
  state: ChatStoreState,
  convId: string,
  fn: (c: ConvChatState) => ConvChatState
): ChatStoreState {
  const existing = state.byId[convId] ?? emptyConv;
  return { byId: { ...state.byId, [convId]: fn(existing) } };
}

function chatStoreReducer(state: ChatStoreState, action: ChatStoreAction): ChatStoreState {
  switch (action.type) {
    case "loaded": {
      // Idempotent: once loaded, repeated loads (e.g. re-opening a chat tab) must not wipe
      // streamingContent / activeToolCalls for an in-flight stream.
      if (state.byId[action.convId]?.loaded) return state;
      return updateConv(state, action.convId, () => ({
        ...emptyConv,
        messages: action.messages,
        loaded: true
      }));
    }
    case "user_message": {
      // Keep `modelLoaded` as-is: Ollama's `/api/ps` is slow to respond while the request
      // is in flight (2-3s), so resetting every send would flash "Loading model…" needlessly.
      // Trade-off: if Ollama unloads after its keep-alive idle window, the next send shows
      // "Working on it…" through the reload — minor; the poller will set it true again next time.
      const userMsg: Message = {
        role: "user",
        content: action.content,
        timestamp: Date.now()
      };
      return updateConv(state, action.convId, (c) => ({
        ...c,
        canUndo: false,
        assistantPending: true,
        loaded: true,
        messages: [...c.messages, userMsg]
      }));
    }
    case "chunk":
      return updateConv(state, action.convId, (c) => ({
        ...c,
        streamingContent: c.streamingContent + action.text
      }));
    case "thinking_chunk":
      return updateConv(state, action.convId, (c) => ({
        ...c,
        streamingThinking: c.streamingThinking + action.text
      }));
    case "tool_call":
      return updateConv(state, action.convId, (c) => ({
        ...c,
        activeToolCalls: [
          ...c.activeToolCalls,
          { id: action.id, name: action.name, input: action.input, status: "running" }
        ]
      }));
    case "tool_result":
      return updateConv(state, action.convId, (c) => ({
        ...c,
        activeToolCalls: c.activeToolCalls.map((tc) =>
          tc.id === action.tool_use_id
            ? {
                ...tc,
                result: action.content,
                isError: action.isError,
                status: action.isError ? "error" : "done"
              }
            : tc
        )
      }));
    case "done":
      return updateConv(state, action.convId, (c) => ({
        ...c,
        messages: [...c.messages, ...action.newMessages],
        streamingContent: "",
        streamingThinking: "",
        activeToolCalls: [],
        assistantPending: false,
        canUndo: action.canUndo
      }));
    case "undo_confirmed":
      return updateConv(state, action.convId, (c) => ({ ...c, canUndo: false }));
    case "error":
      return updateConv(state, action.convId, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: "error",
            id: nanoid(),
            content: `Error: ${action.message}`,
            ...(action.reconfigureProvider
              ? { reconfigureProvider: action.reconfigureProvider }
              : {})
          }
        ],
        streamingContent: "",
        streamingThinking: "",
        activeToolCalls: [],
        assistantPending: false,
        canUndo: false
      }));
    case "abort":
      return updateConv(state, action.convId, (c) => ({
        ...c,
        streamingContent: "",
        streamingThinking: "",
        activeToolCalls: [],
        assistantPending: false
      }));
    case "remove": {
      if (!(action.convId in state.byId)) return state;
      const next = { ...state.byId };
      delete next[action.convId];
      return { byId: next };
    }
  }
}

export type ChatStore = {
  state: ChatStoreState;
  getConv: (convId: string) => ConvChatState;
  loadConversation: (convId: string) => Promise<MapOverlayLayer[]>;
  sendMessage: (convId: string, text: string) => void;
  abort: (convId: string) => void;
  undo: (convId: string) => Promise<{ success: boolean; error?: string; errors?: string[] }>;
  deleteConversation: (convId: string) => Promise<void>;
  renameConversation: (convId: string, title: string) => Promise<{ success: boolean; error?: string }>;
  removeFromStore: (convId: string) => void;
};

export function useChatStore(): ChatStore {
  const [state, dispatch] = useReducer(chatStoreReducer, { byId: {} });
  /** Coalesce concurrent loadConversation(id) calls so we don't double-fetch. */
  const inFlightLoads = useRef<Map<string, Promise<MapOverlayPayload | null>>>(new Map());

  // Subscribe once to chat events; route by convId via the dispatch tag.
  useEffect(() => {
    window.api.chat.onChunk((d: ChatChunkPayload) =>
      dispatch({ type: "chunk", convId: d.convId, text: d.text })
    );
    window.api.chat.onThinkingChunk((d: ChatChunkPayload) =>
      dispatch({ type: "thinking_chunk", convId: d.convId, text: d.text })
    );
    window.api.chat.onToolCall((d: ChatToolCallPayload) =>
      dispatch({ type: "tool_call", convId: d.convId, id: d.id, name: d.name, input: d.input })
    );
    window.api.chat.onToolResult((d: ChatToolResultPayload) =>
      dispatch({
        type: "tool_result",
        convId: d.convId,
        tool_use_id: d.tool_use_id,
        content: d.content,
        isError: d.isError
      })
    );
    window.api.chat.onDone((d: ChatDonePayload) =>
      dispatch({
        type: "done",
        convId: d.convId,
        canUndo: d.canUndo,
        newMessages: d.newMessages
      })
    );
    window.api.chat.onError((d: ChatErrorPayload) =>
      dispatch({
        type: "error",
        convId: d.convId,
        message: d.message,
        ...(d.reconfigureProvider ? { reconfigureProvider: d.reconfigureProvider } : {})
      })
    );
    return () => window.api.chat.removeListeners();
  }, []);

  const getConv = useCallback(
    (convId: string): ConvChatState => state.byId[convId] ?? emptyConv,
    [state]
  );

  const loadConversation = useCallback(
    async (convId: string): Promise<MapOverlayLayer[]> => {
      const existing = inFlightLoads.current.get(convId);
      if (existing) return existing;
      const p = (async () => {
        const { messages, layers } = await window.api.chat.loadConversation(convId);
        dispatch({ type: "loaded", convId, messages });
        return layers;
      })().finally(() => {
        inFlightLoads.current.delete(convId);
      });
      inFlightLoads.current.set(convId, p);
      return p;
    },
    []
  );

  const sendMessage = useCallback((convId: string, text: string) => {
    dispatch({ type: "user_message", convId, content: text });
    window.api.chat.send(convId, text);
  }, []);

  const abort = useCallback((convId: string) => {
    window.api.chat.abort(convId);
    dispatch({ type: "abort", convId });
  }, []);

  const undo = useCallback(async (convId: string) => {
    const result = await window.api.chat.undo(convId);
    dispatch({ type: "undo_confirmed", convId });
    return result;
  }, []);

  const deleteConversation = useCallback(async (convId: string) => {
    await window.api.chat.deleteConversation(convId);
    dispatch({ type: "remove", convId });
  }, []);

  const renameConversation = useCallback(async (convId: string, title: string) => {
    return window.api.chat.renameConversation(convId, title);
  }, []);

  const removeFromStore = useCallback((convId: string) => {
    dispatch({ type: "remove", convId });
  }, []);

  return {
    state,
    getConv,
    loadConversation,
    sendMessage,
    abort,
    undo,
    deleteConversation,
    renameConversation,
    removeFromStore
  };
}

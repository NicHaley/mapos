import type { ConversationMeta } from "@shared/types";
import { useCallback, useEffect, useState } from "react";
import type { ChatStore } from "./use-chat-store";

/** Most-recent-first list of saved conversations, refreshed on app events and when any chat finishes a turn. */
export function useConversations(chatStore: ChatStore): {
  conversations: ConversationMeta[];
  refresh: () => Promise<void>;
} {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);

  const refresh = useCallback(async () => {
    const list = await window.api.chat.listConversations();
    setConversations(list.slice().reverse());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Refresh on two edges, observed via store subscription (not renders, so
   * streaming chunks don't touch the host component):
   * - pending → idle: a turn finished and is persisted.
   * - first chunk / tool call: system:init has fired and the conversation is
   *   safely in the index, so a brand-new chat appears in the sidebar (with the
   *   streaming spinner) before its turn finishes. */
  useEffect(() => {
    let prevPending = chatStore.hasPendingConv();
    let prevStreaming = chatStore.hasActiveStream();
    return chatStore.subscribe(() => {
      const pending = chatStore.hasPendingConv();
      const streaming = chatStore.hasActiveStream();
      if (prevPending && !pending) void refresh();
      if (!prevStreaming && streaming) void refresh();
      prevPending = pending;
      prevStreaming = streaming;
    });
  }, [chatStore, refresh]);

  return { conversations, refresh };
}

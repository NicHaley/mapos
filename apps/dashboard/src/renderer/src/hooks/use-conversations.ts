import type { ConversationMeta } from "@shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  const anyPending = useMemo(
    () => Object.values(chatStore.state.byId).some((c) => c.assistantPending),
    [chatStore.state]
  );
  const prevAnyPending = useRef(false);
  useEffect(() => {
    if (prevAnyPending.current && !anyPending) {
      void refresh();
    }
    prevAnyPending.current = anyPending;
  }, [anyPending, refresh]);

  /** Once any conv has produced its first chunk / tool call, system:init has fired and it's
   * safely in the index. Refresh so a brand-new chat appears in the sidebar (with the
   * streaming spinner) before its turn finishes. */
  const anyStreaming = useMemo(
    () =>
      Object.values(chatStore.state.byId).some(
        (c) =>
          c.streamingContent !== "" || c.streamingThinking !== "" || c.activeToolCalls.length > 0
      ),
    [chatStore.state]
  );
  const prevAnyStreaming = useRef(false);
  useEffect(() => {
    if (!prevAnyStreaming.current && anyStreaming) {
      void refresh();
    }
    prevAnyStreaming.current = anyStreaming;
  }, [anyStreaming, refresh]);

  return { conversations, refresh };
}

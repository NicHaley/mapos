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

  return { conversations, refresh };
}

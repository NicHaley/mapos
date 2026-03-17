import type { ChatStatus } from "ai";
import { EllipsisIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from "./ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea
} from "./ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./ai-elements/reasoning";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "./ui/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "./ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger
} from "./ui/sidebar";

type ChatMessage = {
  role: "user" | "assistant" | "error";
  content: string;
  thinking?: string;
};

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ChatSidebar(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);

  useEffect(() => {
    window.api.chat.loadHistory().then((history) => {
      if (history.length > 0) {
        setMessages(
          history.map((msg) => ({
            role: msg.role,
            content: msg.content,
            thinking: msg.thinking
          }))
        );
      }
    });

    window.api.chat.listConversations().then((convos) => {
      const sorted = convos.slice().reverse();
      setConversations(sorted);
      if (sorted.length > 0) {
        setCurrentConvId(sorted[0].id);
      }
    });
  }, []);

  useEffect(() => {
    window.api.chat.onChunk((text) => {
      setStreamingContent((prev) => prev + text);
    });

    window.api.chat.onThinkingChunk((text) => {
      setStreamingThinking((prev) => prev + text);
    });

    window.api.chat.onDone(() => {
      setStreamingContent((content) => {
        setStreamingThinking((thinking) => {
          if (content) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content, thinking: thinking || undefined }
            ]);
          }
          return "";
        });
        return "";
      });
      setLoading(false);
      window.api.chat.listConversations().then((convos) => {
        const sorted = convos.slice().reverse();
        setConversations(sorted);
        if (sorted.length > 0 && !currentConvId) {
          setCurrentConvId(sorted[0].id);
        }
      });
    });

    window.api.chat.onError((msg) => {
      setMessages((prev) => [...prev, { role: "error", content: `Error: ${msg}` }]);
      setStreamingContent("");
      setStreamingThinking("");
      setLoading(false);
    });

    return () => {
      window.api.chat.removeListeners();
    };
  }, [currentConvId]);

  function handleSubmit({ text }: { text: string }): void {
    if (!text.trim() || loading) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    window.api.chat.send(text);
  }

  function handleStop(): void {
    window.api.chat.abort();
    setLoading(false);
  }

  function clear(): void {
    window.api.chat.reset();
    setMessages([]);
    setStreamingContent("");
    setStreamingThinking("");
    setLoading(false);
  }

  async function switchConversation(id: string): Promise<void> {
    const history = await window.api.chat.switchConversation(id);
    setMessages(
      history.map((msg) => ({ role: msg.role, content: msg.content, thinking: msg.thinking }))
    );
    setCurrentConvId(id);
    setStreamingContent("");
    setStreamingThinking("");
    setLoading(false);
  }

  function handleNewConversation(): void {
    clear();
    setCurrentConvId(null);
  }

  async function deleteConversation(): Promise<void> {
    if (!currentConvId) return;
    await window.api.chat.deleteConversation(currentConvId);
    const updated = await window.api.chat.listConversations();
    const sorted = updated.slice().reverse();
    setConversations(sorted);
    if (sorted.length > 0) {
      await switchConversation(sorted[0].id);
    } else {
      clear();
      setCurrentConvId(null);
    }
  }

  const chatStatus: ChatStatus = loading ? (streamingContent ? "streaming" : "submitted") : "idle";

  return (
    <Sidebar side="right" collapsible="offcanvas" variant="floating">
      <SidebarHeader className="flex-row items-center justify-between px-3 py-2 border-b border-sidebar-border">
        <Select value={currentConvId ?? ""} onValueChange={(id) => switchConversation(id)}>
          <SelectTrigger className="min-w-0 max-w-[160px]">
            <span className="truncate text-sm">
              {currentConvId
                ? conversations.find((c) => c.id === currentConvId)?.preview || "Chat"
                : "New Chat"}
            </span>
          </SelectTrigger>
          <SelectContent className="max-w-[220px] w-full" align="start">
            <SelectGroup>
              {conversations.map((conv) => (
                <SelectItem key={conv.id} value={conv.id} className="max-w-xs">
                  <span className="truncate">{conv.preview || "Empty conversation"}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem variant="destructive" onClick={deleteConversation}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleNewConversation}
            title="New conversation"
          >
            <SquarePenIcon />
          </Button>
          <SidebarTrigger className="rotate-180" />
        </div>
      </SidebarHeader>

      <SidebarContent className="overflow-hidden p-0">
        <Conversation>
          <ConversationContent>
            {messages.length === 0 && !streamingThinking && !streamingContent && (
              <ConversationEmptyState
                title=""
                description="Ask about your saved places, notes, or get help organizing your map."
              />
            )}

            {messages.map((msg, i) =>
              msg.role === "error" ? (
                <div
                  key={i}
                  className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {msg.content}
                </div>
              ) : (
                <Message key={i} from={msg.role}>
                  {msg.thinking && (
                    <Reasoning>
                      <ReasoningTrigger />
                      <ReasoningContent>{msg.thinking}</ReasoningContent>
                    </Reasoning>
                  )}
                  <MessageContent>
                    <MessageResponse>{msg.content}</MessageResponse>
                  </MessageContent>
                </Message>
              )
            )}

            {(streamingThinking || streamingContent) && (
              <Message from="assistant">
                {streamingThinking && (
                  <Reasoning isStreaming={!streamingContent}>
                    <ReasoningTrigger />
                    <ReasoningContent>{streamingThinking}</ReasoningContent>
                  </Reasoning>
                )}
                {streamingContent && (
                  <MessageContent>
                    <MessageResponse isAnimating>{streamingContent}</MessageResponse>
                  </MessageContent>
                )}
              </Message>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border px-3 py-3">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea placeholder="Message MapOS..." disabled={loading} />
          <PromptInputFooter>
            <div />
            <PromptInputSubmit status={chatStatus} onStop={handleStop} />
          </PromptInputFooter>
        </PromptInput>
      </SidebarFooter>
    </Sidebar>
  );
}

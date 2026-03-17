import type { ChatStatus } from "ai";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/utils";
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
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
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
  const [selectorOpen, setSelectorOpen] = useState(false);

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
    setSelectorOpen(false);
  }

  function handleNewConversation(): void {
    clear();
    setCurrentConvId(null);
    setSelectorOpen(false);
  }

  const chatStatus: ChatStatus = loading ? (streamingContent ? "streaming" : "submitted") : "idle";

  const currentPreview = currentConvId
    ? (conversations.find((c) => c.id === currentConvId)?.preview || "Chat")
    : "New Chat";

  return (
    <Sidebar side="right" collapsible="offcanvas" variant="floating">
      <SidebarHeader className="flex-row items-center justify-between px-3 py-2 border-b border-sidebar-border">
        <Popover open={selectorOpen} onOpenChange={setSelectorOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs font-semibold tracking-widest text-sidebar-foreground/60 uppercase hover:text-sidebar-foreground max-w-[160px]"
            >
              <ChevronDownIcon className="size-3 shrink-0" />
              <span className="truncate">{currentPreview}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1">
            <ScrollArea className="max-h-80">
              <button
                onClick={handleNewConversation}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              >
                <PlusIcon className="size-3.5" /> New conversation
              </button>
              {conversations.length > 0 && <Separator className="my-1" />}
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => switchConversation(conv.id)}
                  className={cn(
                    "flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-accent",
                    conv.id === currentConvId && "bg-accent"
                  )}
                >
                  <span className="truncate text-sm">
                    {conv.preview || "Empty conversation"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeDate(conv.updated_at)}
                  </span>
                </button>
              ))}
            </ScrollArea>
          </PopoverContent>
        </Popover>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-sidebar-foreground/50 hover:text-sidebar-foreground"
            onClick={clear}
            title="Clear conversation"
          >
            <Trash2Icon className="size-3.5" />
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

import type { ChatStatus } from "ai";
import { Trash2Icon } from "lucide-react";
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

export function ChatSidebar(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [loading, setLoading] = useState(false);

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
  }, []);

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

  const chatStatus: ChatStatus = loading ? (streamingContent ? "streaming" : "submitted") : "idle";

  return (
    <Sidebar side="right" collapsible="offcanvas" variant="floating">
      <SidebarHeader className="flex-row items-center justify-between px-3 py-2 border-b border-sidebar-border">
        <span className="text-xs font-semibold tracking-widest text-sidebar-foreground/60 uppercase">
          Chat
        </span>
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

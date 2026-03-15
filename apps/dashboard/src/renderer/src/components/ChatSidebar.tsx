import { ArrowUpIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger
} from "./ui/sidebar";

type Message = {
  role: "user" | "assistant" | "error";
  content: string;
};

export function ChatSidebar(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.api.chat.onChunk((text) => {
      setStreamingContent((prev) => prev + text);
    });

    window.api.chat.onDone(() => {
      setStreamingContent((current) => {
        if (current) {
          setMessages((prev) => [...prev, { role: "assistant", content: current }]);
        }
        return "";
      });
      setLoading(false);
    });

    window.api.chat.onError((msg) => {
      setMessages((prev) => [...prev, { role: "error", content: `Error: ${msg}` }]);
      setStreamingContent("");
      setLoading(false);
    });

    return () => {
      window.api.chat.removeListeners();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  function send(): void {
    const text = input.trim();
    if (!text || loading) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    window.api.chat.send(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function clear(): void {
    window.api.chat.reset();
    setMessages([]);
    setStreamingContent("");
    setLoading(false);
  }

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

      <SidebarContent className="px-3 py-3">
        {messages.length === 0 && !loading && (
          <p className="mt-10 text-center text-xs text-sidebar-foreground/40">
            Ask about your saved places, notes, or get help organizing your map.
          </p>
        )}

        <div className="flex flex-col gap-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                  msg.role === "user"
                    ? "rounded-br-sm bg-primary text-primary-foreground"
                    : msg.role === "error"
                      ? "rounded-bl-sm bg-destructive/15 text-destructive"
                      : "rounded-bl-sm bg-sidebar-accent text-sidebar-accent-foreground"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {(streamingContent || loading) && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-xl rounded-bl-sm bg-sidebar-accent text-sidebar-accent-foreground px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
                {streamingContent}
                <span className="inline-block ml-px animate-blink">▌</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border px-3 py-3">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message MapOS..."
            rows={1}
            disabled={loading}
            className="flex-1 resize-none rounded-lg border border-sidebar-border bg-sidebar-accent text-sidebar-foreground placeholder:text-sidebar-foreground/40 px-3 py-2 text-sm leading-relaxed outline-none max-h-30 overflow-y-auto disabled:opacity-50"
          />
          <Button
            onClick={send}
            disabled={loading || !input.trim()}
            size="icon"
            className="shrink-0 self-end"
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

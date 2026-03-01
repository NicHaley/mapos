import { useEffect, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant" | "error";
  content: string;
};

export default function Chat(): React.JSX.Element {
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
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const content = last?.role === "assistant" && last.content === "" ? prev : prev;
        void content;
        return prev;
      });
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

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#1a1a1a",
        color: "#e5e7eb",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #2d2d2d",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, color: "#9ca3af", letterSpacing: "0.05em" }}>
          MAPOS
        </span>
        <button
          onClick={() => {
            window.api.chat.reset();
            setMessages([]);
            setStreamingContent("");
            setLoading(false);
          }}
          type="button"
          title="Clear conversation"
          style={{
            background: "none",
            border: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 6px",
            borderRadius: 4
          }}
        >
          clear
        </button>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        {messages.length === 0 && !loading && (
          <div
            style={{
              color: "#4b5563",
              textAlign: "center",
              marginTop: 40,
              fontSize: 13
            }}
          >
            Ask about your saved places, notes, or get help organizing your map.
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start"
            }}
          >
            <div
              style={{
                maxWidth: "85%",
                padding: "8px 12px",
                borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                background:
                  msg.role === "user" ? "#2563eb" : msg.role === "error" ? "#450a0a" : "#262626",
                color: msg.role === "error" ? "#fca5a5" : "#e5e7eb",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
              }}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {/* Streaming message */}
        {(streamingContent || loading) && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                maxWidth: "85%",
                padding: "8px 12px",
                borderRadius: "12px 12px 12px 2px",
                background: "#262626",
                color: "#e5e7eb",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
              }}
            >
              {streamingContent || ""}
              <span
                style={{
                  display: "inline-block",
                  animation: "blink 1s step-end infinite",
                  marginLeft: 1
                }}
              >
                ▌
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div
        style={{
          borderTop: "1px solid #2d2d2d",
          padding: "12px",
          display: "flex",
          gap: 8,
          flexShrink: 0
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message MapOS..."
          rows={1}
          disabled={loading}
          style={{
            flex: 1,
            background: "#262626",
            border: "1px solid #374151",
            borderRadius: 8,
            color: "#e5e7eb",
            padding: "8px 10px",
            fontSize: 14,
            resize: "none",
            outline: "none",
            fontFamily: "inherit",
            lineHeight: 1.5,
            maxHeight: 120,
            overflowY: "auto"
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{
            background: loading || !input.trim() ? "#374151" : "#2563eb",
            border: "none",
            borderRadius: 8,
            color: loading || !input.trim() ? "#6b7280" : "white",
            cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            padding: "0 14px",
            fontSize: 16,
            flexShrink: 0,
            transition: "background 0.15s"
          }}
          type="button"
        >
          ↑
        </button>
      </div>

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

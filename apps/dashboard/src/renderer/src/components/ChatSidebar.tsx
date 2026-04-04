import type { ChatToolCallPayload, ChatToolResultPayload, ConversationMeta } from "@shared/types";
import type { ChatStatus } from "ai";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  Loader2Icon,
  SquarePenIcon,
  XIcon
} from "lucide-react";
import { useEffect, useReducer, useState } from "react";
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
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "./ui/sidebar";

type ChatMessage = {
  role: "user" | "assistant" | "error";
  content: string;
  thinking?: string;
  toolCalls?: ActiveToolCall[];
};

type ActiveToolCall = {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
};

function ToolCallRow({ call }: { call: ActiveToolCall }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(call.input, null, 2);
  const hasDetail = inputStr !== "{}" || call.result;

  return (
    <div className="my-1 rounded-md border border-sidebar-border bg-sidebar-accent/40 text-xs font-mono overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-sidebar-accent/60 transition-colors disabled:cursor-default"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        disabled={!hasDetail}
      >
        {call.status === "running" ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : call.status === "error" ? (
          <XIcon className="size-3 shrink-0 text-destructive" />
        ) : (
          <CheckIcon className="size-3 shrink-0 text-emerald-500" />
        )}
        <span className="text-foreground/80">{call.name}</span>
        {hasDetail && (
          <span className="ml-auto text-muted-foreground">
            {expanded ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
          </span>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="flex flex-col gap-2 border-t border-sidebar-border px-2.5 py-2">
          {inputStr !== "{}" && (
            <pre className="whitespace-pre-wrap text-muted-foreground leading-relaxed !m-0">
              {inputStr}
            </pre>
          )}
          {call.result && (
            <pre
              className={`whitespace-pre-wrap leading-relaxed !m-0 ${call.isError ? "text-destructive" : "text-foreground/70"}`}
            >
              {call.result.length > 500 ? `${call.result.slice(0, 500)}\n…` : call.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

type ChatState = {
  messages: ChatMessage[];
  streamingContent: string;
  streamingThinking: string;
  activeToolCalls: ActiveToolCall[];
};

type ChatAction =
  | { type: "load_history"; messages: ChatMessage[] }
  | { type: "user_message"; content: string }
  | { type: "chunk"; text: string }
  | { type: "thinking_chunk"; text: string }
  | ({ type: "tool_call" } & ChatToolCallPayload)
  | ({ type: "tool_result" } & ChatToolResultPayload)
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "reset" };

const initialChatState: ChatState = {
  messages: [],
  streamingContent: "",
  streamingThinking: "",
  activeToolCalls: []
};

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "load_history":
      return { ...state, messages: action.messages };
    case "user_message":
      return { ...state, messages: [...state.messages, { role: "user", content: action.content }] };
    case "chunk":
      return { ...state, streamingContent: state.streamingContent + action.text };
    case "thinking_chunk":
      return { ...state, streamingThinking: state.streamingThinking + action.text };
    case "tool_call":
      return {
        ...state,
        activeToolCalls: [
          ...state.activeToolCalls,
          { id: action.id, name: action.name, input: action.input, status: "running" }
        ]
      };
    case "tool_result":
      return {
        ...state,
        activeToolCalls: state.activeToolCalls.map((tc) =>
          tc.id === action.tool_use_id
            ? {
                ...tc,
                result: action.content,
                isError: action.isError,
                status: action.isError ? "error" : "done"
              }
            : tc
        )
      };
    case "done": {
      const { streamingContent, streamingThinking, activeToolCalls } = state;
      const newMessages =
        streamingContent || activeToolCalls.length > 0
          ? [
              ...state.messages,
              {
                role: "assistant" as const,
                content: streamingContent,
                thinking: streamingThinking || undefined,
                toolCalls: activeToolCalls.length > 0 ? activeToolCalls : undefined
              }
            ]
          : state.messages;
      return {
        messages: newMessages,
        streamingContent: "",
        streamingThinking: "",
        activeToolCalls: []
      };
    }
    case "error":
      return {
        messages: [...state.messages, { role: "error", content: `Error: ${action.message}` }],
        streamingContent: "",
        streamingThinking: "",
        activeToolCalls: []
      };
    case "reset":
      return initialChatState;
  }
}

export function ChatSidebar(): React.JSX.Element {
  const [{ messages, streamingContent, streamingThinking, activeToolCalls }, dispatch] = useReducer(
    chatReducer,
    initialChatState
  );
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);

  useEffect(() => {
    window.api.chat.loadHistory().then((history) => {
      if (history.length > 0) {
        dispatch({
          type: "load_history",
          messages: history.map((msg) => ({
            role: msg.role,
            content: msg.content,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls?.map(
              (tc) => ({ ...tc, status: tc.isError ? "error" : "done" }) as ActiveToolCall
            )
          }))
        });
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
    window.api.chat.onChunk((text) => dispatch({ type: "chunk", text }));
    window.api.chat.onThinkingChunk((text) => dispatch({ type: "thinking_chunk", text }));
    window.api.chat.onToolCall(({ id, name, input }) =>
      dispatch({ type: "tool_call", id, name, input })
    );
    window.api.chat.onToolResult(({ tool_use_id, content, isError }) =>
      dispatch({ type: "tool_result", tool_use_id, content, isError })
    );

    window.api.chat.onDone(() => {
      dispatch({ type: "done" });
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
      dispatch({ type: "error", message: msg });
      setLoading(false);
    });

    return () => {
      window.api.chat.removeListeners();
    };
  }, [currentConvId]);

  function handleSubmit({ text }: { text: string }): void {
    if (!text.trim() || loading) return;
    dispatch({ type: "user_message", content: text });
    setLoading(true);
    window.api.chat.send(text);
  }

  function handleStop(): void {
    window.api.chat.abort();
    setLoading(false);
  }

  function clear(): void {
    window.api.chat.reset();
    dispatch({ type: "reset" });
    setLoading(false);
  }

  async function switchConversation(id: string): Promise<void> {
    const history = await window.api.chat.switchConversation(id);
    dispatch({
      type: "load_history",
      messages: history.map((msg) => ({
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls?.map(
          (tc) => ({ ...tc, status: tc.isError ? "error" : "done" }) as ActiveToolCall
        )
      }))
    });
    setCurrentConvId(id);
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
    handleNewConversation();
  }

  const chatStatus: ChatStatus = loading ? (streamingContent ? "streaming" : "submitted") : "ready";

  return (
    <Sidebar side="right" collapsible="offcanvas" variant="floating">
      <SidebarHeader className="flex-row items-center justify-between px-3 py-2 border-b border-sidebar-border">
        <Select value={currentConvId ?? ""} onValueChange={(id) => id && switchConversation(id)}>
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
                  <span className="truncate">{conv.preview}</span>
                </SelectItem>
              ))}
              {conversations.length === 0 && (
                <div className="flex items-center justify-center py-2">
                  <span className="text-muted-foreground text-sm">No conversations</span>
                </div>
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          {currentConvId && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem variant="destructive" onClick={deleteConversation}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNewConversation}
            title="New conversation"
          >
            <SquarePenIcon />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent className="overflow-hidden p-0">
        <Conversation className="prose prose-sm">
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
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="w-full space-y-0.5">
                      {msg.toolCalls.map((tc) => (
                        <ToolCallRow key={tc.id} call={tc} />
                      ))}
                    </div>
                  )}
                  {msg.content && (
                    <MessageContent>
                      <MessageResponse>{msg.content}</MessageResponse>
                    </MessageContent>
                  )}
                </Message>
              )
            )}

            {(streamingThinking || streamingContent || activeToolCalls.length > 0) && (
              <Message from="assistant">
                {streamingThinking && (
                  <Reasoning isStreaming={!streamingContent}>
                    <ReasoningTrigger />
                    <ReasoningContent>{streamingThinking}</ReasoningContent>
                  </Reasoning>
                )}
                {activeToolCalls.length > 0 && (
                  <div className="w-full space-y-0.5">
                    {activeToolCalls.map((tc) => (
                      <ToolCallRow key={tc.id} call={tc} />
                    ))}
                  </div>
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

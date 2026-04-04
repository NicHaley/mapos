import { cn } from "@renderer/lib/utils";
import type {
  ChatToolCallPayload,
  ChatToolResultPayload,
  ConversationMeta,
  MapOverlayPayload
} from "@shared/types";
import type { ChatStatus } from "ai";
import { diffLines } from "diff";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  FilePlusIcon,
  FileX2Icon,
  Loader2Icon,
  PencilIcon,
  SquarePenIcon,
  Undo2Icon,
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

const VAULT_FILE_TOOLS = new Set([
  "mcp__mapos__write_vault_file",
  "mcp__mapos__delete_vault_file",
  "mcp__mapos__rename_vault_file"
]);

const TOOL_LABELS: Record<string, string> = {
  mcp__mapos__render_overlay_on_map: "Rendering On Map",
  mcp__mapos__clear_map_overlay: "Clearing Overlay",
  mcp__mapos__query_spatial_index: "Querying Vault",
  mcp__mapos__index_file: "Indexing File",
  mcp__mapos__rebuild_index: "Rebuilding Index",
  mcp__mapos__get_viewport: "Getting Viewport",
  mcp__mapos__pan_to: "Panning Map",
  mcp__mapos__write_vault_file: "Writing File",
  mcp__mapos__delete_vault_file: "Deleting File",
  mcp__mapos__rename_vault_file: "Renaming File",
  Bash: "Running Command",
  Read: "Reading File",
  Glob: "Searching Files",
  Grep: "Searching Content",
  WebSearch: "Searching Web",
  WebFetch: "Fetching URL"
};

function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  // Strip mcp__namespace__ prefix, then humanize snake_case
  return name.replace(/^mcp__[^_]+(?:__[^_]+)*?__/, "").replace(/_/g, " ");
}

type FileChangeResult = {
  success: boolean;
  path: string;
  fromPath?: string;
  action: "created" | "modified" | "deleted" | "renamed";
  previousContent: string | null;
  newContent: string | null;
};

type DiffLineItem =
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "context"; text: string }
  | { kind: "ellipsis" };

function flattenDiffParts(parts: ReturnType<typeof diffLines>): DiffLineItem[] {
  const items: DiffLineItem[] = [];
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    if (part.added) {
      for (const line of lines) items.push({ kind: "added", text: line });
    } else if (part.removed) {
      for (const line of lines) items.push({ kind: "removed", text: line });
    } else {
      // Unchanged section — collapse to separator, avoiding consecutive ellipses
      const hasContent = lines.some((l) => l !== "");
      if (hasContent && items.length > 0 && items[items.length - 1].kind !== "ellipsis") {
        items.push({ kind: "ellipsis" });
      }
    }
  }
  // Strip trailing ellipsis
  while (items.length > 0 && items[items.length - 1].kind === "ellipsis") {
    items.pop();
  }
  return items;
}

function DiffLineView({ item }: { item: DiffLineItem }): React.JSX.Element {
  if (item.kind === "ellipsis") {
    return (
      <div className="px-2.5 py-px text-muted-foreground/30 select-none border-l-2 border-transparent">
        ···
      </div>
    );
  }
  if (item.kind === "added") {
    return (
      <div className="px-2.5 py-px border-l-2 border-emerald-500/50 text-emerald-500/70">
        <span className="select-none mr-2 opacity-60">+</span>
        {item.text}
      </div>
    );
  }
  if (item.kind === "removed") {
    return (
      <div className="px-2.5 py-px border-l-2 border-destructive/40 text-destructive/60">
        <span className="select-none mr-2 opacity-60">-</span>
        {item.text}
      </div>
    );
  }
  return (
    <div className="px-2.5 py-px border-l-2 border-transparent text-muted-foreground/50">
      <span className="select-none mr-2 opacity-0"> </span>
      {item.text}
    </div>
  );
}

function parseFileChangeResult(call: ActiveToolCall): FileChangeResult | null {
  if (!VAULT_FILE_TOOLS.has(call.name) || !call.result) return null;
  try {
    const parsed = JSON.parse(call.result) as FileChangeResult;
    if (!parsed.action || !parsed.path) return null;
    return parsed;
  } catch {
    return null;
  }
}

const PREVIEW_LINES = 6;

function FileChangeRow({
  call,
  onOpenFile
}: {
  call: ActiveToolCall;
  onOpenFile: (filePath: string) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const change = parseFileChangeResult(call);
  const filename = change?.path.split("/").pop() ?? toolLabel(call.name);
  const fromFilename = change?.fromPath?.split("/").pop();

  const ActionIcon =
    call.status === "running"
      ? Loader2Icon
      : change?.action === "created"
        ? FilePlusIcon
        : change?.action === "deleted"
          ? FileX2Icon
          : change?.action === "renamed"
            ? ArrowRightIcon
            : PencilIcon;

  const actionLabel =
    call.status === "running"
      ? "Writing…"
      : change?.action === "created"
        ? "Created"
        : change?.action === "deleted"
          ? "Deleted"
          : change?.action === "renamed"
            ? "Renamed"
            : "Modified";

  const actionColor =
    call.status === "running"
      ? "text-muted-foreground"
      : change?.action === "created"
        ? "text-emerald-500"
        : change?.action === "deleted"
          ? "text-destructive"
          : change?.action === "renamed"
            ? "text-amber-400"
            : "text-blue-400";

  const allLines =
    change && call.status !== "running"
      ? flattenDiffParts(diffLines(change.previousContent ?? "", change.newContent ?? ""))
      : [];

  const hasOverflow = allLines.length > PREVIEW_LINES;
  const visibleLines = expanded ? allLines : allLines.slice(0, PREVIEW_LINES);
  const canOpen = !!change && change.action !== "deleted" && call.status !== "running";
  const showDiff = allLines.length > 0 && call.status !== "running" && change?.action !== "renamed";

  return (
    <div className="overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-2 pb-1.5">
        <ActionIcon
          className={cn(
            "size-3.5 shrink-0",
            call.status === "running" ? "animate-spin text-muted-foreground/70" : actionColor
          )}
        />
        <button
          type="button"
          disabled={!canOpen}
          onClick={() => change && onOpenFile(change.path)}
          className="flex-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none truncate font-mono"
        >
          {change?.action === "renamed" && fromFilename ? (
            <span className="flex items-center gap-1">
              <span className="opacity-50">{fromFilename}</span>
              <ArrowRightIcon className="size-3 shrink-0 opacity-50" />
              {filename}
            </span>
          ) : (
            filename
          )}
        </button>
        <span className={cn("text-xs font-medium shrink-0", actionColor)}>{actionLabel}</span>
      </div>

      {/* Diff */}
      {showDiff && (
        <div className="mb-1 rounded border border-sidebar-border/60 bg-sidebar-accent/30 overflow-hidden">
          <pre className="font-mono text-[11px] leading-relaxed !m-0">
            {visibleLines.map((item, i) => (
              <DiffLineView key={i} item={item} />
            ))}
          </pre>
          {hasOverflow && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-center py-1 text-muted-foreground hover:text-foreground transition-colors border-t border-sidebar-border/40"
            >
              <ChevronDownIcon
                className={cn("size-3 transition-transform", expanded ? "rotate-180" : "rotate-0")}
              />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { call: ActiveToolCall }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(call.input, null, 2);
  const hasDetail = inputStr !== "{}" || !!call.result;

  return (
    <div className="overflow-hidden">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-sm text-muted-foreground/70 transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground/70"
      >
        {call.status === "running" ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        ) : call.status === "error" ? (
          <XIcon className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
        )}
        <span className="capitalize">{toolLabel(call.name)}</span>
        {hasDetail && (
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              expanded ? "rotate-180" : "rotate-0"
            )}
          />
        )}
      </button>
      {expanded && hasDetail && (
        <div className="mb-1 rounded border border-sidebar-border/60 bg-sidebar-accent/30 text-xs font-mono overflow-hidden">
          <div className="flex flex-col gap-2 px-2.5 py-2">
            {inputStr !== "{}" && (
              <pre className="whitespace-pre-wrap text-muted-foreground leading-relaxed !m-0">
                {inputStr}
              </pre>
            )}
            {call.result && (
              <pre
                className={cn(
                  "whitespace-pre-wrap leading-relaxed !m-0",
                  call.isError ? "text-destructive" : "text-foreground/70"
                )}
              >
                {call.result.length > 500 ? `${call.result.slice(0, 500)}\n…` : call.result}
              </pre>
            )}
          </div>
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
  canUndo: boolean;
};

type ChatAction =
  | { type: "load_history"; messages: ChatMessage[] }
  | { type: "user_message"; content: string }
  | { type: "chunk"; text: string }
  | { type: "thinking_chunk"; text: string }
  | ({ type: "tool_call" } & ChatToolCallPayload)
  | ({ type: "tool_result" } & ChatToolResultPayload)
  | { type: "done"; canUndo: boolean }
  | { type: "undo_confirmed" }
  | { type: "error"; message: string }
  | { type: "reset" };

const initialChatState: ChatState = {
  messages: [],
  streamingContent: "",
  streamingThinking: "",
  activeToolCalls: [],
  canUndo: false
};

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "load_history":
      return { ...state, messages: action.messages };
    case "user_message":
      return {
        ...state,
        canUndo: false,
        messages: [...state.messages, { role: "user", content: action.content }]
      };
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
        activeToolCalls: [],
        canUndo: action.canUndo
      };
    }
    case "undo_confirmed":
      return { ...state, canUndo: false };
    case "error":
      return {
        messages: [...state.messages, { role: "error", content: `Error: ${action.message}` }],
        streamingContent: "",
        streamingThinking: "",
        activeToolCalls: [],
        canUndo: false
      };
    case "reset":
      return initialChatState;
  }
}

function mapOverlayFeatureCount(o: MapOverlayPayload): number {
  return o.points.length + o.lines.length + o.polygons.length;
}

const overlayActionButtonClass = "shrink-0 h-7 text-xs gap-1 font-normal";

export function ChatSidebar({
  onOpenFile,
  mapOverlay,
  mapOverlayNonce,
  onAddAllOverlayToVault,
  addAllOverlayBusy
}: {
  onOpenFile: (filePath: string) => void;
  mapOverlay: MapOverlayPayload;
  /** Increments when the map receives a new non-empty overlay (resets Add-all visibility). */
  mapOverlayNonce: number;
  onAddAllOverlayToVault: () => void | Promise<void>;
  addAllOverlayBusy: boolean;
}): React.JSX.Element {
  const [{ messages, streamingContent, streamingThinking, activeToolCalls, canUndo }, dispatch] =
    useReducer(chatReducer, initialChatState);
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  /** User clicked Add all for the current overlay batch. */
  const [addAllToVaultConsumed, setAddAllToVaultConsumed] = useState(false);
  /** Hide Add all after the user sends a message (until a new map overlay bumps nonce). */
  const [addAllHiddenAfterUserMessage, setAddAllHiddenAfterUserMessage] = useState(false);

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

  // Reset Add-all visibility when the map receives a new overlay (parent bumps nonce).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional subscription to mapOverlayNonce only
  useEffect(() => {
    setAddAllToVaultConsumed(false);
    setAddAllHiddenAfterUserMessage(false);
  }, [mapOverlayNonce]);

  useEffect(() => {
    window.api.chat.onChunk((text) => dispatch({ type: "chunk", text }));
    window.api.chat.onThinkingChunk((text) => dispatch({ type: "thinking_chunk", text }));
    window.api.chat.onToolCall(({ id, name, input }) =>
      dispatch({ type: "tool_call", id, name, input })
    );
    window.api.chat.onToolResult(({ tool_use_id, content, isError }) =>
      dispatch({ type: "tool_result", tool_use_id, content, isError })
    );

    window.api.chat.onDone(({ canUndo: hasVaultOps }) => {
      dispatch({ type: "done", canUndo: hasVaultOps });
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
    setAddAllHiddenAfterUserMessage(true);
    setLoading(true);
    window.api.chat.send(text);
  }

  async function handleUndo(): Promise<void> {
    await window.api.chat.undo();
    dispatch({ type: "undo_confirmed" });
  }

  function handleStop(): void {
    window.api.chat.abort();
    setLoading(false);
  }

  function clear(): void {
    window.api.chat.reset();
    dispatch({ type: "reset" });
    setLoading(false);
    setAddAllToVaultConsumed(false);
    setAddAllHiddenAfterUserMessage(false);
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
    setAddAllToVaultConsumed(false);
    setAddAllHiddenAfterUserMessage(false);
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

  async function handleAddAllToVaultClick(): Promise<void> {
    setAddAllToVaultConsumed(true);
    await onAddAllOverlayToVault();
  }

  const chatStatus: ChatStatus = loading ? (streamingContent ? "streaming" : "submitted") : "ready";
  const mapOverlayCount = mapOverlayFeatureCount(mapOverlay);
  const showAddAllToVaultRow =
    mapOverlayCount > 0 && !addAllToVaultConsumed && !addAllHiddenAfterUserMessage;

  return (
    <Sidebar side="right" collapsible="offcanvas" variant="floating">
      <SidebarHeader className="flex-row items-center justify-between px-3 py-2">
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

            {messages.map((msg, i) => {
              return msg.role === "error" ? (
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
                    <div className="w-full flex flex-col gap-2">
                      {msg.toolCalls.map((tc) =>
                        VAULT_FILE_TOOLS.has(tc.name) ? (
                          <FileChangeRow key={tc.id} call={tc} onOpenFile={onOpenFile} />
                        ) : (
                          <ToolCallRow key={tc.id} call={tc} />
                        )
                      )}
                    </div>
                  )}
                  {msg.content && (
                    <MessageContent>
                      <MessageResponse>{msg.content}</MessageResponse>
                    </MessageContent>
                  )}
                </Message>
              );
            })}

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
                    {activeToolCalls.map((tc) =>
                      VAULT_FILE_TOOLS.has(tc.name) ? (
                        <FileChangeRow key={tc.id} call={tc} onOpenFile={onOpenFile} />
                      ) : (
                        <ToolCallRow key={tc.id} call={tc} />
                      )
                    )}
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

      <SidebarFooter className="px-3 pb-3 pt-0 pointer-events-auto">
        {(canUndo || showAddAllToVaultRow) && (
          <div className="flex flex-col gap-2 pt-2">
            {canUndo && (
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  className={overlayActionButtonClass}
                  onClick={() => void handleUndo()}
                >
                  <Undo2Icon className="size-3.5" />
                  Undo
                </Button>
              </div>
            )}
            {showAddAllToVaultRow && (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  {mapOverlayCount} feature{mapOverlayCount === 1 ? "" : "s"} on map
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className={overlayActionButtonClass}
                  disabled={addAllOverlayBusy}
                  onClick={() => void handleAddAllToVaultClick()}
                >
                  {addAllOverlayBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <FilePlusIcon className="size-3.5" />
                  )}
                  Add all to vault
                </Button>
              </div>
            )}
          </div>
        )}
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

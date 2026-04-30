import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from "@mapos/ui/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@mapos/ui/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea
} from "@mapos/ui/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from "@mapos/ui/components/ai-elements/reasoning";
import { Shimmer } from "@mapos/ui/components/ai-elements/shimmer";
import { Button } from "@mapos/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { cn } from "@mapos/ui/lib/utils";
import type { ConversationMeta, MapOverlayPayload } from "@shared/types";
import type { ChatStatus } from "ai";
import { diffLines } from "diff";
import {
  ArrowRightIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  FilePlusIcon,
  FileX2Icon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PencilIcon,
  Undo2Icon,
  XIcon
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ActiveToolCall, ConvChatState } from "../hooks/use-chat-store";
import { FolderPickerPopover } from "./folder-picker-popover";

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
  return name.replace(/^mcp__[^_]+(?:__[^_]+)*?__/, "").replace(/_/g, " ");
}

/** One-line preview of the operative argument so generic labels like "Running Command" show what's actually running. */
function toolPreview(call: ActiveToolCall): string | null {
  const input = call.input;
  if (!input || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = fields[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  switch (call.name) {
    case "Bash":
      return str("command")?.split("\n")[0] ?? null;
    case "Read":
      return str("file_path");
    case "Glob":
      return str("pattern");
    case "Grep":
      return str("pattern");
    case "WebFetch":
      return str("url");
    case "WebSearch":
      return str("query");
    case "mcp__mapos__pan_to": {
      const lat = fields.lat;
      const lng = fields.lng;
      return typeof lat === "number" && typeof lng === "number"
        ? `${lat.toFixed(4)}, ${lng.toFixed(4)}`
        : null;
    }
    default:
      return null;
  }
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
  | { id: number; kind: "added"; text: string }
  | { id: number; kind: "removed"; text: string }
  | { id: number; kind: "context"; text: string }
  | { id: number; kind: "ellipsis" };

function flattenDiffParts(parts: ReturnType<typeof diffLines>): DiffLineItem[] {
  const items: DiffLineItem[] = [];
  let nextId = 0;
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    if (part.added) {
      for (const line of lines) items.push({ id: nextId++, kind: "added", text: line });
    } else if (part.removed) {
      for (const line of lines) items.push({ id: nextId++, kind: "removed", text: line });
    } else {
      const hasContent = lines.some((l) => l !== "");
      if (hasContent && items.length > 0 && items[items.length - 1].kind !== "ellipsis") {
        items.push({ id: nextId++, kind: "ellipsis" });
      }
    }
  }
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

      {showDiff && (
        <div className="mb-1 rounded border border-sidebar-border/60 bg-sidebar-accent/30 overflow-hidden">
          <pre className="font-mono text-[11px] leading-relaxed !m-0">
            {visibleLines.map((item) => (
              <DiffLineView key={item.id} item={item} />
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
  const preview = toolPreview(call);

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
        <span className="capitalize shrink-0">{toolLabel(call.name)}</span>
        {preview && (
          <span className="min-w-0 truncate text-left font-mono text-xs text-muted-foreground/50">
            {preview}
          </span>
        )}
        {hasDetail && (
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform ml-auto",
              expanded ? "rotate-180" : "rotate-0"
            )}
          />
        )}
      </button>
      {expanded && hasDetail && (
        <div className="mb-1 rounded border border-sidebar-border/60 bg-sidebar-accent/30 text-xs font-mono overflow-hidden mt-2">
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

function mapOverlayFeatureCount(o: MapOverlayPayload): number {
  return o.points.length + o.lines.length + o.polygons.length;
}

const overlayActionButtonClass = "shrink-0 h-7 text-xs gap-1 font-normal";

export function ChatPane({
  convId,
  convState,
  onSubmit,
  onAbort,
  onUndo,
  onClearOverlay,
  onOpenFile,
  onSwitchConv,
  onNewChat,
  onDeleted,
  mapOverlay,
  mapOverlayNonce,
  onAddAllOverlayToVault,
  addAllOverlayBusy,
  defaultParentFolderPath
}: {
  convId: string;
  convState: ConvChatState;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onUndo: () => void;
  onClearOverlay: () => void;
  onOpenFile: (filePath: string) => void;
  /** Replace the current tab with a different conversation. */
  onSwitchConv: (convId: string, title: string) => void;
  /** Open a fresh chat tab. */
  onNewChat: () => void;
  /** Called after the active conversation has been deleted on disk. */
  onDeleted: (convId: string) => void;
  mapOverlay: MapOverlayPayload;
  /** Increments when the map receives a new non-empty overlay (resets Add-all visibility). */
  mapOverlayNonce: number;
  onAddAllOverlayToVault: (parentFolderPath: string | null) => void | Promise<void>;
  addAllOverlayBusy: boolean;
  /** Folder pre-selected as the default destination in the folder picker. */
  defaultParentFolderPath: string | null;
}): React.JSX.Element {
  const {
    messages,
    streamingContent,
    streamingThinking,
    activeToolCalls,
    assistantPending,
    canUndo
  } = convState;
  const loading =
    assistantPending ||
    streamingContent !== "" ||
    streamingThinking !== "" ||
    activeToolCalls.length > 0;

  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  /** Hide Add all after the user sends a message (until a new map overlay bumps nonce). */
  const [addAllHiddenAfterUserMessage, setAddAllHiddenAfterUserMessage] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  // Refresh the recent-chats list when the user opens this tab and on each conversation done.
  useEffect(() => {
    void window.api.chat.listConversations().then((convos) => {
      setConversations(convos.slice().reverse());
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh after each turn completes
  useEffect(() => {
    if (!assistantPending && messages.length > 0) {
      void window.api.chat.listConversations().then((convos) => {
        setConversations(convos.slice().reverse());
      });
    }
  }, [assistantPending]);

  // Reset Add-all visibility when the map receives a new overlay (parent bumps nonce).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional subscription to mapOverlayNonce only
  useEffect(() => {
    setAddAllHiddenAfterUserMessage(false);
  }, [mapOverlayNonce]);

  function handleSubmit({ text }: { text: string }): void {
    if (!text.trim() || loading) return;
    setAddAllHiddenAfterUserMessage(true);
    onSubmit(text);
  }

  async function handleAddAllToVault(folderPath: string | null): Promise<void> {
    await onAddAllOverlayToVault(folderPath);
    onClearOverlay();
  }

  async function handleDeleteConversation(): Promise<void> {
    await window.api.chat.deleteConversation(convId);
    onDeleted(convId);
  }

  const chatStatus: ChatStatus = loading ? (streamingContent ? "streaming" : "submitted") : "ready";
  const mapOverlayCount = mapOverlayFeatureCount(mapOverlay);
  const showAddAllToVaultRow = mapOverlayCount > 0 && !addAllHiddenAfterUserMessage;
  /** Pre-chunk gap: request is in flight but nothing has appeared in the transcript yet. */
  const awaitingFirstToken =
    assistantPending &&
    streamingThinking === "" &&
    streamingContent === "" &&
    activeToolCalls.length === 0;

  return (
    <div className="flex h-full flex-col rounded-lg border border-sidebar-border bg-sidebar shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-1 border-b border-sidebar-border px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="min-w-0 max-w-[180px] justify-start">
                <span className="truncate text-sm font-normal">
                  {conversations.find((c) => c.id === convId)?.preview || "New Chat"}
                </span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-w-[260px] w-full">
            <DropdownMenuItem onClick={onNewChat}>
              <MessageSquarePlusIcon className="size-3.5" />
              New Chat
            </DropdownMenuItem>
            {conversations.length > 0 && <DropdownMenuSeparator />}
            {conversations.map((conv) => (
              <DropdownMenuItem
                key={conv.id}
                onClick={() => onSwitchConv(conv.id, conv.preview || "Chat")}
              >
                <span className="truncate">{conv.preview || "Chat"}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {conversations.some((c) => c.id === convId) && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void handleDeleteConversation()}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <Conversation className="prose prose-sm min-h-0">
        <ConversationContent>
          {messages.length === 0 &&
            !awaitingFirstToken &&
            !streamingThinking &&
            !streamingContent && (
              <ConversationEmptyState
                title=""
                description="Ask about your saved places, notes, or get help organizing your map."
              />
            )}

          {messages.map((msg) => {
            return msg.role === "error" ? (
              <div
                key={msg.id}
                className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {msg.content}
              </div>
            ) : (
              <Message key={msg.id} from={msg.role}>
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

          {awaitingFirstToken && (
            <Message from="assistant">
              <div
                className="flex items-center gap-2 py-0.5 text-sm text-muted-foreground/70 not-prose"
                aria-live="polite"
              >
                <BrainIcon className="size-3.5 shrink-0" aria-hidden />
                <Shimmer as="span" duration={1}>
                  Working on it…
                </Shimmer>
              </div>
            </Message>
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

      <div className="px-3 pb-3 pt-0">
        {(canUndo || showAddAllToVaultRow) && (
          <div className="flex flex-col gap-2 py-2">
            {canUndo && (
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  className={overlayActionButtonClass}
                  onClick={onUndo}
                >
                  <Undo2Icon className="size-3.5" />
                  Undo
                </Button>
              </div>
            )}
            {showAddAllToVaultRow && (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="shrink-0">
                  {mapOverlayCount} feature{mapOverlayCount === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={overlayActionButtonClass}
                    disabled={addAllOverlayBusy}
                    onClick={onClearOverlay}
                  >
                    Clear
                  </Button>
                  <FolderPickerPopover
                    open={folderPickerOpen}
                    onOpenChange={setFolderPickerOpen}
                    defaultParentFolderPath={defaultParentFolderPath}
                    onSelect={(folderPath) => void handleAddAllToVault(folderPath)}
                    trigger={
                      <Button
                        variant="secondary"
                        size="sm"
                        className={overlayActionButtonClass}
                        disabled={addAllOverlayBusy}
                      >
                        {addAllOverlayBusy ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <FilePlusIcon className="size-3.5" />
                        )}
                        Add all to vault
                        <ChevronDownIcon className="size-3" />
                      </Button>
                    }
                  />
                </div>
              </div>
            )}
          </div>
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea placeholder="Message MapOS..." disabled={loading} />
          <PromptInputFooter>
            <div />
            <PromptInputSubmit status={chatStatus} onStop={onAbort} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

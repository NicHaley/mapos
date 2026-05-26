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
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { PulseLoader } from "@mapos/ui/components/pulse-loader";
import { cn } from "@mapos/ui/lib/utils";
import type {
  AssistantMessage as PiAssistantMessage,
  TextContent,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage
} from "@earendil-works/pi-ai";
import type { MapOverlayPayload, PlaceRecord } from "@shared/types";
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
  SparklesIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FeatureMessageProvider,
  FeatureResolverProvider
} from "../contexts/feature-resolver";
import type { ActiveToolCall, ConvChatState } from "../hooks/use-chat-store";
import { FeatureList } from "./feature-list";
import { FolderPickerPopover } from "./folder-picker-popover";

const STREAMDOWN_FEATURES_COMPONENTS = { features: FeatureList };
const STREAMDOWN_FEATURES_ALLOWED_TAGS = { features: ["refs"] };

const VAULT_FILE_TOOLS = new Set([
  "write_vault_file",
  "delete_vault_file",
  "rename_vault_file"
]);

const TOOL_LABELS: Record<string, string> = {
  render_overlay_on_map: "Rendering On Map",
  clear_map_overlay: "Clearing Overlay",
  query_spatial_index: "Querying Vault",
  index_file: "Indexing File",
  rebuild_index: "Rebuilding Index",
  get_viewport: "Getting Viewport",
  pan_to: "Panning Map",
  write_vault_file: "Writing File",
  delete_vault_file: "Deleting File",
  rename_vault_file: "Renaming File",
  web_search: "Searching Web",
  bash: "Running Command",
  read: "Reading File",
  find: "Searching Files",
  grep: "Searching Content",
  ls: "Listing Directory"
};

function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  return name.replace(/_/g, " ");
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
    case "bash":
      return str("command")?.split("\n")[0] ?? null;
    case "read":
    case "ls":
      return str("path");
    case "find":
    case "grep":
      return str("pattern");
    case "web_search":
      return str("query");
    case "pan_to": {
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

function userMessageText(msg: PiUserMessage): string {
  if (typeof msg.content === "string") return msg.content;
  for (const block of msg.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

function toolResultText(msg: PiToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Render one bubble for a run of consecutive `AssistantMessage`s from Pi.
 *
 * Pi splits a single agent turn into multiple `assistant` messages interleaved
 * with `toolResult` messages — text, then tool calls, then more text after the
 * results come back. Rendering each one as its own bubble visually fragments a
 * turn that the user perceives as a single response, so we merge the content
 * blocks across the group into one bubble (matching the live-streaming UX).
 */
function AssistantBubble({
  msgs,
  toolResultsById,
  overlaySnapshot,
  onOpenFile
}: {
  msgs: PiAssistantMessage[];
  toolResultsById: Map<string, PiToolResultMessage>;
  overlaySnapshot: MapOverlayPayload | null;
  onOpenFile: (filePath: string) => void;
}): React.JSX.Element | null {
  let text = "";
  let thinking = "";
  const toolCalls: ActiveToolCall[] = [];

  for (const msg of msgs) {
    for (const block of msg.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "thinking") {
        thinking += block.thinking;
      } else if (block.type === "toolCall") {
        const result = toolResultsById.get(block.id);
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.arguments,
          ...(result
            ? {
                result: toolResultText(result),
                isError: result.isError,
                status: result.isError ? ("error" as const) : ("done" as const)
              }
            : { status: "done" as const })
        });
      }
    }
  }

  if (!text && !thinking && toolCalls.length === 0) return null;

  return (
    <Message from="assistant">
      {thinking && (
        <Reasoning>
          <ReasoningTrigger />
          <ReasoningContent>{thinking}</ReasoningContent>
        </Reasoning>
      )}
      {toolCalls.length > 0 && (
        <div className="w-full flex flex-col gap-2">
          {toolCalls.map((tc) =>
            VAULT_FILE_TOOLS.has(tc.name) ? (
              <FileChangeRow key={tc.id} call={tc} onOpenFile={onOpenFile} />
            ) : (
              <ToolCallRow key={tc.id} call={tc} />
            )
          )}
        </div>
      )}
      {text && (
        <MessageContent>
          <FeatureMessageProvider overlaySnapshot={overlaySnapshot}>
            <MessageResponse
              components={STREAMDOWN_FEATURES_COMPONENTS}
              allowedTags={STREAMDOWN_FEATURES_ALLOWED_TAGS}
            >
              {text}
            </MessageResponse>
          </FeatureMessageProvider>
        </MessageContent>
      )}
    </Message>
  );
}

const overlayActionButtonClass = "shrink-0 h-7 text-xs gap-1 font-normal";

export function ChatPane({
  convId,
  convTitle,
  convState,
  onSubmit,
  onAbort,
  onUndo,
  onClearOverlay,
  onOpenFile,
  onClose,
  onDeleted,
  mapOverlay,
  mapOverlayNonce,
  onAddAllOverlayToVault,
  addAllOverlayBusy,
  isSavedConversation,
  defaultParentFolderPath,
  placesByPath,
  selectedFilePath,
  onOpenFeature
}: {
  convId: string;
  /** Display name for the active conversation (preview text or "New Chat" before first message). */
  convTitle: string;
  convState: ConvChatState;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onUndo: () => void;
  onClearOverlay: () => void;
  onOpenFile: (filePath: string) => void;
  /** Close the chat pane without deleting the conversation. */
  onClose: () => void;
  /** Called after the active conversation has been deleted on disk. */
  onDeleted: (convId: string) => void;
  mapOverlay: MapOverlayPayload;
  /** Increments when the map receives a new non-empty overlay (resets Add-all visibility). */
  mapOverlayNonce: number;
  onAddAllOverlayToVault: (parentFolderPath: string | null) => void | Promise<void>;
  addAllOverlayBusy: boolean;
  /** True once the conversation has been written to disk; gates the delete menu. */
  isSavedConversation: boolean;
  /** Folder pre-selected as the default destination in the folder picker. */
  defaultParentFolderPath: string | null;
  /** Renderer-side mirror of indexed vault places, keyed by file path. Used to resolve `<features vault:...>` refs. */
  placesByPath: Map<string, PlaceRecord>;
  /** File path of the currently-selected place. Used to highlight matching `<features>` rows. */
  selectedFilePath: string | null;
  /** Open a feature; when restoreOverlay is provided, replay it before opening. */
  onOpenFeature: (place: PlaceRecord, restoreOverlay?: MapOverlayPayload) => void;
}): React.JSX.Element {
  const {
    messages,
    overlaySnapshots,
    streamingContent,
    streamingThinking,
    activeToolCalls,
    assistantPending,
    canUndo
  } = convState;

  /** Build once per render so AssistantBubble can pair each ToolCall block with its result. */
  const toolResultsById = useMemo(() => {
    const m = new Map<string, PiToolResultMessage>();
    for (const row of messages) {
      if (row.role === "toolResult") m.set(row.toolCallId, row);
    }
    return m;
  }, [messages]);
  const loading =
    assistantPending ||
    streamingContent !== "" ||
    streamingThinking !== "" ||
    activeToolCalls.length > 0;

  /** Hide Add all after the user sends a message (until a new map overlay bumps nonce). */
  const [addAllHiddenAfterUserMessage, setAddAllHiddenAfterUserMessage] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  /** undefined while loading; null when configured. */
  const [aiConfigured, setAiConfigured] = useState<boolean | undefined>(undefined);

  const refreshAiStatus = useCallback(async () => {
    const status = await window.api.aiConfig.getStatus();
    setAiConfigured(status.configured);
  }, []);

  useEffect(() => {
    void refreshAiStatus();
    // Refresh whenever the user saves the AI tab in Settings.
    return window.api.aiConfig.onChanged(() => {
      void refreshAiStatus();
    });
  }, [refreshAiStatus]);

  function openAiSettings(): void {
    window.dispatchEvent(
      new CustomEvent("mapos:open-settings", { detail: { section: "ai" } })
    );
  }

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

  const featureResolverValue = useMemo(
    () => ({
      getPlace: (filePath: string) => placesByPath.get(filePath),
      liveOverlay: mapOverlay,
      selectedFilePath,
      onOpenFeature
    }),
    [placesByPath, mapOverlay, selectedFilePath, onOpenFeature]
  );

  return (
    <FeatureResolverProvider value={featureResolverValue}>
    <div className="flex h-full flex-col rounded-lg ring-1 ring-sidebar-border bg-sidebar/95 backdrop-blur-md shadow-sm overflow-hidden">
      <div className="flex min-h-12 items-center justify-between gap-1 px-3 py-2">
        <span className="truncate px-2 text-sm font-normal">{convTitle}</span>
        <div className="flex items-center gap-1">
          {isSavedConversation && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void handleDeleteConversation()}
                >
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <XIcon />
          </Button>
        </div>
      </div>

      <Conversation className="min-h-0">
        <ConversationContent>
          {aiConfigured === false && messages.length === 0 && (
            <div className="mx-2 my-3 flex flex-col items-start gap-3 rounded-lg border border-dashed bg-sidebar-accent/30 px-4 py-5">
              <div className="flex items-center gap-2">
                <SparklesIcon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Connect AI to start chatting</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Bring your own Anthropic key or run a local model with Ollama.
              </p>
              <Button size="sm" onClick={openAiSettings}>
                Open AI settings
              </Button>
            </div>
          )}
          {aiConfigured !== false &&
            messages.length === 0 &&
            !awaitingFirstToken &&
            !streamingThinking &&
            !streamingContent && (
              <ConversationEmptyState
                title=""
                description="Ask about your saved places, notes, or get help organizing your map."
              />
            )}

          {(() => {
            // Walk the message list and merge consecutive assistant messages
            // (toolResult rows between them don't break the group) into a
            // single bubble. User and error rows flush the group.
            const rendered: React.JSX.Element[] = [];
            let group: PiAssistantMessage[] = [];

            const flush = (): void => {
              if (group.length === 0) return;
              const last = group[group.length - 1];
              if (!last) {
                group = [];
                return;
              }
              rendered.push(
                <AssistantBubble
                  key={`assistant_${group[0]?.timestamp}_${rendered.length}`}
                  msgs={group}
                  toolResultsById={toolResultsById}
                  overlaySnapshot={overlaySnapshots[last.timestamp] ?? null}
                  onOpenFile={onOpenFile}
                />
              );
              group = [];
            };

            for (let idx = 0; idx < messages.length; idx++) {
              const msg = messages[idx];
              if (!msg) continue;
              if (msg.role === "assistant") {
                group.push(msg);
                continue;
              }
              if (msg.role === "toolResult") continue;
              flush();
              if (msg.role === "error") {
                rendered.push(
                  <div
                    key={msg.id}
                    className="flex flex-col gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                    {msg.reconfigureProvider === "ai" && (
                      <button
                        type="button"
                        onClick={openAiSettings}
                        className="self-start text-xs font-medium text-destructive underline-offset-2 hover:underline"
                      >
                        Reconfigure →
                      </button>
                    )}
                  </div>
                );
              } else if (msg.role === "user") {
                rendered.push(
                  <Message key={`${msg.timestamp}_${idx}`} from="user">
                    <MessageContent>
                      <MessageResponse>{userMessageText(msg)}</MessageResponse>
                    </MessageContent>
                  </Message>
                );
              }
            }
            flush();
            return rendered;
          })()}

          {awaitingFirstToken && (
            <Message from="assistant">
              <div
                className="flex items-center gap-2 py-0.5 text-sm text-muted-foreground/70 not-prose"
                aria-live="polite"
              >
                <PulseLoader color="text-muted-foreground/70" />
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
                  <FeatureMessageProvider overlaySnapshot={null}>
                    <MessageResponse
                      isAnimating
                      components={STREAMDOWN_FEATURES_COMPONENTS}
                      allowedTags={STREAMDOWN_FEATURES_ALLOWED_TAGS}
                    >
                      {streamingContent}
                    </MessageResponse>
                  </FeatureMessageProvider>
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
          <PromptInputTextarea
            placeholder={
              aiConfigured === false ? "Connect AI in Settings to start chatting" : "Message MapOS..."
            }
            disabled={loading || aiConfigured === false}
          />
          <PromptInputFooter>
            <div />
            <PromptInputSubmit status={chatStatus} onStop={onAbort} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
    </FeatureResolverProvider>
  );
}

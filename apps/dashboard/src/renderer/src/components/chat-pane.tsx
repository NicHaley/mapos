import type {
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
  TextContent
} from "@earendil-works/pi-ai";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import { Button } from "@mapos/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { PulseLoader } from "@mapos/ui/components/pulse-loader";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { ErrorTooltip } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import type { AiState } from "@shared/ai-providers";
import type { MapOverlayLayer, PlaceRecord } from "@shared/types";
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
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeatureResolverProvider, useFeatureResolver } from "../contexts/feature-resolver";
import { type ActiveToolCall, type ChatStore, useConvChatState } from "../hooks/use-chat-store";
import { FeatureList } from "./feature-list";
import { FolderPickerPopover } from "./folder-picker-popover";
import { ModelSwitcher } from "./settings/providers/model-switcher";

const STREAMDOWN_FEATURES_COMPONENTS = { features: FeatureList };
const STREAMDOWN_FEATURES_ALLOWED_TAGS = { features: ["refs"] };

const VAULT_FILE_TOOLS = new Set(["write_vault_file", "delete_vault_file", "rename_vault_file"]);

const TOOL_LABELS: Record<string, string> = {
  present_features: "Showing Features",
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
              "size-3.5 shrink-0 transition-transform",
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

type LayerActions = {
  /** Add this layer's ad-hoc features to the vault. The overlay stays on the map. */
  onAddLayerToVault: (layer: MapOverlayLayer, parentFolderPath: string | null) => Promise<void>;
  /** Default destination folder for the add-to-vault picker. */
  defaultParentFolderPath: string | null;
};

/** First `overlay:` ref in a refs string → its owning layer id (the prefix before `:`). */
function layerIdFromRefs(refs: string, layers: MapOverlayLayer[]): MapOverlayLayer | null {
  const overlayEntry = refs
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("overlay:"));
  if (!overlayEntry) return null;
  const id = overlayEntry.slice("overlay:".length);
  return layers.find((l) => id === l.id || id.startsWith(`${l.id}:`)) ?? null;
}

/** Per-card footer: add the layer's ad-hoc features to the vault. */
function FeatureCardActions({
  layer,
  onAddLayerToVault,
  defaultParentFolderPath
}: { layer: MapOverlayLayer } & LayerActions): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const count = layer.points.length + layer.lines.length + layer.polygons.length;
  if (count === 0) return null;

  async function handleAdd(folderPath: string | null): Promise<void> {
    setBusy(true);
    try {
      await onAddLayerToVault(layer, folderPath);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <FolderPickerPopover
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        defaultParentFolderPath={defaultParentFolderPath}
        onSelect={(folderPath) => void handleAdd(folderPath)}
        trigger={
          <Button variant="ghost" size="sm" className={overlayActionButtonClass} disabled={busy}>
            {busy ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <FilePlusIcon className="size-3.5" />
            )}
            Add {count} to vault
            <ChevronDownIcon className="size-3" />
          </Button>
        }
      />
    </div>
  );
}

/**
 * Render a `present_features` tool call as the connected FeatureList plus a
 * footer to add its result set to the vault or remove it from the map. The tool
 * returns `{ kind: "feature_list", refs }`; refs resolve against the live layers
 * (same FeatureList used by inline `<features>` tags). While the call is still
 * running (or if the result can't be parsed) fall back to the generic
 * ToolCallRow so the user sees its status.
 */
function PresentFeaturesCard({
  call,
  actions
}: {
  call: ActiveToolCall;
  actions: LayerActions;
}): React.JSX.Element {
  const { overlayLayers } = useFeatureResolver();
  const refs = useMemo(() => {
    if (!call.result) return null;
    try {
      const parsed = JSON.parse(call.result) as { refs?: unknown };
      return typeof parsed.refs === "string" && parsed.refs.length > 0 ? parsed.refs : null;
    } catch {
      return null;
    }
  }, [call.result]);
  const layer = useMemo(
    () => (refs ? layerIdFromRefs(refs, overlayLayers) : null),
    [refs, overlayLayers]
  );

  if (call.status === "error" || !refs) return <ToolCallRow call={call} />;
  return (
    <div className="flex w-full flex-col">
      <FeatureList refs={refs} />
      {layer && <FeatureCardActions layer={layer} {...actions} />}
    </div>
  );
}

/** Pick the right renderer for a tool call in the assistant bubble. */
function ToolCallView({
  call,
  onOpenFile
}: {
  call: ActiveToolCall;
  onOpenFile: (filePath: string) => void;
}): React.JSX.Element {
  if (VAULT_FILE_TOOLS.has(call.name)) return <FileChangeRow call={call} onOpenFile={onOpenFile} />;
  return <ToolCallRow call={call} />;
}

/**
 * Split a turn's tool calls into the `present_features` cards (rendered as the
 * connected list, placed AFTER the assistant's synthesis text) and everything
 * else (rendered as rows ABOVE the text). Keeping the list below the prose makes
 * "Here are some spots near home:" read as the intro to its own card instead of
 * a detached block up in the tool-call area.
 */
function splitFeatureCalls(calls: ActiveToolCall[]): {
  featureCalls: ActiveToolCall[];
  otherCalls: ActiveToolCall[];
} {
  const featureCalls: ActiveToolCall[] = [];
  const otherCalls: ActiveToolCall[] = [];
  for (const c of calls) (c.name === "present_features" ? featureCalls : otherCalls).push(c);
  return { featureCalls, otherCalls };
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
  onOpenFile,
  layerActions
}: {
  msgs: PiAssistantMessage[];
  toolResultsById: Map<string, PiToolResultMessage>;
  onOpenFile: (filePath: string) => void;
  layerActions: LayerActions;
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

  const { featureCalls, otherCalls } = splitFeatureCalls(toolCalls);

  return (
    <Message from="assistant">
      {thinking && (
        <Reasoning>
          <ReasoningTrigger />
          <ReasoningContent>{thinking}</ReasoningContent>
        </Reasoning>
      )}
      {otherCalls.length > 0 && (
        <div className="w-full flex flex-col gap-2">
          {otherCalls.map((tc) => (
            <ToolCallView key={tc.id} call={tc} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
      {text && (
        <MessageContent>
          <MessageResponse
            components={STREAMDOWN_FEATURES_COMPONENTS}
            allowedTags={STREAMDOWN_FEATURES_ALLOWED_TAGS}
          >
            {text}
          </MessageResponse>
        </MessageContent>
      )}
      {featureCalls.length > 0 && (
        <div className="w-full flex flex-col gap-2">
          {featureCalls.map((tc) => (
            <PresentFeaturesCard key={tc.id} call={tc} actions={layerActions} />
          ))}
        </div>
      )}
    </Message>
  );
}

const overlayActionButtonClass = "shrink-0 h-7 text-xs gap-1 font-normal";

export function ChatPane({
  convId,
  convTitle,
  chatStore,
  onSubmit,
  onAbort,
  onUndo,
  onOpenFile,
  onOpenInNewTab,
  onRename,
  onClose,
  onDeleted,
  overlayLayers,
  focusFeature,
  onAddLayerToVault,
  isSavedConversation,
  defaultParentFolderPath,
  placesByPath,
  selectedFilePath,
  onOpenFeature
}: {
  convId: string;
  /** Display name for the active conversation (preview text or "New Chat" before first message). */
  convTitle: string;
  /** The pane subscribes to its own conversation slice, so streaming chunks re-render only this subtree. */
  chatStore: ChatStore;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onUndo: () => void;
  onOpenFile: (filePath: string) => void;
  /** Open this conversation in a new tab. */
  onOpenInNewTab: () => void;
  /** Rename the conversation; resolves with success or an error message. */
  onRename: (title: string) => Promise<{ success: boolean; error?: string }>;
  /** Close the chat pane without deleting the conversation. */
  onClose: () => void;
  /** Called after the active conversation has been deleted on disk. */
  onDeleted: (convId: string) => void;
  /** All accumulated overlay layers; used to resolve `overlay:` refs and per-card actions. */
  overlayLayers: MapOverlayLayer[];
  /** Emphasize one overlay feature on the map (hovered row); null clears focus. */
  focusFeature: (featureId: string | null) => void;
  /** Add a result layer's features to the vault. The overlay stays on the map. */
  onAddLayerToVault: (layer: MapOverlayLayer, parentFolderPath: string | null) => Promise<void>;
  /** True once the conversation has been written to disk; gates the delete menu. */
  isSavedConversation: boolean;
  /** Folder pre-selected as the default destination in the folder picker. */
  defaultParentFolderPath: string | null;
  /** Renderer-side mirror of indexed vault places, keyed by file path. Used to resolve `vault:` refs. */
  placesByPath: Map<string, PlaceRecord>;
  /** File path of the currently-selected place. Used to highlight matching rows. */
  selectedFilePath: string | null;
  /** Open a feature (place card + map). */
  onOpenFeature: (place: PlaceRecord) => void;
}): React.JSX.Element {
  const {
    messages,
    streamingContent,
    streamingThinking,
    activeToolCalls,
    assistantPending,
    canUndo,
    loaded
  } = useConvChatState(chatStore, convId);

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

  // present_features renders as a list card below the streaming text; other tool
  // calls render as rows above it (mirrors AssistantBubble for persisted turns).
  const { featureCalls: streamingFeatureCalls, otherCalls: streamingOtherCalls } =
    splitFeatureCalls(activeToolCalls);

  // null while loading; drives both the in-composer model switcher and the connect-AI prompt.
  const [aiState, setAiState] = useState<AiState | null>(null);

  const refreshAiState = useCallback(async () => {
    setAiState(await window.api.ai.getState());
  }, []);

  useEffect(() => {
    void refreshAiState();
    // Refresh whenever the AI selection changes (Settings, onboarding, or the in-chat switcher).
    return window.api.ai.onChanged(() => {
      void refreshAiState();
    });
  }, [refreshAiState]);

  // Mirror getAiStatus's "usable" check: a selection exists and its provider is still connected.
  const activeAiProvider = aiState?.active
    ? aiState.providers.find((p) => p.id === aiState.active?.providerId)
    : undefined;
  const aiConfigured: boolean | undefined =
    aiState === null ? undefined : !!aiState.active && !!activeAiProvider?.auth.configured;

  function openAiSettings(): void {
    window.dispatchEvent(new CustomEvent("mapos:open-settings", { detail: { section: "ai" } }));
  }

  function handleSubmit({ text }: { text: string }): void {
    if (!text.trim() || loading) return;
    onSubmit(text);
  }

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function handleDeleteConversation(): Promise<void> {
    await window.api.chat.deleteConversation(convId);
    setConfirmingDelete(false);
    onDeleted(convId);
  }

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Set when a cancel or successful commit unmounts the input, so the blur it
  // synthesizes doesn't re-trigger commitRename (which would save a cancelled edit).
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  const startRename = useCallback(() => {
    setRenameDraft(convTitle);
    setRenameError(null);
    setRenaming(true);
  }, [convTitle]);

  const cancelRename = useCallback(() => {
    skipBlurCommitRef.current = true;
    setRenaming(false);
    setRenameError(null);
  }, []);

  const commitRename = useCallback(async () => {
    const draft = renameDraft.trim();
    if (!draft) {
      setRenameError("Title cannot be empty");
      renameInputRef.current?.focus();
      return;
    }
    const result = await onRename(draft);
    if (!result.success) {
      setRenameError(result.error ?? "Rename failed");
      renameInputRef.current?.focus();
      return;
    }
    skipBlurCommitRef.current = true;
    setRenaming(false);
    setRenameError(null);
  }, [renameDraft, onRename]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelRename();
      }
    },
    [commitRename, cancelRename]
  );

  const chatStatus: ChatStatus = loading ? (streamingContent ? "streaming" : "submitted") : "ready";
  /** Pre-chunk gap: request is in flight but nothing has appeared in the transcript yet. */
  const awaitingFirstToken =
    assistantPending &&
    streamingThinking === "" &&
    streamingContent === "" &&
    activeToolCalls.length === 0;

  const featureResolverValue = useMemo(
    () => ({
      getPlace: (filePath: string) => placesByPath.get(filePath),
      overlayLayers,
      selectedFilePath,
      onOpenFeature,
      focusFeature
    }),
    [placesByPath, overlayLayers, selectedFilePath, onOpenFeature, focusFeature]
  );

  const layerActions = useMemo<LayerActions>(
    () => ({ onAddLayerToVault, defaultParentFolderPath }),
    [onAddLayerToVault, defaultParentFolderPath]
  );

  return (
    <FeatureResolverProvider value={featureResolverValue}>
      <div
        className={cn(
          surfaceVariants({ variant: "panel" }),
          "flex h-full flex-col rounded-lg ring-1 ring-sidebar-border shadow-sm overflow-hidden"
        )}
      >
        <div className="flex min-h-12 items-center justify-between gap-1 p-2">
          {renaming ? (
            <ErrorTooltip error={renameError}>
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(e) => {
                  setRenameDraft(e.target.value);
                  setRenameError(null);
                }}
                onKeyDown={handleRenameKeyDown}
                onBlur={() => {
                  // A cancel/commit already tore down the input; don't double-fire.
                  if (skipBlurCommitRef.current) {
                    skipBlurCommitRef.current = false;
                    return;
                  }
                  void commitRename();
                }}
                className={cn(
                  "min-w-0 flex-1 mx-2 h-6 box-border rounded px-1 text-sm font-normal leading-6",
                  "bg-sidebar-background text-sidebar-foreground border-0 outline-none appearance-none",
                  renameError
                    ? "ring-2 ring-inset ring-destructive"
                    : "ring-2 ring-inset ring-blue-500"
                )}
              />
            </ErrorTooltip>
          ) : (
            <span className="truncate px-2 text-sm font-normal">{convTitle}</span>
          )}
          <div className="flex items-center gap-1">
            {isSavedConversation && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
                  <EllipsisIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                  <DropdownMenuItem onClick={onOpenInNewTab}>
                    <PlusIcon />
                    Open in New Tab
                  </DropdownMenuItem>
                  {chatStatus !== "ready" && (
                    <DropdownMenuItem onClick={onAbort}>
                      <SquareIcon />
                      Stop
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={startRename}>
                    <PencilIcon />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
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

        <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete "{convTitle}".
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => void handleDeleteConversation()}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* `initial="instant"` jumps to the bottom without animating when a conversation
            opens with its messages already in the store. The `key` remount handles the
            lazy-load path: messages arriving after mount would otherwise be a "resize"
            (smooth-scrolled); remounting on `loaded` makes them the initial layout instead. */}
        <Conversation key={loaded ? "loaded" : "loading"} className="min-h-0" initial="instant">
          <ConversationContent>
            {aiConfigured === false && messages.length === 0 && (
              <div className="mx-2 my-3 flex flex-col items-start gap-3 rounded-lg border border-dashed bg-sidebar-accent/30 px-4 py-5">
                <div className="flex items-center gap-2">
                  <SparklesIcon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Connect AI to start chatting</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Setup a cloud provider or run AI locally.
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
                    onOpenFile={onOpenFile}
                    layerActions={layerActions}
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
                {streamingOtherCalls.length > 0 && (
                  <div className="w-full space-y-0.5">
                    {streamingOtherCalls.map((tc) => (
                      <ToolCallView key={tc.id} call={tc} onOpenFile={onOpenFile} />
                    ))}
                  </div>
                )}
                {streamingContent && (
                  <MessageContent>
                    <MessageResponse
                      isAnimating
                      components={STREAMDOWN_FEATURES_COMPONENTS}
                      allowedTags={STREAMDOWN_FEATURES_ALLOWED_TAGS}
                    >
                      {streamingContent}
                    </MessageResponse>
                  </MessageContent>
                )}
                {streamingFeatureCalls.length > 0 && (
                  <div className="w-full flex flex-col gap-2">
                    {streamingFeatureCalls.map((tc) => (
                      <PresentFeaturesCard key={tc.id} call={tc} actions={layerActions} />
                    ))}
                  </div>
                )}
              </Message>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="px-3 pb-3 pt-0">
          {canUndo && (
            <div className="flex justify-end py-2">
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
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputTextarea
              autoFocus
              placeholder={
                aiConfigured === false
                  ? "Connect AI in Settings to start chatting"
                  : "Message MapOS..."
              }
              disabled={loading || aiConfigured === false}
            />
            <PromptInputFooter>
              {aiState ? (
                <ModelSwitcher
                  state={aiState}
                  onSelected={refreshAiState}
                  onConfigure={openAiSettings}
                />
              ) : (
                <div />
              )}
              <PromptInputSubmit status={chatStatus} onStop={onAbort} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </FeatureResolverProvider>
  );
}

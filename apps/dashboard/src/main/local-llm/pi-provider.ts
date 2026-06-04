/**
 * A Pi provider backed by the in-process llama.cpp engine. Pi keeps owning the agent loop, tool
 * execution, and persistence; this only supplies token generation and surfaces the model's tool
 * calls as Pi events. Registering `streamSimple` with a custom `api` makes Pi route models on that
 * api here; the GGUF path is looked up by id (Pi's Model type has nowhere to carry it).
 *
 * Two translations live here: Pi `Context` → node-llama-cpp `ChatHistoryItem[]` (each assistant tool
 * call merged with its matching result), and Pi `Tool[]` → `ChatModelFunctions`.
 */

import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";
import type { ChatHistoryItem, ChatModelFunctions, GbnfJsonSchema } from "node-llama-cpp";
import type { ModelCapabilities } from "../../shared/ai-models";
import { generate, getModelContextInfo } from "./inference";

/** Custom Pi api id for in-process llama.cpp. Open `Api` type accepts arbitrary strings. */
export const MAPOS_LLAMACPP_API: Api = "mapos-llamacpp";
const EMBEDDED_PROVIDER_KEY = "mapos-embedded";

/** modelId → GGUF path. Global because Pi's api provider registration is global. */
const embeddedModelPaths = new Map<string, string>();

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

function userText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function toolResultText(m: ToolResultMessage): string {
  return m.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Translate Pi's conversation into node-llama-cpp chat history, merging tool results into calls. */
function contextToHistory(context: Context): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  if (context.systemPrompt) items.push({ type: "system", text: context.systemPrompt });

  const resultsById = new Map<string, ToolResultMessage>();
  for (const m of context.messages) {
    if (m.role === "toolResult") resultsById.set(m.toolCallId, m);
  }

  for (const m of context.messages) {
    if (m.role === "user") {
      items.push({ type: "user", text: userText(m.content) });
    } else if (m.role === "assistant") {
      const out: Array<string | { type: "functionCall"; name: string; params: unknown; result: unknown }> = [];
      for (const block of m.content) {
        if (block.type === "text") {
          if (block.text) out.push(block.text);
        } else if (block.type === "toolCall") {
          const res = resultsById.get(block.id);
          out.push({
            type: "functionCall",
            name: block.name,
            params: block.arguments,
            result: res ? (res.isError ? { error: toolResultText(res) } : toolResultText(res)) : ""
          });
        }
        // thinking blocks are dropped on replay — local models don't consume them
      }
      if (out.length === 0) out.push("");
      items.push({ type: "model", response: out } as ChatHistoryItem);
    }
    // toolResult rows are folded into the preceding assistant's functionCall above
  }
  return items;
}

/**
 * Make a JSON Schema safe for node-llama-cpp's GBNF layer, which understands `oneOf` but not `anyOf`.
 * typebox emits unions (e.g. `Type.Union` of string literals) as `anyOf`, which reaches GBNF as a
 * node with no `type` and throws "Unknown immutable type undefined" when validating a tool call.
 * Rewriting `anyOf` → `oneOf` is equivalent for the disjoint members tool schemas use. Returns a deep
 * copy so the original schema (used unchanged on the cloud path) isn't mutated.
 */
function toGbnfSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGbnfSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "anyOf" && Array.isArray(value)) out.oneOf = value.map(toGbnfSchema);
    else out[key] = toGbnfSchema(value);
  }
  return out;
}

function toolsToFunctions(tools?: Tool[]): ChatModelFunctions | undefined {
  if (!tools || tools.length === 0) return undefined;
  const fns: Record<string, { description?: string; params?: GbnfJsonSchema }> = {};
  for (const t of tools) {
    fns[t.name] = { description: t.description, params: toGbnfSchema(t.parameters) as GbnfJsonSchema };
  }
  return fns as ChatModelFunctions;
}

/**
 * Pi StreamFunction backed by the in-process engine. Emits the event protocol Pi expects:
 * `start` → text_start/delta/end and/or toolcall_start/end → `done` (or `error`).
 */
function maposLlamacppStream(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  const base = (): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: "stop",
    timestamp: Date.now()
  });

  void (async () => {
    const partial = base();
    stream.push({ type: "start", partial });

    const path = embeddedModelPaths.get(model.id);
    if (!path) {
      const error = base();
      error.stopReason = "error";
      error.errorMessage = `Embedded model "${model.id}" has no downloaded file registered.`;
      stream.push({ type: "error", reason: "error", error });
      stream.end(error);
      return;
    }

    try {
      let textStarted = false;
      const textBlock: TextContent = { type: "text", text: "" };

      const result = await generate({
        modelPath: path,
        history: contextToHistory(context),
        functions: toolsToFunctions(context.tools),
        signal: options?.signal,
        onText: (delta) => {
          if (!textStarted) {
            textStarted = true;
            partial.content.push(textBlock);
            stream.push({ type: "text_start", contentIndex: 0, partial });
          }
          textBlock.text += delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
        }
      });

      if (textStarted) {
        stream.push({ type: "text_end", contentIndex: 0, content: textBlock.text, partial });
      }

      for (const call of result.toolCalls) {
        const contentIndex = partial.content.length;
        const toolCall: ToolCall = {
          type: "toolCall",
          id: randomUUID(),
          name: call.name,
          arguments: (call.params ?? {}) as Record<string, unknown>
        };
        partial.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex, partial });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
      }

      const reason = result.toolCalls.length > 0 ? "toolUse" : "stop";
      partial.stopReason = reason;
      stream.push({ type: "done", reason, message: partial });
      stream.end(partial);
    } catch (e) {
      const aborted = options?.signal?.aborted === true;
      const error = base();
      error.stopReason = aborted ? "aborted" : "error";
      error.errorMessage = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason: aborted ? "aborted" : "error", error });
      stream.end(error);
    }
  })();

  return stream;
}

/**
 * Register the embedded model on a session's ModelRegistry and return the resolved Pi Model.
 *
 * Loads the model and allocates its context up front, then advertises the *actual* allocated context
 * size to Pi (not a cap or catalog guess) so Pi's compaction stays aligned with what llama.cpp holds.
 * The load also warms the cache the first `generate` reuses.
 */
export async function registerEmbeddedModel(
  modelRegistry: ModelRegistry,
  args: { id: string; path: string; label: string; capabilities: ModelCapabilities }
): Promise<Model<Api> | undefined> {
  embeddedModelPaths.set(args.id, args.path);
  const { contextSize } = await getModelContextInfo(args.path);
  // `baseUrl` + `apiKey` are unused (inference is in-process) but Pi's ModelRegistry *requires* both
  // when a provider defines models — placeholders satisfy validation; our streamSimple ignores them.
  modelRegistry.registerProvider(EMBEDDED_PROVIDER_KEY, {
    name: "Local AI",
    baseUrl: "http://localhost",
    apiKey: "local",
    api: MAPOS_LLAMACPP_API,
    streamSimple: maposLlamacppStream,
    models: [
      {
        id: args.id,
        name: args.label,
        api: MAPOS_LLAMACPP_API,
        baseUrl: "http://localhost",
        reasoning: args.capabilities.thinking !== "off",
        input: args.capabilities.supportsImages ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextSize,
        maxTokens: 4096
      }
    ]
  });
  return modelRegistry.find(EMBEDDED_PROVIDER_KEY, args.id);
}

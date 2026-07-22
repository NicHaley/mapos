import type { Static, TSchema } from "typebox";

// Minimal, framework-agnostic tool contract. Previously the tools were defined against the
// Pi SDK's `ToolDefinition`/`defineTool`; the Pi agent loop is gone, so this local shape keeps
// the tool implementations (see mcp-server.ts) reusable by the future MCP server without the
// SDK dependency. It intentionally covers only the fields the MapOS tools actually use.

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

/**
 * MCP tool behavior hints (mirrors the spec's `ToolAnnotations`). Advisory only —
 * clients use them to decide what to gate, but must treat them as untrusted claims,
 * so they are defense-in-depth, never the primary access control.
 */
export interface ToolAnnotations {
  /** Display name for the tool. */
  title?: string;
  /** True if the tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** For non-read-only tools: may it perform irreversible/destructive updates? */
  destructiveHint?: boolean;
  /** Repeated calls with the same args have no additional effect. */
  idempotentHint?: boolean;
  /** True if the tool interacts with external entities (network/services). */
  openWorldHint?: boolean;
}

export interface ToolDefinition<TParams extends TSchema = TSchema> {
  /** Tool name (used in LLM tool calls). */
  name: string;
  /** Human-readable label for UI. */
  label: string;
  /** Description for the LLM. */
  description: string;
  /** Parameter schema (TypeBox). */
  parameters: TParams;
  /** MCP behavior hints, forwarded to the client on tools/list. */
  annotations?: ToolAnnotations;
  /** Execute the tool. */
  execute(toolCallId: string, params: Static<TParams>, signal?: AbortSignal): Promise<ToolResult>;
}

// `ToolDefinition<any>` erases the parameter type so a heterogeneous list of tools (each with
// its own schema) satisfies `ToolDefinition[]` — mirrors the Pi SDK's `AnyToolDefinition` trick.
// biome-ignore lint/suspicious/noExplicitAny: intentional erasure so tools compose into a list.
type AnyToolDefinition = ToolDefinition<any>;

export function defineTool<TParams extends TSchema>(
  tool: ToolDefinition<TParams>
): ToolDefinition<TParams> & AnyToolDefinition {
  return tool as ToolDefinition<TParams> & AnyToolDefinition;
}

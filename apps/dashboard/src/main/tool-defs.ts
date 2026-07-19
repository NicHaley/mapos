import type { Static, TSchema } from "typebox";

// Minimal, framework-agnostic tool contract. Previously the tools were defined against the
// Pi SDK's `ToolDefinition`/`defineTool`; the Pi agent loop is gone, so this local shape keeps
// the tool implementations (see mcp-server.ts) reusable by the future MCP server without the
// SDK dependency. It intentionally covers only the fields the MapOS tools actually use.

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
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

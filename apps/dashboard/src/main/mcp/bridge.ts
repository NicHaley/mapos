import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "../tool-defs";

/**
 * Wire MapOS's tool set onto a low-level MCP `Server`. `getTools` is read on every request so
 * the active (vault-scoped) tool set can be swapped without re-registering handlers.
 *
 * The mapping is deliberately thin: TypeBox parameter schemas are already valid JSON Schema, so
 * they pass straight through as `inputSchema`, and `ToolResult.content` already matches MCP's
 * `{ type: "text", text }` content shape.
 */
export function registerMaposTools(server: Server, getTools: () => ToolDefinition[]): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getTools().map((t) => ({
      name: t.name,
      description: t.description,
      // TypeBox `Type.Object(...)` is a JSON Schema object at runtime.
      inputSchema: t.parameters as { type: "object" } & Record<string, unknown>
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getTools().find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      // Tools take a call id (some use it as a unique overlay-layer id); a random id per call
      // keeps accumulated layers distinct.
      const result = await tool.execute(randomUUID(), args ?? {});
      return { content: result.content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  });
}

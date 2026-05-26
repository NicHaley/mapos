import { WebSearchRequestSchema, WebSearchResponseSchema } from "@mapos/contracts";
import { tavilyAdapter } from "@mapos/service-adapters";
import type { Hono } from "hono";
import { loadEnv } from "../env";
import { errorResponse } from "../errors";
import { handleContractPost } from "../route-helpers";

export function registerWebSearch(app: Hono): void {
  app.post("/v1/web-search", (c) => {
    const env = loadEnv(c.env);
    const apiKey = env.TAVILY_API_KEY;
    if (!apiKey) {
      return errorResponse(c, "server_misconfigured", "TAVILY_API_KEY is required for web search");
    }
    return handleContractPost(c, WebSearchRequestSchema, WebSearchResponseSchema, (req, signal) =>
      tavilyAdapter.webSearch.search(
        req,
        { url: env.TAVILY_URL, auth: { type: "bearer", value: apiKey } },
        { signal }
      )
    );
  });
}

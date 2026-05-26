/**
 * Web search contract. There is no community adapter — every plausible provider
 * requires a key that can't ship in the desktop — so web search runs server-side
 * only. The `tavily` adapter in `@mapos/service-adapters` satisfies this contract,
 * and the MapOS server exposes it at `POST /v1/web-search` (the server holds the
 * key as a secret). These schemas keep the server, adapter, and any future client
 * agreed on the wire shape.
 */

import { z } from "zod";

export const WebSearchRequestSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).optional(),
  recency: z.enum(["day", "week", "month", "year"]).optional()
});
export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;

export const WebSearchResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  /** ISO-8601 timestamp when the page was published, if the provider exposes it. */
  publishedAt: z.string().optional()
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const WebSearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(WebSearchResultSchema)
});
export type WebSearchResponse = z.infer<typeof WebSearchResponseSchema>;

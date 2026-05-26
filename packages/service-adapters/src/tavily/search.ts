import type { Endpoint, WebSearchRequest, WebSearchResponse } from "@mapos/contracts";
import { z } from "zod";
import { fetchJson } from "../http";
import type { AdapterContext } from "../types";

const DEFAULT_MAX_RESULTS = 5;

// Tavily's `/search` response. Only the fields we map are declared; Tavily
// returns more (answer, response_time, usage…) which we ignore. `published_date`
// is only populated for `topic: "news"`, so it stays optional.
const TavilyResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number().optional(),
  published_date: z.string().optional()
});

const TavilyResponseSchema = z.object({
  results: z.array(TavilyResultSchema)
});

export async function search(
  req: WebSearchRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<WebSearchResponse> {
  const key = ep.auth?.type === "bearer" ? ep.auth.value : null;
  if (!key) throw new Error("Tavily adapter requires a bearer API key");

  const body = {
    query: req.query,
    max_results: req.maxResults ?? DEFAULT_MAX_RESULTS,
    search_depth: "basic",
    topic: "general",
    // `recency` maps 1:1 onto Tavily's `time_range` (day | week | month | year).
    ...(req.recency ? { time_range: req.recency } : {})
  };

  const data = await fetchJson(
    `${ep.url}/search`,
    TavilyResponseSchema,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${key}` }
    },
    { signal: ctx.signal }
  );

  return {
    query: req.query,
    results: data.results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
      ...(r.published_date ? { publishedAt: r.published_date } : {})
    }))
  };
}

/**
 * Web search has no community adapter — every plausible provider requires a key
 * that can't ship in the desktop. The contract is defined here so the dispatcher
 * and a future server agree on the shape, but no adapter satisfies it in this
 * package yet.
 */

export type WebSearchRequest = {
  query: string;
  maxResults?: number;
  recency?: "day" | "week" | "month" | "year";
};

export type WebSearchResult = {
  url: string;
  title: string;
  snippet: string;
  /** ISO-8601 timestamp when the page was published, if the provider exposes it. */
  publishedAt?: string;
};

export type WebSearchResponse = {
  query: string;
  results: WebSearchResult[];
};

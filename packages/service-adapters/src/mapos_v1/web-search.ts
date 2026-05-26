import {
  type Endpoint,
  type WebSearchRequest,
  type WebSearchResponse,
  WebSearchResponseSchema
} from "@mapos/contracts";
import type { AdapterContext } from "../types";
import { fetchMapos } from "./client";

function tokenFor(ep: Endpoint): string | undefined {
  return ep.auth?.type === "bearer" ? ep.auth.value : undefined;
}

export function search(
  req: WebSearchRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<WebSearchResponse> {
  return fetchMapos(
    `${ep.url}/v1/web-search`,
    WebSearchResponseSchema,
    { method: "POST", body: JSON.stringify(req) },
    { signal: ctx.signal, authToken: tokenFor(ep) }
  );
}

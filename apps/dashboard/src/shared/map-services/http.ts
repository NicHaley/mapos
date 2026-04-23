import { DEFAULT_TIMEOUT_MS, USER_AGENT } from "./config";

export class MapServiceError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodySnippet?: string;

  constructor(message: string, opts: { status: number; url: string; bodySnippet?: string }) {
    super(message);
    this.name = "MapServiceError";
    this.status = opts.status;
    this.url = opts.url;
    this.bodySnippet = opts.bodySnippet;
  }
}

export type FetchJsonOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ctrl = new AbortController();
  const onAbort = (src: AbortSignal): void => {
    ctrl.abort(src.reason);
  };
  if (a.aborted) ctrl.abort(a.reason);
  else a.addEventListener("abort", () => onAbort(a), { once: true });
  if (b.aborted) ctrl.abort(b.reason);
  else b.addEventListener("abort", () => onAbort(b), { once: true });
  return ctrl.signal;
}

const LOG_PREFIX = "[map-services]";

/** Short path+query summary for console logs — avoids echoing full hostnames on every line. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  opts: FetchJsonOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(new Error("timeout")), timeoutMs);

  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = init.method ?? "GET";
  const started = performance.now();
  console.log(`${LOG_PREFIX} → ${method} ${shortUrl(url)}`);

  try {
    const res = await fetch(url, {
      ...init,
      headers,
      signal: combineSignals(opts.signal, timeoutCtrl.signal)
    });
    const elapsedMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.warn(
        `${LOG_PREFIX} ✗ ${method} ${shortUrl(url)} ${res.status} ${res.statusText} in ${elapsedMs}ms`
      );
      throw new MapServiceError(`Request failed: ${res.status} ${res.statusText}`, {
        status: res.status,
        url,
        bodySnippet: bodyText.slice(0, 500)
      });
    }
    console.log(`${LOG_PREFIX} ← ${method} ${shortUrl(url)} ${res.status} in ${elapsedMs}ms`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof MapServiceError) throw err;
    const elapsedMs = Math.round(performance.now() - started);
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} ✗ ${method} ${shortUrl(url)} failed in ${elapsedMs}ms — ${reason}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

import type { BrowserWindow } from "electron";

export type OllamaPullProgress = {
  modelId: string;
  /** 0–100; absent until total is known. */
  percent?: number;
  status?: string;
};

const DETECT_TIMEOUT_MS = 1500;

/** Active pull controllers keyed by `${baseUrl}::${modelId}` so cancelPull can reach them. */
const activePulls = new Map<string, AbortController>();

function pullKey(baseUrl: string, modelId: string): string {
  return `${baseUrl}::${modelId}`;
}

/**
 * Probe the Ollama daemon by hitting `/api/tags`. Returns false on any failure
 * (timeout, ECONNREFUSED, non-2xx) so the renderer can show the install CTA.
 */
export async function detectOllama(baseUrl: string): Promise<{ running: boolean; baseUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    return { running: res.ok, baseUrl };
  } catch {
    return { running: false, baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

export async function listInstalledModels(baseUrl: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull a model from Ollama's registry, streaming NDJSON progress events to the renderer
 * via `ollama:pull-progress`. Resolves when the stream closes; throws on transport failure.
 */
export async function pullModel(
  mainWindow: BrowserWindow,
  baseUrl: string,
  modelId: string
): Promise<void> {
  const key = pullKey(baseUrl, modelId);
  // Cancel any prior pull for this exact model+endpoint.
  activePulls.get(key)?.abort();
  const controller = new AbortController();
  activePulls.set(key, controller);

  const send = (payload: OllamaPullProgress): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ollama:pull-progress", payload);
    }
  };

  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelId, stream: true }),
      signal: controller.signal
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama pull failed: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as {
              status?: string;
              total?: number;
              completed?: number;
              error?: string;
            };
            if (parsed.error) {
              throw new Error(parsed.error);
            }
            const percent =
              typeof parsed.total === "number" &&
              parsed.total > 0 &&
              typeof parsed.completed === "number"
                ? Math.min(100, Math.round((parsed.completed / parsed.total) * 100))
                : undefined;
            send({ modelId, status: parsed.status, percent });
          } catch (e) {
            if (e instanceof Error && e.message !== "Unexpected end of JSON input") {
              throw e;
            }
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
    send({ modelId, status: "done", percent: 100 });
  } finally {
    activePulls.delete(key);
  }
}

export function cancelPull(baseUrl: string, modelId: string): void {
  const key = pullKey(baseUrl, modelId);
  activePulls.get(key)?.abort();
  activePulls.delete(key);
}

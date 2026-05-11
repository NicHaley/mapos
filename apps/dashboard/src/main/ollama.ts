import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

export type OllamaPullProgress = {
  modelId: string;
  /** 0–100; absent until total is known. */
  percent?: number;
  status?: string;
};

type StoredPendingPull = { baseUrl: string; modelId: string };

export type PendingPull = StoredPendingPull & {
  /**
   * True when the pull is still streaming in this process (not just persisted). The renderer
   * uses this to decide whether to re-issue `pullModel` (false → fresh resume needed) or just
   * hook up its UI to the existing stream (true → restarting would abort progress).
   */
  active: boolean;
};

const DETECT_TIMEOUT_MS = 1500;
const PENDING_PULLS_FILENAME = "ollama-pending-pulls.json";

/** Active pull controllers keyed by `${baseUrl}::${modelId}` so cancelPull can reach them. */
const activePulls = new Map<string, AbortController>();

/** Set once at startup by {@link setupOllamaPersistence}; null until then. */
let appStateDirRef: string | null = null;

/**
 * Wire up the persistence directory for pending pulls. Must be called once during main
 * process init before any pulls are started. Persisting which models are mid-download
 * survives app restarts and computer-sleep network drops so the UI can resume the
 * indicator (Ollama itself keeps the partial bytes on disk and re-pulling resumes).
 */
export function setupOllamaPersistence(appStateDir: string): void {
  appStateDirRef = appStateDir;
}

function pendingPullsPath(): string | null {
  return appStateDirRef ? join(appStateDirRef, PENDING_PULLS_FILENAME) : null;
}

function readPendingPullsFromDisk(): StoredPendingPull[] {
  const p = pendingPullsPath();
  if (!p || !existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is StoredPendingPull =>
        !!e &&
        typeof e === "object" &&
        typeof (e as StoredPendingPull).baseUrl === "string" &&
        typeof (e as StoredPendingPull).modelId === "string"
    );
  } catch {
    return [];
  }
}

function writePendingPullsToDisk(pulls: StoredPendingPull[]): void {
  const p = pendingPullsPath();
  if (!p) return;
  try {
    writeFileSync(p, `${JSON.stringify(pulls, null, 2)}\n`, "utf-8");
  } catch {
    /* best-effort — losing the persistence file just means no resume on restart */
  }
}

function addPendingPull(baseUrl: string, modelId: string): void {
  const cur = readPendingPullsFromDisk();
  if (cur.some((e) => e.baseUrl === baseUrl && e.modelId === modelId)) return;
  cur.push({ baseUrl, modelId });
  writePendingPullsToDisk(cur);
}

function removePendingPull(baseUrl: string, modelId: string): void {
  const cur = readPendingPullsFromDisk();
  const next = cur.filter((e) => !(e.baseUrl === baseUrl && e.modelId === modelId));
  if (next.length !== cur.length) writePendingPullsToDisk(next);
}

/** Snapshot of pulls that should be in progress — survives app restarts. */
export function getPendingPulls(): PendingPull[] {
  return readPendingPullsFromDisk().map((p) => ({
    ...p,
    active: activePulls.has(pullKey(p.baseUrl, p.modelId))
  }));
}

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
  // Record on disk so a crash/sleep/quit mid-download is recoverable; only success
  // and explicit cancel clear it — transient errors keep the entry for next retry.
  addPendingPull(baseUrl, modelId);

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
    removePendingPull(baseUrl, modelId);
  } finally {
    activePulls.delete(key);
  }
}

export function cancelPull(baseUrl: string, modelId: string): void {
  const key = pullKey(baseUrl, modelId);
  activePulls.get(key)?.abort();
  activePulls.delete(key);
  removePendingPull(baseUrl, modelId);
}

/**
 * Remove a pulled model from the Ollama daemon. Frees the disk space immediately —
 * the model has to be re-pulled to use again.
 */
export async function deleteModel(baseUrl: string, modelId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: modelId })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama delete failed: HTTP ${res.status}${text ? `: ${text.slice(0, 240)}` : ""}`);
  }
  removePendingPull(baseUrl, modelId);
}

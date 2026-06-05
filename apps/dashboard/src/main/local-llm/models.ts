/**
 * The embedded model catalog and its on-disk management.
 *
 * A small, curated set of tool-capable GGUFs (the agent is tool-driven, so every model must do
 * function calling) downloaded into `userData/models`. The recommendation is resolved against the
 * machine's memory at runtime. Sizes and filenames were verified against Hugging Face.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { createModelDownloader } from "node-llama-cpp";
import type { ModelCapabilities } from "../../shared/ai-models";
import type {
  DownloadProgress,
  InstalledModel,
  LocalLlmHardware,
  LocalModelCapabilities,
  RecommendedModel
} from "../../shared/local-llm";
import { getLlamaRuntime } from "./engine";
import { unloadModel } from "./inference";

type CatalogEntry = {
  id: string;
  label: string;
  params: string;
  quant: string;
  /** Hugging Face URI the downloader resolves. */
  hfUri: string;
  /** Deterministic on-disk filename (so "installed" checks don't depend on the downloader's naming). */
  fileName: string;
  sizeBytes: number;
  minMemoryGB: number;
  description: string;
  capabilities: LocalModelCapabilities;
};

const GB = 1_000_000_000;

/**
 * Curated, tool-capable models. Q4_K_M is the sweet spot for quality/size on Apple Silicon.
 * Kept deliberately short — a handful of tiers, not a browsable library.
 */
const CATALOG: CatalogEntry[] = [
  {
    id: "qwen2.5-3b",
    label: "Qwen2.5 3B Instruct",
    params: "3B",
    quant: "Q4_K_M",
    hfUri: "hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M",
    fileName: "qwen2.5-3b-instruct.Q4_K_M.gguf",
    sizeBytes: Math.round(1.93 * GB),
    minMemoryGB: 8,
    description: "Small and fast. Solid tool use on modest machines.",
    capabilities: { supportsTools: true, supportsImages: false, thinking: false, contextWindow: 32_768 }
  },
  {
    id: "qwen2.5-7b",
    label: "Qwen2.5 7B Instruct",
    params: "7B",
    quant: "Q4_K_M",
    hfUri: "hf:bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
    fileName: "qwen2.5-7b-instruct.Q4_K_M.gguf",
    sizeBytes: Math.round(4.68 * GB),
    minMemoryGB: 16,
    description: "The balanced default. Strong, reliable tool calling.",
    capabilities: { supportsTools: true, supportsImages: false, thinking: false, contextWindow: 32_768 }
  },
  {
    id: "llama3.1-8b",
    label: "Llama 3.1 8B Instruct",
    params: "8B",
    quant: "Q4_K_M",
    hfUri: "hf:bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M",
    fileName: "llama3.1-8b-instruct.Q4_K_M.gguf",
    sizeBytes: Math.round(4.92 * GB),
    minMemoryGB: 16,
    description: "Meta's 8B. Long 128K context, good general reasoning.",
    capabilities: { supportsTools: true, supportsImages: false, thinking: false, contextWindow: 131_072 }
  },
  {
    id: "qwen2.5-14b",
    label: "Qwen2.5 14B Instruct",
    params: "14B",
    quant: "Q4_K_M",
    hfUri: "hf:bartowski/Qwen2.5-14B-Instruct-GGUF:Q4_K_M",
    fileName: "qwen2.5-14b-instruct.Q4_K_M.gguf",
    sizeBytes: Math.round(8.99 * GB),
    minMemoryGB: 24,
    description: "Most capable. Best quality if you have the memory for it.",
    capabilities: { supportsTools: true, supportsImages: false, thinking: false, contextWindow: 32_768 }
  }
];

const byId = new Map(CATALOG.map((e) => [e.id, e]));
const byFileName = new Map(CATALOG.map((e) => [e.fileName, e]));

/** Where downloaded GGUFs live. Created on demand. */
export function modelsDir(): string {
  const dir = join(app.getPath("userData"), "models");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function modelPath(fileName: string): string {
  return join(modelsDir(), fileName);
}

/** Hardware summary used to size recommendations. */
export async function getHardware(): Promise<LocalLlmHardware> {
  const llama = await getLlamaRuntime();
  const vram = await llama.getVramState();
  return {
    gpu: llama.gpu,
    gpuDeviceNames: await llama.getGpuDeviceNames(),
    totalMemoryGB: Math.round((vram.total / GB) * 10) / 10
  };
}

function installedFileNames(): Set<string> {
  const dir = modelsDir();
  const names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".gguf"));
  return new Set(names);
}

/**
 * The catalog annotated for this machine: which models fit, which single one is the recommended
 * default (the most capable that fits), and which are already installed.
 */
export async function listRecommended(): Promise<RecommendedModel[]> {
  const { totalMemoryGB } = await getHardware();
  const installed = installedFileNames();
  const fitting = CATALOG.filter((e) => e.minMemoryGB <= totalMemoryGB);
  // Recommended = the most capable model that comfortably fits (largest min-memory among fitting).
  const bestId = fitting.reduce<string | null>(
    (best, e) => (best === null || e.minMemoryGB > (byId.get(best)?.minMemoryGB ?? 0) ? e.id : best),
    null
  );
  return CATALOG.map((e) => ({
    id: e.id,
    label: e.label,
    params: e.params,
    quant: e.quant,
    sizeBytes: e.sizeBytes,
    minMemoryGB: e.minMemoryGB,
    description: e.description,
    capabilities: toModelCapabilities(e.capabilities),
    fits: e.minMemoryGB <= totalMemoryGB,
    recommended: e.id === bestId,
    installed: installed.has(e.fileName)
  }));
}

/** Models present on disk (catalog ones plus any stray .gguf the user added). */
export function listInstalled(): InstalledModel[] {
  return [...installedFileNames()].map((fileName) => {
    const entry = byFileName.get(fileName);
    const sizeBytes = (() => {
      try {
        return statSync(modelPath(fileName)).size;
      } catch {
        return 0;
      }
    })();
    return {
      id: entry?.id ?? fileName,
      label: entry?.label ?? fileName,
      fileName,
      sizeBytes,
      fromCatalog: !!entry
    };
  });
}

// One download at a time per model id, so cancel has something to abort.
const activeDownloads = new Map<string, AbortController>();

/**
 * Download a catalog model, reporting progress via `onProgress`. Resolves to the local path on
 * success. Safe to call when already installed (skipExisting short-circuits).
 */
export async function downloadModel(
  id: string,
  onProgress: (p: DownloadProgress) => void
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const entry = byId.get(id);
  if (!entry) return { ok: false, error: `Unknown model "${id}".` };
  if (activeDownloads.has(id)) return { ok: false, error: "This model is already downloading." };

  const controller = new AbortController();
  activeDownloads.set(id, controller);
  try {
    const downloader = await createModelDownloader({
      modelUri: entry.hfUri,
      dirPath: modelsDir(),
      fileName: entry.fileName,
      skipExisting: true,
      deleteTempFileOnCancel: true,
      onProgress: ({ totalSize, downloadedSize }) =>
        onProgress({ modelId: id, downloadedBytes: downloadedSize, totalBytes: totalSize, done: false })
    });
    const path = await downloader.download({ signal: controller.signal });
    onProgress({ modelId: id, downloadedBytes: downloader.totalSize, totalBytes: downloader.totalSize, done: true });
    return { ok: true, path };
  } catch (e) {
    const error = controller.signal.aborted ? "Download cancelled." : e instanceof Error ? e.message : String(e);
    onProgress({ modelId: id, downloadedBytes: 0, totalBytes: 0, done: true, error });
    return { ok: false, error };
  } finally {
    activeDownloads.delete(id);
  }
}

/** Cancel an in-flight download. No-op if none is running for `id`. */
export function cancelDownload(id: string): void {
  activeDownloads.get(id)?.abort();
}

/** Delete a downloaded model file. Accepts a catalog id or a raw filename. */
export function deleteModel(idOrFileName: string): { ok: true } | { ok: false; error: string } {
  const fileName = byId.get(idOrFileName)?.fileName ?? idOrFileName;
  const path = modelPath(fileName);
  if (!existsSync(path)) return { ok: false, error: "Model not found." };
  void unloadModel(path); // free it from memory; unlinking a still-mapped file is safe on POSIX
  try {
    rmSync(path);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
// If the deleted model was the active selection, the delete IPC clears it (see local-llm/ipc.ts).

/** Map the catalog's capability flags onto Pi's ModelCapabilities (thinking is a string enum). */
function toModelCapabilities(c: LocalModelCapabilities): ModelCapabilities {
  return {
    thinking: c.thinking ? "medium" : "off",
    supportsImages: c.supportsImages,
    supportsTools: c.supportsTools,
    contextWindow: c.contextWindow
  };
}

/**
 * Resolve a catalog model id to its on-disk path and capabilities, or null when the id is unknown or
 * the GGUF isn't downloaded. The `active` selection (not a local pointer) decides *which* model is
 * in use; this just turns that id into what the chat path needs.
 */
export function resolveEmbeddedModel(
  id: string
): { id: string; path: string; label: string; capabilities: ModelCapabilities } | null {
  const entry = byId.get(id);
  if (!entry) return null;
  const path = modelPath(entry.fileName);
  if (!existsSync(path)) return null;
  return { id: entry.id, path, label: entry.label, capabilities: toModelCapabilities(entry.capabilities) };
}

/**
 * Shared types for the embedded runtime. Embedded models are GGUF files MapOS downloads and runs
 * in-process; the renderer only sees these resolved views, never Hugging Face URIs or file paths.
 */

export type LocalLlmHardware = {
  /** Selected GPU backend, e.g. "metal", or false on CPU. */
  gpu: string | false;
  gpuDeviceNames: string[];
  /** Total unified memory / VRAM in GB — drives the hardware-aware recommendation. */
  totalMemoryGB: number;
};

export type LocalModelCapabilities = {
  supportsTools: boolean;
  supportsImages: boolean;
  thinking: boolean;
  contextWindow: number;
};

/** A curated, downloadable model as shown in the picker. */
export type RecommendedModel = {
  /** Stable catalog id (also used to address download/cancel). */
  id: string;
  label: string;
  /** Parameter count, e.g. "7B". */
  params: string;
  /** Quantization, e.g. "Q4_K_M". */
  quant: string;
  sizeBytes: number;
  /** Recommended minimum unified memory (GB) to run this comfortably. */
  minMemoryGB: number;
  description: string;
  capabilities: LocalModelCapabilities;
  /** True when this machine meets {@link minMemoryGB}. */
  fits: boolean;
  /** True for the single best default for this machine. */
  recommended: boolean;
  /** True when the GGUF is already downloaded. */
  installed: boolean;
};

/** A model file present on disk under userData/models. */
export type InstalledModel = {
  /** Catalog id when the file matches the catalog; otherwise the filename. */
  id: string;
  label: string;
  fileName: string;
  sizeBytes: number;
  /** False for a .gguf the user dropped in that isn't in our catalog. */
  fromCatalog: boolean;
};

/** Streamed while a model downloads. */
export type DownloadProgress = {
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  done: boolean;
  /** Set if the download failed or was cancelled. */
  error?: string;
};

/**
 * Single source of truth for the models MapOS exposes in the chat picker and the
 * capabilities each model has end-to-end through our chat path. Both the renderer
 * (model picker UI) and main (request building, capability gating) read from here.
 *
 * Adding a new model? Drop an entry below — the picker shows it and the SDK
 * request branches off its capabilities automatically.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type AiProvider = "anthropic" | "local";

/**
 * What a given model can actually do when routed through MapOS's chat path.
 * For local models this is *not* a claim about the protocol — it's a claim about
 * what works through the Anthropic-compat shim (Ollama, LiteLLM, etc.), which
 * often advertises support that doesn't work in practice.
 */
export type ModelCapabilities = {
  /**
   * Reasoning effort to pass to Pi. `"off"` disables thinking; the other values
   * are forwarded verbatim as `thinkingLevel`. Pi clamps to the model's
   * supported range, so over-specifying (e.g. "high" on a model that tops out
   * at "medium") is safe.
   */
  thinking: ModelThinkingLevel;
  /** Vision input (image content blocks on user messages). */
  supportsImages: boolean;
  /** Tool use through MapOS's chat path. */
  supportsTools: boolean;
  /**
   * Maximum context window in tokens. Source of truth for both Pi's compaction
   * budget (passed through `ModelRegistry.registerProvider` for local models)
   * and the display label in Settings (rendered via {@link formatContextWindow}).
   */
  contextWindow: number;
};

/** Display label for a token count, e.g. 256_000 → "256K", 1_000_000 → "1M". */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

export type AnthropicModel = {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
};

export type OllamaModel = {
  id: string;
  label: string;
  size: string;
  hint: string;
  capabilities: ModelCapabilities;
};

const ANTHROPIC_DEFAULT: ModelCapabilities = {
  thinking: "high",
  supportsImages: true,
  supportsTools: true,
  contextWindow: 200_000
};

/**
 * Conservative default for unrecognized local models — no thinking, no images, no tools.
 * Curated entries below opt into stronger capabilities only after end-to-end verification.
 */
const LOCAL_DEFAULT: ModelCapabilities = {
  thinking: "off",
  supportsImages: false,
  supportsTools: false,
  contextWindow: 32_000
};

export const ANTHROPIC_MODELS: AnthropicModel[] = [
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    capabilities: { ...ANTHROPIC_DEFAULT, contextWindow: 1_000_000 }
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    capabilities: { ...ANTHROPIC_DEFAULT, contextWindow: 1_000_000 }
  }
];

/**
 * Curated Ollama models surfaced in the picker. Capabilities default to LOCAL_DEFAULT
 * until verified end-to-end through our compat shim — bump fields on a per-model basis
 * after confirming the behavior actually works.
 */
export const OLLAMA_MODELS: OllamaModel[] = [
  {
    id: "lfm2.5-thinking:1.2b",
    label: "LFM2.5 Thinking 1.2B",
    size: "0.8 GB",
    hint: "Tiny — runs on almost any machine.",
    capabilities: {
      ...LOCAL_DEFAULT,
      contextWindow: 32_000,
      thinking: "medium",
      supportsTools: true
    }
  },
  {
    id: "ministral-3:3b",
    label: "Ministral 3B",
    size: "2.0 GB",
    hint: "Small and fast, light RAM use.",
    capabilities: {
      ...LOCAL_DEFAULT,
      contextWindow: 128_000,
      supportsImages: true,
      supportsTools: true
    }
  },
  {
    id: "qwen3.5:9b",
    label: "Qwen 3.5 9B",
    size: "5.4 GB",
    hint: "Sweet spot. Most popular tools model.",
    capabilities: {
      ...LOCAL_DEFAULT,
      contextWindow: 256_000,
      thinking: "medium",
      supportsImages: true,
      supportsTools: true
    }
  },
  {
    id: "ministral-3:14b",
    label: "Ministral 14B",
    size: "8.5 GB",
    hint: "Higher quality if you have the RAM.",
    capabilities: {
      ...LOCAL_DEFAULT,
      contextWindow: 256_000,
      supportsImages: true,
      supportsTools: true
    }
  },
  {
    id: "gemma4:26b",
    label: "Gemma 4 26B",
    size: "16 GB",
    hint: "Frontier-level reasoning. Needs 32GB+ RAM.",
    capabilities: {
      ...LOCAL_DEFAULT,
      contextWindow: 256_000,
      thinking: "medium",
      supportsImages: true,
      supportsTools: true
    }
  }
];

const ANTHROPIC_LOOKUP: Record<string, ModelCapabilities> = Object.fromEntries(
  ANTHROPIC_MODELS.map((m) => [m.id, m.capabilities])
);

const OLLAMA_LOOKUP: Record<string, ModelCapabilities> = Object.fromEntries(
  OLLAMA_MODELS.map((m) => [m.id, m.capabilities])
);

export function resolveCapabilities(provider: AiProvider, model: string): ModelCapabilities {
  if (provider === "anthropic") {
    return ANTHROPIC_LOOKUP[model] ?? ANTHROPIC_DEFAULT;
  }
  return OLLAMA_LOOKUP[model] ?? LOCAL_DEFAULT;
}

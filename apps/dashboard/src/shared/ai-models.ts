/**
 * Single source of truth for the models MapOS exposes in the chat picker and the
 * capabilities each model has end-to-end through our chat path. Both the renderer
 * (model picker UI) and main (request building, capability gating) read from here.
 *
 * Adding a new model? Drop an entry below — the picker shows it and the SDK
 * request branches off its capabilities automatically.
 */

export type AiProvider = "anthropic" | "local";

/**
 * What a given model can actually do when routed through MapOS's chat path.
 * For local models this is *not* a claim about the protocol — it's a claim about
 * what works through the Anthropic-compat shim (Ollama, LiteLLM, etc.), which
 * often advertises support that doesn't work in practice.
 */
export type ModelCapabilities = {
  /**
   * Extended thinking. Mirrors the SDK's `ThinkingConfig` shape: "adaptive" for
   * Opus 4.6+ style, "enabled" for older fixed-budget thinking, false for none.
   */
  thinking: "adaptive" | "enabled" | false;
  /** Vision input (image content blocks on user messages). */
  supportsImages: boolean;
  /** Display-ready context window magnitude (e.g. "32K", "1M"). UX hint, not enforcement. */
  contextWindow: string;
};

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
  thinking: "adaptive",
  supportsImages: true,
  contextWindow: "200K"
};

/**
 * Conservative default for unrecognized local models — no thinking, no images.
 * Curated entries below opt into stronger capabilities only after end-to-end verification.
 */
const LOCAL_DEFAULT: ModelCapabilities = {
  thinking: false,
  supportsImages: false,
  contextWindow: "32K"
};

export const ANTHROPIC_MODELS: AnthropicModel[] = [
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    capabilities: { ...ANTHROPIC_DEFAULT, contextWindow: "1M" }
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    capabilities: { ...ANTHROPIC_DEFAULT, contextWindow: "1M" }
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
    capabilities: { ...LOCAL_DEFAULT, contextWindow: "32K" }
  },
  {
    id: "ministral-3:3b",
    label: "Ministral 3B",
    size: "2.0 GB",
    hint: "Small and fast, light RAM use.",
    capabilities: { ...LOCAL_DEFAULT, contextWindow: "128K" }
  },
  {
    id: "qwen3.5:9b",
    label: "Qwen 3.5 9B",
    size: "5.4 GB",
    hint: "Sweet spot. Most popular tools model.",
    capabilities: { ...LOCAL_DEFAULT, contextWindow: "256K" }
  },
  {
    id: "ministral-3:14b",
    label: "Ministral 14B",
    size: "8.5 GB",
    hint: "Higher quality if you have the RAM.",
    capabilities: { ...LOCAL_DEFAULT, contextWindow: "256K" }
  },
  {
    id: "gemma4:26b",
    label: "Gemma 4 26B",
    size: "16 GB",
    hint: "Frontier-level reasoning. Needs 32GB+ RAM.",
    capabilities: { ...LOCAL_DEFAULT, contextWindow: "256K" }
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

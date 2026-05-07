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
  /** Native function/tool calling. Without it, MapOS chat can't run vault tools. */
  supportsTools: boolean;
  /**
   * Extended thinking. Mirrors the SDK's `ThinkingConfig` shape: "adaptive" for
   * Opus 4.6+ style, "enabled" for older fixed-budget thinking, false for none.
   */
  thinking: "adaptive" | "enabled" | false;
  /** Vision input (image content blocks on user messages). */
  supportsImages: boolean;
  /** Approximate input context window in tokens. Best-effort; UX hint, not enforcement. */
  contextWindow: number;
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
  supportsTools: true,
  thinking: "adaptive",
  supportsImages: true,
  contextWindow: 200_000
};

/**
 * Conservative default for unrecognized local models — no tools, no thinking, no images.
 * Curated entries below opt into stronger capabilities only after end-to-end verification.
 */
const LOCAL_DEFAULT: ModelCapabilities = {
  supportsTools: false,
  thinking: false,
  supportsImages: false,
  contextWindow: 32_768
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
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    capabilities: { ...ANTHROPIC_DEFAULT, contextWindow: 1_000_000 }
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    capabilities: { ...ANTHROPIC_DEFAULT }
  }
];

/**
 * Curated Ollama models surfaced in the picker. Capabilities default to LOCAL_DEFAULT
 * until verified end-to-end through our compat shim — bump fields on a per-model basis
 * after confirming the behavior actually works.
 */
export const OLLAMA_MODELS: OllamaModel[] = [
  {
    id: "qwen2.5-coder:7b",
    label: "Qwen 2.5 Coder 7B",
    size: "4.4 GB",
    hint: "Strong tool calling, fast on M-series Macs.",
    capabilities: LOCAL_DEFAULT
  },
  {
    id: "llama3.1:8b",
    label: "Llama 3.1 8B",
    size: "4.7 GB",
    hint: "General-purpose, well-rounded.",
    capabilities: LOCAL_DEFAULT
  },
  {
    id: "deepseek-coder-v2:16b-lite-instruct-q4_0",
    label: "DeepSeek Coder v2 Lite",
    size: "8.9 GB",
    hint: "Coding-focused; good for editing place files.",
    capabilities: LOCAL_DEFAULT
  },
  {
    id: "gemma2:9b",
    label: "Gemma 2 9B",
    size: "5.5 GB",
    hint: "Concise, low-latency replies.",
    capabilities: LOCAL_DEFAULT
  },
  {
    id: "qwen2.5:14b",
    label: "Qwen 2.5 14B",
    size: "8.4 GB",
    hint: "Higher quality if you have the RAM.",
    capabilities: LOCAL_DEFAULT
  },
  {
    id: "mistral-nemo:12b",
    label: "Mistral Nemo 12B",
    size: "7.1 GB",
    hint: "Long context window.",
    capabilities: LOCAL_DEFAULT
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

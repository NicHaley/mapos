/**
 * POC: unified "provider" model for AI configuration.
 *
 * Instead of three top-level modes (Anthropic / Ollama-magic / custom-URL), everything is a
 * *provider*: a protocol + a baseUrl + an auth strategy. The dimensions that used to be
 * separate branches (cloud vs local, key vs token) are now fields. Models are fetched live
 * from each provider rather than hard-coded, and a model's capabilities are resolved from the
 * provider where possible (Ollama's `/api/show`) and fall back to a per-protocol default.
 *
 * This lives alongside the existing `ai-models.ts` / `mapos-config.ts` AI config — it does not
 * replace it yet. Runtime prefers a v2 selection when one exists.
 */

import type { ModelCapabilities } from "./ai-models";

/** Wire format / SDK adapter. `anthropic` = Messages API, `openai` = OpenAI-compatible completions. */
export type ProviderProtocol = "anthropic" | "openai";

/** How the provider authenticates. `api-key` → `x-api-key`, `bearer` → `Authorization: Bearer`. */
export type ProviderAuthKind = "none" | "api-key" | "bearer";

/** How a provider is currently authenticated, for display. */
export type ProviderAuthMethod = "none" | "api-key" | "bearer" | "oauth";

export type ProviderAuthView = {
  method: ProviderAuthMethod;
  /** Whether usable auth is configured (no auth needed counts as configured). */
  configured: boolean;
  /** Whether OAuth sign-in is available (Pi ships an OAuth flow for this provider). */
  oauthAvailable: boolean;
};

/** A configured provider as exposed to the renderer — never carries the encrypted secret. */
export type ProviderView = {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  authKind: ProviderAuthKind;
  /** Whether a secret (key/token) is saved for the custom path. The secret itself never leaves main. */
  hasSecret: boolean;
  /** Pi catalog provider name (e.g. "anthropic") when this is a known provider; null for custom/local. */
  knownProvider: string | null;
  /** Set for the one permanent built-in (Anthropic) so the UI locks structural fields. */
  builtin: "anthropic" | null;
  /** The local-runtime preset this provider was created from (see {@link LOCAL_PRESETS}); null otherwise.
   *  Drives the "local" badge and dedups the preset list in the Add-provider sheet. */
  preset: string | null;
  auth: ProviderAuthView;
};

/** One entry in Pi's bundled provider catalog, for the "Add provider" list. */
export type KnownProviderOption = {
  name: string;
  label: string;
  oauthAvailable: boolean;
  modelCount: number;
};

/**
 * A pre-filled local-runtime template offered in the Add-provider sheet. Picking one creates a
 * normal, editable, removable custom provider — it is *not* a Pi catalog entry, and its models are
 * fetched live (`/v1/models`, plus Ollama's `/api/show` capability probe) like any custom endpoint.
 *
 * Pi's `registerProvider` is the wrong tool here: it lives on the coding-agent's ModelRegistry
 * (invisible to the `getProviders()`/`getModels()` catalog this app reads) and expects a *static*
 * model list, whereas local runtimes expose whatever the user has downloaded. So these are plain
 * config templates, not registered providers.
 */
export type LocalPresetOption = {
  /** Stable id; also stored on the created provider (`preset`) for dedup + the "local" badge. */
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  protocol: ProviderProtocol;
};

export const LOCAL_PRESETS: LocalPresetOption[] = [
  {
    id: "ollama",
    label: "Ollama",
    description: "Models you've pulled with Ollama. Capabilities are detected automatically.",
    baseUrl: "http://localhost:11434",
    protocol: "openai"
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    description: "LM Studio's local server — start it from the app's Developer tab.",
    baseUrl: "http://localhost:1234/v1",
    protocol: "openai"
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    description: "llama-server's OpenAI-compatible endpoint.",
    baseUrl: "http://localhost:8080/v1",
    protocol: "openai"
  }
];

/** Plaintext input for creating/updating a provider. Main encrypts the secret before persisting. */
export type ProviderInput = {
  label?: string;
  protocol?: ProviderProtocol;
  baseUrl?: string;
  authKind?: ProviderAuthKind;
  /** Plaintext secret. `null` clears, `undefined` leaves unchanged. */
  secret?: string | null;
  /** The local-runtime preset this provider was created from (see {@link LOCAL_PRESETS}). */
  preset?: string;
};

/** Where a model's capabilities came from — drives the "assumed" hint in the picker. */
export type CapabilitySource = "fetched" | "assumed";

/** A model offered by a provider, discovered at fetch time rather than hard-coded. */
export type FetchedModel = {
  id: string;
  capabilities: ModelCapabilities;
  capabilitySource: CapabilitySource;
};

/** The single active provider+model selection, with capabilities captured at selection time. */
export type ActiveSelectionView = {
  providerId: string;
  providerLabel: string;
  model: string;
  capabilities: ModelCapabilities;
} | null;

export type AiV2State = {
  providers: ProviderView[];
  active: ActiveSelectionView;
};

/**
 * Anthropic models all drive tools + vision + extended thinking through MapOS's path, so a single
 * default is safe. Context window is bumped for the known large-context families at fetch time.
 */
export const ANTHROPIC_CAPS: ModelCapabilities = {
  thinking: "high",
  supportsImages: true,
  supportsTools: true,
  contextWindow: 200_000
};

/**
 * Fallback for an OpenAI-compatible model whose capabilities we couldn't fetch (a remote proxy
 * with no `/api/show`). We assume tools work — MapOS is tool-driven, and most proxies forward tool
 * calls — but mark the source as "assumed" so the UI can flag that we're guessing.
 */
export const OPENAI_ASSUMED_CAPS: ModelCapabilities = {
  thinking: "off",
  supportsImages: false,
  supportsTools: true,
  contextWindow: 32_000
};

/** Default label for the protocol when the user hasn't typed one. */
export function defaultProviderLabel(protocol: ProviderProtocol): string {
  return protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible";
}

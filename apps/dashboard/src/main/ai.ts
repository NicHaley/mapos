/**
 * Storage + model fetching for the AI provider model (see shared/ai-providers.ts): the providers
 * list, the single `active` selection, and live model fetching. Persisted to `ai.json` in userData.
 * {@link resolveActive} turns the active selection into the shape the chat path consumes.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { z } from "zod";
import { ANTHROPIC_MODELS, type AiProvider, type ModelCapabilities } from "../shared/ai-models";
import {
  ANTHROPIC_CAPS,
  type AiState,
  type FetchedModel,
  type KnownProviderOption,
  OPENAI_ASSUMED_CAPS,
  type ProviderAuthKind,
  type ProviderAuthView,
  type ProviderInput,
  type ProviderProtocol,
  type ProviderView
} from "../shared/ai-providers";
import {
  catalogBaseUrl,
  catalogModels,
  knownAuthStatus,
  knownProviderConfigured,
  knownProviderLabel,
  listKnownProviders as listKnownProvidersImpl
} from "./ai-auth";

const AI_FILENAME = "ai.json";
const FETCH_TIMEOUT_MS = 6000;

/** Thrown by {@link loadAiConfigForRequest} when no usable AI selection exists. */
export class AiConfigError extends Error {
  constructor(
    public code: "AI_NOT_CONFIGURED" | "AI_DECRYPT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "AiConfigError";
  }
}

/** The active selection resolved into env-var-ready values for one chat request. */
export type ResolvedAiRequestConfig = {
  provider: AiProvider;
  baseUrl: string;
  authToken: string;
  apiKey: string;
  model: string;
  capabilities: ModelCapabilities;
  /**
   * A Pi catalog provider name (e.g. "anthropic"). When set, the chat path resolves the model via
   * `getModel(piProvider, model)` and its auth through the shared persistent AuthStorage.
   */
  piProvider?: string;
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const CapabilitiesSchema = z.object({
  thinking: z.enum(THINKING_LEVELS).catch("off"),
  supportsImages: z.boolean().catch(false),
  supportsTools: z.boolean().catch(false),
  contextWindow: z.number().catch(32_000)
});

const ProviderSchema = z.object({
  id: z.string().min(1),
  label: z.string().catch(""),
  protocol: z.enum(["anthropic", "openai"]).catch("openai"),
  baseUrl: z.string().catch(""),
  authKind: z.enum(["none", "api-key", "bearer"]).catch("none"),
  encryptedSecret: z.string().nullable().catch(null),
  /** Pi catalog provider name when this is a known provider; null for custom/local endpoints. */
  knownProvider: z.string().nullable().catch(null),
  /** Optional origin tag for a local-runtime provider; surfaced as a badge in the UI. */
  preset: z.string().nullable().catch(null)
});

const ActiveSchema = z
  .object({
    providerId: z.string(),
    model: z.string(),
    capabilities: CapabilitiesSchema
  })
  .nullable()
  .catch(null);

const AiSchema = z
  .object({
    providers: z.array(ProviderSchema).catch([]),
    active: ActiveSchema
  })
  .catch(() => ({ providers: [], active: null }));

type AiStored = z.infer<typeof AiSchema>;
type ProviderStored = z.infer<typeof ProviderSchema>;

/**
 * First-run convenience: pre-list the marquee OAuth-capable catalog providers as ordinary, removable
 * providers, each unconnected until the user signs in. If the user removes one (or edits the saved
 * config), it is not re-added. Other providers are added from the catalog or "Custom endpoint".
 * Stable ids so an active selection survives reloads; built from the catalog so labels/baseUrl/
 * protocol stay in sync with Pi.
 */
const SEEDED_PROVIDERS = ["anthropic", "openai", "github-copilot"] as const;

function seedProviders(): ProviderStored[] {
  return SEEDED_PROVIDERS.map((name) => ({
    id: `default-${name}`,
    label: knownProviderLabel(name),
    // anthropic-messages models map to our "anthropic" protocol; everything else routes as openai-ish.
    protocol: catalogModels(name)[0]?.api === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: catalogBaseUrl(name),
    authKind: "api-key",
    encryptedSecret: null,
    knownProvider: name,
    preset: null
  }));
}

function configPath(): string {
  return join(app.getPath("userData"), AI_FILENAME);
}

function write(state: AiStored): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

/** Load, seeding a first-run (or corrupt) config with the default Anthropic provider. */
function load(): AiStored {
  const p = configPath();
  if (existsSync(p)) {
    try {
      return AiSchema.parse(JSON.parse(readFileSync(p, "utf-8")));
    } catch {
      /* corrupt — fall through to reseed a fresh default */
    }
  }
  const seeded: AiStored = { providers: seedProviders(), active: null };
  write(seeded);
  return seeded;
}

function encrypt(plaintext: string): string {
  return safeStorage.encryptString(plaintext).toString("base64");
}

function decrypt(encryptedBase64: string): string {
  return safeStorage.decryptString(Buffer.from(encryptedBase64, "base64"));
}

/** Compute the display auth state. Known providers read Pi's AuthStorage; custom/local read locally. */
function authView(p: ProviderStored): ProviderAuthView {
  if (p.knownProvider) {
    return knownAuthStatus(p.knownProvider);
  }
  if (p.authKind === "none") {
    return { method: "none", configured: true, oauthAvailable: false };
  }
  // Custom OpenAI-compatible endpoint with an optional bearer token in our own encrypted store.
  return { method: "bearer", configured: !!p.encryptedSecret, oauthAvailable: false };
}

function toView(p: ProviderStored): ProviderView {
  return {
    id: p.id,
    label: p.label,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    authKind: p.authKind,
    hasSecret: !!p.encryptedSecret,
    knownProvider: p.knownProvider,
    preset: p.preset,
    auth: authView(p)
  };
}

export function listKnownProviders(): KnownProviderOption[] {
  return listKnownProvidersImpl();
}

/** Add a provider from Pi's catalog. Protocol/baseUrl are derived from the catalog, not typed in. */
export function addKnownProvider(name: string): { ok: true; id: string } | { ok: false; error: string } {
  const models = catalogModels(name);
  if (models.length === 0) return { ok: false, error: `Unknown provider "${name}".` };
  const st = load();
  // Don't add the same catalog provider twice.
  const existing = st.providers.find((x) => x.knownProvider === name);
  if (existing) return { ok: true, id: existing.id };
  const id = randomUUID();
  // anthropic-messages models map to our "anthropic" protocol; everything else routes as openai-ish.
  const protocol: ProviderProtocol = models[0]?.api === "anthropic-messages" ? "anthropic" : "openai";
  const next: ProviderStored = {
    id,
    label: knownProviderLabel(name),
    protocol,
    baseUrl: catalogBaseUrl(name),
    authKind: "api-key",
    encryptedSecret: null,
    knownProvider: name,
    preset: null
  };
  write({ ...st, providers: [...st.providers, next] });
  return { ok: true, id };
}

export function getAiState(): AiState {
  const st = load();
  const active = (() => {
    if (!st.active) return null;
    const provider = st.providers.find((x) => x.id === st.active?.providerId);
    if (!provider) return null;
    return {
      providerId: st.active.providerId,
      providerLabel: provider.label,
      model: st.active.model,
      capabilities: st.active.capabilities
    };
  })();
  return { providers: st.providers.map(toView), active };
}

export function addProvider(input: ProviderInput): { ok: true; id: string } | { ok: false; error: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "Secure storage isn't available on this system." };
  }
  const protocol: ProviderProtocol = input.protocol ?? "openai";
  const baseUrl = input.baseUrl?.trim() ?? "";
  if (!baseUrl) return { ok: false, error: "Base URL is required." };
  const authKind: ProviderAuthKind = input.authKind ?? "none";
  const id = randomUUID();
  const next: ProviderStored = {
    id,
    label: input.label?.trim() || (protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible"),
    protocol,
    baseUrl,
    authKind,
    encryptedSecret:
      authKind !== "none" && typeof input.secret === "string" && input.secret.trim().length > 0
        ? encrypt(input.secret.trim())
        : null,
    knownProvider: null,
    preset: input.preset ?? null
  };
  const st = load();
  write({ ...st, providers: [...st.providers, next] });
  return { ok: true, id };
}

export function updateProvider(
  id: string,
  patch: ProviderInput
): { ok: true } | { ok: false; error: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "Secure storage isn't available on this system." };
  }
  const st = load();
  const idx = st.providers.findIndex((x) => x.id === id);
  const current = st.providers[idx];
  if (!current) return { ok: false, error: "Provider not found." };

  const authKind = patch.authKind ?? current.authKind;
  let encryptedSecret = current.encryptedSecret;
  if (patch.secret === null || authKind === "none") {
    encryptedSecret = null;
  } else if (typeof patch.secret === "string") {
    const trimmed = patch.secret.trim();
    encryptedSecret = trimmed === "" ? encryptedSecret : encrypt(trimmed);
  }

  const updated: ProviderStored = {
    ...current,
    protocol: patch.protocol ?? current.protocol,
    label: patch.label?.trim() || current.label,
    baseUrl: patch.baseUrl?.trim() || current.baseUrl,
    authKind,
    encryptedSecret
  };
  const providers = [...st.providers];
  providers[idx] = updated;
  write({ ...st, providers });
  return { ok: true };
}

export function removeProvider(id: string): { ok: true } | { ok: false; error: string } {
  const st = load();
  const target = st.providers.find((x) => x.id === id);
  if (!target) return { ok: false, error: "Provider not found." };
  const providers = st.providers.filter((x) => x.id !== id);
  const active = st.active?.providerId === id ? null : st.active;
  write({ ...st, providers, active });
  return { ok: true };
}

export function setActive(
  providerId: string,
  model: string,
  capabilities: ModelCapabilities
): { ok: true } | { ok: false; error: string } {
  const st = load();
  if (!st.providers.some((x) => x.id === providerId)) {
    return { ok: false, error: "Provider not found." };
  }
  write({ ...st, active: { providerId, model, capabilities } });
  return { ok: true };
}

export function clearActive(): { ok: true } {
  const st = load();
  write({ ...st, active: null });
  return { ok: true };
}

// ── Model fetching ──────────────────────────────────────────────────────────

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Normalize a bare `host:port` to the `/v1` base the OpenAI SDK and `/v1/models` expect. */
function openAiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.pathname === "" || u.pathname === "/") return `${trimmed}/v1`;
  } catch {
    /* fall through */
  }
  return trimmed;
}

/** Strip any `/v1` suffix to reach Ollama's native API (`/api/show`, `/api/tags`). */
function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function fetchAnthropicModels(
  baseUrl: string,
  apiKey: string | null
): Promise<{ ok: true; models: FetchedModel[] } | { ok: false; error: string }> {
  // No key yet — fall back to the known catalog so the picker still shows something. These are
  // "assumed" (we didn't confirm them against the live account).
  if (!apiKey) {
    return {
      ok: true,
      models: ANTHROPIC_MODELS.map((m) => ({
        id: m.id,
        capabilities: m.capabilities,
        capabilitySource: "assumed" as const
      }))
    };
  }
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models?limit=1000`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models: FetchedModel[] = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => ({
        id,
        capabilities: {
          ...ANTHROPIC_CAPS,
          // Known large-context families; everything else keeps the conservative 200K default.
          contextWindow: /opus-4|sonnet-4/.test(id) ? 1_000_000 : ANTHROPIC_CAPS.contextWindow
        },
        capabilitySource: "fetched" as const
      }));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    done();
  }
}

/**
 * Resolve one Ollama model's real capabilities via `/api/show`. Ollama returns a `capabilities`
 * array (`tools`, `vision`, `thinking`, ...) and the context length in `model_info`. Returns null
 * on any failure so the caller can fall back to assumed defaults.
 */
async function fetchOllamaCapabilities(root: string, model: string): Promise<ModelCapabilities | null> {
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      capabilities?: string[];
      model_info?: Record<string, unknown>;
    };
    const caps = data.capabilities ?? [];
    const ctxEntry = Object.entries(data.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
    const contextWindow =
      typeof ctxEntry?.[1] === "number" && ctxEntry[1] > 0 ? (ctxEntry[1] as number) : 32_000;
    return {
      supportsTools: caps.includes("tools"),
      supportsImages: caps.includes("vision"),
      thinking: caps.includes("thinking") ? "medium" : "off",
      contextWindow
    };
  } catch {
    return null;
  } finally {
    done();
  }
}

async function fetchOpenAiModels(
  baseUrl: string,
  token: string | null
): Promise<{ ok: true; models: FetchedModel[] } | { ok: false; error: string }> {
  const base = openAiBase(baseUrl);
  const root = ollamaRoot(base);
  const { signal, done } = withTimeout();
  let ids: string[];
  try {
    const res = await fetch(`${base}/models`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    done();
  }

  // Probe once for Ollama's native API. If present, enrich each model with real capabilities;
  // otherwise we can only assume (a generic proxy exposes the model list but not capabilities).
  const isOllama = await fetch(`${root}/api/tags`)
    .then((r) => r.ok)
    .catch(() => false);

  const models: FetchedModel[] = await Promise.all(
    ids.map(async (id) => {
      if (isOllama) {
        const caps = await fetchOllamaCapabilities(root, id);
        if (caps) return { id, capabilities: caps, capabilitySource: "fetched" as const };
      }
      return { id, capabilities: OPENAI_ASSUMED_CAPS, capabilitySource: "assumed" as const };
    })
  );
  return { ok: true, models };
}

/** Map a Pi catalog Model to our capability shape. Catalog chat models drive tools through MapOS. */
function catalogToFetched(name: string): FetchedModel[] {
  return catalogModels(name).map((m) => ({
    id: m.id,
    capabilities: {
      contextWindow: m.contextWindow,
      supportsImages: m.input.includes("image"),
      supportsTools: true,
      thinking: m.reasoning ? "high" : "off"
    },
    capabilitySource: "fetched" as const
  }));
}

/** Fetch the live model list for a provider, resolving capabilities where the provider exposes them. */
export async function fetchModels(
  providerId: string
): Promise<{ ok: true; models: FetchedModel[] } | { ok: false; error: string }> {
  const st = load();
  const provider = st.providers.find((x) => x.id === providerId);
  if (!provider) return { ok: false, error: "Provider not found." };

  // Known providers: read Pi's bundled catalog — capabilities come baked in, no network call.
  if (provider.knownProvider) {
    return { ok: true, models: catalogToFetched(provider.knownProvider) };
  }

  let secret: string | null = null;
  if (provider.encryptedSecret) {
    try {
      secret = decrypt(provider.encryptedSecret);
    } catch {
      return { ok: false, error: "Couldn't decrypt the saved secret." };
    }
  }

  if (provider.protocol === "anthropic") {
    return fetchAnthropicModels(provider.baseUrl, secret);
  }
  return fetchOpenAiModels(provider.baseUrl, secret);
}

/**
 * Resolve the active selection into the shape the chat path consumes, or null when nothing usable is
 * selected (none set, provider gone, model deleted, or a required secret missing/undecryptable).
 */
export function resolveActive(): ResolvedAiRequestConfig | null {
  const st = load();
  if (!st.active) return null;

  // A stale embedded ("local-embedded") selection no longer resolves — it falls through here, the
  // provider lookup misses, and we return null so the user is prompted to pick a model.
  const provider = st.providers.find((x) => x.id === st.active?.providerId);
  if (!provider) return null;
  const capabilities = st.active.capabilities;
  const model = st.active.model;

  // Known providers resolve auth (API key or OAuth, auto-refreshed) through Pi's AuthStorage at
  // request time — the `piProvider` marker tells chat.ts to use the persistent store + getModel.
  if (provider.knownProvider) {
    if (!knownProviderConfigured(provider.knownProvider)) return null;
    return {
      provider: provider.protocol === "anthropic" ? "anthropic" : "local",
      baseUrl: "",
      authToken: "",
      apiKey: "",
      model,
      capabilities,
      piProvider: provider.knownProvider
    };
  }

  let secret = "";
  if (provider.encryptedSecret) {
    try {
      secret = decrypt(provider.encryptedSecret);
    } catch {
      return null;
    }
  }

  if (provider.protocol === "anthropic") {
    if (!secret) return null; // unusable without a key
    return { provider: "anthropic", baseUrl: "", authToken: "", apiKey: secret, model, capabilities };
  }
  return {
    provider: "local",
    baseUrl: provider.baseUrl,
    authToken: secret,
    apiKey: "",
    model,
    capabilities
  };
}

/** Status for the chat composer: whether a usable model is selected, and which. */
export function getAiStatus(): { configured: boolean; activeProvider: AiProvider; model: string } {
  const resolved = resolveActive();
  if (!resolved) return { configured: false, activeProvider: "anthropic", model: "" };
  return { configured: true, activeProvider: resolved.provider, model: resolved.model };
}

/**
 * Resolve the active selection for one chat request, throwing {@link AiConfigError} when nothing
 * usable is configured. This is the entry point chat.ts calls.
 */
export function loadAiConfigForRequest(): ResolvedAiRequestConfig {
  const resolved = resolveActive();
  if (!resolved) {
    throw new AiConfigError("AI_NOT_CONFIGURED", "No AI model is configured. Pick one in Settings → AI.");
  }
  return resolved;
}

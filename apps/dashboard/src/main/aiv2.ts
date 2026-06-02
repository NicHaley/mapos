/**
 * POC: storage + model fetching for the unified provider model (see shared/ai-providers.ts).
 *
 * Persisted to its own `aiv2.json` in userData rather than `mapos.json` so this POC stays fully
 * isolated from the carefully-migrated existing AI config — nothing here can break the current
 * setup, and it's trivial to delete. Runtime prefers a v2 selection when one exists
 * ({@link resolveActiveV2}), otherwise the old config path takes over.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { z } from "zod";
import { ANTHROPIC_MODELS, type ModelCapabilities } from "../shared/ai-models";
import {
  ANTHROPIC_CAPS,
  type AiV2State,
  type FetchedModel,
  type KnownProviderOption,
  OPENAI_ASSUMED_CAPS,
  type ProviderAuthKind,
  type ProviderAuthView,
  type ProviderInput,
  type ProviderProtocol,
  type ProviderView
} from "../shared/ai-providers";
import type { ResolvedAiRequestConfig } from "./ai-config";
import {
  catalogBaseUrl,
  catalogModels,
  knownAuthStatus,
  knownProviderConfigured,
  knownProviderLabel,
  listKnownProviders as listKnownProvidersImpl
} from "./aiv2-auth";

const AIV2_FILENAME = "aiv2.json";
const FETCH_TIMEOUT_MS = 6000;

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
  builtin: z.enum(["anthropic", "ollama"]).nullable().catch(null)
});

const ActiveSchema = z
  .object({
    providerId: z.string(),
    model: z.string(),
    capabilities: CapabilitiesSchema
  })
  .nullable()
  .catch(null);

const AiV2Schema = z
  .object({
    providers: z.array(ProviderSchema).catch([]),
    active: ActiveSchema
  })
  .catch(() => ({ providers: [], active: null }));

type AiV2Stored = z.infer<typeof AiV2Schema>;
type ProviderStored = z.infer<typeof ProviderSchema>;

/** The two seeded presets. Stable ids so an active selection survives reloads. */
function seedProviders(): ProviderStored[] {
  return [
    {
      id: "builtin-anthropic",
      label: "Anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authKind: "api-key",
      encryptedSecret: null,
      knownProvider: "anthropic",
      builtin: "anthropic"
    },
    {
      id: "builtin-ollama",
      label: "Ollama",
      protocol: "openai",
      baseUrl: "http://localhost:11434",
      authKind: "none",
      encryptedSecret: null,
      knownProvider: null,
      builtin: "ollama"
    }
  ];
}

function configPath(): string {
  return join(app.getPath("userData"), AIV2_FILENAME);
}

function write(state: AiV2Stored): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

/** Load (and seed on first run). Always returns at least the two built-in providers. */
function load(): AiV2Stored {
  const p = configPath();
  if (!existsSync(p)) {
    const seeded: AiV2Stored = { providers: seedProviders(), active: null };
    write(seeded);
    return seeded;
  }
  let parsed: AiV2Stored;
  try {
    parsed = AiV2Schema.parse(JSON.parse(readFileSync(p, "utf-8")));
  } catch {
    parsed = { providers: [], active: null };
  }
  // Re-seed any missing built-ins so the presets are always present (e.g. after a manual edit).
  const have = new Set(parsed.providers.map((x) => x.builtin).filter(Boolean));
  const missing = seedProviders().filter((s) => !have.has(s.builtin));
  if (missing.length > 0) {
    parsed = { ...parsed, providers: [...missing, ...parsed.providers] };
    write(parsed);
  }
  return parsed;
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
    builtin: p.builtin,
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
    builtin: null
  };
  write({ ...st, providers: [...st.providers, next] });
  return { ok: true, id };
}

export function getAiV2State(): AiV2State {
  const st = load();
  const active = st.active
    ? (() => {
        const provider = st.providers.find((x) => x.id === st.active?.providerId);
        if (!provider || !st.active) return null;
        return {
          providerId: st.active.providerId,
          providerLabel: provider.label,
          model: st.active.model,
          capabilities: st.active.capabilities
        };
      })()
    : null;
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
    builtin: null
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
    // Built-in providers keep their protocol (it's structural); everything else is editable.
    protocol: current.builtin ? current.protocol : (patch.protocol ?? current.protocol),
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
  if (target.builtin) return { ok: false, error: "Built-in providers can't be removed." };
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
 * Resolve the active v2 selection into the shape the chat path already consumes, or null when no
 * v2 selection is usable (none set, provider gone, or a required secret is missing). Returning
 * null lets {@link loadAiConfigForRequest} fall through to the legacy config cleanly.
 */
export function resolveActiveV2(): ResolvedAiRequestConfig | null {
  const st = load();
  if (!st.active) return null;
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
    if (!secret) return null; // unusable without a key — fall back to legacy config
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

/** Status for the chat composer — mirrors {@link isAiConfigured} but for a v2 selection. */
export function isAiV2Configured(): { configured: boolean; activeProvider: "anthropic" | "local"; model: string } | null {
  const resolved = resolveActiveV2();
  if (!resolved) return null;
  return { configured: true, activeProvider: resolved.provider, model: resolved.model };
}

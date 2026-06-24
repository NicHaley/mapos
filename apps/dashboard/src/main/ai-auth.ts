/**
 * Persistent, encrypted credential store for AI providers.
 *
 * Pi's `AuthStorage` already handles the hard parts — API-key + OAuth credentials, OAuth token
 * refresh, and lock-guarded persistence — but it writes plaintext JSON to disk. We back it with a
 * custom {@link AuthStorageBackend} that encrypts the whole blob via Electron `safeStorage`
 * (OS keychain), so we get Pi's OAuth machinery *and* keychain-grade secret-at-rest protection.
 *
 * This single persistent AuthStorage is shared across chat sessions (see chat.ts) so OAuth tokens
 * resolve and auto-refresh at request time, and across the Providers settings UI (sign in / paste
 * key / disconnect). Known providers (Pi catalog) authenticate through here; custom OpenAI-compatible
 * endpoints keep their inline bearer token in ai.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, KnownProvider, Model, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
// `getOAuthProvider` ships behind the `./oauth` subpath export, not the package root — the root
// only re-exports the OAuth *types*. Importing it from the root type-checks but throws at runtime.
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { AuthStorage, type AuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { app, safeStorage } from "electron";
import type { KnownProviderOption } from "../shared/ai-providers";

const AUTH_FILENAME = "ai-auth.enc";

/**
 * AuthStorage backend that persists Pi's auth.json blob as a safeStorage-encrypted file.
 * Electron main is single-process, so the lock contract is satisfied by running the callback
 * synchronously around a read/modify/write.
 */
class SafeStorageAuthBackend implements AuthStorageBackend {
  private path(): string {
    return join(app.getPath("userData"), AUTH_FILENAME);
  }

  private read(): string | undefined {
    const p = this.path();
    if (!existsSync(p)) return undefined;
    try {
      const buf = readFileSync(p);
      if (buf.length === 0) return undefined;
      return safeStorage.decryptString(buf);
    } catch {
      // Corrupt/undecryptable (e.g. keychain reset) — treat as empty rather than crash.
      return undefined;
    }
  }

  private persist(next: string): void {
    const p = this.path();
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(p, safeStorage.encryptString(next));
  }

  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    const { result, next } = fn(this.read());
    if (next !== undefined) this.persist(next);
    return result;
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<{ result: T; next?: string }>
  ): Promise<T> {
    const { result, next } = await fn(this.read());
    if (next !== undefined) this.persist(next);
    return result;
  }
}

let storageRef: AuthStorage | null = null;

/** The shared persistent AuthStorage. Lazily created so `app` is ready before we touch userData. */
export function getRuntimeAuthStorage(): AuthStorage {
  if (!storageRef) {
    storageRef = AuthStorage.fromStorage(new SafeStorageAuthBackend());
  }
  return storageRef;
}

// ── Known-provider catalog helpers ────────────────────────────────────────────

/** Friendly labels for the noisier catalog ids; everything else falls back to the raw name. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI (Codex sign-in)",
  google: "Google Gemini",
  "google-vertex": "Google Vertex",
  "github-copilot": "GitHub Copilot",
  groq: "Groq",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
  xai: "xAI Grok",
  mistral: "Mistral",
  openrouter: "OpenRouter",
  together: "Together",
  fireworks: "Fireworks"
};

export function knownProviderLabel(name: string): string {
  return PROVIDER_LABELS[name] ?? name;
}

/** Whether Pi ships an OAuth flow (subscription sign-in) for this provider. */
export function oauthAvailable(name: string): boolean {
  return !!getOAuthProvider(name);
}

/** Every provider in Pi's bundled catalog, with model counts — drives the "Add provider" list. */
export function listKnownProviders(): KnownProviderOption[] {
  return getProviders()
    .map((name) => {
      let modelCount = 0;
      try {
        modelCount = getModels(name).length;
      } catch {
        modelCount = 0;
      }
      return {
        name,
        label: knownProviderLabel(name),
        oauthAvailable: oauthAvailable(name),
        modelCount
      };
    })
    .filter((p) => p.modelCount > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The catalog models for a known provider, or [] if the name isn't in the catalog. */
export function catalogModels(name: string): Model<Api>[] {
  try {
    return getModels(name as KnownProvider);
  } catch {
    return [];
  }
}

/** A catalog baseUrl for display (providers expose it per-model; they share one). */
export function catalogBaseUrl(name: string): string {
  return catalogModels(name)[0]?.baseUrl ?? "";
}

/** Look up a single catalog model (used at runtime to resolve the Pi Model object). */
export function catalogModel(name: string, modelId: string): Model<Api> | undefined {
  try {
    return getModel(name as KnownProvider, modelId as never) as Model<Api> | undefined;
  } catch {
    return undefined;
  }
}

// ── Auth status / mutations for known providers ───────────────────────────────

export type KnownAuthMethod = "none" | "api-key" | "oauth";

export type KnownAuthStatus = {
  method: KnownAuthMethod;
  configured: boolean;
  oauthAvailable: boolean;
};

export function knownAuthStatus(name: string): KnownAuthStatus {
  const cred = getRuntimeAuthStorage().get(name);
  const method: KnownAuthMethod =
    cred?.type === "oauth" ? "oauth" : cred?.type === "api_key" ? "api-key" : "none";
  return { method, configured: !!cred, oauthAvailable: oauthAvailable(name) };
}

export function setKnownProviderApiKey(
  name: string,
  key: string
): { ok: true } | { ok: false; error: string } {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "API key is required." };
  getRuntimeAuthStorage().set(name, { type: "api_key", key: trimmed });
  return { ok: true };
}

export function disconnectKnownProvider(name: string): { ok: true } {
  getRuntimeAuthStorage().logout(name);
  return { ok: true };
}

/** True if a known provider has usable auth (without forcing an OAuth refresh). */
export function knownProviderConfigured(name: string): boolean {
  return getRuntimeAuthStorage().hasAuth(name);
}

/**
 * One in-flight OAuth login at a time. Callback-server flows bind a fixed local port (Anthropic
 * 53692, OpenAI Codex 1455), so concurrent or abandoned logins collide with EADDRINUSE. We track the
 * active login so we can (a) reject a second attempt and (b) cancel a stuck one.
 */
let pendingLogin: { provider: string; cancel: (reason: string) => void } | null = null;

/** Cancel an in-flight OAuth login, which frees the callback server's port. No-op if none. */
export function cancelOauthLogin(): void {
  pendingLogin?.cancel("Sign-in cancelled.");
}

/**
 * Run an OAuth login for a known provider. Two flow shapes are supported:
 *
 * - **Callback-server** (Anthropic): `onAuthUrl` carries the authorize URL so the UI opens the
 *   system browser, and the local callback server completes the exchange. We pass `onManualCodeInput`
 *   not to collect a pasted code but as a cancellation channel: rejecting it makes Pi call
 *   `cancelWait()`, whose `finally` closes the callback server and frees port 53692.
 * - **Device-code** (GitHub Copilot): there's no callback server. Pi first calls `onPrompt` for an
 *   optional GitHub Enterprise domain (we default to github.com), then `onDeviceCode` with a user
 *   code + verification URL the user enters in the browser. Cancellation rides the `AbortSignal`.
 */
export async function oauthLogin(
  name: string,
  hooks: {
    onAuthUrl: (url: string) => void;
    onProgress?: (message: string) => void;
    onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!oauthAvailable(name)) {
    return { ok: false, error: `No OAuth sign-in available for ${name}.` };
  }
  if (pendingLogin) {
    return {
      ok: false,
      error: "A sign-in is already in progress. Finish it in your browser, or cancel it first."
    };
  }

  let rejectManual: ((e: Error) => void) | null = null;
  const manualChannel = new Promise<string>((_resolve, reject) => {
    rejectManual = reject;
  });
  // The channel only ever rejects (on cancel); swallow so it's never an unhandled rejection.
  manualChannel.catch(() => {});
  // Device-code flows have no callback server to tear down; they cancel by aborting their poll.
  const abort = new AbortController();
  pendingLogin = {
    provider: name,
    cancel: (reason) => {
      rejectManual?.(new Error(reason));
      abort.abort(new Error(reason));
    }
  };

  const callbacks: OAuthLoginCallbacks = {
    onAuth: (info) => hooks.onAuthUrl(info.url),
    onProgress: (m) => hooks.onProgress?.(m),
    onDeviceCode: (info) =>
      hooks.onDeviceCode?.({ userCode: info.userCode, verificationUri: info.verificationUri }),
    // The only built-in prompt is GitHub Copilot's optional Enterprise domain (allowEmpty) — answer
    // it with "" to use github.com. Anything else (e.g. a code paste) we genuinely can't service here.
    onPrompt: async (prompt) => {
      if (prompt.allowEmpty) return "";
      throw new Error("Manual code entry isn't supported.");
    },
    onManualCodeInput: () => manualChannel,
    // A provider (OpenAI Codex) may offer a choice of login methods. We can't pop an interactive
    // picker from here, so take the provider's default — Pi lists it first (e.g. "Browser login
    // (default)"), and that browser flow reuses the same callback-server path as Anthropic.
    onSelect: async (prompt) => prompt.options[0]?.id,
    signal: abort.signal
  };
  try {
    await getRuntimeAuthStorage().login(name, callbacks);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("EADDRINUSE")) {
      return {
        ok: false,
        error:
          "The sign-in callback port is busy — a previous attempt may be stuck. Restart MapOS and try again."
      };
    }
    return { ok: false, error: msg };
  } finally {
    pendingLogin = null;
  }
}

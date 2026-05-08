import { ANTHROPIC_MODELS, OLLAMA_MODELS } from "@shared/ai-models";
import type { AiSettingsState, CustomEndpoint, SheetTarget } from "./types";

export function ctxLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K tokens`;
  return `${tokens} tokens`;
}

export function thinkingLabel(t: "adaptive" | "enabled" | false): string {
  if (t === "adaptive") return "Adaptive";
  if (t === "enabled") return "Enabled";
  return "No";
}

export function anthropicCapabilityMeta(modelId: string): string {
  const entry = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  if (!entry) return "Cloud model";
  const ctx = entry.capabilities.contextWindow;
  const ctxText =
    ctx >= 1_000_000
      ? "1M context"
      : ctx >= 1000
        ? `${Math.round(ctx / 1000)}K context`
        : `${ctx} ctx`;
  const parts = [ctxText];
  if (entry.capabilities.supportsImages) parts.push("vision");
  if (entry.capabilities.supportsTools) parts.push("tools");
  return parts.join(" · ");
}

export function customEndpointMeta(endpoint: CustomEndpoint): string {
  const host = (() => {
    if (!endpoint.baseUrl) return "";
    try {
      return new URL(endpoint.baseUrl).host || endpoint.baseUrl;
    } catch {
      return endpoint.baseUrl;
    }
  })();
  return [endpoint.model, host].filter(Boolean).join(" · ") || "Custom endpoint";
}

export function currentModelDisplay(
  state: AiSettingsState
): { kind: "cloud" | "local" | "custom"; label: string; target: SheetTarget } | null {
  if (state.provider === "anthropic") {
    const id = state.anthropic.model;
    if (!id) return null;
    const entry = ANTHROPIC_MODELS.find((m) => m.id === id);
    return {
      kind: "cloud",
      label: entry?.label ?? id,
      target: { type: "cloud", modelId: id }
    };
  }
  if (state.local.mode === "advanced") {
    const active = state.local.advanced.endpoints.find(
      (e) => e.id === state.local.advanced.activeId
    );
    if (!active) return null;
    return {
      kind: "custom",
      label: active.label || active.model,
      target: { type: "custom", endpointId: active.id }
    };
  }
  const id = state.local.magic.model;
  if (!id) return null;
  const entry = OLLAMA_MODELS.find((m) => m.id === id);
  return {
    kind: "local",
    label: entry?.label ?? id,
    target: { type: "local", modelId: id }
  };
}

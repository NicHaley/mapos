import type { ModelCapabilities } from "@shared/ai-models";
import { ANTHROPIC_MODELS, OLLAMA_MODELS, formatContextWindow } from "@shared/ai-models";
import type { AiSettingsState, CustomEndpoint, SheetTarget } from "./types";

const THINKING_LABELS: Record<ModelCapabilities["thinking"], string> = {
  off: "No",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high"
};

export function thinkingLabel(t: ModelCapabilities["thinking"]): string {
  return THINKING_LABELS[t];
}

export function anthropicCapabilityMeta(modelId: string): string {
  const entry = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  if (!entry) return "Cloud model";
  const parts = [`${formatContextWindow(entry.capabilities.contextWindow)} context`];
  if (entry.capabilities.supportsImages) parts.push("vision");
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

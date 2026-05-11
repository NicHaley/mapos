import { ANTHROPIC_MODELS, type OLLAMA_MODELS } from "@shared/ai-models";
import { thinkingLabel } from "./helpers";
import type { CustomEndpoint } from "./types";

export function ModelInfo({
  fullId,
  description,
  rows
}: {
  fullId: string;
  description?: string;
  rows: { label: string; value: string }[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
        {fullId}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {rows.length > 0 && (
        <dl className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd className="truncate text-right text-xs font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function anthropicInfoContent(modelId: string): React.ReactNode {
  const entry = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  if (!entry) return null;
  const c = entry.capabilities;
  return (
    <ModelInfo
      fullId={entry.id}
      rows={[
        { label: "Context", value: `${c.contextWindow} tokens` },
        { label: "Vision", value: c.supportsImages ? "Yes" : "No" },
        { label: "Thinking", value: thinkingLabel(c.thinking) }
      ]}
    />
  );
}

export function ollamaCuratedInfoContent(model: (typeof OLLAMA_MODELS)[number]): React.ReactNode {
  const c = model.capabilities;
  return (
    <ModelInfo
      fullId={model.id}
      description={model.hint}
      rows={[
        { label: "Disk", value: model.size },
        { label: "Context", value: `${c.contextWindow} tokens` },
        { label: "Vision", value: c.supportsImages ? "Yes" : "No" }
      ]}
    />
  );
}

export function ollamaGenericInfoContent(modelId: string): React.ReactNode {
  return (
    <ModelInfo
      fullId={modelId}
      description="Installed locally via Ollama. Capabilities default to off — local model behavior through the Anthropic-compat shim varies by model."
      rows={[]}
    />
  );
}

export function customInfoContent(endpoint: CustomEndpoint): React.ReactNode {
  return (
    <ModelInfo
      fullId={endpoint.model || "(no model set)"}
      rows={[
        { label: "Endpoint", value: endpoint.baseUrl || "—" },
        { label: "Auth", value: endpoint.hasAuthToken ? "Token saved" : "None" }
      ]}
    />
  );
}

import { Badge } from "@mapos/ui/components/badge";
import { ANTHROPIC_MODELS, type ModelCapabilities, type OLLAMA_MODELS } from "@shared/ai-models";
import { thinkingLabel } from "./helpers";
import type { CustomEndpoint } from "./types";

export function ModelInfo({
  fullId,
  rows
}: {
  fullId: string;
  rows: { label: string; value: string }[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <Badge variant="secondary" className="break-all font-mono">
        {fullId}
      </Badge>
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

function capabilityRows(size: string, c: ModelCapabilities): { label: string; value: string }[] {
  return [
    { label: "Size", value: size },
    { label: "Thinking", value: thinkingLabel(c.thinking) },
    { label: "Tools", value: c.supportsTools ? "Yes" : "No" },
    { label: "Vision", value: c.supportsImages ? "Yes" : "No" }
  ];
}

export function anthropicInfoContent(modelId: string): React.ReactNode {
  const entry = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  if (!entry) return null;
  return <ModelInfo fullId={entry.id} rows={capabilityRows("Cloud", entry.capabilities)} />;
}

export function ollamaCuratedInfoContent(model: (typeof OLLAMA_MODELS)[number]): React.ReactNode {
  return <ModelInfo fullId={model.id} rows={capabilityRows(model.size, model.capabilities)} />;
}

export function ollamaGenericInfoContent(modelId: string): React.ReactNode {
  return <ModelInfo fullId={modelId} rows={[]} />;
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

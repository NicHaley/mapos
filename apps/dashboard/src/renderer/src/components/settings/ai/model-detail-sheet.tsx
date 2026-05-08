import { Button } from "@mapos/ui/components/button";
import { CircularProgress } from "@mapos/ui/components/circular-progress";
import { ANTHROPIC_MODELS, OLLAMA_MODELS } from "@shared/ai-models";
import { DownloadIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { SettingsSheet } from "../settings-sheet";
import { anthropicCapabilityMeta, customEndpointMeta } from "./helpers";
import {
  anthropicInfoContent,
  customInfoContent,
  ollamaCuratedInfoContent,
  ollamaGenericInfoContent
} from "./model-info";
import type { AiSettingsState, CustomEndpoint, SheetTarget } from "./types";

/**
 * Slide-in panel that appears when the user clicks a model row. Replaces the
 * old per-row info popover; here we have room to render full model info AND
 * primary actions (Select, Download, Delete, Edit) in the footer.
 */
export function ModelDetailSheet({
  open,
  target,
  onClose,
  state,
  endpoints,
  installed,
  ollamaRunning,
  pullingModel,
  pullPercent,
  onCancelPull,
  cloudSelected,
  localSelected,
  endpointSelected,
  onSelectCloud,
  onSelectLocal,
  onSelectEndpoint,
  onPull,
  onRequestDeleteModel,
  onRequestDeleteEndpoint,
  onEditEndpoint
}: {
  open: boolean;
  target: SheetTarget | null;
  onClose: () => void;
  state: AiSettingsState;
  endpoints: CustomEndpoint[];
  installed: string[];
  ollamaRunning: boolean;
  pullingModel: string | null;
  pullPercent: number;
  onCancelPull: () => void;
  cloudSelected: (modelId: string) => boolean;
  localSelected: (modelId: string) => boolean;
  endpointSelected: (id: string) => boolean;
  onSelectCloud: (modelId: string) => void;
  onSelectLocal: (modelId: string) => void;
  onSelectEndpoint: (id: string) => void;
  onPull: (modelId: string) => void;
  onRequestDeleteModel: (modelId: string) => void;
  onRequestDeleteEndpoint: (id: string) => void;
  onEditEndpoint: (id: string) => void;
}): React.JSX.Element {
  let title = "";
  let description: string | undefined;
  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;

  if (target?.type === "cloud") {
    const id = target.modelId;
    const entry = ANTHROPIC_MODELS.find((m) => m.id === id);
    const isSelected = cloudSelected(id);
    const hasKey = state.anthropic.hasApiKey;
    title = entry?.label ?? id;
    description = entry ? anthropicCapabilityMeta(id) : undefined;
    body = anthropicInfoContent(id) ?? (
      <p className="text-xs text-muted-foreground">Model details unavailable for {id}.</p>
    );
    footer = (
      <div className="flex items-center justify-end gap-2">
        {!hasKey && (
          <span className="mr-auto text-xs text-muted-foreground">
            Connect your Anthropic account first.
          </span>
        )}
        <Button disabled={!hasKey || isSelected} onClick={() => onSelectCloud(id)}>
          {isSelected ? "Selected" : "Select"}
        </Button>
      </div>
    );
  } else if (target?.type === "local") {
    const id = target.modelId;
    const curated = OLLAMA_MODELS.find((m) => m.id === id);
    const isInstalled = installed.includes(id);
    const isSelected = localSelected(id);
    title = curated?.label ?? id;
    description = curated ? `${curated.size} · ${curated.hint}` : "Installed locally via Ollama";
    body = curated ? ollamaCuratedInfoContent(curated) : ollamaGenericInfoContent(id);
    if (isInstalled) {
      footer = (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onRequestDeleteModel(id)}>
            <Trash2Icon className="size-4" />
            Delete
          </Button>
          <Button disabled={isSelected} onClick={() => onSelectLocal(id)}>
            {isSelected ? "Selected" : "Select"}
          </Button>
        </div>
      );
    } else {
      const isPullingThis = pullingModel === id;
      footer = (
        <div className="flex items-center justify-end gap-2">
          {!ollamaRunning && !isPullingThis && (
            <span className="mr-auto text-xs text-muted-foreground">Start Ollama to download.</span>
          )}
          {isPullingThis && (
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
              {pullPercent}%
            </span>
          )}
          {isPullingThis ? (
            <Button variant="secondary" className="gap-1.5" onClick={onCancelPull}>
              <CircularProgress percent={pullPercent} />
              Cancel
            </Button>
          ) : (
            <Button disabled={!ollamaRunning || pullingModel !== null} onClick={() => onPull(id)}>
              <DownloadIcon className="size-4" />
              Download
            </Button>
          )}
        </div>
      );
    }
  } else if (target?.type === "custom") {
    const endpoint = endpoints.find((e) => e.id === target.endpointId);
    if (endpoint) {
      const isSelected = endpointSelected(endpoint.id);
      title = endpoint.label || endpoint.model || "Custom endpoint";
      description = customEndpointMeta(endpoint);
      body = customInfoContent(endpoint);
      footer = (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onEditEndpoint(endpoint.id)}>
            <PencilIcon className="size-4" />
            Edit
          </Button>
          <Button variant="ghost" onClick={() => onRequestDeleteEndpoint(endpoint.id)}>
            <Trash2Icon className="size-4" />
            Delete
          </Button>
          <Button disabled={isSelected} onClick={() => onSelectEndpoint(endpoint.id)}>
            {isSelected ? "Selected" : "Select"}
          </Button>
        </div>
      );
    }
  }

  return (
    <SettingsSheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      description={description}
      footer={footer}
    >
      {body}
    </SettingsSheet>
  );
}

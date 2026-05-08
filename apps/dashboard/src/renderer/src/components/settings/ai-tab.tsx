import { Alert, AlertAction, AlertTitle } from "@mapos/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import { Button } from "@mapos/ui/components/button";
import { ANTHROPIC_MODELS, OLLAMA_MODELS } from "@shared/ai-models";
import { CloudIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiKeysSheet } from "./ai/api-keys-sheet";
import { MAGIC_OLLAMA_BASE_URL } from "./ai/constants";
import { CustomEndpointSheet } from "./ai/custom-endpoint-sheet";
import { GroupHeader } from "./ai/group-header";
import {
  anthropicCapabilityMeta,
  currentModelDisplay,
  customEndpointMeta
} from "./ai/helpers";
import { ModelDetailSheet } from "./ai/model-detail-sheet";
import { ModelRow } from "./ai/model-row";
import { OllamaBanner } from "./ai/ollama-banner";
import { ProviderBadge } from "./ai/provider-badge";
import type { AiSettingsState, SheetTarget } from "./ai/types";
import { useOllamaDetection } from "./ai/use-ollama-detection";

export function AiTab(): React.JSX.Element {
  const [state, setState] = useState<AiSettingsState | null>(null);

  const { detection, installed, refresh: refreshOllama } = useOllamaDetection(MAGIC_OLLAMA_BASE_URL);

  // Pull state
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number>(0);
  const [pullError, setPullError] = useState<string | null>(null);

  // Selection in flight (for optimistic emerald check)
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  // Delete state
  const [pendingDeleteModel, setPendingDeleteModel] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // UI overlays
  const [keysOpen, setKeysOpen] = useState(false);
  /** When the dialog is open, this is null for "create new" or the endpoint id for "edit". */
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customDialogEndpointId, setCustomDialogEndpointId] = useState<string | null>(null);
  const [pendingDeleteEndpoint, setPendingDeleteEndpoint] = useState<string | null>(null);
  const [deletingEndpoint, setDeletingEndpoint] = useState<string | null>(null);
  const [deleteEndpointError, setDeleteEndpointError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // Detail sheet — shown when a model row is clicked. The body and footer are
  // derived from this target and reflect the appropriate model/endpoint info.
  const [sheetTarget, setSheetTarget] = useState<SheetTarget | null>(null);
  // Held one render behind so the sheet keeps its content visible during the
  // 220ms close animation (otherwise it would snap to empty).
  const [lastSheetTarget, setLastSheetTarget] = useState<SheetTarget | null>(null);
  useEffect(() => {
    if (sheetTarget) setLastSheetTarget(sheetTarget);
  }, [sheetTarget]);

  const baseUrl = MAGIC_OLLAMA_BASE_URL;

  const reload = useCallback(async () => {
    const next = await window.api.aiConfig.getSettingsState();
    setState(next);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    return window.api.aiConfig.onPullProgress((data) => {
      if (data.modelId !== pullingModel) return;
      // Ollama's post-download events (verifying, writing manifest, cleanup) carry no percent;
      // accept only numeric, non-decreasing values so the bar doesn't snap back to 0.
      if (typeof data.percent === "number") {
        const next = data.percent;
        setPullPercent((prev) => (next > prev ? next : prev));
      }
      if (data.status === "done") {
        void refreshOllama();
      }
    });
  }, [pullingModel, refreshOllama]);

  function flashSaved(): void {
    setSavedMessage("Saved");
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

  async function selectCloud(modelId: string): Promise<void> {
    if (!state) return;
    // Cloud rows are disabled when no key is saved; this is defensive only.
    if (!state.anthropic.hasApiKey) return;
    setPendingSelect(modelId);
    const result = await window.api.aiConfig.update({
      provider: "anthropic",
      anthropic: { model: modelId }
    });
    setPendingSelect(null);
    if (!result.ok) return;
    await reload();
    flashSaved();
  }

  async function selectLocal(modelId: string): Promise<void> {
    setPendingSelect(modelId);
    const result = await window.api.aiConfig.update({
      provider: "local",
      local: { mode: "magic", magic: { model: modelId } }
    });
    setPendingSelect(null);
    if (!result.ok) {
      setPullError(result.error);
      return;
    }
    await reload();
    flashSaved();
  }

  async function selectEndpoint(id: string): Promise<void> {
    setPendingSelect(`endpoint:${id}`);
    const result = await window.api.aiConfig.update({
      provider: "local",
      local: { mode: "advanced", advanced: { activeId: id } }
    });
    setPendingSelect(null);
    if (!result.ok) return;
    await reload();
    flashSaved();
  }

  function openAddEndpointDialog(): void {
    setCustomDialogEndpointId(null);
    setCustomDialogOpen(true);
  }

  async function confirmDeleteEndpoint(): Promise<void> {
    const target = pendingDeleteEndpoint;
    if (!target) return;
    setDeletingEndpoint(target);
    setDeleteEndpointError(null);
    const result = await window.api.aiConfig.removeCustomEndpoint(target);
    setDeletingEndpoint(null);
    if (!result.ok) {
      setDeleteEndpointError(result.error);
      return;
    }
    setPendingDeleteEndpoint(null);
    if (sheetTarget?.type === "custom" && sheetTarget.endpointId === target) {
      setSheetTarget(null);
    }
    await reload();
  }

  async function pullAndSelect(modelId: string): Promise<void> {
    setPullError(null);
    setPullingModel(modelId);
    setPullPercent(0);
    const result = await window.api.aiConfig.ollamaPull(baseUrl, modelId);
    setPullingModel(null);
    setPullPercent(0);
    if (!result.ok) {
      setPullError(result.error);
      return;
    }
    await refreshOllama();
    await selectLocal(modelId);
  }

  function cancelCurrentPull(): void {
    if (!pullingModel) return;
    void window.api.aiConfig.ollamaCancelPull(baseUrl, pullingModel);
    setPullingModel(null);
    setPullPercent(0);
  }

  async function confirmDelete(): Promise<void> {
    const target = pendingDeleteModel;
    if (!target) return;
    setDeletingModel(target);
    setDeleteError(null);
    const result = await window.api.aiConfig.ollamaDelete(baseUrl, target);
    setDeletingModel(null);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    setPendingDeleteModel(null);
    if (sheetTarget?.type === "local" && sheetTarget.modelId === target) {
      setSheetTarget(null);
    }
    await refreshOllama();
    // Main has already cleared local.magic.model when the deleted model was active; pull the new state.
    await reload();
  }

  const curatedOllamaIds = useMemo(() => new Set(OLLAMA_MODELS.map((m) => m.id)), []);
  const otherInstalled = useMemo(
    () => installed.filter((m) => !curatedOllamaIds.has(m)),
    [installed, curatedOllamaIds]
  );

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  const ollamaRunning = detection === "running";
  const endpoints = state.local.advanced.endpoints;
  const cloudSelected = (modelId: string): boolean =>
    state.provider === "anthropic" && state.anthropic.model === modelId;
  const localSelected = (modelId: string): boolean =>
    state.provider === "local" &&
    state.local.mode === "magic" &&
    state.local.magic.model === modelId;
  const endpointSelected = (id: string): boolean =>
    state.provider === "local" &&
    state.local.mode === "advanced" &&
    state.local.advanced.activeId === id;
  const editingEndpoint = customDialogEndpointId
    ? (endpoints.find((e) => e.id === customDialogEndpointId) ?? null)
    : null;
  const pendingDeleteEndpointEntry = pendingDeleteEndpoint
    ? (endpoints.find((e) => e.id === pendingDeleteEndpoint) ?? null)
    : null;
  const current = currentModelDisplay(state);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-medium">Models</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Pick a model. Cloud models run on the provider's servers; local models run on this Mac.
        </p>
        {current && (
          <Alert className="mt-3 flex items-center gap-2">
            <ProviderBadge kind={current.kind} size="sm" />
            <AlertTitle>Currently using {current.label}</AlertTitle>
            <AlertAction className="top-1/2 -translate-y-1/2">
              <Button variant="ghost" size="sm" onClick={() => setSheetTarget(current.target)}>
                View
              </Button>
            </AlertAction>
          </Alert>
        )}
      </div>

      {!ollamaRunning && detection !== "checking" && (
        <OllamaBanner onRecheck={() => void refreshOllama()} />
      )}

      {/* Anthropic */}
      <section className="flex flex-col gap-2">
        <GroupHeader
          label="Anthropic"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => setKeysOpen(true)}>
              {state.anthropic.hasApiKey ? "Manage" : "Connect your account"}
            </Button>
          }
        />
        <div className="divide-y divide-border overflow-hidden rounded-lg border">
          {ANTHROPIC_MODELS.map((m) => {
            const selected = cloudSelected(m.id) || pendingSelect === m.id;
            return (
              <ModelRow
                key={`cloud:${m.id}`}
                kind="cloud"
                label={m.label}
                meta={anthropicCapabilityMeta(m.id)}
                selected={selected}
                onClick={() => setSheetTarget({ type: "cloud", modelId: m.id })}
                trailing={<CloudIcon className="size-4 text-muted-foreground" aria-hidden />}
              />
            );
          })}
        </div>
      </section>

      {/* Local */}
      <section className="flex flex-col gap-2">
        <GroupHeader label="Local" />
        <div className="divide-y divide-border overflow-hidden rounded-lg border">
          {OLLAMA_MODELS.map((m) => {
            const isInstalled = installed.includes(m.id);
            const isSelected = localSelected(m.id) || pendingSelect === m.id;
            const isPulling = pullingModel === m.id;
            const isDeleting = deletingModel === m.id;
            return (
              <ModelRow
                key={`local:${m.id}`}
                kind="local"
                label={m.label}
                meta={`${m.size} · ${m.hint}`}
                selected={isSelected}
                disabled={isDeleting}
                pulling={isPulling}
                pullPercent={isPulling ? pullPercent : undefined}
                onClick={() => setSheetTarget({ type: "local", modelId: m.id })}
                trailing={
                  isInstalled ? (
                    <span className="text-xs tabular-nums text-muted-foreground">{m.size}</span>
                  ) : null
                }
              />
            );
          })}
          {otherInstalled.map((modelId) => {
            const isSelected = localSelected(modelId) || pendingSelect === modelId;
            const isDeleting = deletingModel === modelId;
            return (
              <ModelRow
                key={`local:${modelId}`}
                kind="local"
                label={modelId}
                meta="Installed locally via Ollama"
                selected={isSelected}
                disabled={isDeleting}
                onClick={() => setSheetTarget({ type: "local", modelId })}
              />
            );
          })}
        </div>
      </section>

      {/* Custom */}
      <section className="flex flex-col gap-2">
        <GroupHeader
          label="Custom"
          action={
            <Button type="button" variant="outline" size="sm" onClick={openAddEndpointDialog}>
              {endpoints.length === 0 ? (
                "Add"
              ) : (
                <>
                  <PlusIcon className="size-3.5" />
                  Add
                </>
              )}
            </Button>
          }
        />
        {endpoints.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-lg border">
            {endpoints.map((endpoint) => {
              const isSelected =
                endpointSelected(endpoint.id) || pendingSelect === `endpoint:${endpoint.id}`;
              const isDeleting = deletingEndpoint === endpoint.id;
              return (
                <ModelRow
                  key={`endpoint:${endpoint.id}`}
                  kind="custom"
                  label={endpoint.label || endpoint.model || "Custom endpoint"}
                  meta={customEndpointMeta(endpoint)}
                  selected={isSelected}
                  disabled={isDeleting}
                  onClick={() => setSheetTarget({ type: "custom", endpointId: endpoint.id })}
                />
              );
            })}
          </div>
        ) : (
          <div className="flex h-[60px] items-center justify-center rounded-lg border px-3 text-xs text-muted-foreground">
            No custom endpoints
          </div>
        )}
      </section>

      {pullError && <p className="text-xs text-destructive">{pullError}</p>}
      {savedMessage && <p className="text-xs text-emerald-500">{savedMessage}</p>}

      <ModelDetailSheet
        open={!!sheetTarget}
        target={sheetTarget ?? lastSheetTarget}
        onClose={() => setSheetTarget(null)}
        state={state}
        endpoints={endpoints}
        installed={installed}
        ollamaRunning={ollamaRunning}
        pullingModel={pullingModel}
        pullPercent={pullPercent}
        onCancelPull={cancelCurrentPull}
        cloudSelected={cloudSelected}
        localSelected={localSelected}
        endpointSelected={endpointSelected}
        onSelectCloud={(id) => {
          setSheetTarget(null);
          void selectCloud(id);
        }}
        onSelectLocal={(id) => {
          setSheetTarget(null);
          void selectLocal(id);
        }}
        onSelectEndpoint={(id) => {
          setSheetTarget(null);
          void selectEndpoint(id);
        }}
        onPull={(id) => {
          // Keep the sheet open so the radial progress shows on the now-disabled
          // Download button. The footer flips back to "Selected"/"Delete" once the
          // pull completes and pullAndSelect activates the model.
          void pullAndSelect(id);
        }}
        onRequestDeleteModel={(id) => setPendingDeleteModel(id)}
        onRequestDeleteEndpoint={(id) => setPendingDeleteEndpoint(id)}
        onEditEndpoint={(id) => {
          // Cross-fade: close detail sheet, then open the editor sheet once the
          // close animation has finished so they don't overlap visually.
          setSheetTarget(null);
          window.setTimeout(() => {
            setCustomDialogEndpointId(id);
            setCustomDialogOpen(true);
          }, 240);
        }}
      />

      <CustomEndpointSheet
        open={customDialogOpen}
        onOpenChange={(o) => {
          setCustomDialogOpen(o);
          if (!o) setCustomDialogEndpointId(null);
        }}
        endpoint={editingEndpoint}
        onSaved={(createdId) => {
          void (async () => {
            await reload();
            // Newly created endpoints become the active selection — matches the previous
            // "save advanced config and use it" flow so users don't have to click twice.
            if (createdId) {
              await selectEndpoint(createdId);
            }
          })();
        }}
      />

      <ApiKeysSheet
        open={keysOpen}
        onOpenChange={setKeysOpen}
        state={state.anthropic}
        onSaved={() => void reload()}
      />

      <AlertDialog
        open={!!pendingDeleteEndpoint}
        onOpenChange={(o) => {
          if (!o && !deletingEndpoint) {
            setPendingDeleteEndpoint(null);
            setDeleteEndpointError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteEndpointEntry?.label ||
                pendingDeleteEndpointEntry?.model ||
                "This endpoint"}{" "}
              will be removed. The model files at the remote endpoint are not affected.
            </AlertDialogDescription>
            {deleteEndpointError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteEndpointError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (deletingEndpoint) return;
                setPendingDeleteEndpoint(null);
                setDeleteEndpointError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!deletingEndpoint}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteEndpoint();
              }}
            >
              {deletingEndpoint ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingDeleteModel}
        onOpenChange={(o) => {
          if (!o && !deletingModel) {
            setPendingDeleteModel(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this model?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-xs">{pendingDeleteModel}</span> will be removed from
              Ollama and the disk space freed. You can re-download it later.
            </AlertDialogDescription>
            {deleteError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (deletingModel) return;
                setPendingDeleteModel(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!deletingModel}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deletingModel ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

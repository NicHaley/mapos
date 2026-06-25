import { Button } from "@mapos/ui/components/button";
import type { KnownProviderOption } from "@shared/ai-providers";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AddProviderSheet } from "./add-provider-sheet";
import { CapabilityBadges } from "./capability-badges";
import { ChangeModelSheet } from "./change-model-sheet";
import { DeleteProviderDialog } from "./delete-provider-dialog";
import { KnownProviderAuthSheet } from "./known-provider-auth-sheet";
import { ProviderBadge } from "./provider-badge";
import { ProviderEditorSheet } from "./provider-editor-sheet";
import { ProviderRow } from "./provider-row";
import { ProvidersEmptyState } from "./providers-empty-state";
import { useProviderManager } from "./use-provider-manager";

export function AiModelTab(): React.JSX.Element {
  const pm = useProviderManager();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [queuePicker, setQueuePicker] = useState(false);

  // After a provider connects, prompt model selection if none is set yet — the second half of the
  // "configure provider → select model" flow. No curated default; the user picks explicitly.
  const promptModelAfterConnect = useCallback(async (): Promise<void> => {
    const next = await pm.reload();
    setQueuePicker(!next.active && next.providers.some((p) => p.auth.configured));
  }, [pm.reload]);

  // Open the picker a beat after a connect so the connect drawer's slide-out finishes before it
  // slides in (they share a sheet slot). The timer clears itself if the tab unmounts first.
  useEffect(() => {
    if (!queuePicker) return;
    const id = window.setTimeout(() => {
      setPickerOpen(true);
      setQueuePicker(false);
    }, 240);
    return () => window.clearTimeout(id);
  }, [queuePicker]);

  if (!pm.state) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  const { state, active } = pm;
  const activeProvider = active
    ? state.providers.find((p) => p.id === active.providerId)
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-medium text-base">AI Models</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          The model MapOS uses by default. Switch anytime in a chat.
        </p>

        {/* No model hero while there are no providers — the Providers picker below is the single
            call to action, so we don't repeat "add a provider" twice. */}
        {state.providers.length > 0 &&
          (active ? (
            <div className="mt-3 rounded-lg border bg-muted/30 p-4">
              <div className="font-medium text-emerald-500 text-xs uppercase tracking-wide">
                Active model
              </div>
              <div className="mt-2.5 flex items-center gap-3">
                <ProviderBadge
                  knownProvider={activeProvider?.knownProvider}
                  label={active.providerLabel}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-base">{active.model}</div>
                  <div className="text-muted-foreground text-sm">via {active.providerLabel}</div>
                </div>
                <Button onClick={() => setPickerOpen(true)}>Change model</Button>
              </div>
              <div className="my-3 border-t" />
              <CapabilityBadges caps={active.capabilities} />
            </div>
          ) : pm.hasConnected ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
              <div className="min-w-0">
                <div className="font-medium text-sm">No model selected</div>
                <div className="text-muted-foreground text-sm">
                  Choose a model to start using MapOS's AI.
                </div>
              </div>
              <Button onClick={() => setPickerOpen(true)}>Choose a model</Button>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed bg-muted/30 p-4">
              <div className="font-medium text-sm">No model selected</div>
              <div className="text-muted-foreground text-sm">
                Connect a provider below to choose a model.
              </div>
            </div>
          ))}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-medium text-sm">Providers</h3>
            <p className="text-muted-foreground text-xs">
              Downloads and connected accounts. Powered by Pi.
            </p>
          </div>
          {state.providers.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => pm.setAddOpen(true)}>
              <PlusIcon className="size-4" />
              Add provider
            </Button>
          )}
        </div>

        {state.providers.length === 0 ? (
          <ProvidersEmptyState
            onPick={pm.openNewConnect}
            onCustom={pm.openCustomEditor}
            onBrowseAll={() => pm.setAddOpen(true)}
          />
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-lg border">
            {state.providers.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                onEdit={() => pm.editProvider(p)}
                onDelete={() => pm.requestDelete(p)}
              />
            ))}
          </div>
        )}
      </div>

      <ChangeModelSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        state={state}
        onSelected={pm.reload}
      />

      <AddProviderSheet
        open={pm.addOpen}
        onOpenChange={pm.setAddOpen}
        addedKnownProviders={pm.addedKnown}
        onPickKnown={(option: KnownProviderOption) => pm.openNewConnect(option.name, option.label)}
        onChooseCustom={pm.openCustomEditor}
      />

      <ProviderEditorSheet
        open={pm.editorOpen}
        onOpenChange={pm.setEditorOpen}
        provider={pm.editorProvider}
        onSaved={() => void promptModelAfterConnect()}
      />

      <KnownProviderAuthSheet
        open={pm.authOpen}
        onOpenChange={pm.setAuthOpen}
        target={pm.connectDrawerTarget}
        onChanged={() => void pm.reload()}
        onConnected={() => void promptModelAfterConnect()}
      />

      <DeleteProviderDialog
        pendingDelete={pm.pendingDelete}
        deleting={pm.deleting}
        deleteError={pm.deleteError}
        onCancel={pm.cancelDelete}
        onConfirm={() => void pm.confirmDelete()}
      />
    </div>
  );
}
